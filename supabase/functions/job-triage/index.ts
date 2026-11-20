import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Job triage with Claude: a short summary and a longer write-up for a job, parts worth bringing, and a
// back-and-forth conversation a technician can keep going from the job site.
//
// Three ways in:
//   { job_id }                     draft (or redo) the triage for one job
//   { job_id, message }            add to the conversation about that job and get an answer
//   { auto: true } + x-sync-token  from the database scheduler: draft triage for upcoming jobs that have none
//
// Who may call: a signed-in csr, admin or tech who can see that job. The job is read with the caller's own
// sign-in, so the database's rule (can_see_job, which also requires two-step sign-in) decides, not this file.
//
// What is sent to Claude: the job description, job type, tags, the unit and symptoms, the intake answers and
// the job notes with phone numbers and email addresses removed. Never the customer's name, address or phone.
//
// Spending limit: triage_settings.daily_limit answers a day across everyone; the scheduler drafts at most
// AUTO_BATCH jobs a run and only for jobs in the next AUTO_DAYS days.
//
// Secrets: ANTHROPIC_API_KEY (shared with invoice-read). TRIAGE_MODEL optional, default claude-sonnet-5-5.
// NOT YET DEPLOYED. Deploying is a live change and needs the owner's approval.

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const AUTO_BATCH = 6;
const AUTO_DAYS = 14;
const MAX_MESSAGE = 2000;
const HISTORY = 30;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = Record<string, unknown>;
const enc = encodeURIComponent;
const s = (v: unknown, max = 4000) => String(v ?? "").trim().slice(0, max);
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

async function rest(key: string, auth: string, path: string, init: RequestInit = {}): Promise<Row[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth}`, apikey: key, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`database ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}
const db = (path: string, init: RequestInit = {}) => rest(SERVICE, SERVICE, path, init);

// Phone numbers and email addresses are taken out of free text before it leaves for Claude.
const scrub = (t: string) => t
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email removed]")
  .replace(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone removed]");

function texts(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length > 60) return out;
  if (typeof v === "string") { if (v.trim()) out.push(v.trim()); }
  else if (Array.isArray(v)) v.forEach((x) => texts(x, out, depth + 1));
  else if (v && typeof v === "object") Object.values(v as Row).forEach((x) => texts(x, out, depth + 1));
  return out;
}

const DEFAULT_INSTRUCTIONS = `You help an appliance repair company get ready for service calls before the technician leaves the shop.
Work from the customer's description, the brand, the model and serial number when given, and anything the technician adds.
Be practical and brief. Rank the likely causes, most likely first. Say what to check first on site and which tools or meters to bring.
Suggest parts worth having on the truck only when the symptoms point to them clearly enough to justify the trip to the parts house.`;

const RULES = `Rules you always follow:
- Never invent a part number. Give a part number only when you are confident it fits this exact model; otherwise leave part_number empty and describe the part. People check every part number before ordering.
- If the model number is missing or looks wrong, say so, because parts cannot be confirmed without it.
- Mention safety where it matters (gas, sealed system, high voltage, microwave capacitors).
- Plain words and short sentences. No customer names or addresses.`;

const SHAPE = `Return ONLY a JSON object, no other text, in this shape:
{"summary":"two or three short sentences: the most likely cause and what to bring",
 "detail":"the longer write-up as plain text with short lines: likely causes in order, what to check first, tools, anything to ask the customer before the visit",
 "appliance":"","brand":"","model":"","serial":"",
 "parts":[{"part_number":"","description":"","qty":1,"why":""}]}
appliance, brand, model and serial: fill them in only when the job facts state them; otherwise empty strings.
parts: at most 5, most useful first; an empty list when nothing is worth bringing yet.`;

async function claude(system: string, messages: { role: string; content: string }[], maxTokens: number): Promise<string> {
  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: Deno.env.get("TRIAGE_MODEL") ?? "claude-sonnet-5-5", max_tokens: maxTokens, system, messages }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("anthropic", r.status, t.slice(0, 300));
    throw new Error(r.status === 429 ? "Claude is busy just now. Try again in a minute." : `Claude request failed (${r.status})`);
  }
  const data = await r.json();
  return (data.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").trim();
}

async function settings() {
  const rows = await db("triage_settings?id=eq.1&select=instructions,daily_limit");
  const row = rows[0] || {};
  return { instructions: s(row.instructions, 12000) || DEFAULT_INSTRUCTIONS, limit: Number(row.daily_limit ?? 300) };
}
async function usedToday(): Promise<number> {
  const since = new Date(Date.now() - 864e5).toISOString();
  const r = await fetch(`${SB_URL}/rest/v1/job_triage_messages?role=eq.assistant&created_at=gte.${enc(since)}&select=id`, {
    method: "HEAD", headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, Prefer: "count=exact" },
  });
  return Number((r.headers.get("content-range") || "").split("/")[1] || 0);
}

