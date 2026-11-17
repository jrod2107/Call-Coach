-- Issues the office typed in under "Other" on the Call intake guide, one row per appliance on a saved call.
-- Counted on Home so an issue that keeps coming up can be added to the appliance's list for good.
-- Holds no customer details. Office roles read and add; only admins delete.
-- Applied to the Call-Coach-CA project on 2026-11-17.
create table public.intake_other_issues (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  appliance text not null,
  brand text,
  issue text not null,
  taken_by text,
  intake_id uuid references public.intakes(id) on delete set null
);
create index intake_other_issues_intake_id_idx on public.intake_other_issues (intake_id);
alter table public.intake_other_issues enable row level security;
create policy "intake_other_issues: office reads" on public.intake_other_issues for select to authenticated using (has_role('csr','admin'));
create policy "intake_other_issues: office adds" on public.intake_other_issues for insert to authenticated with check (has_role('csr','admin'));
create policy "intake_other_issues: admin deletes" on public.intake_other_issues for delete to authenticated using (is_admin());
