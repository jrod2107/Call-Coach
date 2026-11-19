-- Protected pages: page content that must only reach signed-in staff.
-- A page file on the web host is readable by anyone who has its address, so a page that carries business details
-- (fees, phone scripts, ZIP rulings) keeps only a sign-in screen on the host. Its real content lives here and is
-- handed out by row-level security after sign-in. First used by the Call Desk (slug 'desk').
-- Applied to the Call-Coach-CA project on 2026-11-19. Release steps: tools/release-protected-page.sh.

create table public.protected_pages (
  slug text primary key check (slug ~ '^[a-z0-9-]{1,40}$'),
  roles text[] not null check (cardinality(roles) between 1 and 6),
  html text not null,
  sha256 text not null,
  updated_at timestamptz not null default now()
);
alter table public.protected_pages enable row level security;
create policy "protected pages: allowed roles read" on public.protected_pages for select to authenticated
  using (public.has_role(variadic roles));
revoke all on public.protected_pages from anon, authenticated;
grant select on public.protected_pages to authenticated;

-- A release is permission to store one exact version of a page, named by the SHA-256 of its content. Rows are
-- created only by a database administrator (no policies, so no signed-in person can read or write them).
create table public.protected_page_releases (
  slug text not null check (slug ~ '^[a-z0-9-]{1,40}$'),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  roles text[] not null check (cardinality(roles) between 1 and 6),
  expires_at timestamptz not null,
  primary key (slug, sha256)
);
alter table public.protected_page_releases enable row level security;
revoke all on public.protected_page_releases from anon, authenticated;

-- Stores page content, but only content whose hash matches an unexpired release. The caller needs no secret:
-- what may be stored was fixed in advance by the administrator, so calling this with anything else does nothing.
-- This content runs as the page for staff, which is why nothing a signed-in person can do is able to change it.
-- It is callable without signing in on purpose (the release tool has no account); the hash check is the gate.
create or replace function public.protected_page_put(p_slug text, p_html text) returns text
language plpgsql security definer set search_path to 'public' as $$
declare h text; r public.protected_page_releases;
begin
  if p_html is null or length(p_html) < 1 or length(p_html) > 2000000 then raise exception 'Content is missing or too large.'; end if;
  h := encode(sha256(convert_to(p_html, 'UTF8')), 'hex');
  select * into r from public.protected_page_releases where slug = p_slug and sha256 = h and expires_at > now();
  if not found then raise exception 'This content has not been released.'; end if;
  insert into public.protected_pages (slug, roles, html, sha256) values (r.slug, r.roles, p_html, h)
    on conflict (slug) do update set roles = excluded.roles, html = excluded.html, sha256 = excluded.sha256, updated_at = now();
  delete from public.protected_page_releases where slug = p_slug;
  return h;
end $$;
revoke execute on function public.protected_page_put(text, text) from public;
grant execute on function public.protected_page_put(text, text) to anon, authenticated;