// Everything known about the job that is safe to send, as plain text.
async function facts(job: Row, tri: Row): Promise<string> {
  const [priv, intakes] = await Promise.all([
    db(`job_private?job_id=eq.${enc(String(job.id))}&select=notes`),
    job.hcp_job_id ? db(`intakes?hcp_job_id=eq.${enc(String(job.hcp_job_id))}&select=units,note&order=created_at&limit=3`) : Promise.resolve([]),
  ]);
  const notes = texts(priv[0]?.notes).join("\n");
  const intake = intakes.map((i) => texts([i.units, i.note]).join("; ")).filter(Boolean).join("\n");
  const lines = [
    `Job type: ${s(job.job_type, 200) || "not given"}`,
    `Tags: ${(Array.isArray(job.tags) ? job.tags : []).join(", ") || "none"}`,
    `Job description: ${s(job.description, 3000) || "none"}`,
    `Appliance: ${s(tri.appliance, 100) || "not recorded"}`,
    `Brand: ${s(tri.brand, 100) || "not recorded"}`,
    `Model number: ${s(tri.model, 100) || "not recorded"}`,
    `Serial number: ${s(tri.serial, 100) || "not recorded"}`,
    `Symptoms added by our team: ${s(tri.symptoms, 3000) || "none"}`,
    intake ? `Call intake answers:\n${intake.slice(0, 3000)}` : "",
    notes ? `Job notes:\n${notes.slice(0, 3000)}` : "",
  ];
  return scrub(lines.filter(Boolean).join("\n"));
}

async function triageRow(jobId: string): Promise<Row> {
  const rows = await db(`job_triage?job_id=eq.${enc(jobId)}&select=*`);
  if (rows[0]) return rows[0];
  const made = await db("job_triage", { method: "POST", headers: { Prefer: "return=representation,resolution=ignore-duplicates" }, body: JSON.stringify({ job_id: jobId }) });
  return made[0] || (await db(`job_triage?job_id=eq.${enc(jobId)}&select=*`))[0] || { job_id: jobId };
}
const history = async (jobId: string) =>
  (await db(`job_triage_messages?job_id=eq.${enc(jobId)}&select=role,author_name,body&order=id.desc&limit=${HISTORY}`)).reverse();
const say = (jobId: string, role: string, body: string, who?: { id: string; name: string }) =>
  db("job_triage_messages", { method: "POST", body: JSON.stringify({ job_id: jobId, role, body, author_id: who?.id ?? null, author_name: who?.name ?? null }) });

// Draft the triage for one job and save it. A redo takes the conversation so far into account.
async function draft(job: Row, cfg: { instructions: string }) {
  const jobId = String(job.id);
  const tri = await triageRow(jobId);
  const past = await history(jobId);
  const talk = past.filter((m) => m.role === "user").map((m) => `- ${s(m.body, 600)}`).join("\n");
  const user = `${await facts(job, tri)}${talk ? `\n\nOur team has added this since:\n${scrub(talk)}` : ""}\n\nTriage this job.`;
  const text = await claude(`${cfg.instructions}\n\n${RULES}\n\n${SHAPE}`, [{ role: "user", content: user }], 2000);
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude's answer could not be read. Try again.");
  let out: Row;
  try { out = JSON.parse(m[0]); } catch { throw new Error("Claude's answer could not be read. Try again."); }
  const patch: Row = { summary: s(out.summary, 1200), detail: s(out.detail, 8000), ai_at: new Date().toISOString() };
  // Only fill in the unit where nobody has typed it; a person's entry always wins.
  for (const k of ["appliance", "brand", "model", "serial"]) if (!s(tri[k]) && s(out[k], 100)) patch[k] = s(out[k], 100);
  await db(`job_triage?job_id=eq.${enc(jobId)}`, { method: "PATCH", body: JSON.stringify(patch) });
  // Replace Claude's earlier suggestions that nobody has decided on; leave people's and decided ones alone.
  await db(`job_triage_parts?job_id=eq.${enc(jobId)}&source=eq.ai&status=eq.suggested`, { method: "DELETE" });
  const parts = (Array.isArray(out.parts) ? out.parts : []).slice(0, 5).map((p) => p as Row)
    .filter((p) => s(p.description, 200))
    .map((p) => ({
      job_id: jobId, source: "ai", added_by_name: "Claude",
      part_number: s(p.part_number, 60).toUpperCase().replace(/\s/g, ""),
      description: s(p.description, 200), why: s(p.why, 400) || null,
      qty: Math.min(20, Math.max(1, Math.round(Number(p.qty) || 1))),
    }));
  if (parts.length) await db("job_triage_parts", { method: "POST", body: JSON.stringify(parts) });
  await say(jobId, "assistant", patch.summary as string);
  return { summary: patch.summary, parts: parts.length };
}

