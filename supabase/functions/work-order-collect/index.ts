import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Collects work-order emails from the office mailbox and saves each one as a DRAFT work order for a person to review.
// Runs every 10 minutes from the database scheduler (see the *work_order_mail_collector migration). An admin can also
// run it from the Work orders page ("Check the mailbox now").
//
// What it does with each new email from a known sender (collector_config "senders"):
//   a new work order            -> draft work order, with the PDF attached        (work_order_mail outcome "draft")
//   one we already have         -> a note on the existing work order              ("duplicate")
//   a follow-up or status email -> a note on the work order it names, if we have it ("update"), otherwise "ignored"
//   could not be read 3 times   -> "error", shown on the Work orders page so someone enters it by hand
// It only reads mail. It never sends, moves or deletes anything in the mailbox, and it never follows links.
//
// Secrets:
//   MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET   the Microsoft 365 app registration (read access to one mailbox)
//   MS_MAILBOX                                     the mailbox address; several can be listed with commas
// Until those are set the function answers {configured:false} and does nothing.

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-collector-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const WHO = "Mail collector";
const PER_RUN = 5;        // emails read per run; the rest wait for the next run
const MAX_ATTEMPTS = 3;
const READABLE = ["application/pdf", "image/jpeg", "image/png", "image/webp"];

