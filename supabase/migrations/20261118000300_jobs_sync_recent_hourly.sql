-- The 10-minute jobs sync only re-reads jobs scheduled from 7 days back onward. A job older than that which is
-- finished, cancelled or rescheduled in Housecall Pro later (for example during clean-up) would never update here.
-- This second schedule re-reads every job scheduled in the last 60 days, once an hour, so those changes come over.
-- Applied to the Call-Coach-CA project on 2026-11-18.
select cron.schedule('jobs-sync-recent', '5 * * * *', $job$
  select net.http_post(
    url := 'https://skwgnvxjwfrkgzxrdfhe.supabase.co/functions/v1/jobs-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-sync-token', (select value from public.collector_config where key = 'jobs_sync_token')),
    body := jsonb_build_object('from', to_char(current_date - 60, 'YYYY-MM-DD'), 'to', to_char(current_date, 'YYYY-MM-DD')),
    timeout_milliseconds := 120000);
$job$);
