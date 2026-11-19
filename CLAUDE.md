# Project rules

This is the internal service platform for an appliance repair company. It is being built step by step to
replace Housecall Pro. The owner is not a programmer: explain things in plain language, without jargon.

This file is public (the repository is public). Never put secrets, customer details or staff contact details in it.

## Standing rules

1. **Publish only with the owner's explicit approval, each time.** Publishing means pushing to `main`, which
   updates the live site. Database changes and server function deploys are live changes too: say so before
   making them, and get approval first.
2. **One session publishes.** Other chats are for discussion and exploration. If more than one session edits
   this folder, only one of them pushes. Before every push: fetch `origin/main`, read the full diff of what is
   about to go out, and leave out anything that is not yours or was not approved.
3. **Never handle secrets.** Do not enter the owner's passwords, and do not read, print, store or paste API
   keys or tokens anywhere (chat, files, commits). The owner enters secrets personally in the Supabase dashboard.
4. **Security first, checked proactively on every build.** Customer data is private and for office roles only.
   - Access is enforced in the database (row level security) and in server functions, never only in the page.
   - Every new table gets row level security and rules in the same change. Test the rules as each role
     (signed out, technician, office, manager, admin) before calling the work done.
   - Every server function checks the caller's profile role itself. "Signed in" is not enough.
   - Run the Supabase security advisor after any database change.
5. **Deleting data needs the owner's explicit confirmation**, naming what will be deleted.
6. **Do not copy code, designs or licensed data from competitors** or from the parts Blue Book.
7. **Do not commit** the `.claude/` folder, prototype pages, exports, or anything containing customer data.
8. **Report honestly.** Say what was tested and how, and what was not. The local preview cannot sign in, so
   pages are tested with stand-in data and rules are tested in the database; say so when that is the case.

## How it is built

- Static pages on GitHub Pages, one folder per tool: `home`, `intake`, `parts`, `stock`, `jobs`, `desk`,
  `workorders`, `lookup`, `settings`. The call coach is the root `index.html`. Shared settings are in `config.js`.
- Supabase project "Call-Coach-CA": database, sign-in, server functions (`supabase/functions`), scheduled jobs.
  Every database change is also saved as a file in `supabase/migrations`.
- Housecall Pro is still the source of truth for jobs and customers. The Jobs page is a read-only copy,
  refreshed every 10 minutes (hourly for the last 60 days). Nothing writes back to Housecall Pro yet.
- Roles live in `profiles`: `admin`, `csr` (office), `tech`, `stock`, `pending`. Manager is `csr` with
  `manager = true`. Senior technician is `tech` with `senior = true`. Helper functions: `has_role`,
  `is_admin`, `is_manager`, `can_see_job`.
- Two-step sign-in is required by the database for job data.
- Backups: `backups.take()` copies every table nightly into `backups.snapshots` (30 days kept, plus monthly
  for a year). `select * from backups.restore_test()` rehearses a restore without touching live data.
- Off-site copy: the office Mac fetches the latest snapshot at 3 am (catch-up at noon), encrypts it, and saves
  it to the NAS folder "CA Hub Backup", keeping 90 days. Scripts are in `ops/nas-backup`; the installed copy
  runs from `~/Library/Application Support/CAHubBackup` under launchd (`com.cityappliance.cahub-backup`), log
  in `~/Library/Logs/cahub-backup.log`. The download key and the encryption passphrase live only in the Mac's
  Keychain; the database holds only the key's hash. Not covered yet: sign-in accounts and uploaded files.

## Known gaps (remove each line when fixed)

- Each page carries its own copy of sign-in, role checks and styling. Move these to shared files before
  building the schedule board, and change all copies together until then.
- There is no test copy of the site or database. Changes go straight to live.
- Two-step sign-in does not yet cover intakes, call transcripts, work orders or the Housecall Pro lookup.
- No idle sign-out. No spending limits on the AI-backed server functions.
- The invoice reader accepts any office account; it should be managers only.
- Free Supabase plan (no provider backups, can pause) and GitHub Pages hosting: both must change before
  payments or a customer portal.

## Layout rules

- One menu, same order on every page: left side on desktop, bottom bar on phones with at most five items.
- Settings in one place, split into "My account" and "Company settings" (admins).
- Each role sees only what it can use, and the database enforces the same thing.
- List beside detail on wide screens; list, then detail with a back button, on phones.
- Status is never shown by color alone: always with a word.
- Buttons at least 44 pixels tall on technician screens. Single column, no sideways scrolling on phones.
- Labels always visible above fields, never placeholder-only.
- One main action per screen, in the same position each time.
- Confirm only actions that cannot be undone, name the item, and label buttons with the outcome.
- Times shown in Central time.

## Writing for the team

Plain words and short sentences in on-screen text. Tell people what to do next.
