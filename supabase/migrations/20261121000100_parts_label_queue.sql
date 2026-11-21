-- Labels to print for job parts (Parts desk tags, P0xxxx), alongside the stock tags added in
-- 20261121000000_stock_label_queue.sql. A job part's tag is pending once the part is received and until someone
-- marks its label printed.
-- Parts that were already past the received stage count as printed. Parts not yet received stay empty, so they
-- become pending when they arrive; the ones received right now stay pending too, so they can be printed.
-- Only office (csr, admin) can mark a label printed; a technician is refused by the guard below.
alter table public.parts add column label_printed_at timestamptz;
update public.parts set label_printed_at = now()
 where status not in ('need_to_order','ordered','backordered','shipped','received');
create index parts_label_pending_idx on public.parts (received_on) where label_printed_at is null and status = 'received';

-- Same guard as before, with one more field a technician may not change.
create or replace function public.parts_guard() returns trigger language plpgsql set search_path to 'public' as $$
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
        new.tracking_number, new.list_price, new.cost, new.sell_price, new.eta, new.ordered_on, new.received_on, new.return_by, new.credited_on, new.tag, new.label_printed_at)
       is distinct from
       (old.job_number, old.hcp_job_id, old.customer_name, old.part_number, old.qty, old.vendor_id, old.vendor_other, old.po_number, old.vendor_order_no,
        old.tracking_number, old.list_price, old.cost, old.sell_price, old.eta, old.ordered_on, old.received_on, old.return_by, old.credited_on, old.tag, old.label_printed_at) then
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
end $$;
