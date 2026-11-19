-- Work orders: the approval process for each company that sends them.
-- Each property manager, warranty company or manufacturer has its own way of approving work (call a person, submit
-- through a portal). The Work orders page and the intake guide show the process for the company on the work order,
-- and the intake posts it to the Housecall Pro job as its own note.
-- A row applies to a work order when the work order's company name contains the row's name (case-insensitive).
-- Applied to the Call-Coach-CA project on 2026-11-18.

create table public.work_order_source_processes (
  id bigint generated always as identity primary key,
  name text not null,
  process text not null,
  updated_at timestamptz not null default now(),
  updated_by_name text
);
create unique index work_order_source_processes_name_key on public.work_order_source_processes (lower(name));
alter table public.work_order_source_processes enable row level security;
-- Office reads; only an admin changes them.
create policy "source processes: office reads" on public.work_order_source_processes for select to authenticated using (public.has_role('csr','admin'));
create policy "source processes: admin adds" on public.work_order_source_processes for insert to authenticated with check (public.is_admin());
create policy "source processes: admin edits" on public.work_order_source_processes for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "source processes: admin removes" on public.work_order_source_processes for delete to authenticated using (public.is_admin());
revoke all on public.work_order_source_processes from anon;

-- The rows themselves (which company, who to call, usual limits) are business details. They live only in the
-- database and are edited on the Settings page; they are deliberately not kept in this file.
