-- Two-step sign-in (the 6-digit code) for call intakes, call transcripts and work orders.
--
-- Job data already needs it (see jobs_mirror). These tables hold customer and tenant names, phone numbers and
-- addresses too, so every signed-in request to them now also needs a session that entered the code (aal2).
--
-- Each rule below is "restrictive": it is added on top of the existing role rules, which stay as they are.
-- A request must pass both: the right role AND the code entered. The scheduled jobs and server functions that
-- use the service key are not affected.

do $$
declare t text;
begin
  foreach t in array array['intakes','calls','work_orders','work_order_events','work_order_files','work_order_mail']
  loop
    execute format('drop policy if exists %I on public.%I', t || ': two-step code required', t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (public.is_aal2()) with check (public.is_aal2())',
      t || ': two-step code required', t);
  end loop;
end $$;

-- Files attached to work orders (storage bucket "work-orders"): same rule.
drop policy if exists "work-orders files: two-step code required" on storage.objects;
create policy "work-orders files: two-step code required" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'work-orders' or public.is_aal2())
  with check (bucket_id <> 'work-orders' or public.is_aal2());
