import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Reads a parts-house invoice or packing slip (photos or a PDF) and returns its lines as JSON.
// It only reads. The Stock page shows the lines for review and nothing is saved until a person confirms.
// Office only: the caller must be a signed-in profile with role csr or admin.
//
// Secrets (shared with desk-ask and coach-suggest):
//   ANTHROPIC_API_KEY     required
//   INVOICE_MODEL         optional, default claude-sonnet-5-5

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const OFFICE = ["csr", "admin"];
async function isOffice(req: Request): Promise<boolean> {
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
  return Array.isArray(rows) && rows.length === 1 && OFFICE.includes(String(rows[0].role));
}

const SYSTEM = `You read invoices and packing slips from appliance parts distributors for an appliance repair company.
Return ONLY a JSON object, no other text, in this shape:
{"vendor":"","invoice_number":"","order_number":"","po_number":"","invoice_date":"","lines":[
 {"part_number":"","description":"","qty_shipped":0,"qty_backordered":0,"unit_cost":null,"line_ref":"","unsure":false}]}
Rules:
- One entry per part line. Skip freight, shipping, tax, fees, core charges, totals and payment lines.
- part_number is the part number exactly as printed (the manufacturer part number if both a vendor item number and a manufacturer number are shown). Uppercase, no spaces.
- qty_shipped is the quantity shipped on this document. If only one quantity column exists, use it. qty_backordered is the backordered quantity, or 0.
- unit_cost is the price per unit the company pays, as a number, or null if not printed.
- line_ref is any reference printed for that line or, if there is only one for the whole document, the document's PO or reference text: a job number, a customer name, a PO line note, or the word STOCK. Copy it as printed. Empty string if none.
- po_number is the customer PO field. order_number is the vendor's order or sales order number. invoice_date as YYYY-MM-DD when readable.
- Set unsure to true on any line where the part number or quantity is hard to read. Never invent a part number: if you cannot read it, put your best reading and set unsure to true.
- If the document is not an invoice or packing slip, return {"error":"not an invoice"}.`;

type InFile = { media_type?: unknown; data?: unknown };
const IMG = ["image/jpeg", "image/png", "image/webp", "image/gif"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!(await isOffice(req))) return json({ error: "Receiving an invoice is limited to office accounts." }, 401);

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY is not set" }, 500);

  let body: { files?: unknown } = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const files = (Array.isArray(body.files) ? body.files : []) as InFile[];
  if (!files.length || files.length > 6) return json({ error: "Send 1 to 6 pages." }, 400);

  const content: unknown[] = [];
  let total = 0;
  for (const f of files) {
    const mt = String(f.media_type || ""), data = String(f.data || "");
    total += data.length;
    if (!data || total > 14_000_000) return json({ error: "The files are too large. Try fewer pages or a smaller photo." }, 400);
    if (mt === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: mt, data } });
    else if (IMG.includes(mt)) content.push({ type: "image", source: { type: "base64", media_type: mt, data } });
    else return json({ error: "Only photos (JPEG, PNG, WebP) and PDFs can be read." }, 400);
  }
  content.push({ type: "text", text: "Read this invoice or packing slip and return the JSON." });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: Deno.env.get("INVOICE_MODEL") ?? "claude-sonnet-5-5",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("anthropic", r.status, t.slice(0, 300));
    return json({ error: `Claude request failed (${r.status})` }, r.status === 429 ? 429 : 502);
  }
  const data = await r.json();
  const text: string = (data.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return json({ error: "The invoice could not be read." }, 502);
  try { return json({ data: JSON.parse(m[0]) }); } catch { return json({ error: "The invoice could not be read." }, 502); }
});
