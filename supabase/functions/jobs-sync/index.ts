import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Copies Housecall Pro jobs into the site's own jobs table. Read-only toward Housecall Pro: it only GETs.
// Runs every 10 minutes from the database scheduler (see the *jobs_mirror migration), which sends the
// x-sync-token header. An admin can also run it from the Jobs page ("Sync now"), optionally with a date range
// to bring in older jobs: { "from": "2026-01-01", "to": "2026-03-01" }.
//
// Each run reads jobs scheduled from 7 days back to 45 days ahead, plus the 100 most recently created
// (which catches unscheduled jobs). Contact details and notes go to job_private, which no signed-in user
// can read directly; see job_details() in the migration.
//
// Secrets: HCP_API_KEY (shared with the hcp function). SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and
// SUPABASE_ANON_KEY are provided by the platform.

const HCP_BASE = "https://api.housecallpro.com";
const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const MAX_PAGES = 12;     // 100 jobs a page; a run stops here and says so

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = Record<string, unknown>;
const enc = encodeURIComponent;
const str = (v: unknown, max = 500) => { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; };
const ts = (v: unknown) => { const s = String(v ?? ""); return s && !isNaN(Date.parse(s)) ? new Date(s).toISOString() : null; };
const int = (v: unknown) => (typeof v === "number" && isFinite(v) ? Math.round(v) : null);
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : null);
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };

async function db(path: string, init: RequestInit = {}): Promise<Row[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`database ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}

async function isAdmin(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt.startsWith("eyJ")) return false;
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${jwt}`, apikey: ANON } });
  if (u.status !== 200) return false;
  const uid = String(((await u.json()) as Row)?.id || "");
  if (!uid) return false;
  const rows = await db(`profiles?id=eq.${enc(uid)}&select=role`);
  return rows.length === 1 && rows[0].role === "admin";
}

