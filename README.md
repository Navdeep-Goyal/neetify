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

## Adding next week's exam
1. Duplicate `data/questions-week1.json` as `data/questions-week2.json` and replace the questions.
2. In `js/app.js`, change the `QUESTION_FILE` constant to point to the new file (or extend the landing page to let you pick which week to attempt \u2014 ask me if you want this built in).
3. Push the update. Past results stay intact (they live in your browser's localStorage, keyed separately from the question file).

## Data & progress
- All progress and results are stored in your browser's **localStorage** \u2014 nothing leaves your device, no account needed.
- Closing the tab mid-exam is safe: reopening the site offers **Resume In-Progress Exam**, and the section timer correctly accounts for real time elapsed while closed (it does not pause).
- Use **Export Results (JSON)** on the history page to back up your results (e.g., before clearing browser data or switching devices), and **Import Results (JSON)** to restore them elsewhere.
- Results are tied to this browser/device only \u2014 there is no cross-device sync.

## Files
```
index.html              All screens (landing, instructions, exam, result, history)
css/style.css           CBT-style visual design
js/app.js               Exam engine: timer, palette, scoring, localStorage persistence
data/questions-week1.json   Week 1 question bank (45 Qs: Surgery/OBG/PSM)
```

## Note on question content
All questions were originally authored for this schedule (clinical-vignette style, matched to NEET PG difficulty and format) \u2014 they are not reproduced from BTR, Marrow, Reflex, or any other proprietary question bank.
