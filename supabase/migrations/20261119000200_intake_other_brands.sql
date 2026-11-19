-- Brands the office typed in under "Other" on the Call intake guide, one row per appliance on a saved call.
-- Counted on Home so a brand that keeps coming up can be made its own button.
-- Holds no customer details. Office roles add; managers read and delete (same as intake_other_issues).
-- Applied to the Call-Coach-CA project on 2026-11-19.
create table public.intake_other_brands (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  brand text not null,
  appliance text,
  taken_by text,
  intake_id uuid references public.intakes(id) on delete set null
);
create index intake_other_brands_intake_id_idx on public.intake_other_brands (intake_id);
alter table public.intake_other_brands enable row level security;
create policy "intake_other_brands: managers read" on public.intake_other_brands for select to authenticated using (public.is_manager());
create policy "intake_other_brands: office adds" on public.intake_other_brands for insert to authenticated with check (public.has_role('csr','admin'));
create policy "intake_other_brands: managers delete" on public.intake_other_brands for delete to authenticated using (public.is_manager());
revoke all on public.intake_other_brands from anon;