async function chat(job: Row, cfg: { instructions: string }, message: string, who: { id: string; name: string }) {
  const jobId = String(job.id);
  const tri = await triageRow(jobId);
  const past = await history(jobId);
  const system = `${cfg.instructions}\n\n${RULES}\n\nYou are talking with a technician or the service manager about one job, possibly while they stand in front of the appliance. Answer in a few short lines they can read on a phone. Ask one question at a time when you need more to go on.\n\nJob facts:\n${await facts(job, tri)}\n\nYour triage so far:\n${s(tri.detail, 6000) || s(tri.summary, 1200) || "none yet"}`;
  // Claude needs turns that start with the person and alternate; fold repeats together.
  const turns: { role: string; content: string }[] = [];
  for (const m of [...past, { role: "user", body: message }]) {
    const role = m.role === "assistant" ? "assistant" : "user", content = scrub(s(m.body, MAX_MESSAGE));
    if (!content || (!turns.length && role === "assistant")) continue;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content += "\n" + content; else turns.push({ role, content });
  }
  const reply = await claude(system, turns, 900);
  if (!reply) throw new Error("Claude gave no answer. Try again.");
  await say(jobId, "user", message, who);
  await say(jobId, "assistant", reply);
  return { reply };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: Row = {};
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }

  try {
    /* ---------- the scheduler ---------- */
    const token = req.headers.get("x-sync-token") || "";
    if (token) {
      const cfgRow = await db("collector_config?key=eq.triage_token&select=value");
      if (!cfgRow[0] || !same(token, String(cfgRow[0].value))) return json({ error: "Not allowed." }, 401);
      const cfg = await settings();
      let room = cfg.limit - (await usedToday());
      const now = new Date().toISOString(), until = new Date(Date.now() + AUTO_DAYS * 864e5).toISOString();
      const jobs = await db(`jobs?deleted_at=is.null&canceled_at=is.null&scheduled_start=gte.${enc(now)}&scheduled_start=lt.${enc(until)}&work_status=eq.scheduled&select=*&order=scheduled_start&limit=200`);
      const have = new Set((await db("job_triage?ai_at=not.is.null&select=job_id")).map((r) => String(r.job_id)));
      const todo = jobs.filter((j) => !have.has(String(j.id)) && (s(j.description) || s(j.job_type))).slice(0, AUTO_BATCH);
      let done = 0; const errors: string[] = [];
      for (const j of todo) {
        if (room <= 0) break;
        try { await draft(j, cfg); done++; room--; } catch (e) { errors.push(String((e as Error).message || e).slice(0, 120)); }
      }
      return json({ drafted: done, waiting: Math.max(0, jobs.filter((j) => !have.has(String(j.id))).length - done), errors });
    }

    /* ---------- a signed-in person ---------- */
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (!jwt.startsWith("eyJ")) return json({ error: "Sign in with a City Appliance staff account." }, 401);
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { Authorization: `Bearer ${jwt}`, apikey: ANON } });
    if (u.status !== 200) return json({ error: "Your sign-in has ended. Sign in again." }, 401);
    const uid = String(((await u.json()) as Row)?.id || "");
    const prof = uid ? (await db(`profiles?id=eq.${enc(uid)}&select=role,display_name,email`))[0] : null;
    if (!prof || !["csr", "admin", "tech"].includes(String(prof.role))) return json({ error: "This account cannot use triage." }, 403);

    const jobId = s(body.job_id, 40);
    if (!isUuid(jobId)) return json({ error: "Which job?" }, 400);
    // Read the job as the caller: row level security decides whether they may see it.
    const mine = await rest(ANON, jwt, `jobs?id=eq.${enc(jobId)}&select=*`);
    if (!mine[0]) return json({ error: "You do not have access to this job, or your two-step sign-in has run out." }, 403);

    const cfg = await settings();
    if ((await usedToday()) >= cfg.limit) return json({ error: "Today's limit for Claude answers has been reached. A manager can raise it on the Triage page." }, 429);

    const message = s(body.message, MAX_MESSAGE);
    const who = { id: uid, name: s(prof.display_name, 80) || s(prof.email, 80) };
    return json(message ? await chat(mine[0], cfg, message, who) : await draft(mine[0], cfg));
  } catch (e) {
    console.error("job-triage", e);
    return json({ error: String((e as Error).message || e).slice(0, 200) }, 502);
  }
});
