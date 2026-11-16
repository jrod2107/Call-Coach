-- Work orders: automatic collection from the office mailbox.
-- The work-order-collect function reads new mail from known senders (Buildium, AppFolio, Rentvine), has
-- work-order-read extract the fields, and saves each one as a DRAFT for a person to review. A draft is not a lead
-- until someone confirms it, and it still cannot be booked without an intake.
-- Applied to the Call-Coach-CA project on 2026-11-16.

alter table public.work_orders drop constraint work_orders_status_check;
alter table public.work_orders add constraint work_orders_status_check
  check (status in ('draft','new','contacting','booked','done','cancelled'));

-- One row per email the collector has looked at, so nothing is read twice and nothing is silently dropped.
create table public.work_order_mail (
  id bigint generated always as identity primary key,
  message_id text not null unique,
  mailbox text not null,
  received_at timestamptz,
  sender text,
  subject text,
  outcome text not null check (outcome in ('draft','duplicate','update','ignored','error')),
  detail text,
  attempts int not null default 1,
  work_order_id uuid references public.work_orders(id) on delete set null,
  created_at timestamptz not null default now()
);
create index work_order_mail_work_order_id_idx on public.work_order_mail (work_order_id);
alter table public.work_order_mail enable row level security;
-- Office can see what was collected or skipped. Only the collector (service role) writes.
create policy "work_order_mail: office reads" on public.work_order_mail for select to authenticated using (public.has_role('csr','admin'));

-- Collector settings. No policies on purpose: only the service role (the functions) and the scheduler can read it.
create table public.collector_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table public.collector_config enable row level security;
revoke all on public.collector_config from anon, authenticated;
insert into public.collector_config (key, value) values
  ('token', encode(extensions.gen_random_bytes(32), 'hex')),          -- shared by the scheduler and the functions
  ('senders', 'managebuilding.com,appfolio.us,rentvine.com'),          -- only mail from these domains is read
  ('start_at', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));  -- never reach back before this

-- History wording for drafts and for rows written by the collector.
create or replace function public.work_orders_log() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text; msg text := '';
begin
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  if auth.uid() is null then who := 'Mail collector'; end if;
  if tg_op = 'INSERT' then msg := case when new.status = 'draft' then 'Collected from email. Needs review' else 'Work order entered' end;
  else
    if new.status is distinct from old.status then
      msg := case when old.status = 'draft' and new.status = 'new' then 'Reviewed and confirmed'
        when new.status = 'contacting' then 'Contact started' when new.status = 'booked' then 'Booked: intake linked' || coalesce(', job #' || new.hcp_job_number, '')
        when new.status = 'done' then 'Closed' when new.status = 'cancelled' then 'Cancelled' else 'Reopened' end;
    end if;
    if new.approval is distinct from old.approval then
      msg := msg || case when msg = '' then '' else '; ' end || 'Approval: ' || replace(new.approval, '_', ' ') || coalesce(' $' || new.approval_amount::text, '');
    end if;
    if new.invoice_sent_on is distinct from old.invoice_sent_on and new.invoice_sent_on is not null then
      msg := msg || case when msg = '' then '' else '; ' end || 'Invoice sent' || coalesce(' $' || new.invoice_amount::text, '');
    end if;
    if new.paid_on is distinct from old.paid_on and new.paid_on is not null then
      msg := msg || case when msg = '' then '' else '; ' end || 'Paid';
    end if;
    if new.portal_updated is distinct from old.portal_updated and new.portal_updated then
      msg := msg || case when msg = '' then '' else '; ' end || 'Their portal updated';
    end if;
    if msg = '' then return new; end if;
  end if;
  insert into public.work_order_events (work_order_id, by_id, by_name, kind, note) values (new.id, auth.uid(), who, 'status', msg);
  return new;
end $$;
revoke execute on function public.work_orders_log() from public, anon, authenticated;

-- Check the mailbox every 10 minutes. Until the Microsoft 365 secrets are set on the function it answers
-- "not set up" and does nothing.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
select cron.schedule('work-order-collect', '*/10 * * * *', $job$
  select net.http_post(
    url := 'https://skwgnvxjwfrkgzxrdfhe.supabase.co/functions/v1/work-order-collect',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-collector-token', (select value from public.collector_config where key = 'token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 140000);
$job$);
