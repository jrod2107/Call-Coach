import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// HCP proxy for the City Appliance intake tool.
// The HCP API key lives ONLY here, as the HCP_API_KEY secret.
// verify_jwt=true: only signed-in CSRs can call this function.
// Request/response shapes verified against docs.housecallpro.com (2026-11-08):
//   money fields (unit_price, unit_cost) are in CENTS.

const HCP_BASE = "https://api.housecallpro.com";

const ALLOWED_ORIGINS = [
  "https://jrod2107.github.io",
  "http://localhost:8000",
  "http://localhost:5173",
];

function cors(origin: string | null) {
  const o = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

async function hcp(path: string, init: RequestInit = {}) {
  const key = Deno.env.get("HCP_API_KEY");
  if (!key) {
    return { status: 500, body: { error: "HCP_API_KEY secret is not set. Add it in Supabase: Edge Functions settings, secret name HCP_API_KEY." } };
  }
  const res = await fetch(HCP_BASE + path, {
    ...init,
    headers: {
      "Authorization": `Token ${key}`,
      "Accept": "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  let body: unknown = null;
  const text = await res.text();
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (res.status >= 400) body = { error: "HCP returned " + res.status, hcp_status: res.status, detail: body };
  return { status: res.status, body };
}

const id = (v: unknown) => encodeURIComponent(String(v || ""));

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers });

  let action = "", payload: Record<string, unknown> = {};
  try {
    const j = await req.json();
    action = String(j.action || "");
    payload = (j.payload || {}) as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({ error: "bad json" }), { status: 400, headers });
  }

  let out;
  switch (action) {
    case "health": {
      const key_set = !!Deno.env.get("HCP_API_KEY");
      let hcp_status: number | null = null;
      let company: string | null = null;
      if (key_set) {
        const r = await hcp("/company");
        hcp_status = r.status;
        const b = r.body as Record<string, unknown> | null;
        if (r.status === 200 && b) company = String(b.name || b.company_name || "");
      }
      out = { status: 200, body: { ok: key_set && hcp_status === 200, key_set, hcp_status, company } };
      break;
    }
    case "customer_search": {
      const q = String(payload.q || "").trim();
      if (q.length < 3) { out = { status: 200, body: { customers: [] } }; break; }
      out = await hcp(`/customers?q=${encodeURIComponent(q)}&page_size=8`);
      break;
    }
    case "customer_jobs":
      out = await hcp(`/jobs?customer_id=${id(payload.customer_id)}&page_size=10&sort_by=created_at&sort_direction=desc`);
      break;
    case "customer_create":
      out = await hcp("/customers", { method: "POST", body: JSON.stringify(payload.customer || {}) });
      break;
    case "customer_update":
      out = await hcp(`/customers/${id(payload.customer_id)}`, { method: "PUT", body: JSON.stringify(payload.patch || {}) });
      break;
    case "address_create":
      out = await hcp(`/customers/${id(payload.customer_id)}/addresses`, { method: "POST", body: JSON.stringify(payload.address || {}) });
      break;
    case "job_create":
      out = await hcp("/jobs", { method: "POST", body: JSON.stringify(payload.job || {}) });
      break;
    case "job_note":
      out = await hcp(`/jobs/${id(payload.job_id)}/notes`, { method: "POST", body: JSON.stringify({ content: String(payload.content || "") }) });
      break;
    case "job_get":
      out = await hcp(`/jobs/${id(payload.job_id)}`);
      break;
    case "job_line_items":
      out = await hcp(`/jobs/${id(payload.job_id)}/line_items`);
      break;
    case "line_items_bulk":
      out = await hcp(`/jobs/${id(payload.job_id)}/line_items/bulk_update`, { method: "PUT", body: JSON.stringify({ line_items: payload.line_items || [], append_line_items: !!payload.append }) });
      break;
    case "pricebook_search":
      out = await hcp(`/api/price_book/services?q=${encodeURIComponent(String(payload.q || ""))}&page_size=25`);
      break;
    case "lead_create":
      out = await hcp("/leads", { method: "POST", body: JSON.stringify(payload.lead || {}) });
      break;
    default:
      out = { status: 400, body: { error: "unknown action: " + action } };
  }

  return new Response(JSON.stringify(out.body), { status: out.status >= 200 && out.status < 300 ? 200 : out.status, headers });
});
