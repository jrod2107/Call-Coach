-- Nightly copy of every table in the public schema. The project is on the Supabase free plan, which keeps no
-- backups of its own. Applied to the Call-Coach-CA project on 2026-11-19.
--
-- What this protects against: a bad change, a mistaken delete, or a broken migration. Each night's copy is one
-- row in backups.snapshots, kept for 30 days, plus the first of each month for a year.
-- What it does NOT protect against: losing the whole Supabase project, because the copies live inside it.
-- An off-site copy (Mac or NAS) is the second layer and is still to be set up.
-- Not included: sign-in accounts (auth schema) and uploaded files (storage).
--
-- The backups schema is not exposed through the API and no signed-in role has any rights on it.
create schema if not exists backups;
revoke all on schema backups from public, anon, authenticated;

create table if not exists backups.snapshots (
  id bigint generated always as identity primary key,
  taken_at timestamptz not null default now(),
  kind text not null default 'nightly',
  table_count int not null,
  row_count bigint not null,
  data jsonb not null
);
alter table backups.snapshots enable row level security;
revoke all on backups.snapshots from public, anon, authenticated;

create or replace function backups.take(p_kind text default 'nightly') returns bigint
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare t text; d jsonb := '{}'::jsonb; r jsonb; n bigint := 0; tc int := 0; new_id bigint;
begin
  for t in select c.relname from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
           where ns.nspname = 'public' and c.relkind = 'r' order by 1 loop
    execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) from public.%I x', t) into r;
    d := d || jsonb_build_object(t, r);
    n := n + jsonb_array_length(r);
    tc := tc + 1;
  end loop;
  insert into backups.snapshots (kind, table_count, row_count, data) values (p_kind, tc, n, d) returning id into new_id;
  delete from backups.snapshots
   where kind = 'nightly' and taken_at < now() - interval '30 days'
     and not (extract(day from taken_at) = 1 and taken_at > now() - interval '1 year');
  return new_id;
end $fn$;

-- Restore rehearsal: loads every table of a backup into scratch tables with the real column types, then
-- compares the result with the live table. Nothing live is changed. differs_from_live counts restored rows
-- that are not identical to a live row (0 right after a backup; grows as live data changes).
create or replace function backups.restore_test(p_id bigint default null)
returns table (tbl text, in_backup bigint, restored bigint, differs_from_live bigint)
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare s backups.snapshots; t text; tmp text;
begin
  select * into s from backups.snapshots where id = coalesce(p_id, (select max(id) from backups.snapshots));
  if not found then raise exception 'No backup found.'; end if;
  for t in select k from jsonb_object_keys(s.data) k order by 1 loop
    tbl := t; in_backup := jsonb_array_length(s.data -> t); restored := null; differs_from_live := null;
    if to_regclass(format('public.%I', t)) is not null then
      tmp := '_rt_' || t;
      execute format('create temp table %I (like public.%I)', tmp, t);
      execute format('insert into %I select * from jsonb_populate_recordset(null::public.%I, $1)', tmp, t) using s.data -> t;
      execute format('select count(*) from %I', tmp) into restored;
      execute format('select count(*) from (select to_jsonb(a) from %I a except select to_jsonb(b) from public.%I b) q', tmp, t) into differs_from_live;
      execute format('drop table %I', tmp);
    end if;
    return next;
  end loop;
end $fn$;

revoke all on function backups.take(text) from public, anon, authenticated;
revoke all on function backups.restore_test(bigint) from public, anon, authenticated;

-- 08:15 UTC is about 2:15 am Central.
select cron.schedule('nightly-backup', '15 8 * * *', $job$select backups.take('nightly')$job$);
