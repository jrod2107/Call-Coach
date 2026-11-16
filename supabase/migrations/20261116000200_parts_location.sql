-- Where a received job part is sitting: the shop shelf or one of the trucks (same list Stock uses).
-- Optional. Anyone on the team may set it; the parts_guard trigger does not restrict this column.
-- Applied to the Call-Coach-CA project on 2026-11-16.
alter table public.parts add column location_id uuid references public.stock_locations(id);
create index parts_location_id_idx on public.parts (location_id);
