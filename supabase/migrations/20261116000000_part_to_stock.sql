-- Move an unused job part from the Parts desk onto the shelf, in one step.
-- Adds one more part status ('stocked'), a link from a stock item back to the job part it came from,
-- and a function that does the whole move or none of it. Office only.
-- Applied to the Call-Coach-CA project on 2026-11-16.

alter table public.parts drop constraint parts_status_check;
alter table public.parts add constraint parts_status_check check (status = any (array[
  'need_to_order','ordered','backordered','shipped','received','installed','returned','credited','cancelled','stocked']));

alter table public.stock_items add column source_part_id uuid references public.parts(id) on delete set null;
create index stock_items_source_part_id_idx on public.stock_items (source_part_id);

create or replace function public.part_to_stock(p_part uuid, p_location uuid, p_purpose text default 'keep', p_bin text default null)
returns text[] language plpgsql set search_path to 'public' as $$
declare p public.parts; pn text; vend text; tags text[];
begin
  if not public.has_role('csr','admin') then raise exception 'Only office staff can move a job part into stock.'; end if;
  select * into p from public.parts where id = p_part for update;
  if not found then raise exception 'That part was not found.'; end if;
  if p.status not in ('received','returned') then
    raise exception 'Only a part that has been received and not installed can be moved into stock.';
  end if;
  pn := upper(btrim(p.part_number));
  select coalesce(nullif(p.vendor_other,''), v.name) into vend from public.vendors v where v.id = p.vendor_id;

  insert into public.stock_catalog (part_number, description) values (pn, coalesce(p.description,''))
  on conflict (part_number) do update set description = excluded.description where public.stock_catalog.description = '';

  with ins as (
    insert into public.stock_items (part_number, location_id, bin, purpose, cost, vendor, source_part_id, notes)
    select pn, p_location, nullif(btrim(coalesce(p_bin, p.bin, '')), ''), p_purpose, p.cost, vend, p.id,
           'From Parts desk tag ' || p.tag || ', ordered for job #' || p.job_number
    from generate_series(1, p.qty)
    returning tag)
  select array_agg(tag order by tag) into tags from ins;

  update public.parts set status = 'stocked' where id = p.id;
  return tags;
end $$;
revoke execute on function public.part_to_stock(uuid, uuid, text, text) from public, anon;
grant execute on function public.part_to_stock(uuid, uuid, text, text) to authenticated;
