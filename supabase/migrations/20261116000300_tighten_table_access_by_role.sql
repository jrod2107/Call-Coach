-- Security pass: several older tables were readable (some writable) by ANY signed-in account, including a technician,
-- the Stock helper, or an account that had not been given a role yet. Access now follows the role:
--   customer data (intakes, household_contacts, callback_decisions, calls) -> office (csr, admin) only
--   internal reference material (desk_asks, coach_rules, playbook, knowledge) -> staff (csr, admin, tech)
-- Applied to the Call-Coach-CA project on 2026-11-16.
-- Not changed here, and worth a decision: calls still accepts inserts from signed-out visitors ("allow_insert_calls").

drop policy "authenticated full access" on public.intakes;
create policy "intakes: office reads" on public.intakes for select to authenticated using (public.has_role('csr','admin'));
create policy "intakes: office adds" on public.intakes for insert to authenticated with check (public.has_role('csr','admin'));
create policy "intakes: office edits" on public.intakes for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "intakes: admin deletes" on public.intakes for delete to authenticated using (public.is_admin());

drop policy "authenticated full access" on public.household_contacts;
create policy "household_contacts: office reads" on public.household_contacts for select to authenticated using (public.has_role('csr','admin'));
create policy "household_contacts: office adds" on public.household_contacts for insert to authenticated with check (public.has_role('csr','admin'));
create policy "household_contacts: office edits" on public.household_contacts for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "household_contacts: admin deletes" on public.household_contacts for delete to authenticated using (public.is_admin());

drop policy "authenticated full access" on public.callback_decisions;
create policy "callback_decisions: office reads" on public.callback_decisions for select to authenticated using (public.has_role('csr','admin'));
create policy "callback_decisions: office adds" on public.callback_decisions for insert to authenticated with check (public.has_role('csr','admin'));
create policy "callback_decisions: office edits" on public.callback_decisions for update to authenticated using (public.has_role('csr','admin')) with check (public.has_role('csr','admin'));
create policy "callback_decisions: admin deletes" on public.callback_decisions for delete to authenticated using (public.is_admin());

drop policy "calls: team reads" on public.calls;
create policy "calls: office reads" on public.calls for select to authenticated using (public.has_role('csr','admin'));

drop policy "desk_asks: team reads" on public.desk_asks;
create policy "desk_asks: staff reads" on public.desk_asks for select to authenticated using (public.has_role('csr','admin','tech'));
drop policy "rules: team reads" on public.coach_rules;
create policy "rules: staff reads" on public.coach_rules for select to authenticated using (public.has_role('csr','admin','tech'));
drop policy "playbook: team reads" on public.playbook;
create policy "playbook: staff reads" on public.playbook for select to authenticated using (public.has_role('csr','admin','tech'));
drop policy "knowledge: team reads active" on public.knowledge;
create policy "knowledge: staff reads active" on public.knowledge for select to authenticated
  using (public.is_admin() or (public.has_role('csr','tech') and status = any (array['active','review','outdated'])));
