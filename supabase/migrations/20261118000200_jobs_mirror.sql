-- Jobs: a read-only mirror of Housecall Pro jobs, the first step toward the site owning the job record.
-- Housecall Pro stays the source of truth. The jobs-sync function copies jobs in every 10 minutes; nothing here writes back.
--
-- Security, because this is the first full copy of customer data in the site:
--   * Reading jobs requires a session that passed two-step sign-in (aal2).
--   * Office roles see every job. A senior technician sees every job. A regular technician sees only jobs
--     assigned to them in Housecall Pro, from 2 days back to 5 days ahead.
--   * Phone, email, street address and job notes live in job_private, which no signed-in user can read directly.
--     They come only through job_details(), which checks the same rules and writes a row to access_log.
--   * access_log is readable by admins only and cannot be written or changed by any signed-in user.
-- Applied to the Call-Coach-CA project on 2026-11-18.

alter table public.profiles add column senior boolean not null default false;      -- senior technician: sees all jobs
alter table public.profiles add column hcp_employee_id text;                       -- this person's Housecall Pro employee id

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  hcp_job_id text not null unique,
  job_number text,
  description text,
  work_status text,
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  arrival_window integer,
  on_my_way_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  tech_hcp_ids text[] not null default '{}',
  tech_names text[] not null default '{}',
  tags text[] not null default '{}',
  business_unit text,
  job_type text,
  lead_source text,
  total_cents integer,
  balance_cents integer,
  customer_hcp_id text,
  customer_name text,
  city text,
  zip text,
  hcp_created_at timestamptz,
  hcp_updated_at timestamptz,
  canceled_at timestamptz,
  deleted_at timestamptz,
  synced_at timestamptz not null default now()
);
create index jobs_scheduled_start_idx on public.jobs (scheduled_start);
create index jobs_job_number_idx on public.jobs (job_number);
create index jobs_customer_hcp_id_idx on public.jobs (customer_hcp_id);

create table public.job_private (
  job_id uuid primary key references public.jobs(id) on delete cascade,
  phone_mobile text,
  phone_home text,
  phone_work text,
  email text,
  street text,
  street2 text,
  state text,
  lat double precision,
  lng double precision,
  notes jsonb not null default '[]'
);

create table public.access_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id uuid,
  user_name text,
  action text not null,
  job_id uuid,
  job_number text,
  customer_name text
);
create index access_log_at_idx on public.access_log (at desc);

create or replace function public.is_aal2() returns boolean
 language sql stable set search_path to 'public'
as $$ select coalesce((auth.jwt() ->> 'aal') = 'aal2', false); $$;

-- May the signed-in user see this job? One rule, used by the table policy and by job_details().
create or replace function public.can_see_job(j public.jobs) returns boolean
 language sql stable security definer set search_path to 'public'
as $$
  select public.is_aal2() and exists (
    select 1 from public.profiles p where p.id = auth.uid() and (
      p.role in ('csr','admin')
      or (p.role = 'tech' and p.senior)
      or (p.role = 'tech' and p.hcp_employee_id is not null and p.hcp_employee_id = any(j.tech_hcp_ids)
          and j.scheduled_start >= now() - interval '2 days' and j.scheduled_start < now() + interval '5 days')));
$$;
revoke execute on function public.can_see_job(public.jobs) from public, anon;
grant execute on function public.can_see_job(public.jobs) to authenticated, service_role;

alter table public.jobs enable row level security;
alter table public.job_private enable row level security;
alter table public.access_log enable row level security;
create policy "jobs: staff read what they may see" on public.jobs for select to authenticated using (public.can_see_job(jobs));
create policy "access_log: admin reads" on public.access_log for select to authenticated using (public.is_admin());
-- job_private has no policies on purpose: only the sync (service role) and job_details() touch it.

-- Contact details and notes for one job. Checks access, records who looked, then returns the details.
create or replace function public.job_details(p_job uuid) returns jsonb
 language plpgsql security definer set search_path to 'public'
as $$
declare j public.jobs; d public.job_private; who text;
begin
  select * into j from public.jobs where id = p_job;
  if not found or not public.can_see_job(j) then raise exception 'You do not have access to this job.'; end if;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  insert into public.access_log (user_id, user_name, action, job_id, job_number, customer_name)
    values (auth.uid(), who, 'viewed contact details', j.id, j.job_number, j.customer_name);
  select * into d from public.job_private where job_id = p_job;
  return coalesce(to_jsonb(d), '{}'::jsonb);
end $$;
revoke execute on function public.job_details(uuid) from public, anon;
grant execute on function public.job_details(uuid) to authenticated;

-- A separate secret for the scheduler to call jobs-sync with (same table the mail collector uses; no user can read it).
insert into public.collector_config (key, value) values ('jobs_sync_token', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
  on conflict (key) do nothing;

select cron.schedule('jobs-sync', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://skwgnvxjwfrkgzxrdfhe.supabase.co/functions/v1/jobs-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-token', (select value from public.collector_config where key = 'jobs_sync_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000);
$job$);