type Row = Record<string, unknown>;
async function db(path: string, init: RequestInit = {}): Promise<Row[]> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`database ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : [];
}
const enc = encodeURIComponent;
const same = (a: string, b: string) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const stripLinks = (s: string) => s.replace(/https?:\/\/\S+/gi, "[link removed]");
const clean = (v: unknown, max = 300) => String(v ?? "").trim().slice(0, max);
const orNull = (v: unknown, max = 300) => clean(v, max) || null;

async function config(): Promise<Record<string, string>> {
  const rows = await db("collector_config?select=key,value");
  return Object.fromEntries(rows.map((r) => [String(r.key), String(r.value)]));
}
const setConfig = (key: string, value: string) =>
  db("collector_config?on_conflict=key", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }) });

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

type Mail = {
  messageId: string; mailbox: string; from: string; fromName: string; subject: string; text: string; receivedAt: string;
  files: { name: string; media_type: string; data: string }[];
};
type Outcome = { outcome: string; detail?: string; work_order_id?: string | null; ref?: string };

async function logMail(m: Mail, o: Outcome, attempts = 1) {
  await db("work_order_mail?on_conflict=message_id", {
    method: "POST", headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ message_id: m.messageId, mailbox: m.mailbox, received_at: m.receivedAt, sender: m.from, subject: clean(stripLinks(m.subject)),
      outcome: o.outcome, detail: orNull(o.detail, 500), attempts, work_order_id: o.work_order_id ?? null }),
  });
}

// Finds a work order we already hold for this sender's number. A company name can be worded differently between
// two emails, so an earlier email from the same sending domain also counts as a match.
async function findWorkOrder(ref: string, name: string, domain: string): Promise<Row | null> {
  const rows = await db(`work_orders?source_ref=eq.${enc(ref)}&select=id,ref,source_name&order=created_at.asc&limit=20`);
  if (!rows.length) return null;
  const byName = name && rows.find((w) => String(w.source_name).trim().toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  const ids = rows.map((w) => `"${w.id}"`).join(",");
  const prior = await db(`work_order_mail?work_order_id=in.(${ids})&sender=ilike.${enc("*@" + domain)}&select=work_order_id&limit=1`);
  if (prior.length) return rows.find((w) => w.id === prior[0].work_order_id) ?? null;
  return !name && rows.length === 1 ? rows[0] : null;
}
const addNote = (id: unknown, note: string) =>
  db("work_order_events", { method: "POST", body: JSON.stringify({ work_order_id: id, kind: "note", note: note.slice(0, 600), by_name: WHO }) });

async function ingest(m: Mail, token: string): Promise<Outcome> {
  const text = stripLinks(m.text).slice(0, 55_000);
  const readable = m.files.filter((f) => READABLE.includes(f.media_type)).slice(0, 3);
  const r = await fetch(`${SB_URL}/functions/v1/work-order-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON, Authorization: `Bearer ${ANON}`, "x-collector-token": token },
    body: JSON.stringify({ text, subject: m.subject, files: readable.map((f) => ({ media_type: f.media_type, data: f.data })) }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.data) throw new Error(`reader ${r.status}: ${clean(j?.error, 160)}`);
  const d = j.data as Row;
  const domain = m.from.split("@")[1] || "";
  const ref = clean(d.source_ref, 80).replace(/^#/, "");
  const sender = m.fromName || domain;

  if (d.is_work_order === false) {
    const w = ref ? await findWorkOrder(ref, "", domain) : null;
    const summary = clean(d.summary, 400) || "Follow-up email";
    if (!w) return { outcome: "ignored", detail: summary };
    await addNote(w.id, `Email from ${sender}: ${summary}`);
    return { outcome: "update", detail: summary, work_order_id: String(w.id), ref: String(w.ref) };
  }

  const name = clean(d.source_name, 120) || sender || "Unknown sender";
  const existing = ref ? await findWorkOrder(ref, name, domain) : null;
  if (existing) {
    await addNote(existing.id, `The same work order arrived by email again from ${sender}. Nothing was changed.`);
    return { outcome: "duplicate", work_order_id: String(existing.id), ref: String(existing.ref) };
  }

  const contacts = (Array.isArray(d.contacts) ? d.contacts : []) as Row[];
  const c1 = contacts[0] || {}, c2 = contacts[1] || {};
  const unsure = (Array.isArray(d.unsure) ? d.unsure : []).map((x) => clean(x, 40)).filter(Boolean);
  const notes = [
    ...contacts.slice(1).map((c) => "Also on the work order: " + [c.name, c.phone, c.email].map((x) => clean(x, 120)).filter(Boolean).join(", ")),
    clean(d.availability, 400) ? "Availability they gave: " + clean(d.availability, 400) : "",
    clean(d.entry_notes, 400) ? "Entry: " + clean(d.entry_notes, 400) : "",
    unsure.length ? "The reader was not sure about: " + unsure.join(", ") + "." : "",
  ].filter(Boolean).join("\n");
  const nte = d.nte === null || d.nte === "" || d.nte === undefined ? null : Number(d.nte);
  const kind = ["property_manager", "warranty", "oem", "other"].includes(String(d.source_kind)) ? String(d.source_kind) : "property_manager";
  const portal = clean(d.portal, 60);
  const receivedOn = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago" }).format(new Date(m.receivedAt));

  const [w] = await db("work_orders", {
    method: "POST", headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      status: "draft", source_kind: kind, source_name: name, source_ref: ref || null,
      received_via: readable.some((f) => f.media_type === "application/pdf") ? "pdf" : "email", received_on: receivedOn,
      portal_note: portal ? `${portal}: update the work order there to get paid` : null,
      contact_name: clean(c1.name, 120), contact_phone: orNull(c1.phone, 40), contact_phone2: orNull(c2.phone, 40), contact_email: orNull(c1.email, 160),
      street: orNull(d.street, 160), unit: orNull(d.unit, 40), city: orNull(d.city, 80), zip: orNull(d.zip, 12),
      appliance: orNull(d.appliance, 120), issue: orNull(d.issue, 4000),
      original_text: [m.subject ? "Subject: " + stripLinks(m.subject) : "", text].filter(Boolean).join("\n\n").slice(0, 20_000) || null,
      nte: nte !== null && isFinite(nte) && nte >= 0 ? nte : null, notes: notes || null, created_by_name: WHO,
    }),
  });

  // Keep the original documents with the work order. A failed upload must not lose the work order itself.
  for (const f of m.files.slice(0, 4)) {
    try {
      const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const safe = f.name.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80) || "attachment";
      const path = `${w.id}/${Date.now()}-${safe}`;
      const up = await fetch(`${SB_URL}/storage/v1/object/work-orders/${path}`, {
        method: "POST", headers: { Authorization: `Bearer ${SERVICE}`, apikey: SERVICE, "Content-Type": f.media_type }, body: bytes,
      });
      if (!up.ok) throw new Error(`storage ${up.status}`);
      await db("work_order_files", { method: "POST", body: JSON.stringify({ work_order_id: w.id, path, name: f.name.slice(0, 160), size_bytes: bytes.length, uploaded_by_name: WHO }) });
    } catch (e) {
      console.error("attachment", (e as Error).message);
      await addNote(w.id, `An attachment (${f.name.slice(0, 80)}) could not be saved. Attach it by hand from the email.`);
    }
  }
  return { outcome: "draft", work_order_id: String(w.id), ref: String(w.ref) };
}

