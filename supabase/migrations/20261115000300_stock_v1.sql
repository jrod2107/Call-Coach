-- Stock v1. New tables, functions and policies, plus one more allowed role ('stock', the scan-in helper).
-- One row per physical part (stock_items). Four numbers per part number and location drive everything:
--   on hand = in_stock + held, held = set aside for a job, available = in_stock, on order = stock_plan.on_order.
--   Restock need = min_qty - (available + on_order). A held part counts as gone; a part already on order is not ordered twice.
-- Applied to the Call-Coach-CA project on 2026-11-15.

alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin','csr','tech','stock','pending']));

-- Locations -----------------------------------------------------------------
create table public.stock_locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  kind text not null default 'shop' check (kind in ('shop','truck')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.stock_locations enable row level security;
create policy "stock_locations: team reads" on public.stock_locations for select to authenticated using (public.has_role('csr','admin','tech','stock'));
create policy "stock_locations: office adds" on public.stock_locations for insert to authenticated with check (public.has_role('csr','admin'));
create policy "stock_locations: office edits" on public.stock_locations for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "stock_locations: admin deletes" on public.stock_locations for delete to authenticated using (public.is_admin());
insert into public.stock_locations (name, kind) values ('Shop shelf', 'shop');

-- Catalog: what a part number is. It fills itself in the first time a number is scanned. -------------
create table public.stock_catalog (
  part_number text primary key check (part_number = upper(btrim(part_number)) and part_number <> ''),
  description text not null default '',
  brand text not null default '',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.stock_catalog enable row level security;
create policy "stock_catalog: team reads" on public.stock_catalog for select to authenticated using (public.has_role('csr','admin','tech','stock'));
create policy "stock_catalog: team adds" on public.stock_catalog for insert to authenticated with check (public.has_role('csr','admin','tech','stock'));
create policy "stock_catalog: team edits" on public.stock_catalog for update to authenticated using (public.has_role('csr','admin','tech','stock')) with check (public.has_role('csr','admin','tech','stock'));
create policy "stock_catalog: admin deletes" on public.stock_catalog for delete to authenticated using (public.is_admin());
create trigger stock_catalog_touch before update on public.stock_catalog for each row execute function public.touch_updated_at();

-- Plan: the minimum to keep at each location, and how many are already on order. Office only. ---------
create table public.stock_plan (
  part_number text not null references public.stock_catalog(part_number) on update cascade on delete cascade,
  location_id uuid not null references public.stock_locations(id) on delete cascade,
  min_qty integer not null default 0 check (min_qty >= 0),
  on_order integer not null default 0 check (on_order >= 0),
  primary key (part_number, location_id)
);
create index stock_plan_location_id_idx on public.stock_plan (location_id);
alter table public.stock_plan enable row level security;
create policy "stock_plan: team reads" on public.stock_plan for select to authenticated using (public.has_role('csr','admin','tech','stock'));
create policy "stock_plan: office adds" on public.stock_plan for insert to authenticated with check (public.has_role('csr','admin'));
create policy "stock_plan: office edits" on public.stock_plan for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "stock_plan: office deletes" on public.stock_plan for delete to authenticated using (public.has_role('csr','admin'));

-- Items: one row per physical part -------------------------------------------
create sequence public.stock_tag_seq start 1001;
grant usage, select on sequence public.stock_tag_seq to authenticated;

create table public.stock_items (
  id uuid primary key default gen_random_uuid(),
  tag text not null unique default ('S' || lpad(nextval('public.stock_tag_seq')::text, 5, '0')),
  part_number text not null references public.stock_catalog(part_number) on update cascade,
  location_id uuid not null references public.stock_locations(id),
  bin text,
  purpose text not null default 'undecided' check (purpose in ('keep','ebay','undecided')),
  status text not null default 'in_stock' check (status in ('in_stock','held','used','sold','removed')),
  condition text not null default 'new' check (condition in ('new','open_box','used')),
  cost numeric(10,2) check (cost is null or cost >= 0),
  vendor text,
  held_job text,
  held_by uuid references public.profiles(id),
  held_by_name text,
  held_at timestamptz,
  used_job text,
  used_on date,
  ebay_listed_on date,
  ebay_price numeric(10,2),
  sold_price numeric(10,2),
  sold_on date,
  notes text,
  added_by uuid references public.profiles(id),
  added_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stock_items_part_number_idx on public.stock_items (part_number);
create index stock_items_location_id_idx on public.stock_items (location_id);
create index stock_items_status_idx on public.stock_items (status);
create index stock_items_held_by_idx on public.stock_items (held_by);
create index stock_items_added_by_idx on public.stock_items (added_by);

alter table public.stock_items enable row level security;
create policy "stock_items: team reads" on public.stock_items for select to authenticated using (public.has_role('csr','admin','tech','stock'));
create policy "stock_items: team adds" on public.stock_items for insert to authenticated with check (public.has_role('csr','admin','tech','stock'));
create policy "stock_items: team edits" on public.stock_items for update to authenticated using (public.has_role('csr','admin','tech','stock')) with check (public.has_role('csr','admin','tech','stock'));
create policy "stock_items: admin deletes" on public.stock_items for delete to authenticated using (public.is_admin());

-- Keeps the hold and use fields honest, and limits what a technician may change.
create or replace function public.stock_items_guard() returns trigger language plpgsql set search_path to 'public' as $$
declare who text;
begin
  if auth.uid() is not null then
    select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.added_by := auth.uid(); new.added_by_name := who; end if;
  elsif auth.uid() is not null and not public.has_role('csr','admin','stock') then
    if (new.part_number, new.purpose, new.condition, new.cost, new.vendor, new.ebay_listed_on, new.ebay_price, new.sold_price, new.sold_on, new.tag)
       is distinct from
       (old.part_number, old.purpose, old.condition, old.cost, old.vendor, old.ebay_listed_on, old.ebay_price, old.sold_price, old.sold_on, old.tag) then
      raise exception 'Technicians can hold, release, move and use stock, but not change what a part is or what it cost.';
    end if;
    if new.status is distinct from old.status and new.status not in ('in_stock','held','used') then
      raise exception 'Technicians can only hold, release or use a part.';
    end if;
  end if;

  if new.status = 'held' then
    if coalesce(btrim(new.held_job),'') = '' then raise exception 'A held part needs the job number it is held for.'; end if;
    if tg_op = 'INSERT' or old.status <> 'held' or new.held_job is distinct from old.held_job then
      new.held_at := now();
      if auth.uid() is not null then new.held_by := auth.uid(); new.held_by_name := who; end if;
    end if;
  else
    new.held_job := null; new.held_by := null; new.held_by_name := null; new.held_at := null;
  end if;
  if new.status = 'used' then
    if coalesce(btrim(new.used_job),'') = '' then raise exception 'A used part needs the job number it went on.'; end if;
    if new.used_on is null then new.used_on := current_date; end if;
  else
    new.used_job := null; new.used_on := null;
  end if;
  if new.status = 'sold' and new.sold_on is null then new.sold_on := current_date; end if;
  return new;
end $$;
create trigger stock_items_guard before insert or update on public.stock_items for each row execute function public.stock_items_guard();
create trigger stock_items_touch before update on public.stock_items for each row execute function public.touch_updated_at();

-- Journal: every movement ------------------------------------------------------
create table public.stock_events (
  id bigint generated always as identity primary key,
  item_id uuid not null references public.stock_items(id) on delete cascade,
  at timestamptz not null default now(),
  by_id uuid,
  by_name text,
  what text not null
);
create index stock_events_item_id_idx on public.stock_events (item_id);
alter table public.stock_events enable row level security;
create policy "stock_events: team reads" on public.stock_events for select to authenticated using (public.has_role('csr','admin','tech','stock'));

create or replace function public.stock_items_log() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text; loc text; msg text := '';
begin
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  select name into loc from public.stock_locations where id = new.location_id;
  if tg_op = 'INSERT' then
    msg := 'Added to ' || coalesce(loc,'stock');
    -- A part arriving at a location fills one unit of whatever was on order for it there.
    update public.stock_plan set on_order = on_order - 1
     where part_number = new.part_number and location_id = new.location_id and on_order > 0;
  else
    if new.status is distinct from old.status then
      msg := case new.status
        when 'held' then 'Held for job ' || new.held_job
        when 'used' then 'Used on job ' || new.used_job
        when 'sold' then 'Sold' || coalesce(' for $' || new.sold_price::text, '')
        when 'removed' then 'Removed from stock'
        else case old.status when 'held' then 'Hold released' else 'Back in stock' end end;
    elsif new.status = 'held' and new.held_job is distinct from old.held_job then
      msg := 'Hold moved to job ' || new.held_job;
    end if;
    if new.location_id is distinct from old.location_id then
      msg := msg || case when msg = '' then '' else '; ' end || 'Moved to ' || coalesce(loc,'another location');
    end if;
    if new.purpose is distinct from old.purpose then
      msg := msg || case when msg = '' then '' else '; ' end ||
        case new.purpose when 'keep' then 'Marked keep in stock' when 'ebay' then 'Marked sell on eBay' else 'Marked not decided' end;
    end if;
    if new.ebay_listed_on is distinct from old.ebay_listed_on and new.ebay_listed_on is not null then
      msg := msg || case when msg = '' then '' else '; ' end || 'Listed on eBay' || coalesce(' at $' || new.ebay_price::text, '');
    end if;
    if msg = '' then return new; end if;
  end if;
  insert into public.stock_events (item_id, by_id, by_name, what) values (new.id, auth.uid(), who, msg);
  return new;
end $$;
revoke execute on function public.stock_items_log() from public, anon, authenticated;
revoke execute on function public.stock_items_guard() from public, anon, authenticated;
create trigger stock_items_log after insert or update on public.stock_items for each row execute function public.stock_items_log();
