-- Parts desk v1. Additive only: new tables, functions and policies. No existing table is changed.
-- Applied to the Call-Coach-CA project on 2026-11-15.

create or replace function public.has_role(variadic roles text[])
returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = any(roles));
$$;
revoke execute on function public.has_role(text[]) from public, anon;
grant execute on function public.has_role(text[]) to authenticated;

-- Vendors -------------------------------------------------------------------
create table public.vendors (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  account_no text,
  return_days integer check (return_days is null or return_days >= 0),
  warranty_notes text,
  return_notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.vendors enable row level security;
create policy "vendors: staff and techs read" on public.vendors for select to authenticated using (public.has_role('csr','admin','tech'));
create policy "vendors: office adds" on public.vendors for insert to authenticated with check (public.has_role('csr','admin'));
create policy "vendors: office edits" on public.vendors for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "vendors: admin deletes" on public.vendors for delete to authenticated using (public.is_admin());
insert into public.vendors (name) values ('Marcone'),('Encompass'),('Reliable Parts'),('Appliance Parts Company'),('UED'),('Amazon');

-- Parts ---------------------------------------------------------------------
create sequence public.part_tag_seq start 1001;
grant usage, select on sequence public.part_tag_seq to authenticated;

create table public.parts (
  id uuid primary key default gen_random_uuid(),
  tag text not null unique default ('P' || lpad(nextval('public.part_tag_seq')::text, 5, '0')),
  job_number text not null,
  hcp_job_id text,
  customer_name text not null default '',
  appliance text not null default '',
  part_number text not null,
  description text not null default '',
  qty integer not null default 1 check (qty > 0),
  status text not null default 'need_to_order'
    check (status in ('need_to_order','ordered','backordered','shipped','received','installed','returned','credited','cancelled')),
  vendor_id uuid references public.vendors(id),
  po_number text,
  vendor_order_no text,
  tracking_number text,
  list_price numeric(10,2),
  cost numeric(10,2),
  sell_price numeric(10,2),
  eta date,
  ordered_on date,
  received_on date,
  return_by date,
  installed_on date,
  returned_on date,
  credited_on date,
  warranty_until date generated always as (installed_on + 365) stored,
  bin text,
  notes text,
  requested_by uuid references public.profiles(id),
  requested_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index parts_status_idx on public.parts (status);
create index parts_job_number_idx on public.parts (job_number);
create index parts_po_number_idx on public.parts (po_number);
create index parts_vendor_id_idx on public.parts (vendor_id);
create index parts_requested_by_idx on public.parts (requested_by);

alter table public.parts enable row level security;
create policy "parts: staff and techs read" on public.parts for select to authenticated using (public.has_role('csr','admin','tech'));
create policy "parts: staff and techs add" on public.parts for insert to authenticated with check (public.has_role('csr','admin','tech'));
create policy "parts: staff and techs edit" on public.parts for update to authenticated using (public.has_role('csr','admin','tech')) with check (public.has_role('csr','admin','tech'));
create policy "parts: admin deletes" on public.parts for delete to authenticated using (public.is_admin());

-- Technicians may request a part and mark it installed or not used. Everything about the order is office-only.
create or replace function public.parts_guard() returns trigger language plpgsql set search_path to 'public' as $$
declare office boolean;
begin
  if auth.uid() is null then return new; end if;  -- SQL editor or service role
  office := public.has_role('csr','admin');
  if tg_op = 'INSERT' then
    new.requested_by := auth.uid();
    select coalesce(nullif(display_name,''), email) into new.requested_by_name from public.profiles where id = auth.uid();
    if not office then
      new.status := 'need_to_order'; new.vendor_id := null; new.po_number := null; new.vendor_order_no := null;
      new.tracking_number := null; new.list_price := null; new.cost := null; new.sell_price := null; new.eta := null;
      new.ordered_on := null; new.received_on := null; new.return_by := null; new.credited_on := null;
    end if;
    return new;
  end if;
  if not office then
    if (new.job_number, new.hcp_job_id, new.customer_name, new.part_number, new.qty, new.vendor_id, new.po_number, new.vendor_order_no,
        new.tracking_number, new.list_price, new.cost, new.sell_price, new.eta, new.ordered_on, new.received_on, new.return_by, new.credited_on, new.tag)
       is distinct from
       (old.job_number, old.hcp_job_id, old.customer_name, old.part_number, old.qty, old.vendor_id, old.po_number, old.vendor_order_no,
        old.tracking_number, old.list_price, old.cost, old.sell_price, old.eta, old.ordered_on, old.received_on, old.return_by, old.credited_on, old.tag) then
      raise exception 'Only office staff can change order details on a part.';
    end if;
    if new.status is distinct from old.status and new.status not in ('installed','returned') then
      raise exception 'Technicians can only mark a part installed or not used.';
    end if;
  end if;
  return new;
end $$;
create trigger parts_guard before insert or update on public.parts for each row execute function public.parts_guard();
create trigger parts_touch before update on public.parts for each row execute function public.touch_updated_at();

-- History -------------------------------------------------------------------
create table public.part_events (
  id bigint generated always as identity primary key,
  part_id uuid not null references public.parts(id) on delete cascade,
  at timestamptz not null default now(),
  by_id uuid,
  by_name text,
  from_status text,
  to_status text not null,
  note text
);
create index part_events_part_id_idx on public.part_events (part_id);
alter table public.part_events enable row level security;
create policy "part_events: staff and techs read" on public.part_events for select to authenticated using (public.has_role('csr','admin','tech'));

create or replace function public.parts_log() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text;
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  insert into public.part_events (part_id, by_id, by_name, from_status, to_status)
  values (new.id, auth.uid(), who, case when tg_op = 'UPDATE' then old.status end, new.status);
  return new;
end $$;
revoke execute on function public.parts_log() from public, anon, authenticated;
revoke execute on function public.parts_guard() from public, anon, authenticated;
create trigger parts_log after insert or update on public.parts for each row execute function public.parts_log();
