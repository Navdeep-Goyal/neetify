# Weekly Practice Test \u2014 NEET PG Format

A self-hosted, NEET PG-format mock test site. Static HTML/CSS/JS, no backend, no build step \u2014 just push to GitHub and turn on Pages.

## What this replicates from the real NEET PG CBT
- 180 marks, +4 correct / \u22121 wrong / 0 unattempted
- Sectional locking: once a section's timer expires (or you submit it), it's locked \u2014 no going back
- Exact per-question pace: 70 seconds/question (same as the real exam's 42 min \u00f7 36 Q)
- Standard question palette color coding (grey/red/green/purple, matching NBE/NTA convention)
- Save & Next / Mark for Review & Next / Clear Response, one question at a time
- Instructions screen with a declaration checkbox gating entry, same as the real portal

## Hosting on GitHub Pages
1. Create a new GitHub repository (public or private with Pages enabled on a paid plan).
2. Push all files in this folder to the repository root (`index.html` must be at the repo root, or in `/docs` if you set Pages to serve from `/docs`).
3. In the repo: **Settings \u2192 Pages \u2192 Source**, select the branch (usually `main`) and folder (`/root` or `/docs`).
4. Wait ~1 minute, then visit `https://<your-username>.github.io/<repo-name>/`.

```bash
git init
git add .
git commit -m "Week 1 NEET PG practice test"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

Then enable Pages in the repo settings as above.

## Exam lockdown (tab/app-switch detection)
Once you begin a section, the site tries to enforce exam-like conditions:
- **Fullscreen is requested automatically** when you start or resume an exam.
- **Leaving the tab/app or exiting fullscreen is detected and logged as a violation**, with an on-screen warning ("Violation 1 of 3...").
- **After 3 violations, the exam auto-submits** — same as a section timer running out — and the result screen shows a note that it was auto-submitted for repeated exits.
- A generic browser "leave site?" confirmation appears if you try to close the tab or navigate away mid-exam (the exact wording is controlled by the browser, not this site).

**Important honest limitation:** no website can block OS-level app-switching (Alt+Tab, Cmd+Tab, the Home button, etc.) — browsers deliberately don't give any site that power, for your own security. What this *does* do is detect every time you leave and hold you accountable for it via the violation count, the same mechanism real browser-based proctored exams use. If you want the threshold different from 3, it's the `MAX_VIOLATIONS` constant near the top of `js/app.js`.

### iPad specifics
- **Fullscreen works on iPad Safari** — unlike iPhone Safari, iPadOS Safari supports fullscreening an arbitrary element (not just video), so the exam should genuinely go fullscreen when you start it.
- **Tab/app-switch detection (the core violation mechanism) is unaffected by device** — it uses the standard Page Visibility API, which is reliable across Safari, Chrome, and every other browser on iPad.
- **The "leave site?" browser confirmation is unreliable on iOS/iPadOS Safari** — Apple's WebKit engine doesn't consistently show it, especially for app-switching. This isn't a gap in the core protection (that's the violation counter, which still fires), just a missing extra nudge when actually closing the tab.
- **If fullscreen is ever denied** (e.g. by Screen Time or MDM content restrictions on a school-managed iPad), a small banner appears suggesting **Guided Access** (Settings → Accessibility → Guided Access, then triple-click the top button once in the exam) — this is the one thing that genuinely *can* lock an iPad to a single app at the OS level, since no website ever can.

## Accounts (name + PIN)
Every result and all progress is tied to an account, so the same name+PIN works on any device — no email, no magic link. This is a custom, deliberately low-security system (fine for a small personal-use project): there's no real password-reset flow, no rate-limiting, and the PIN is only as private as whoever you tell it to.

**One-time setup:**
1. In your Supabase project's **SQL Editor**, paste and run the whole `supabase_schema.sql` (included in this zip). It creates:
   - A `users` table (name + hashed PIN) — locked down so PIN hashes can never be fetched directly, even with the public key; all access goes through two functions (`register_user`, `login_user`).
   - `exam_history` (every attempt's full result, for review later) and `week_overrides` (admin-controlled unlock flags) — both left **fully open** (no per-row security), per how this project is scoped.
   - The one admin account: name `alpha`, PIN `1010`.
2. Go to **Project Settings → API** and copy the **`anon` `public`** key (safe to be client-visible — this project doesn't rely on hiding it).
3. Paste that key into `js/supabase-config.js`, replacing the placeholder if you haven't already.
4. Push `supabase-config.js` to GitHub Pages.

**How it works day-to-day:**
- First time: enter a name + PIN (4+ digits) and tap **Register**.
- Any device after that: same name + PIN, tap **Login** — pulls your existing results automatically.
- The device remembers you after login (skips the login screen) until you tap **Switch User**.
- **In-progress exams are not synced** — only completed results. This avoids two devices fighting over one live section timer.
- If a name is already taken, Register fails — use Login instead (with the right PIN).
- **Login requires an internet connection** (it's a real server-side check now) — but once logged in, taking an exam works fully offline since progress stays local until you submit.

## Admin panel (one admin account)
Log in as name `alpha`, PIN `1010` (from the SQL above — change this PIN any time by logging in as alpha and re-registering isn't possible since the name is taken, so instead update it directly: `update public.users set pin_hash = crypt('newpin', gen_salt('bf')) where name_key = 'alpha';`). Admin status is just a `user_type` column — checked via the same login the whole site uses, nothing more exotic.

**What the admin gets:**
- **Week Unlock Control** — a "Force unlock now" toggle per week. Unlike the old per-user bypass, this applies to **every user immediately**, regardless of the real schedule. Toggle it back off to return to the normal Sunday-1pm rule.
- **All Users** — every registered user, each expandable to show their attempts (week, score, violations, date), with a **View** button opening the full per-question review for any attempt.
- If you promote an existing user to admin later (`update public.users set user_type = 'ADMIN' where name_key = '...'`), they need to **Switch User and log back in** with the same credentials to see the Admin Panel — a plain page reload won't pick it up, since the account type is cached locally after login for speed.

## Weekly unlock rule
Each week's exam is **locked until 1:00 PM IST on that week's Sunday** \u2014 the study window has to actually be over before you can attempt it. The landing page shows each week as a card:
- **Locked** \u2014 disabled, shows the exact unlock date/time and a live "in Xd Xh Xm" countdown
- **Available** \u2014 unlocked, not yet attempted
- **In Progress** \u2014 you started it and can Resume
- **Completed** \u2014 shows your score, with **View Result** and **Retake Exam**

The unlock check uses an absolute IST timestamp (`Date.UTC`-based), so it's correct no matter what timezone the browser itself is set to.

**Testing/QA only:** appending `?unlockall=1` to the URL (e.g. `index.html?unlockall=1`) bypasses every lock so you (or I, while building) can test a week's exam before its real unlock time. It's a URL flag only \u2014 nothing is saved, and a normal visit to the site is unaffected.

## Adding next week's exam
1. Duplicate `data/questions-week1.json` as `data/questions-week2.json` and replace the questions.
2. Add a new entry to `data/weeks.json`:
   ```json
   {
     "id": "week2",
     "label": "Week 2",
     "dateRangeLabel": "Aug 24 \u2013 Aug 30, 2026",
     "weekStartDate": "2026-08-24",
     "weekEndDate": "2026-08-30",
     "questionFile": "data/questions-week2.json"
   }
   ```
   `weekEndDate` must be that week's actual Sunday \u2014 this is what drives the 1:00 PM IST unlock, so double-check it against a calendar rather than assuming a fixed day offset.
3. Push the update. It'll automatically show up as a new card on the landing page, locked until its `weekEndDate` at 1 PM IST. Past results stay intact \u2014 progress and history are now stored per week (keyed by each week's `id`), so switching or adding weeks never touches another week's data.

## Data & progress
- Progress and results are cached in your browser's **localStorage** for speed and offline resilience, and synced to Supabase under your account (see "Accounts" above) so they follow you across devices.
- In-progress state is local-only and per week, so you can have Week 1 mid-attempt and still see Week 2 unlock and start cleanly without collision.
- Closing the tab mid-exam is safe: reopening the site's week card offers **Resume Exam**, and the section timer correctly accounts for real time elapsed while closed (it does not pause).
- Use **Export Results (JSON)** on the history page as an extra local backup, and **Import Results (JSON)** to restore them elsewhere.

## Files
```
index.html                  All screens (landing, instructions, exam, result, history)
css/style.css               CBT-style visual design, incl. week-picker cards
js/app.js                   Exam engine: weeks manifest, unlock gating, timer, palette, scoring, localStorage
data/weeks.json             Week manifest: labels, date ranges, unlock dates, question file per week
data/questions-week1.json   Week 1 (45 Qs): Surgery (finish) / OBG (Parts 1-5) / PSM (Parts 1-5)
data/questions-week2.json   Week 2 (45 Qs): OBG (finish, Parts 6-10+PPH) / PSM (finish, Parts 6-8+updates) / Anatomy (start, Parts 1-4)
data/questions-week3.json   Week 3 (45 Qs): Pediatrics (complete) / Anatomy (finish, Parts 5-8) / Ophthalmology (start, Parts 1-3) / ENT (start, Part 1)
data/questions-week4.json   Week 4 (45 Qs): Ophthalmology (finish, Parts 4-6) / ENT (finish, Parts 2-7) / Neurology (start, Parts 1-4)
js/supabase-config.js       Account backend config (fill in your anon key -- see "Accounts" above)
supabase_schema.sql         SQL to run once in Supabase's SQL Editor: users, exam_history, week_overrides, and the admin account
```

Each week's questions were matched to the exact video parts/topics that schedule covers per `NEET_PG_2027_Schedule.pdf` (topics from subjects under active revision-only, like a completed subject's Notes+Qbank pass, are intentionally excluded — only newly-covered content gets exam questions).

## Note on question content
All questions were originally authored for this schedule (clinical-vignette style, matched to NEET PG difficulty and format) \u2014 they are not reproduced from BTR, Marrow, Reflex, or any other proprietary question bank.
