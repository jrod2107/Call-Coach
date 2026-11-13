-- New sign-ups start as 'pending' and get no access to the HCP functions until
-- an admin sets their role to 'csr' or 'admin'. Existing profiles are unchanged.
alter table public.profiles alter column role set default 'pending';
