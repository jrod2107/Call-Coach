-- Labels waiting to be printed. A part's tag is pending until someone marks its label printed.
-- Adding the column with a default stamps every part that already exists as printed; the default is then
-- dropped so new parts start as pending (null).
-- Applied to the live database on 2026-11-21 and tested as signed out, admin, office, technician, stock helper
-- and a no-role account (rolled back): everyone with a stock role can see pending parts; only admin, office and
-- the stock helper can mark labels printed; a technician is refused; signed out and no-role see nothing.
alter table public.stock_items add column label_printed_at timestamptz default now();
alter table public.stock_items alter column label_printed_at drop default;
create index stock_items_label_pending_idx on public.stock_items (created_at) where label_printed_at is null;

-- Same guard as before, with one more field a technician may not change.
create or replace function public.stock_items_guard() returns trigger language plpgsql set search_path to 'public' as $$
declare who text;
begin
  if auth.uid() is not null then
    select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  end if;
  if tg_op = 'INSERT' then
    if auth.uid() is not null then new.added_by := auth.uid(); new.added_by_name := who; end if;
  elsif auth.uid() is not null and not public.has_role('csr','admin','stock') then
    if (new.part_number, new.purpose, new.condition, new.cost, new.vendor, new.ebay_listed_on, new.ebay_price, new.sold_price, new.sold_on, new.tag, new.label_printed_at)
       is distinct from
       (old.part_number, old.purpose, old.condition, old.cost, old.vendor, old.ebay_listed_on, old.ebay_price, old.sold_price, old.sold_on, old.tag, old.label_printed_at) then
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
