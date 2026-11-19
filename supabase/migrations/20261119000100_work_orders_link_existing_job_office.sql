-- Work orders: any office account (CSR or admin) may link a work order to a job that was already booked.
-- The page makes them acknowledge that new work orders go through the intake guide before it lets them link.
-- Opened up from admin-only on 2026-11-19 at the owner's request; tighten it again here if it gets misused.
-- Applied to the Call-Coach-CA project on 2026-11-19.

create or replace function public.work_orders_guard_no_intake() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.booked_no_intake_by is distinct from old.booked_no_intake_by and not public.has_role('csr','admin') then
    raise exception 'Only office accounts can link a work order to an existing job without an intake.';
  end if;
  return new;
end $$;
revoke execute on function public.work_orders_guard_no_intake() from public, anon, authenticated;
