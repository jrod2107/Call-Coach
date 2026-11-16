-- Triage part: an extra part ordered for a job in case it is needed, to be returned if it is not used.
-- The Parts desk reminds the office to decide on it 10 days after it was ordered, or as soon as another
-- part on the same job is marked installed. Anyone on the team may set the flag when requesting a part.
-- Applied to the Call-Coach-CA project on 2026-11-16.
alter table public.parts add column triage boolean not null default false;
