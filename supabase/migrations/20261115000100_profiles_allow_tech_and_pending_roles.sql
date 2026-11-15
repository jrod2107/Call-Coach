-- Roles can now be admin, csr, tech or pending. Before this, the check allowed only admin and csr,
-- which rejected the 'pending' default given to new sign-ups and left no role for technicians.
-- Existing rows (admin, csr) already satisfy the new check. Applied to Call-Coach-CA on 2026-11-15.
alter table public.profiles drop constraint profiles_role_check;
alter table public.profiles add constraint profiles_role_check check (role = any (array['admin','csr','tech','pending']));
