-- Off-site backup: lets the office Mac fetch the latest nightly copy and save it to the NAS.
-- Applied to the Call-Coach-CA project on 2026-11-19.
--
-- public.backup_export(token) returns the newest row of backups.snapshots, but only to a caller holding the
-- export key. The key itself is generated on the Mac and lives only in its Keychain; the database stores just
-- its SHA-256 hash (backups.config, key export_token_sha256), which cannot be turned back into the key.
-- The function is callable without signing in because the Mac's nightly job has no user session. Without the
-- key it returns nothing. The Supabase advisor will flag it as a public security-definer function: intended.
create table if not exists backups.config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table backups.config enable row level security;
revoke all on backups.config from public, anon, authenticated;

create or replace function public.backup_export(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $fn$
declare h text; s backups.snapshots;
begin
  select value into h from backups.config where key = 'export_token_sha256';
  if h is null or p_token is null or length(p_token) < 40
     or encode(sha256(convert_to(p_token, 'UTF8')), 'hex') <> h then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select * into s from backups.snapshots order by id desc limit 1;
  if not found then raise exception 'No backup found.'; end if;
  insert into backups.config (key, value) values ('last_export', now()::text)
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('id', s.id, 'taken_at', s.taken_at, 'table_count', s.table_count,
                            'row_count', s.row_count, 'data', s.data);
end $fn$;
revoke all on function public.backup_export(text) from public, authenticated;
grant execute on function public.backup_export(text) to anon;
