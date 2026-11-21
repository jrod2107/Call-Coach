import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Finds where a street address is on the map, so the Job pricing page can tell which service zone it is in.
// It sends the address (street, city, state, zip only: never a name or phone) to the US Census Bureau's free
// address lookup and returns the matched address and its coordinates. It saves nothing and logs no address.
// The page works out the zone itself from the zones it is allowed to read.
// Callers: signed-in profiles with role csr, admin or tech.
// No secrets needed.

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await isStaff(req))) return json({ error: "The address lookup is limited to signed-in staff." }, 401);

  let body: { address?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  let address = String(body.address || "").replace(/\s+/g, " ").trim();
  if (address.length < 6 || address.length > 200) return json({ error: "Type the street address and the city or zip." }, 400);
  // The company only works in Texas; adding the state helps the match when the caller left it out.
  if (!/\b(tx|texas)\b/i.test(address)) address += ", TX";

  const q = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
  let r: Response;
  try {
    r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${q}`, { signal: AbortSignal.timeout(12000) });
  } catch {
    return json({ error: "The address lookup did not answer. Pick the area by hand." }, 502);
  }
  if (!r.ok) return json({ error: "The address lookup did not answer. Pick the area by hand." }, 502);
  const data = await r.json().catch(() => null) as { result?: { addressMatches?: { matchedAddress?: string; coordinates?: { x?: number; y?: number } }[] } } | null;
  const m = data?.result?.addressMatches?.[0];
  const lng = Number(m?.coordinates?.x), lat = Number(m?.coordinates?.y);
  if (!m || !isFinite(lng) || !isFinite(lat)) return json({ found: false });
  return json({ found: true, matched: String(m.matchedAddress || ""), lat, lng });
});
