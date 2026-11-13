import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Read-only schedule feed for the City Appliance intake tool.
// Kept separate from the `hcp` function so the live lookup/save function is
// never touched by schedule work. This function only ever sends GET requests.
// The HCP API key lives ONLY here, as the HCP_API_KEY secret (shared with `hcp`).
// verify_jwt=true plus isStaff(): only signed-in csr/admin profiles can call this function.
//
// Each job carries its street address, tags and block length (minutes) so the
// intake page can count points per tech and rank days by drive time.
//
// Behaviour checked against the live HCP API on 2026-11-12:
//   /jobs   honours scheduled_start_min / scheduled_start_max, page_size up to 200.
//   /events ignores date filters, so every event is fetched and filtered here.
//           Repeating events come back once, with an RRULE in recurrence_rule,
//           and are expanded here into the dates that fall inside the range.

const HCP_BASE = "https://api.housecallpro.com";
const DEFAULT_TZ = "America/Chicago";
const MAX_RANGE_DAYS = 31;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
const EVENTS_TTL_MS = 5 * 60 * 1000;

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

type Obj = Record<string, unknown>;

/* ---------- staff check ----------
   verify_jwt alone lets the site's public (publishable) key through, so check
   here that the caller is a signed-in user whose profile role is csr or admin.
   Users can read their own profile row (RLS) but cannot change their role. */
