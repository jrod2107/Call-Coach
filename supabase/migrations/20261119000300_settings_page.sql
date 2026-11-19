-- Settings page: what a person may change about their own account, and what an admin may see and change about
-- the email collector, without opening up the tables behind them.
-- Applied to the Call-Coach-CA project on 2026-11-19.

-- A person's usual truck or shelf. Stock starts on it.
alter table public.profiles add column default_location_id uuid references public.stock_locations(id) on delete set null;

-- Profiles stay admin-only for updates (role, manager, senior must never be self-service). This function lets a
-- signed-in person change exactly two things on their own row: their name and their usual location.
create or replace function public.set_my_profile(p_display_name text, p_default_location_id uuid) returns void
language plpgsql security definer set search_path to 'public' as $$
declare nm text := btrim(coalesce(p_display_name, ''));
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if not public.has_role('admin','csr','tech','stock') then raise exception 'This account has no access yet.'; end if;
  if length(nm) < 1 or length(nm) > 60 then raise exception 'The name must be between 1 and 60 characters.'; end if;
  if p_default_location_id is not null and not exists (select 1 from public.stock_locations where id = p_default_location_id and active) then
    raise exception 'That location is not available.';
  end if;
  update public.profiles set display_name = nm, default_location_id = p_default_location_id where id = auth.uid();
end $$;
revoke execute on function public.set_my_profile(text, uuid) from public, anon;
grant execute on function public.set_my_profile(text, uuid) to authenticated;

-- collector_config holds the collector's token, so it has no policies at all. These two functions give an admin
-- the parts that are safe to see and the one part that is safe to change. The token never leaves the table.
create or replace function public.collector_status() returns jsonb
language plpgsql stable security definer set search_path to 'public' as $$
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  return (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from public.collector_config
          where key in ('mailboxes', 'senders', 'start_at', 'last_run'));
end $$;
revoke execute on function public.collector_status() from public, anon;
grant execute on function public.collector_status() to authenticated;

-- Senders are whole domains (for example rentvine.com). Only mail from these domains is ever opened.
create or replace function public.collector_set_senders(p_senders text) returns text
language plpgsql security definer set search_path to 'public' as $$
declare parts text[]; d text; clean text[] := '{}';
begin
  if not public.is_admin() then raise exception 'Admins only.'; end if;
  parts := string_to_array(lower(coalesce(p_senders, '')), ',');
  foreach d in array parts loop
    d := btrim(d);
    if d = '' then continue; end if;
    if d !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' then raise exception '"%" is not a domain. Use the part after the @, for example rentvine.com.', d; end if;
    if d in ('gmail.com','yahoo.com','outlook.com','hotmail.com','icloud.com','aol.com','live.com','msn.com','me.com') then
      raise exception '% is a public email service. Adding it would open every email from anyone using it.', d;
    end if;
    if not d = any(clean) then clean := clean || d; end if;
  end loop;
  if coalesce(array_length(clean, 1), 0) < 1 then raise exception 'Keep at least one sender.'; end if;
  if array_length(clean, 1) > 40 then raise exception 'That is too many senders.'; end if;
  insert into public.collector_config (key, value) values ('senders', array_to_string(clean, ','))
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return array_to_string(clean, ',');
end $$;
revoke execute on function public.collector_set_senders(text) from public, anon;
grant execute on function public.collector_set_senders(text) to authenticated;
