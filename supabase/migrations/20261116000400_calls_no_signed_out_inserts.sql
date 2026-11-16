-- The call log accepted new rows from visitors who were not signed in. Nothing could be read that way, but anyone who
-- found it could fill the log with junk. Signed-in CSRs still log their own calls ("calls: csr inserts own").
-- If a tool that logs calls without a login stops working, it should sign in or go through a server-side function instead.
-- Applied to the Call-Coach-CA project on 2026-11-16.
drop policy "allow_insert_calls" on public.calls;
