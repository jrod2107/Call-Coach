-- Work orders v1: jobs sent to us by warranty companies, property managers and manufacturers.
-- A work order starts as a lead. It can only become "booked" by linking the intake a CSR completed for it,
-- so the intake guide is never skipped. The same row then tracks approval, invoice and payment.
-- Office (csr, admin) only: these rows hold customer and tenant details.
-- Applied to the Call-Coach-CA project on 2026-11-16.

create sequence public.work_order_ref_seq start 1001;
grant usage, select on sequence public.work_order_ref_seq to authenticated;

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique default ('W' || lpad(nextval('public.work_order_ref_seq')::text, 5, '0')),
  source_kind text not null default 'property_manager' check (source_kind in ('warranty','property_manager','oem','other')),
  source_name text not null check (btrim(source_name) <> ''),
  source_ref text,
  received_via text not null default 'email' check (received_via in ('email','pdf','portal','phone','other')),
  received_on date not null default current_date,
  portal_note text,
  contact_name text not null default '',
  contact_phone text,
  contact_phone2 text,
  contact_email text,
  street text,
  unit text,
  city text,
  zip text,
  appliance text,
  issue text,
  original_text text,
  nte numeric(10,2) check (nte is null or nte >= 0),
  status text not null default 'new' check (status in ('new','contacting','booked','done','cancelled')),
  intake_id uuid unique references public.intakes(id) on delete set null,
  hcp_job_number text,
  approval text not null default 'not_needed' check (approval in ('not_needed','needed','requested','approved','denied')),
  approval_amount numeric(10,2),
  invoice_number text,
  invoice_amount numeric(10,2),
  invoice_sent_on date,
  paid_on date,
  portal_updated boolean not null default false,
  notes text,
  created_by uuid references public.profiles(id),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The rule the whole tool exists for: no booking without a completed intake.
  constraint work_orders_booked_needs_intake check (status not in ('booked','done') or intake_id is not null)
);
create index work_orders_status_idx on public.work_orders (status);
create index work_orders_created_by_idx on public.work_orders (created_by);

alter table public.work_orders enable row level security;
create policy "work_orders: office reads" on public.work_orders for select to authenticated using (public.has_role('csr','admin'));
create policy "work_orders: office adds" on public.work_orders for insert to authenticated with check (public.has_role('csr','admin'));
create policy "work_orders: office edits" on public.work_orders for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "work_orders: admin deletes" on public.work_orders for delete to authenticated using (public.is_admin());
create trigger work_orders_touch before update on public.work_orders for each row execute function public.touch_updated_at();

-- Activity: contact attempts, notes and status changes ---------------------------
create table public.work_order_events (
  id bigint generated always as identity primary key,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  at timestamptz not null default now(),
  by_id uuid,
  by_name text,
  kind text not null default 'note' check (kind in ('call','voicemail','text','email','note','status')),
  note text
);
create index work_order_events_work_order_id_idx on public.work_order_events (work_order_id);
alter table public.work_order_events enable row level security;
create policy "work_order_events: office reads" on public.work_order_events for select to authenticated using (public.has_role('csr','admin'));
create policy "work_order_events: office adds" on public.work_order_events for insert to authenticated with check (public.has_role('csr','admin'));

create or replace function public.work_order_stamp() returns trigger language plpgsql set search_path to 'public' as $$
declare who text;
begin
  if auth.uid() is null then return new; end if;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  if tg_table_name = 'work_orders' then new.created_by := auth.uid(); new.created_by_name := who;
  else new.by_id := auth.uid(); new.by_name := who; end if;
  return new;
end $$;
create trigger work_orders_stamp before insert on public.work_orders for each row execute function public.work_order_stamp();
create trigger work_order_events_stamp before insert on public.work_order_events for each row execute function public.work_order_stamp();

create or replace function public.work_orders_log() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text; msg text := '';
begin
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  if tg_op = 'INSERT' then msg := 'Work order entered';
  else
    if new.status is distinct from old.status then
      msg := case new.status when 'contacting' then 'Contact started' when 'booked' then 'Booked: intake linked' || coalesce(', job #' || new.hcp_job_number, '')
        when 'done' then 'Closed' when 'cancelled' then 'Cancelled' else 'Reopened' end;
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
revoke execute on function public.work_order_stamp() from public, anon, authenticated;
create trigger work_orders_log after insert or update on public.work_orders for each row execute function public.work_orders_log();

-- Files: the original email PDF or work order document ------------------------------
create table public.work_order_files (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  path text not null unique,
  name text not null,
  size_bytes bigint,
  uploaded_by_name text,
  created_at timestamptz not null default now()
);
create index work_order_files_work_order_id_idx on public.work_order_files (work_order_id);
alter table public.work_order_files enable row level security;
create policy "work_order_files: office reads" on public.work_order_files for select to authenticated using (public.has_role('csr','admin'));
create policy "work_order_files: office adds" on public.work_order_files for insert to authenticated with check (public.has_role('csr','admin'));
create policy "work_order_files: admin deletes" on public.work_order_files for delete to authenticated using (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit) values ('work-orders', 'work-orders', false, 15728640);
create policy "work-orders files: office reads" on storage.objects for select to authenticated using (bucket_id = 'work-orders' and public.has_role('csr','admin'));
create policy "work-orders files: office adds" on storage.objects for insert to authenticated with check (bucket_id = 'work-orders' and public.has_role('csr','admin'));
create policy "work-orders files: admin deletes" on storage.objects for delete to authenticated using (bucket_id = 'work-orders' and public.is_admin());
