-- Hardening from the 2026-11-19 security review. Applied to the Call-Coach-CA project on 2026-11-19.
-- 1. Two trigger functions had no fixed search_path (Supabase advisor 0011).
alter function public.touch_updated_at() set search_path = public;
alter function public.knowledge_touch() set search_path = public;
-- 2. Nobody needs to call these directly without signing in (advisor 0028). handle_new_user only runs as a
--    trigger, which does not need EXECUTE. is_admin is still needed by signed-in users for the access rules.
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;
-- 3. Signed-out visitors were already blocked by row level security on every table. This removes their table
--    grants as well, so a future table with a missing rule is still closed to them.
revoke all on all tables in schema public from anon;