async function hcpJobs(query: string): Promise<{ jobs: Row[]; totalPages: number }> {
  const key = Deno.env.get("HCP_API_KEY");
  if (!key) throw new Error("HCP_API_KEY is not set");
  const r = await fetch(`${HCP_BASE}/jobs?${query}`, { headers: { Authorization: `Token ${key}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Housecall Pro returned ${r.status}`);
  const j = (await r.json()) as Row;
  return { jobs: Array.isArray(j.jobs) ? (j.jobs as Row[]) : [], totalPages: Number(j.total_pages) || 1 };
}

function toRows(j: Row) {
  const sch = (j.schedule || {}) as Row, wt = (j.work_timestamps || {}) as Row;
  const cu = (j.customer || {}) as Row, ad = (j.address || {}) as Row, jf = (j.job_fields || {}) as Row;
  const emps = (Array.isArray(j.assigned_employees) ? j.assigned_employees : []) as Row[];
  const name = [cu.first_name, cu.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ") || str(cu.company, 200) || null;
  const job = {
    hcp_job_id: String(j.id),
    job_number: str(j.invoice_number, 40),
    description: str(j.description, 2000),
    work_status: str(j.work_status, 60),
    scheduled_start: ts(sch.scheduled_start),
    scheduled_end: ts(sch.scheduled_end),
    arrival_window: int(sch.arrival_window),
    on_my_way_at: ts(wt.on_my_way_at),
    started_at: ts(wt.started_at),
    completed_at: ts(wt.completed_at),
    tech_hcp_ids: emps.map((e) => String(e.id || "")).filter(Boolean),
    tech_names: emps.map((e) => [e.first_name, e.last_name].map((x) => String(x ?? "").trim()).filter(Boolean).join(" ")).filter(Boolean),
    tags: (Array.isArray(j.tags) ? j.tags : []).map((t) => String(t)).slice(0, 40),
    business_unit: str(((jf.business_unit || {}) as Row).name, 120),
    job_type: str(((jf.job_type || {}) as Row).name, 120),
    lead_source: str(j.lead_source, 120),
    total_cents: int(j.total_amount),
    balance_cents: int(j.outstanding_balance),
    customer_hcp_id: str(cu.id, 80),
    customer_name: name,
    city: str(ad.city, 120),
    zip: str(ad.zip, 20),
    hcp_created_at: ts(j.created_at),
    hcp_updated_at: ts(j.updated_at),
    canceled_at: ts(j.canceled_at),
    deleted_at: ts(j.deleted_at),
    synced_at: new Date().toISOString(),
  };
  const priv: Row = {
    phone_mobile: str(cu.mobile_number, 40),
    phone_home: str(cu.home_number, 40),
    phone_work: str(cu.work_number, 40),
    email: str(cu.email, 200),
    street: str(ad.street, 200),
    street2: str(ad.street_line_2, 200),
    state: str(ad.state, 40),
    lat: num(ad.latitude),
    lng: num(ad.longitude),
  };
  const notes = Array.isArray(j.notes)
    ? (j.notes as unknown[]).map((n) => String((n && typeof n === "object" ? (n as Row).content : n) ?? "").slice(0, 8000)).filter(Boolean).slice(0, 30)
    : null;
  const staff = emps.map((e) => ({ id: String(e.id || ""), email: String(e.email || "").trim().toLowerCase() })).filter((e) => e.id && e.email);
  return { job, priv, notes, staff };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SB_URL || !SERVICE) return json({ error: "Not configured" }, 500);

  let token = "";
  try { token = String((await db("collector_config?key=eq.jobs_sync_token&select=value"))[0]?.value || ""); } catch (e) { return json({ error: (e as Error).message }, 500); }
  const sent = req.headers.get("x-sync-token") || "";
  const scheduled = !!sent && !!token && same(sent, token);
  if (!scheduled && !(await isAdmin(req))) return json({ error: "Not allowed." }, 401);

  let body: Row = {};
  try { body = (await req.json()) as Row; } catch { /* empty body is fine */ }
  const day = 864e5, now = Date.now();
  const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const ranged = !scheduled && isDate(body.from) && isDate(body.to);
  const from = ranged ? new Date(body.from + "T00:00:00Z") : new Date(now - 7 * day);
  const to = ranged ? new Date(body.to + "T23:59:59Z") : new Date(now + 45 * day);

  const seen = new Map<string, ReturnType<typeof toRows>>();
  let pages = 0, capped = false;
  try {
    for (let page = 1; ; page++) {
      if (pages >= MAX_PAGES) { capped = true; break; }
      const r = await hcpJobs(`scheduled_start_min=${enc(from.toISOString())}&scheduled_start_max=${enc(to.toISOString())}&page=${page}&page_size=100`);
      pages++;
      for (const j of r.jobs) if (j && j.id) seen.set(String(j.id), toRows(j));
      if (page >= r.totalPages || !r.jobs.length) break;
    }
    if (!ranged) {
      const r = await hcpJobs("page=1&page_size=100&sort_by=created_at&sort_direction=desc");
      pages++;
      for (const j of r.jobs) if (j && j.id) seen.set(String(j.id), toRows(j));
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }

  const all = [...seen.values()];
  let saved = 0;
  try {
    for (let i = 0; i < all.length; i += 200) {
      const chunk = all.slice(i, i + 200);
      const rows = await db("jobs?on_conflict=hcp_job_id&select=id,hcp_job_id", {
        method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=representation" }, body: JSON.stringify(chunk.map((c) => c.job)),
      });
      const idOf = new Map(rows.map((r) => [String(r.hcp_job_id), String(r.id)]));
      const withNotes: Row[] = [], without: Row[] = [];
      for (const c of chunk) {
        const job_id = idOf.get(c.job.hcp_job_id); if (!job_id) continue;
        if (c.notes) withNotes.push({ job_id, ...c.priv, notes: c.notes }); else without.push({ job_id, ...c.priv });
      }
      for (const group of [withNotes, without]) {
        if (group.length) await db("job_private?on_conflict=job_id", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(group) });
      }
      saved += rows.length;
    }
    // Link site accounts to their Housecall Pro employee by exact email, so a technician sees their own jobs.
    const staff = new Map<string, string>();
    for (const c of all) for (const s of c.staff) staff.set(s.email, s.id);
    for (const [email, id] of staff) {
      await db(`profiles?email=eq.${enc(email)}&hcp_employee_id=is.null`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ hcp_employee_id: id }) });
    }
    const summary = { at: new Date().toISOString(), jobs: saved, pages, capped, range: ranged ? `${body.from} to ${body.to}` : "rolling" };
    await db("collector_config?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify({ key: "jobs_last_sync", value: JSON.stringify(summary), updated_at: new Date().toISOString() }) });
    return json({ ok: true, ...summary });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
