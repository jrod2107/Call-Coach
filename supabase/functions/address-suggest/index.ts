import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Address suggestions for Call intake, checked against Google Maps (Places API, New).
//   { q, token }         -> { suggestions: [{ place_id, main, secondary }] }   as the address is typed
//   { place_id, token }  -> { street, city, state, zip, formatted, lat, lng }  when one is picked
// Only the typed address text goes to Google: never a name, phone or email. Nothing is saved or logged here.
// The Google key stays on the server; the page never sees it.
// Callers: signed-in profiles with role csr, admin or tech.
//
// Secrets:
//   GOOGLE_MAPS_API_KEY   required. A Google Maps Platform key with "Places API (New)" enabled.
//                         Until it is set this answers { error: "not_configured" } and intake carries on without suggestions.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ALLOWED = ["csr", "admin", "tech"];
async function isStaff(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt.startsWith("eyJ")) return false;
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return false;
  const h = { Authorization: `Bearer ${jwt}`, apikey: anon };
  const u = await fetch(`${url}/auth/v1/user`, { headers: h });
  if (u.status !== 200) return false;
  const uid = String(((await u.json()) as Record<string, unknown>)?.id || "");
  if (!uid) return false;
  const p = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: h });
  if (p.status !== 200) return false;
  const rows = (await p.json()) as Record<string, unknown>[];
  return Array.isArray(rows) && rows.length === 1 && ALLOWED.includes(String(rows[0].role));
}

// Prefer addresses in and around the service area (a box a little larger than the service area map).
const BIAS = { rectangle: { low: { latitude: 29.40, longitude: -98.55 }, high: { latitude: 30.40, longitude: -97.40 } } };
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const PLACE = /^[A-Za-z0-9_-]{10,300}$/;

// Google said no. Log its reason (a status and a short message about the key or the request, never the address)
// so the cause can be found, and tell the page the check is unavailable.
async function refused(r: Response): Promise<Response> {
  const e = await r.json().catch(() => null) as { error?: { status?: string; message?: string } } | null;
  console.log(`google refused: http ${r.status} ${e?.error?.status || ""} ${String(e?.error?.message || "").slice(0, 200)}`);
  return json({ error: "The address check did not answer.", google_status: r.status }, 502);
}

type Comp = { longText?: string; shortText?: string; types?: string[] };

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await isStaff(req))) return json({ error: "Address suggestions are limited to signed-in staff." }, 401);
  const key = Deno.env.get("GOOGLE_MAPS_API_KEY");
  if (!key) return json({ error: "not_configured" }, 503);

  let body: { q?: unknown; place_id?: unknown; token?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const token = TOKEN.test(String(body.token || "")) ? String(body.token) : "";

  try {
    if (body.place_id != null) {
      const id = String(body.place_id);
      if (!PLACE.test(id)) return json({ error: "Bad request" }, 400);
      const r = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(id)}${token ? `?sessionToken=${token}` : ""}`, {
        headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": "formattedAddress,addressComponents,location" },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return refused(r);
      const d = await r.json() as { formattedAddress?: string; addressComponents?: Comp[]; location?: { latitude?: number; longitude?: number } };
      const part = (t: string, short = false) => { const c = (d.addressComponents || []).find((x) => (x.types || []).includes(t)); return c ? String((short ? c.shortText : c.longText) || "") : ""; };
      const street = [part("street_number"), part("route", true)].filter(Boolean).join(" ");
      const unit = part("subpremise");
      return json({
        street: unit ? `${street} #${unit}` : street,
        city: part("locality") || part("sublocality") || part("postal_town") || part("administrative_area_level_3"),
        state: part("administrative_area_level_1", true),
        zip: part("postal_code"),
        formatted: String(d.formattedAddress || ""),
        lat: Number(d.location?.latitude), lng: Number(d.location?.longitude),
      });
    }

    const q = String(body.q || "").replace(/\s+/g, " ").trim();
    if (q.length < 4 || q.length > 120) return json({ suggestions: [] });
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "X-Goog-Api-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: q, includedRegionCodes: ["us"], locationBias: BIAS,
        includedPrimaryTypes: ["street_address", "premise", "subpremise"],
        ...(token ? { sessionToken: token } : {}),
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return refused(r);
    const d = await r.json() as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string }; structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } } } }[] };
    const suggestions = (d.suggestions || []).map((s) => s.placePrediction).filter((p) => p && p.placeId).slice(0, 5).map((p) => ({
      place_id: String(p!.placeId),
      main: String(p!.structuredFormat?.mainText?.text || p!.text?.text || ""),
      secondary: String(p!.structuredFormat?.secondaryText?.text || ""),
    }));
    return json({ suggestions });
  } catch {
    return json({ error: "The address check did not answer." }, 502);
  }
});