const STAFF_ROLES = ["csr", "admin"];
async function isStaff(req: Request): Promise<boolean> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!jwt.startsWith("eyJ")) return false; // publishable and secret keys are not user sessions
  const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) return false;
  const h = { Authorization: `Bearer ${jwt}`, apikey: anon };
  const u = await fetch(`${url}/auth/v1/user`, { headers: h });
  if (u.status !== 200) return false;
  const uid = String(((await u.json()) as Obj)?.id || "");
  if (!uid) return false;
  const p = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&select=role`, { headers: h });
  if (p.status !== 200) return false;
  const rows = (await p.json()) as Obj[];
  return Array.isArray(rows) && rows.length === 1 && STAFF_ROLES.includes(String(rows[0].role));
}

async function hcpGet(path: string): Promise<{ status: number; body: unknown }> {
  const key = Deno.env.get("HCP_API_KEY");
  if (!key) return { status: 500, body: { error: "HCP_API_KEY secret is not set." } };
  const res = await fetch(HCP_BASE + path, {
    headers: { "Authorization": `Token ${key}`, "Accept": "application/json" },
  });
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

const str = (v: unknown) => (v == null ? "" : String(v));
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const techName = (e: unknown) => { const o = obj(e); return [o.first_name, o.last_name].map(str).filter(Boolean).join(" "); };

// Fetch every page of an HCP list endpoint (first page, then the rest together).
async function listAll(basePath: string, listKey: string) {
  const page = (n: number) => hcpGet(`${basePath}&page=${n}&page_size=${PAGE_SIZE}`);
  const first = await page(1);
  if (first.status !== 200) return { items: [] as Obj[], status: first.status, truncated: false };
  const items = arr(obj(first.body)[listKey]) as Obj[];
  const totalPages = Number(obj(first.body).total_pages || 1);
  const last = Math.min(totalPages, MAX_PAGES);
  const rest = await Promise.all(Array.from({ length: Math.max(0, last - 1) }, (_, i) => page(i + 2)));
  for (const r of rest) {
    if (r.status !== 200) return { items, status: r.status, truncated: true };
    items.push(...(arr(obj(r.body)[listKey]) as Obj[]));
  }
  return { items, status: 200, truncated: totalPages > MAX_PAGES };
}

/* ---------- time zone helpers (wall-clock time in the company's zone) ---------- */
function localParts(t: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(t))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, s: number, tz: string) {
  const want = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = localParts(guess, tz);
    guess -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - want;
  }
  return guess;
}
const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 864e5);

/* ---------- repeating events ---------- */
const DOW = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function parseRule(rule: string) {
  const kv: Record<string, string> = {};
  for (const part of rule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) kv[k.trim().toUpperCase()] = v.trim().toUpperCase();
  }
  let until: number | null = null;
  const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(kv.UNTIL || "");
  if (u) until = Date.UTC(+u[1], +u[2] - 1, +u[3], +(u[4] ?? 23), +(u[5] ?? 59), +(u[6] ?? 59));
  else if (kv.UNTIL && !isNaN(+new Date(kv.UNTIL))) until = +new Date(kv.UNTIL);
  return {
    freq: kv.FREQ || "",
    interval: Math.max(1, parseInt(kv.INTERVAL || "1", 10) || 1),
    byday: (kv.BYDAY || "").split(",").map((x) => x.trim()).filter(Boolean),
    bymonthday: (kv.BYMONTHDAY || "").split(",").map((x) => parseInt(x, 10)).filter((n) => !isNaN(n)),
    count: kv.COUNT ? parseInt(kv.COUNT, 10) : null,
    until,
  };
}

// Start times (ms) of a repeating event that fall inside [from, to).
// Returns null when the rule is one this code does not understand.
function expand(startMs: number, rule: string, tz: string, from: number, to: number): number[] | null {
  const r = parseRule(rule);
  if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(r.freq)) return null;
  if (r.byday.some((b) => !/^[+-]?\d{0,2}(SU|MO|TU|WE|TH|FR|SA)$/.test(b))) return null;
  const s = localParts(startMs, tz);
  const d0 = dayNum(s.y, s.m, s.d);
  const dow0 = new Date(Date.UTC(s.y, s.m - 1, s.d)).getUTCDay();
  const week0 = d0 - dow0;
  const endP = localParts(to, tz);
  const dEnd = dayNum(endP.y, endP.m, endP.d);
  const out: number[] = [];
  let made = 0;
  for (let dn = d0; dn <= dEnd && dn - d0 < 6000; dn++) {
    const dt = new Date(dn * 864e5);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate(), dow = dt.getUTCDay();
    let hit = false;
    if (r.freq === "DAILY") {
      hit = (dn - d0) % r.interval === 0 && (!r.byday.length || r.byday.includes(DOW[dow]));
    } else if (r.freq === "WEEKLY") {
      const days = r.byday.length ? r.byday.map((b) => b.slice(-2)) : [DOW[dow0]];
      hit = Math.floor((dn - week0) / 7) % r.interval === 0 && days.includes(DOW[dow]);
    } else if (r.freq === "MONTHLY") {
      const months = (y - s.y) * 12 + (m - s.m);
      if (months % r.interval === 0) {
        if (r.byday.length) {
          const nth = Math.ceil(d / 7);
          const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
          const fromEnd = -Math.ceil((daysInMonth - d + 1) / 7);
          hit = r.byday.some((b) => {
            const mm = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(b)!;
            if (mm[2] !== DOW[dow]) return false;
            return !mm[1] || +mm[1] === nth || +mm[1] === fromEnd;
          });
        } else {
          hit = (r.bymonthday.length ? r.bymonthday : [s.d]).includes(d);
        }
      }
    } else {
      hit = (y - s.y) % r.interval === 0 && m === s.m && d === s.d;
    }
    if (!hit) continue;
    const t = zonedToUtc(y, m, d, s.h, s.mi, s.s, tz);
    if (r.until != null && t > r.until) break;
    made++;
    if (r.count != null && made > r.count) break;
    if (t >= from && t < to) out.push(t);
  }
  return out;
}

/* ---------- events (cached briefly: HCP cannot filter them by date) ---------- */
let eventsCache: { at: number; items: Obj[]; truncated: boolean } | null = null;

async function loadEvents() {
  if (eventsCache && Date.now() - eventsCache.at < EVENTS_TTL_MS) return { ...eventsCache, status: 200 };
  const r = await listAll(`/events?sort_direction=desc`, "events");
  if (r.status === 200) eventsCache = { at: Date.now(), items: r.items, truncated: r.truncated };
  return { items: r.items, truncated: r.truncated, status: r.status };
}

function eventsInRange(items: Obj[], from: number, to: number) {
  const out: Obj[] = [];
  let unsupported = 0;
  for (const e of items) {
    const sch = obj(e.schedule);
    const start = +new Date(str(sch.start_time)), end = +new Date(str(sch.end_time));
    if (isNaN(start)) continue;
    const dur = isNaN(end) ? 0 : Math.max(0, end - start);
    const tz = str(sch.time_zone) || DEFAULT_TZ;
    const base = { id: str(e.id), name: str(e.name), all_day: !!e.all_day, techs: arr(e.assigned_employees).map(techName).filter(Boolean) };
    const rule = str(e.recurrence_rule);
    if (!rule) {
      if (start < to && start + Math.max(dur, 1) > from) out.push({ ...base, start: new Date(start).toISOString(), end: new Date(start + dur).toISOString(), repeats: false });
      continue;
    }
    const times = expand(start, rule, tz, from - dur, to);
    if (times == null) { unsupported++; continue; }
    for (const t of times) out.push({ ...base, start: new Date(t).toISOString(), end: new Date(t + dur).toISOString(), repeats: true });
  }
  out.sort((a, b) => (str(a.start) < str(b.start) ? -1 : 1));
  return { events: out, unsupported };
}

// A coordinate HCP may or may not have filled in; null when missing or not a number.
const coord = (v: unknown) => { const n = v == null || v === "" ? NaN : Number(v); return isFinite(n) && n !== 0 ? n : null; };

function slimJob(j: Obj) {
  const sch = obj(j.schedule), cust = obj(j.customer), addr = obj(j.address);
  return {
    id: str(j.id),
    number: str(j.invoice_number),
    start: str(sch.scheduled_start),
    end: str(sch.scheduled_end),
    window: sch.arrival_window == null ? null : Number(sch.arrival_window),
    status: str(j.work_status),
    name: [cust.first_name, cust.last_name].map(str).filter(Boolean).join(" ") || str(cust.company),
    company: str(cust.company),
    // Street address for drive-time ranking. lat/lng are HCP's own when it has them.
    street: [addr.street, addr.street_line_2].map(str).filter(Boolean).join(" "),
    city: str(addr.city),
    state: str(addr.state),
    zip: str(addr.zip),
    lat: coord(addr.latitude),
    lng: coord(addr.longitude),
    // Job and customer tags (appliances, Business, Warranty, Return Visit, ...) drive the point count.
    tags: arr(j.tags).map(str).filter(Boolean),
    customer_tags: arr(cust.tags).map(str).filter(Boolean),
    desc: str(j.description).slice(0, 160),
    techs: arr(j.assigned_employees).map(techName).filter(Boolean),
    visit: 0,
  };
}

// Length of the calendar block in minutes (1-hour job = 60, 2-hour block = 120).
function blockMinutes(start: string, end: string) {
  const m = (+new Date(end) - +new Date(start)) / 60000;
  return isFinite(m) && m > 0 ? Math.round(m) : null;
}

// A job with several visits is listed once, spanning first visit to last. For
// those, fetch the visits so each one lands on its own day. Single-visit jobs
// (the usual case) cost no extra request.
async function jobVisits(j: Obj) {
  const base = slimJob(j);
  const span = +new Date(base.end) - +new Date(base.start);
  if (!(span > 864e5)) return [base];
  const r = await hcpGet(`/jobs/${encodeURIComponent(base.id)}/appointments`);
  const appts = arr(obj(r.body).appointments);
  if (r.status !== 200 || !appts.length) return [base];
  return appts.map((a, i) => {
    const o = obj(a);
    const ids = arr(o.dispatched_employees_ids).map(str);
    const techs = arr(j.assigned_employees).filter((e) => ids.includes(str(obj(e).id))).map(techName).filter(Boolean);
    return {
      ...base,
      start: str(o.start_time),
      end: str(o.end_time),
      window: o.arrival_window_minutes == null ? null : Number(o.arrival_window_minutes),
      techs: techs.length ? techs : base.techs,
      visit: i + 1,
    };
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...cors(origin), "Content-Type": "application/json" };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  if (!(await isStaff(req))) return reply(401, { error: "Sign in with a City Appliance staff account." });

  let payload: Obj = {};
  try { payload = obj(await req.json()); } catch { return reply(400, { error: "bad json" }); }

  const from = +new Date(str(payload.from)), to = +new Date(str(payload.to));
  if (isNaN(from) || isNaN(to) || to <= from) return reply(400, { error: "from and to must be ISO timestamps, with to after from" });
  if ((to - from) / 864e5 > MAX_RANGE_DAYS) return reply(400, { error: `range is limited to ${MAX_RANGE_DAYS} days` });

  // Every job whose schedule overlaps the range: starts before `to`, ends after `from`.
  const range = `scheduled_start_max=${encodeURIComponent(new Date(to).toISOString())}&scheduled_end_min=${encodeURIComponent(new Date(from).toISOString())}`;
  const [jobsRes, evRes] = await Promise.all([listAll(`/jobs?${range}&sort_direction=asc`, "jobs"), loadEvents()]);

  if (jobsRes.status !== 200) return reply(502, { error: "Housecall Pro returned " + jobsRes.status + " for jobs", hcp_status: jobsRes.status });

  const live = jobsRes.items.filter((j) => !j.deleted_at && !/cancel/i.test(str(j.work_status)));
  const visits = (await Promise.all(live.map(jobVisits))).flat();
  const jobs = visits
    .filter((j) => { const t = +new Date(j.start); return !isNaN(t) && t >= from && t < to; })
    .map((j) => ({ ...j, minutes: blockMinutes(j.start, j.end) }))
    .sort((a, b) => (a.start < b.start ? -1 : 1));

  // Calendar events are optional: the schedule still works if they cannot be read.
  const ev = evRes.status === 200 ? eventsInRange(evRes.items, from, to) : null;

  // How many jobs can be placed on a map without a lookup. Counts only, no customer data.
  const geo = { jobs: jobs.length, with_latlng: jobs.filter((j) => j.lat != null && j.lng != null).length, with_street: jobs.filter((j) => j.street).length };
  const addrKeys = Object.keys(obj((live[0] || {}).address)).sort().join(","); // field names only
  console.log(`geo coverage: ${geo.with_latlng}/${geo.jobs} jobs have HCP coordinates, ${geo.with_street}/${geo.jobs} have a street; address fields: ${addrKeys}`);

  return reply(200, {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    fetched_at: new Date().toISOString(),
    tz: DEFAULT_TZ,
    jobs,
    events: ev ? ev.events : null,
    events_status: evRes.status,
    events_unsupported_rules: ev ? ev.unsupported : 0,
    truncated: jobsRes.truncated || evRes.truncated,
    geo,
  });
});
