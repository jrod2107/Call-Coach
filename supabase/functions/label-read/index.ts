import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Reads the printed label on an appliance part (box, bag or sticker) from one photo and returns the
// part number, the part name and the brand as JSON. The barcode on a label is often a distributor or
// box code rather than the part number, so this reads the printed text instead.
// It only reads. The Stock page fills the form and a person checks it before anything is saved.
// Callers: signed-in profiles with role csr, admin, tech or stock (the same roles that may add stock).
//
// Secrets (shared with invoice-read):
//   ANTHROPIC_API_KEY     required
//   LABEL_MODEL           optional, default claude-sonnet-5-5

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const ALLOWED = ["csr", "admin", "tech", "stock"];
async function mayScan(req: Request): Promise<boolean> {
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

const SYSTEM = `You read the printed label on an appliance repair part (a box, bag or sticker) from a photo.
Return ONLY a JSON object, no other text, in this shape:
{"part_number":"","description":"","brand":"","unsure":false}
Rules:
- part_number is the manufacturer's part number as printed in text, usually next to "P/N", "PN", "Part No", "Part #", "Part Number" or "MFR". Uppercase, no spaces.
- Do NOT use the barcode or the digits under it unless the same number is also printed as the part number. Barcodes are often a distributor, box, lot or sales code.
- Do NOT use a model number, serial number, date code, lot number, quantity, price, UPC or "for use with" model list as the part number.
- If both a manufacturer part number and a distributor item or SKU number are printed, use the manufacturer part number.
- description is the name of the part as printed, short, in plain words (for example "Dryer heating element"). Empty string if none is printed.
- brand is the manufacturer or brand printed on the label (for example "Whirlpool", "GE"). Empty string if none.
- Set unsure to true if the part number is hard to read or you had to choose between several numbers. Never invent a part number: if there is none, return {"error":"no part number found"}.
- If the photo is not a part label, return {"error":"not a part label"}.`;

const IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await mayScan(req))) return json({ error: "Reading a label is limited to signed-in staff." }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

  let body: { file?: { media_type?: unknown; data?: unknown } } = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const mt = String(body.file?.media_type || ""), data = String(body.file?.data || "");
  if (!data || data.length > 8_000_000) return json({ error: "The photo is missing or too large. Try again." }, 400);
  if (!IMG.includes(mt)) return json({ error: "Only photos (JPEG, PNG, WebP) can be read." }, 400);

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("LABEL_MODEL") ?? "claude-sonnet-5-5",
      max_tokens: 500,
      system: SYSTEM,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mt, data } },
          { type: "text", text: "Read this part label and return the JSON." },
        ],
      }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("anthropic", r.status, t.slice(0, 300));
    return json({ error: `Claude request failed (${r.status})` }, r.status === 429 ? 429 : 502);
  }
  const res = await r.json();
  const text: string = (res.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "The label could not be read." }, 502);
  try { return json({ data: JSON.parse(m[0]) }); } catch { return json({ error: "The label could not be read." }, 502); }
});
