-- Job triage: going through a job before the visit so the right parts are on the truck.
--
-- One triage record per job: the unit (brand, model, serial), the symptoms, Claude's short summary and longer
-- write-up, and whether a person has gone through it. A job counts as triaged only when a person says so;
-- Claude's write-up is a draft that makes that review quick.
--
-- Parts that triage suggests wait for a sign-off by a manager or senior technician. Signing off creates the
-- part on the Parts desk as "need to order", so the Parts desk stays the one list of parts to buy.
--
-- Security:
--   * Every row hangs off a job, and every read uses can_see_job(): office and senior technicians see all,
--     a regular technician sees only their own jobs in their date window, and two-step sign-in is required.
--   * Any of those people may fill in the unit and symptoms, suggest a part, and mark a job triaged.
--   * Only a manager, admin or senior technician can sign off a suggested part (triage_sign_off()).
--     (Widened to any technician by 20261120000100_triage_sign_off_all_techs.sql.)
--   * The conversation with Claude is written only by the job-triage function, never straight from a page.
--   * Managers alone can change the instructions Claude is given.
-- Applied to the Call-Coach-CA project on 2026-11-19.

create or replace function public.can_see_job_id(p_job uuid) returns boolean
 language sql stable security definer set search_path to 'public'
as $$ select exists (select 1 from public.jobs j where j.id = p_job and public.can_see_job(j)); $$;
revoke execute on function public.can_see_job_id(uuid) from public, anon;
grant execute on function public.can_see_job_id(uuid) to authenticated, service_role;

-- May the signed-in user sign off parts? Managers, admins and senior technicians.
create or replace function public.can_sign_off_parts() returns boolean
 language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from public.profiles where id = auth.uid()
    and (role = 'admin' or (role = 'csr' and manager) or (role = 'tech' and senior)));
$$;
revoke execute on function public.can_sign_off_parts() from public, anon;
grant execute on function public.can_sign_off_parts() to authenticated, service_role;

create table public.job_triage (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  status text not null default 'needs' check (status in ('needs','triaged')),
  -- The person's call when they mark it triaged: no parts needed, parts needed, or cannot tell before the visit.
  parts_call text check (parts_call in ('none','needed','unsure')),
  appliance text,
  brand text,
  model text,
  serial text,
  symptoms text,
  summary text,          -- Claude's two or three lines
  detail text,           -- Claude's longer write-up
  ai_at timestamptz,     -- when Claude last wrote the summary
  triaged_by uuid references public.profiles(id),
  triaged_by_name text,
  triaged_at timestamptz,
  updated_at timestamptz not null default now()
);

create table public.job_triage_parts (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  part_number text not null default '',     -- may be empty when only the kind of part is known
  description text not null,
  qty integer not null default 1 check (qty > 0),
  why text,
  source text not null default 'person' check (source in ('ai','person')),
  status text not null default 'suggested' check (status in ('suggested','approved','declined')),
  added_by uuid references public.profiles(id),
  added_by_name text,
  decided_by uuid references public.profiles(id),
  decided_by_name text,
  decided_at timestamptz,
  part_id uuid references public.parts(id) on delete set null,   -- the Parts desk row made by the sign-off
  created_at timestamptz not null default now()
);
create index job_triage_parts_job_idx on public.job_triage_parts (job_id);
create index job_triage_parts_status_idx on public.job_triage_parts (status);

create table public.job_triage_messages (
  id bigint generated always as identity primary key,
  job_id uuid not null references public.jobs(id) on delete cascade,
  role text not null check (role in ('user','assistant')),
  author_id uuid,
  author_name text,
  body text not null,
  created_at timestamptz not null default now()
);
create index job_triage_messages_job_idx on public.job_triage_messages (job_id, id);
create index job_triage_messages_at_idx on public.job_triage_messages (created_at);

-- One row: what Claude is told, and the most answers it may give in a day (a spending limit).
create table public.triage_settings (
  id integer primary key default 1 check (id = 1),
  instructions text not null default '',
  daily_limit integer not null default 300 check (daily_limit between 0 and 5000),
  updated_at timestamptz not null default now()
);
insert into public.triage_settings (id) values (1);

alter table public.job_triage enable row level security;
alter table public.job_triage_parts enable row level security;
alter table public.job_triage_messages enable row level security;
alter table public.triage_settings enable row level security;

create policy "job_triage: read with the job" on public.job_triage for select to authenticated using (public.can_see_job_id(job_id));
create policy "job_triage: add with the job" on public.job_triage for insert to authenticated with check (public.can_see_job_id(job_id));
create policy "job_triage: edit with the job" on public.job_triage for update to authenticated using (public.can_see_job_id(job_id)) with check (public.can_see_job_id(job_id));

create policy "job_triage_parts: read with the job" on public.job_triage_parts for select to authenticated using (public.can_see_job_id(job_id));
create policy "job_triage_parts: suggest with the job" on public.job_triage_parts for insert to authenticated with check (public.can_see_job_id(job_id));
-- No update or delete policy: decisions go through triage_sign_off() and triage_decline().

create policy "job_triage_messages: read with the job" on public.job_triage_messages for select to authenticated using (public.can_see_job_id(job_id));
-- No insert policy: only the job-triage function (service role) writes the conversation.

create policy "triage_settings: staff read" on public.triage_settings for select to authenticated using (public.has_role('csr','admin','tech'));
create policy "triage_settings: managers edit" on public.triage_settings for update to authenticated using (public.is_manager()) with check (public.is_manager());

