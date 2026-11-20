-- Triage sign-off: for now, any technician may sign off a suggested part, not only senior technicians.
-- Managers and admins as before. Regular office staff still cannot.
-- A technician still only reaches their own jobs (can_see_job), so they can only sign off parts on those.
-- Applied to the Call-Coach-CA project on 2026-11-19.

create or replace function public.can_sign_off_parts() returns boolean
 language sql stable security definer set search_path to 'public'
as $$
  select exists (select 1 from public.profiles where id = auth.uid()
    and (role = 'admin' or (role = 'csr' and manager) or role = 'tech'));
$$;

create or replace function public.triage_sign_off(p_id uuid, p_part_number text default null, p_qty integer default null) returns uuid
 language plpgsql security definer set search_path to 'public'
as $$
declare s public.job_triage_parts; j public.jobs; t public.job_triage; who text; pn text; new_part uuid;
begin
  if not public.can_sign_off_parts() then raise exception 'Only a manager or technician can sign off parts.'; end if;
  select * into s from public.job_triage_parts where id = p_id for update;
  if not found or not public.can_see_job_id(s.job_id) then raise exception 'You do not have access to this job.'; end if;
  if s.status <> 'suggested' then raise exception 'This part was already decided.'; end if;
  select * into j from public.jobs where id = s.job_id;
  if coalesce(j.job_number,'') = '' then raise exception 'This job has no job number yet, so the part cannot go to the Parts desk.'; end if;
  pn := upper(regexp_replace(coalesce(nullif(p_part_number,''), s.part_number, ''), '\s', '', 'g'));
  if pn = '' then raise exception 'Type the part number before signing off.'; end if;
  select * into t from public.job_triage where job_id = s.job_id;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  insert into public.parts (job_number, hcp_job_id, customer_name, appliance, part_number, description, qty, notes)
    values (j.job_number, j.hcp_job_id, coalesce(j.customer_name,''), coalesce(t.appliance,''), pn, s.description,
            coalesce(p_qty, s.qty), 'From triage' || coalesce(': ' || nullif(s.why,''), ''))
    returning id into new_part;
  update public.job_triage_parts set status = 'approved', part_number = pn, qty = coalesce(p_qty, s.qty),
    decided_by = auth.uid(), decided_by_name = who, decided_at = now(), part_id = new_part where id = p_id;
  return new_part;
end $$;

create or replace function public.triage_decline(p_id uuid) returns void
 language plpgsql security definer set search_path to 'public'
as $$
declare s public.job_triage_parts; who text;
begin
  select * into s from public.job_triage_parts where id = p_id for update;
  if not found or not public.can_see_job_id(s.job_id) then raise exception 'You do not have access to this job.'; end if;
  if s.status <> 'suggested' then raise exception 'This part was already decided.'; end if;
  if not (public.can_sign_off_parts() or s.added_by = auth.uid()) then
    raise exception 'Only a manager or technician can turn down a part someone else suggested.';
  end if;
  select coalesce(nullif(display_name,''), email) into who from public.profiles where id = auth.uid();
  update public.job_triage_parts set status = 'declined', decided_by = auth.uid(), decided_by_name = who, decided_at = now() where id = p_id;
end $$;
