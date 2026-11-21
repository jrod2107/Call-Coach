-- Service zones: the areas the company drives to, each with its own diagnostic fee.
-- Applied 2026-11-20 with the owner's approval.
--
-- The zones come from the owner's own Google map of service areas. Each row is one shape on that map:
-- a name, the diagnostic fee for that area, the days the area is normally served, and the outline as a list
-- of [longitude, latitude] points. The rows themselves are loaded straight into the database and are not in
-- this file, because fees are kept out of the public repository.
-- Where zones overlap, the page uses the lowest fee (the inner areas are the cheaper ones).
-- No customer data.

create table public.service_zones (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 60),
  fee numeric(10,2) not null check (fee >= 0),
  days text not null default '',
  boundary jsonb not null default '[]'::jsonb check (jsonb_typeof(boundary) = 'array'),
  sort integer not null default 0,
  active boolean not null default true,
  updated_at timestamptz not null default now()
);
alter table public.service_zones enable row level security;
create policy "service zones: staff read" on public.service_zones for select to authenticated
  using (public.has_role('csr', 'admin', 'tech'));
create policy "service zones: admins add" on public.service_zones for insert to authenticated with check (public.is_admin());
create policy "service zones: admins edit" on public.service_zones for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "service zones: admins delete" on public.service_zones for delete to authenticated using (public.is_admin());
create trigger service_zones_touch before update on public.service_zones
  for each row execute function public.touch_updated_at();

revoke all on public.service_zones from anon;
