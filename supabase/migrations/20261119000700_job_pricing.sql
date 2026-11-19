-- Job pricing v1: labor levels and the settings the Job pricing calculator needs.
-- Applied 2026-11-19 with the owner's approval. Labor levels and the tax rate are entered by an admin on the page.
--
-- A job price = service charge (pricing_models) + one labor level + parts (existing part pricing rule).
-- Labor levels are a few named prices per appliance class, typed in by an admin. They are the company's own
-- numbers: nothing is copied from the Blue Book.
-- The calculator saves nothing, so there is no customer data in these tables.

create table public.labor_tiers (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.pricing_models (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 60),
  price numeric(10,2) not null check (price >= 0),
  sort integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (model_id, name)
);
alter table public.labor_tiers enable row level security;
create policy "labor tiers: staff read" on public.labor_tiers for select to authenticated
  using (public.has_role('csr', 'admin', 'tech'));
create policy "labor tiers: admins add" on public.labor_tiers for insert to authenticated with check (public.is_admin());
create policy "labor tiers: admins edit" on public.labor_tiers for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "labor tiers: admins delete" on public.labor_tiers for delete to authenticated using (public.is_admin());
create trigger labor_tiers_touch before update on public.labor_tiers
  for each row execute function public.touch_updated_at();

-- One row of settings. tax_rate is empty until the owner sets it; the page says so and totals stay before tax.
create table public.pricing_settings (
  id boolean primary key default true check (id),
  tax_rate numeric(6,5) check (tax_rate is null or (tax_rate >= 0 and tax_rate < 0.2)),
  cash_discount numeric(5,4) not null default 0.035 check (cash_discount >= 0 and cash_discount <= 0.5),
  deposit_pct numeric(4,3) not null default 0.5 check (deposit_pct >= 0 and deposit_pct <= 1),
  updated_at timestamptz not null default now()
);
insert into public.pricing_settings (id) values (true);
alter table public.pricing_settings enable row level security;
create policy "pricing settings: staff read" on public.pricing_settings for select to authenticated
  using (public.has_role('csr', 'admin', 'tech'));
create policy "pricing settings: admins edit" on public.pricing_settings for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create trigger pricing_settings_touch before update on public.pricing_settings
  for each row execute function public.touch_updated_at();

revoke all on public.labor_tiers, public.pricing_settings from anon;