// Reads one email, with retries counted in work_order_mail. Returns false when the run should stop and try again later.
async function handle(m: Mail, token: string, tally: Record<string, number>): Promise<boolean> {
  const prior = await db(`work_order_mail?message_id=eq.${enc(m.messageId)}&select=attempts`);
  const attempts = (prior.length ? Number(prior[0].attempts) : 0) + 1;
  try {
    const o = await ingest(m, token);
    await logMail(m, o, attempts);
    tally[o.outcome] = (tally[o.outcome] || 0) + 1;
    return true;
  } catch (e) {
    console.error("ingest", (e as Error).message);
    await logMail(m, { outcome: "error", detail: (e as Error).message }, attempts);
    if (attempts >= MAX_ATTEMPTS) { tally.error = (tally.error || 0) + 1; return true; }
    return false;
  }
}

// ---------- Microsoft Graph (read only) ----------
async function graphToken(tenant: string, client: string, secret: string): Promise<string> {
  const r = await fetch(`https://login.microsoftonline.com/${enc(tenant)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client, client_secret: secret, grant_type: "client_credentials", scope: "https://graph.microsoft.com/.default" }),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j?.access_token) throw new Error(`Microsoft sign-in failed (${r.status}): ${clean(j?.error_description || j?.error, 200)}`);
  return j.access_token;
}
async function graph(token: string, path: string): Promise<Row> {
  const r = await fetch(`https://graph.microsoft.com/v1.0/${path}`, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.body-content-type="text"' } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error(`Microsoft Graph ${r.status}: ${clean((j?.error as Row)?.message || (j?.error as Row)?.code, 200)}`);
  return j as Row;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!SB_URL || !SERVICE) return json({ error: "Not configured" }, 500);

  let cfg: Record<string, string>;
  try { cfg = await config(); } catch (e) { return json({ error: (e as Error).message }, 500); }
  const sent = req.headers.get("x-collector-token") || "";
  const scheduled = !!sent && !!cfg.token && same(sent, cfg.token);
  const admin = !scheduled && (await isAdmin(req));
  if (!scheduled && !admin) return json({ error: "Not allowed." }, 401);

  const senders = (cfg.senders || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const known = (addr: string) => { const d = (addr.split("@")[1] || "").toLowerCase(); return !!d && senders.some((s) => d === s || d.endsWith("." + s)); };
  const body = await req.json().catch(() => ({})) as Row;
  const tally: Record<string, number> = {};

  // An admin can push one made-up email through the same path to test it, without touching the mailbox.
  if (admin && body.test) {
    const t = body.test as Row;
    const m: Mail = { messageId: `test-${crypto.randomUUID()}`, mailbox: "test", from: clean(t.from, 200).toLowerCase(), fromName: clean(t.fromName, 120),
      subject: clean(t.subject, 400), text: String(t.text || ""), receivedAt: new Date().toISOString(),
      files: (Array.isArray(t.files) ? t.files : []).map((f: Row) => ({ name: clean(f.name, 160) || "attachment.pdf", media_type: clean(f.media_type, 80), data: String(f.data || "") })) };
    if (!known(m.from)) return json({ test: true, skipped: "That sender is not on the list of work-order senders." });
    await handle(m, cfg.token, tally);
    return json({ test: true, tally });
  }

  const tenant = Deno.env.get("MS_TENANT_ID"), client = Deno.env.get("MS_CLIENT_ID"), secret = Deno.env.get("MS_CLIENT_SECRET");
  const boxes = (Deno.env.get("MS_MAILBOX") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!tenant || !client || !secret || !boxes.length) return json({ configured: false, message: "The mailbox connection is not set up yet." });

  try {
    const token = await graphToken(tenant, client, secret);
    let read = 0, seen = 0, more = false;
    for (const box of boxes) {
      const wmKey = `watermark:${box}`;
      const since = cfg[wmKey] || cfg.start_at || new Date().toISOString();
      const list = await graph(token, `users/${enc(box)}/messages?$select=id,internetMessageId,from,subject,receivedDateTime,hasAttachments,isDraft` +
        `&$filter=${enc(`receivedDateTime ge ${since}`)}&$orderby=${enc("receivedDateTime asc")}&$top=50`);
      const msgs = (list.value as Row[]) || [];
      let wm = since, stopped = false;
      for (const g of msgs) {
        seen++;
        const from = clean(((g.from as Row)?.emailAddress as Row)?.address, 200).toLowerCase();
        const mid = clean(g.internetMessageId, 400) || `graph-${g.id}`;
        if (!g.isDraft && known(from)) {
          const prior = await db(`work_order_mail?message_id=eq.${enc(mid)}&select=outcome,attempts`);
          const done = prior.length && (prior[0].outcome !== "error" || Number(prior[0].attempts) >= MAX_ATTEMPTS);
          if (!done) {
            if (read >= PER_RUN) { stopped = true; more = true; break; }
            const full = await graph(token, `users/${enc(box)}/messages/${enc(String(g.id))}?$select=subject,body,receivedDateTime`);
            const files: Mail["files"] = [];
            if (g.hasAttachments) {
              const att = await graph(token, `users/${enc(box)}/messages/${enc(String(g.id))}/attachments`);
              for (const a of ((att.value as Row[]) || [])) {
                const mt = clean(a.contentType, 80).toLowerCase();
                if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || a.isInline || !READABLE.includes(mt)) continue;
                if (!a.contentBytes || Number(a.size) > 9_000_000 || files.length >= 4) continue;
                files.push({ name: clean(a.name, 160) || "attachment", media_type: mt, data: String(a.contentBytes) });
              }
            }
            read++;
            const ok = await handle({ messageId: mid, mailbox: box, from, fromName: clean(((g.from as Row)?.emailAddress as Row)?.name, 120),
              subject: clean(full.subject, 400), text: String((full.body as Row)?.content || ""), receivedAt: String(full.receivedDateTime || g.receivedDateTime), files }, cfg.token, tally);
            if (!ok) { stopped = true; more = true; break; }
          }
        }
        wm = String(g.receivedDateTime);
      }
      if (wm !== since) await setConfig(wmKey, wm);
      if (!stopped && msgs.length === 50) more = true;
    }
    await setConfig("last_run", JSON.stringify({ at: new Date().toISOString(), ok: true }));
    return json({ configured: true, looked_at: seen, read, tally, more });
  } catch (e) {
    console.error("collect", (e as Error).message);
    await setConfig("last_run", JSON.stringify({ at: new Date().toISOString(), ok: false, error: (e as Error).message.slice(0, 300) })).catch(() => {});
    return json({ configured: true, error: (e as Error).message }, 502);
  }
});