-- A page cannot put words in Claude's mouth or sign for someone else: these fields are set here, not by the page.
create or replace function public.job_triage_guard() returns trigger language plpgsql set search_path to 'public' as $$
declare who text;
begin
  new.updated_at := now();
  if auth.uid() is null then return new; end if;  -- SQL editor or the job-triage function (service role)
  if tg_op = 'INSERT' then
    new.summary := null; new.detail := null; new.ai_at := null;
  else
    new.summary := old.summary; new.detail := old.detail; new.ai_at := old.ai_at;
  end if;
  if new.status = 'triaged' and (tg_op = 'INSERT' or old.status is distinct from 'triaged') then
    if new.parts_call is null then raise exception 'Say whether the job needs parts before marking it triaged.'; end if;
    select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
    new.triaged_by := auth.uid(); new.triaged_by_name := who; new.triaged_at := now();
  elsif new.status = 'needs' then
    new.triaged_by := null; new.triaged_by_name := null; new.triaged_at := null;
  elsif tg_op = 'UPDATE' then
    new.triaged_by := old.triaged_by; new.triaged_by_name := old.triaged_by_name; new.triaged_at := old.triaged_at;
  end if;
  return new;
end $$;
create trigger job_triage_guard before insert or update on public.job_triage for each row execute function public.job_triage_guard();

create or replace function public.job_triage_parts_guard() returns trigger language plpgsql set search_path to 'public' as $$
begin
  if auth.uid() is null then return new; end if;
  new.source := 'person'; new.status := 'suggested'; new.part_id := null;
  new.decided_by := null; new.decided_by_name := null; new.decided_at := null;
  new.added_by := auth.uid();
  select coalesce(nullif(display_name,''), email) into new.added_by_name from public.profiles where id = auth.uid();
  new.part_number := upper(regexp_replace(coalesce(new.part_number,''), '\s', '', 'g'));
  return new;
end $$;
create trigger job_triage_parts_guard before insert on public.job_triage_parts for each row execute function public.job_triage_parts_guard();

-- Sign off a suggested part: it becomes a "need to order" part on the Parts desk.
-- The part number can be corrected at sign-off, since a suggestion may only name the kind of part.
create or replace function public.triage_sign_off(p_id uuid, p_part_number text default null, p_qty integer default null) returns uuid
 language plpgsql security definer set search_path to 'public'
as $$
declare s public.job_triage_parts; j public.jobs; t public.job_triage; who text; pn text; new_part uuid;
begin
  if not public.can_sign_off_parts() then raise exception 'Only a manager or senior technician can sign off parts.'; end if;
  select * into s from public.job_triage_parts where id = p_id for update;
  if not found or not public.can_see_job_id(s.job_id) then raise exception 'You do not have access to this job.'; end if;
  if s.status <> 'suggested' then raise exception 'This part was already decided.'; end if;
  select * into j from public.jobs where id = s.job_id;
  if coalesce(j.job_number,'') = '' then raise exception 'This job has no job number yet, so the part cannot go to the Parts desk.'; end if;
  pn := upper(regexp_replace(coalesce(nullif(p_part_number,''), s.part_number, ''), '\s', '', 'g'));
  if pn = '' then raise exception 'Type the part number before signing off.'; end if;
  select * into t from public.job_triage where job_id = s.job_id;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  insert into public.parts (job_number, hcp_job_id, customer_name, appliance, part_number, description, qty, notes)
    values (j.job_number, j.hcp_job_id, coalesce(j.customer_name,''), coalesce(t.appliance,''), pn, s.description,
            coalesce(p_qty, s.qty), 'From triage' || coalesce(': ' || nullif(s.why,''), ''))
    returning id into new_part;
  update public.job_triage_parts set status = 'approved', part_number = pn, qty = coalesce(p_qty, s.qty),
    decided_by = auth.uid(), decided_by_name = who, decided_at = now(), part_id = new_part where id = p_id;
  return new_part;
end $$;
revoke execute on function public.triage_sign_off(uuid, text, integer) from public, anon;
grant execute on function public.triage_sign_off(uuid, text, integer) to authenticated;

-- Turn a suggestion down. The person who suggested it may withdraw their own; otherwise it takes a signer.
create or replace function public.triage_decline(p_id uuid) returns void
 language plpgsql security definer set search_path to 'public'
as $$
declare s public.job_triage_parts; who text;
begin
  select * into s from public.job_triage_parts where id = p_id for update;
  if not found or not public.can_see_job_id(s.job_id) then raise exception 'You do not have access to this job.'; end if;
  if s.status <> 'suggested' then raise exception 'This part was already decided.'; end if;
  if not (public.can_sign_off_parts() or s.added_by = auth.uid()) then
    raise exception 'Only a manager or senior technician can turn down a part someone else suggested.';
  end if;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  update public.job_triage_parts set status = 'declined', decided_by = auth.uid(), decided_by_name = who, decided_at = now() where id = p_id;
end $$;
revoke execute on function public.triage_decline(uuid) from public, anon;
grant execute on function public.triage_decline(uuid) to authenticated;

-- A separate secret so the scheduler can ask the job-triage function to draft triage for new jobs.
insert into public.collector_config (key, value) values ('triage_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;

-- Every 30 minutes: draft triage for upcoming jobs that have none yet (a few at a time; see the function).
select cron.schedule('job-triage-auto', '7,37 * * * *', $job$
  select net.http_post(
    url := 'https://skwgnvxjwfrkgzxrdfhe.supabase.co/functions/v1/job-triage',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-token', (select value from public.collector_config where key = 'triage_token')),
    body := '{"auto":true}'::jsonb,
    timeout_milliseconds := 120000);
$job$);
