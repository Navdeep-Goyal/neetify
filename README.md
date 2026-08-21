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
- All progress and results are stored in your browser's **localStorage** \u2014 nothing leaves your device, no account needed.
- In-progress state is stored per week, so you can have Week 1 mid-attempt and still see Week 2 unlock and start cleanly without collision.
- Closing the tab mid-exam is safe: reopening the site's week card offers **Resume Exam**, and the section timer correctly accounts for real time elapsed while closed (it does not pause).
- Use **Export Results (JSON)** on the history page to back up your results (e.g., before clearing browser data or switching devices), and **Import Results (JSON)** to restore them elsewhere.
- Results are tied to this browser/device only \u2014 there is no cross-device sync.

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
```

Each week's questions were matched to the exact video parts/topics that schedule covers per `NEET_PG_2027_Schedule.pdf` (topics from subjects under active revision-only, like a completed subject's Notes+Qbank pass, are intentionally excluded — only newly-covered content gets exam questions).

## Note on question content
All questions were originally authored for this schedule (clinical-vignette style, matched to NEET PG difficulty and format) \u2014 they are not reproduced from BTR, Marrow, Reflex, or any other proprietary question bank.
