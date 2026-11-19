-- Work orders: link one to a Housecall Pro job that was already booked.
-- Some work orders arrive after the job is already on the schedule (booked by phone before the email came, or before
-- this page existed). An admin can link such a work order straight to the existing job. It stays the exception:
-- everyone else still books through the intake guide, and the record keeps who made the link.
-- Applied to the Call-Coach-CA project on 2026-11-19.

alter table public.work_orders add column booked_no_intake_by text;

alter table public.work_orders drop constraint work_orders_booked_needs_intake;
alter table public.work_orders add constraint work_orders_booked_needs_intake check (
  status not in ('booked','done') or intake_id is not null
  or (hcp_job_number is not null and booked_no_intake_by is not null));

-- Only an admin may set or change the no-intake link.
create or replace function public.work_orders_guard_no_intake() returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.booked_no_intake_by is distinct from old.booked_no_intake_by and not public.is_admin() then
    raise exception 'Only an admin can link a work order to an existing job without an intake.';
  end if;
  return new;
end $$;
revoke execute on function public.work_orders_guard_no_intake() from public, anon, authenticated;
create trigger work_orders_guard_no_intake before update on public.work_orders
  for each row execute function public.work_orders_guard_no_intake();

-- History wording for that case.
create or replace function public.work_orders_log() returns trigger language plpgsql security definer set search_path to 'public' as $$
declare who text; msg text := '';
begin
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  if auth.uid() is null then who := 'Mail collector'; end if;
  if tg_op = 'INSERT' then msg := case when new.status = 'draft' then 'Collected from email. Needs review' else 'Work order entered' end;
  else
    if new.status is distinct from old.status then
      msg := case when old.status = 'draft' and new.status = 'new' then 'Reviewed and confirmed'
        when new.status = 'contacting' then 'Contact started'
        when new.status = 'booked' and new.intake_id is null then 'Booked: linked to existing job #' || coalesce(new.hcp_job_number, '?') || ', no intake'
        when new.status = 'booked' then 'Booked: intake linked' || coalesce(', job #' || new.hcp_job_number, '')
        when new.status = 'done' then 'Closed' when new.status = 'cancelled' then 'Cancelled' else 'Reopened' end;
    end if;
    if new.approval is distinct from old.approval then
      msg := msg || case when msg = '' then '' else '; ' end || 'Approval: ' || replace(new.approval, '_', ' ') || coalesce(' $' || new.approval_amount::text, '');
    end if;
    if new.invoice_sent_on is distinct from old.invoice_sent_on and new.invoice_sent_on is not null then
      msg := msg || case when msg = '' then '' else '; ' end || 'Invoice sent' || coalesce(' $' || new.invoice_amount::text, '');
    end if;
    if new.paid_on is distinct from old.paid_on and new.paid_on is not null then
      msg := msg || case when msg = '' then '' else '; ' end || 'Paid';
    end if;
    if new.portal_updated is distinct from old.portal_updated and new.portal_updated then
      msg := msg || case when msg = '' then '' else '; ' end || 'Their portal updated';
    end if;
    if msg = '' then return new; end if;
  end if;
  insert into public.work_order_events (work_order_id, by_id, by_name, kind, note) values (new.id, auth.uid(), who, 'status', msg);
  return new;
end $$;
revoke execute on function public.work_orders_log() from public, anon, authenticated;
