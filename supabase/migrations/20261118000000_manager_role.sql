-- Manager: an office account with extra rights, between Office (csr) and Admin.
-- Stored as profiles.manager = true on a csr account rather than as a new role value, so every existing
-- "csr or admin" rule and server function keeps working for managers unchanged. Only an admin can set it
-- (profiles can only be updated by admins). is_manager() is true for admins and for csr accounts with the flag.
--
-- Manager or admin only from here on: adding and editing vendors and stock locations, reading the
-- "typed under Other" intake issues, deleting parts, stock, work orders and their files, and cancelling a part.
-- Applied to the Call-Coach-CA project on 2026-11-18.
alter table public.profiles add column manager boolean not null default false;

create or replace function public.is_manager() returns boolean
 language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and (role = 'admin' or (role = 'csr' and manager)));
$$;
revoke execute on function public.is_manager() from public, anon;
grant execute on function public.is_manager() to authenticated, service_role;

alter policy "vendors: office adds" on public.vendors with check (public.is_manager());
alter policy "vendors: office edits" on public.vendors using (public.is_manager()) with check (public.is_manager());
alter policy "vendors: admin deletes" on public.vendors using (public.is_manager());
alter policy "stock_locations: office adds" on public.stock_locations with check (public.is_manager());
alter policy "stock_locations: office edits" on public.stock_locations using (public.is_manager()) with check (public.is_manager());
alter policy "stock_locations: admin deletes" on public.stock_locations using (public.is_manager());
alter policy "intake_other_issues: office reads" on public.intake_other_issues using (public.is_manager());
alter policy "intake_other_issues: admin deletes" on public.intake_other_issues using (public.is_manager());
alter policy "parts: admin deletes" on public.parts using (public.is_manager());
alter policy "stock_items: admin deletes" on public.stock_items using (public.is_manager());
alter policy "stock_catalog: admin deletes" on public.stock_catalog using (public.is_manager());
alter policy "work_orders: admin deletes" on public.work_orders using (public.is_manager());
alter policy "work_order_files: admin deletes" on public.work_order_files using (public.is_manager());

alter policy "vendors: office adds" on public.vendors rename to "vendors: managers add";
alter policy "vendors: office edits" on public.vendors rename to "vendors: managers edit";
alter policy "vendors: admin deletes" on public.vendors rename to "vendors: managers delete";
alter policy "stock_locations: office adds" on public.stock_locations rename to "stock_locations: managers add";
alter policy "stock_locations: office edits" on public.stock_locations rename to "stock_locations: managers edit";
alter policy "stock_locations: admin deletes" on public.stock_locations rename to "stock_locations: managers delete";
alter policy "intake_other_issues: office reads" on public.intake_other_issues rename to "intake_other_issues: managers read";
alter policy "intake_other_issues: admin deletes" on public.intake_other_issues rename to "intake_other_issues: managers delete";
alter policy "parts: admin deletes" on public.parts rename to "parts: managers delete";
alter policy "stock_items: admin deletes" on public.stock_items rename to "stock_items: managers delete";
alter policy "stock_catalog: admin deletes" on public.stock_catalog rename to "stock_catalog: managers delete";
alter policy "work_orders: admin deletes" on public.work_orders rename to "work_orders: managers delete";
alter policy "work_order_files: admin deletes" on public.work_order_files rename to "work_order_files: managers delete";

-- parts_guard: same as before, plus only a manager or admin may cancel a part.
create or replace function public.parts_guard()
 returns trigger language plpgsql set search_path to 'public'
as $function$
declare office boolean;
begin
  if auth.uid() is null then return new; end if;  -- SQL editor or service role
  office := public.has_role('csr','admin');
  if tg_op = 'INSERT' then
    new.requested_by := auth.uid();
    select coalesce(nullif(display_name,''), email) into new.requested_by_name from public.profiles where id = auth.uid();
    if not office then
      new.status := 'need_to_order'; new.vendor_id := null; new.vendor_other := null; new.po_number := null; new.vendor_order_no := null;
      new.tracking_number := null; new.list_price := null; new.cost := null; new.sell_price := null; new.eta := null;
      new.ordered_on := null; new.received_on := null; new.return_by := null; new.credited_on := null;
    end if;
    return new;
  end if;
  if not office then
    if (new.job_number, new.hcp_job_id, new.customer_name, new.part_number, new.qty, new.vendor_id, new.vendor_other, new.po_number, new.vendor_order_no,
        new.tracking_number, new.list_price, new.cost, new.sell_price, new.eta, new.ordered_on, new.received_on, new.return_by, new.credited_on, new.tag)
       is distinct from
       (old.job_number, old.hcp_job_id, old.customer_name, old.part_number, old.qty, old.vendor_id, old.vendor_other, old.po_number, old.vendor_order_no,
        old.tracking_number, old.list_price, old.cost, old.sell_price, old.eta, old.ordered_on, old.received_on, old.return_by, old.credited_on, old.tag) then
      raise exception 'Only office staff can change order details on a part.';
    end if;
    if new.status is distinct from old.status and new.status not in ('installed','returned') then
      raise exception 'Technicians can only mark a part installed or not used.';
    end if;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' and not public.is_manager() then
    raise exception 'Only a manager or admin can cancel a part.';
  end if;
  return new;
end $function$;
