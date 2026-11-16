-- A requester (usually a tech who already checked a local vendor's stock) can suggest where to order a part from.
-- Two optional columns; nothing else changes. Applied to the Call-Coach-CA project on 2026-11-16.
-- suggested_vendor_id deliberately has NO foreign key: a second link from parts to vendors makes the API's
-- "parts with their vendor" lookup ambiguous, which stopped the Parts desk from loading.
alter table public.parts add column suggested_vendor_id uuid;
alter table public.parts add column suggested_note text;
create index parts_suggested_vendor_id_idx on public.parts (suggested_vendor_id);
