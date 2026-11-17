-- When a job has more than one part: 'all' = book the visit only once every part is in,
-- 'any' = fine to go out with whichever part is in. Kept the same on every part of the job by the Parts desk.
-- Null means not decided. Applied to the Call-Coach-CA project on 2026-11-17.
alter table public.parts add column job_rule text check (job_rule in ('all','any'));
