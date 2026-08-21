// ============================================================
// NEET PG-style CBT practice exam engine
// Pure vanilla JS, localStorage persistence, no backend.
// ============================================================

const STORAGE_KEY_HISTORY = "neetpg_history";
const WEEKS_FILE = "data/weeks.json";

// A week's exam unlocks at 1:00 PM IST on that week's weekEndDate (the Sunday
// closing out the study week), regardless of what timezone the browser is in.
const UNLOCK_HOUR_IST = 13; // 1 PM

let weeksManifest = null;  // loaded JSON from weeks.json, with unlockTimestamp added
let currentWeek = null;    // the manifest entry for the week currently being attempted/viewed
let examData = null;       // loaded JSON for currentWeek.questionFile
let state = null;          // live exam state
let timerInterval = null;

// ---------------- Utility ----------------
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }
function show(id) { $all(".screen-root").forEach(el => el.classList.add("hidden")); $(id).classList.remove("hidden"); }
function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function nowTs() { return Date.now(); }

// ---------------- Weeks manifest & unlock gating ----------------
async function loadWeeksManifest() {
  const res = await fetch(WEEKS_FILE);
  const data = await res.json();
  weeksManifest = data.weeks.map(w => ({
    ...w,
    unlockTimestamp: computeUnlockTimestamp(w.weekEndDate),
  }));
  return weeksManifest;
}

// weekEndDateStr is that week's Sunday, e.g. "2026-08-23".
// Returns the absolute ms timestamp for 1:00 PM IST on that date.
// Built with Date.UTC so it's correct regardless of the viewer's own timezone.
function computeUnlockTimestamp(weekEndDateStr) {
  const [y, m, d] = weekEndDateStr.split("-").map(Number);
  const unlockUtcHour = UNLOCK_HOUR_IST - 5;   // IST is UTC+5:30
  const unlockUtcMinute = -30;
  return Date.UTC(y, m - 1, d, unlockUtcHour, unlockUtcMinute, 0);
}

function isWeekUnlocked(week) {
  if (new URLSearchParams(location.search).has("unlockall")) return true; // testing/QA override
  return nowTs() >= week.unlockTimestamp;
}

function formatUnlockLabel(ts) {
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
  }).format(new Date(ts)) + " IST";
}

function formatCountdown(msRemaining) {
  const totalMin = Math.max(0, Math.floor(msRemaining / 60000));
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (days || hours) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

// ---------------- Loading question data ----------------
async function loadExamData() {
  const res = await fetch(currentWeek.questionFile);
  examData = await res.json();
  return examData;
}

function questionById(id) {
  return examData.questions.find(q => q.id === id);
}

// ---------------- State init / persistence ----------------
function freshState() {
  const responses = {};
  examData.questions.forEach(q => {
    responses[q.id] = { selected: null, marked: false, visited: false };
  });
  const sectionState = examData.sections.map(s => ({
    id: s.id,
    durationSeconds: s.durationSeconds,
    remainingSeconds: s.durationSeconds,
    endTimestamp: null,   // wall-clock ms when this section's time runs out; set once, on first entry
    submitted: false,
    startedAt: null,
  }));
  return {
    responses,
    sectionState,
    currentSectionIdx: 0,
    currentQIdxInSection: 0,
    examStartedAt: nowTs(),
    submitted: false,
  };
}

function progressKey(weekId) { return `neetpg_inprogress_${weekId}`; }

function saveProgress() {
  localStorage.setItem(progressKey(currentWeek.id), JSON.stringify(state));
}
function loadProgress() {
  return loadProgressFor(currentWeek.id);
}
function loadProgressFor(weekId) {
  const raw = localStorage.getItem(progressKey(weekId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearProgress() {
  localStorage.removeItem(progressKey(currentWeek.id));
}

function getHistory() {
  const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function getHistoryForWeek(weekId) {
  return getHistory().filter(h => h.weekId === weekId);
}
function saveHistoryEntry(entry) {
  const hist = getHistory();
  hist.unshift(entry);
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(hist));
}

// ---------------- Landing screen ----------------
function initLanding() {
  renderWeekList();
  renderLandingHistoryPreview();
  $("#btn-view-history").onclick = () => { renderHistory(); show("#screen-history"); };
}

function renderWeekList() {
  const wrap = $("#week-list");
  if (!wrap || !weeksManifest) return;
  wrap.innerHTML = "";

  weeksManifest.forEach(week => {
    const unlocked = isWeekUnlocked(week);
    const savedProgress = unlocked ? loadProgressFor(week.id) : null;
    const inProgress = !!(savedProgress && !savedProgress.submitted);
    const weekHistory = getHistoryForWeek(week.id);
    const hasCompleted = weekHistory.length > 0 && !inProgress;

    const card = document.createElement("div");
    card.className = "week-card" + (unlocked ? "" : " locked");

    let statusHtml, actionsHtml;

    if (!unlocked) {
      statusHtml = `<span class="week-status-badge locked">Locked</span>`;
      actionsHtml = `<div class="week-lock-note">Unlocks ${formatUnlockLabel(week.unlockTimestamp)}
        <span class="week-countdown">(in ${formatCountdown(week.unlockTimestamp - nowTs())})</span></div>`;
    } else if (inProgress) {
      statusHtml = `<span class="week-status-badge inprogress">In Progress</span>`;
      actionsHtml = `<button class="btn btn-mark" data-action="resume" data-week="${week.id}">Resume Exam</button>`;
    } else if (hasCompleted) {
      const best = weekHistory[0];
      statusHtml = `<span class="week-status-badge completed">Completed &mdash; ${best.score}/${best.totalMarks} (${best.percentage}%)</span>`;
      actionsHtml = `
        <button class="btn btn-clear" data-action="view" data-week="${week.id}">View Result</button>
        <button class="btn btn-submit" data-action="start" data-week="${week.id}">Retake Exam</button>`;
    } else {
      statusHtml = `<span class="week-status-badge available">Available</span>`;
      actionsHtml = `<button class="btn btn-submit" data-action="start" data-week="${week.id}">Start Exam</button>`;
    }

    card.innerHTML = `
      <div class="week-card-header">
        <div>
          <div class="week-card-title">${week.label}</div>
          <div class="week-card-dates">${week.dateRangeLabel}</div>
        </div>
        ${statusHtml}
      </div>
      <div class="week-card-actions">${actionsHtml}</div>
    `;
    wrap.appendChild(card);
  });

  wrap.querySelectorAll("[data-action]").forEach(btn => {
    const weekId = btn.dataset.week;
    if (btn.dataset.action === "start") btn.onclick = () => startWeekExam(weekId);
    if (btn.dataset.action === "resume") btn.onclick = () => resumeWeekExam(weekId);
    if (btn.dataset.action === "view") btn.onclick = () => viewWeekResult(weekId);
  });
}

async function startWeekExam(weekId) {
  currentWeek = weeksManifest.find(w => w.id === weekId);
  if (!isWeekUnlocked(currentWeek)) return; // guard against stale DOM/back-button access
  await loadExamData();
  const checkbox = $("#declaration-checkbox");
  const beginBtn = $("#btn-begin-from-instructions");
  checkbox.checked = false;
  beginBtn.disabled = true;
  show("#screen-instructions");
}

async function resumeWeekExam(weekId) {
  currentWeek = weeksManifest.find(w => w.id === weekId);
  if (!isWeekUnlocked(currentWeek)) return;
  await loadExamData();
  state = loadProgress();
  if (!state) { initLanding(); return; }
  enterExam(true);
}

async function viewWeekResult(weekId) {
  currentWeek = weeksManifest.find(w => w.id === weekId);
  await loadExamData();
  const entries = getHistoryForWeek(weekId);
  if (entries.length === 0) return;
  renderResult(entries[0]);
  show("#screen-result");
}

function renderLandingHistoryPreview() {
  const hist = getHistory();
  const el = $("#landing-history-preview");
  if (hist.length === 0) {
    el.innerHTML = `<p style="color:#888;font-size:13px;">No attempts yet. Your results will appear here after your first exam.</p>`;
    return;
  }
  const best = hist[0];
  el.innerHTML = `<p style="font-size:13px;color:#555;">Last attempt: <b>${best.score}/${best.totalMarks}</b> (${best.percentage}%) on ${new Date(best.date).toLocaleDateString()}</p>`;
}

// ---------------- Instructions screen ----------------
function initInstructions() {
  const checkbox = $("#declaration-checkbox");
  const beginBtn = $("#btn-begin-from-instructions");
  beginBtn.disabled = true;
  checkbox.checked = false;
  checkbox.onchange = () => { beginBtn.disabled = !checkbox.checked; };
  beginBtn.onclick = () => {
    state = freshState();
    saveProgress();
    enterExam(false);
  };
}

// ---------------- Exam screen ----------------
function enterExam(resuming) {
  show("#screen-exam");
  renderSectionTabs();
  ensureSectionClockStarted(state.currentSectionIdx);
  startSectionTimer();
  renderQuestion();
  renderPalette();
  saveProgress();
}

// Sets an absolute wall-clock deadline the first time a section is entered, so the
// countdown keeps running (and can expire) even if the browser is closed and reopened
// later -- matching how the real server-side NEET PG timer behaves.
function ensureSectionClockStarted(idx) {
  const secState = state.sectionState[idx];
  if (!secState.startedAt) secState.startedAt = nowTs();
  if (!secState.endTimestamp) secState.endTimestamp = nowTs() + secState.remainingSeconds * 1000;
}

function currentSection() { return examData.sections[state.currentSectionIdx]; }
function currentSectionState() { return state.sectionState[state.currentSectionIdx]; }
function currentQuestionId() { return currentSection().questionIds[state.currentQIdxInSection]; }

function startSectionTimer() {
  if (timerInterval) clearInterval(timerInterval);
  // Immediately reconcile in case time passed while the tab/browser was closed.
  reconcileSectionTime();
  if (currentSectionState().remainingSeconds <= 0) {
    submitCurrentSection(true);
    return;
  }
  timerInterval = setInterval(() => {
    const secState = currentSectionState();
    if (secState.submitted) return;
    reconcileSectionTime();
    updateTimerDisplay();
    if (secState.remainingSeconds <= 0) {
      submitCurrentSection(true);
    }
    if (secState.remainingSeconds % 5 === 0) saveProgress();
  }, 1000);
  updateTimerDisplay();
}

// Recomputes remainingSeconds from the absolute end-timestamp rather than decrementing
// a counter, so elapsed real-world time (including while closed) is always honored.
function reconcileSectionTime() {
  const secState = currentSectionState();
  secState.remainingSeconds = Math.max(0, Math.round((secState.endTimestamp - nowTs()) / 1000));
}

function updateTimerDisplay() {
  const secState = currentSectionState();
  const timerEl = $("#exam-timer");
  timerEl.textContent = fmtTime(secState.remainingSeconds);
  timerEl.classList.toggle("low-time", secState.remainingSeconds <= 120);
}

function renderSectionTabs() {
  const wrap = $("#section-tabs");
  wrap.innerHTML = "";
  examData.sections.forEach((s, idx) => {
    const btn = document.createElement("button");
    btn.className = "section-tab";
    const secState = state.sectionState[idx];
    if (idx === state.currentSectionIdx) btn.classList.add("active");
    if (secState.submitted) {
      btn.classList.add("locked");
      btn.innerHTML = `${s.name} <span class="lock-icon">&#128274;</span>`;
    } else {
      btn.textContent = s.name;
    }
    wrap.appendChild(btn);
  });
}

function renderQuestion() {
  const qid = currentQuestionId();
  const q = questionById(qid);
  const resp = state.responses[qid];
  resp.visited = true;

  const secIdx = state.currentSectionIdx;
  const qIdxInSec = state.currentQIdxInSection;
  const totalInSec = currentSection().questionIds.length;
  // global question number across whole exam
  let globalNum = 0;
  for (let i = 0; i < secIdx; i++) globalNum += examData.sections[i].questionIds.length;
  globalNum += qIdxInSec + 1;

  $("#q-number").textContent = `Question No. ${globalNum}`;
  $("#q-section-progress").textContent = `${currentSection().name} \u2014 Question ${qIdxInSec + 1} of ${totalInSec}`;
  $("#q-text").textContent = q.question;

  const optsWrap = $("#options-list");
  optsWrap.innerHTML = "";
  ["A", "B", "C", "D"].forEach(letter => {
    const row = document.createElement("label");
    row.className = "option-row" + (resp.selected === letter ? " selected" : "");
    row.innerHTML = `
      <input type="radio" name="option" value="${letter}" ${resp.selected === letter ? "checked" : ""}>
      <span class="option-label">${letter}.</span>
      <span class="option-text">${q.options[letter]}</span>
    `;
    row.querySelector("input").addEventListener("change", () => {
      resp.selected = letter;
      renderQuestion();
      renderPalette();
      saveProgress();
    });
    optsWrap.appendChild(row);
  });

  $("#btn-prev-question").disabled = (qIdxInSec === 0);
  const isLastInSection = (qIdxInSec === totalInSec - 1);
  $("#btn-save-next").textContent = isLastInSection ? "Save" : "Save & Next";
  $("#btn-mark-next").textContent = isLastInSection ? "Mark for Review" : "Mark for Review & Next";

  renderSectionTabs();
}

function moveToQuestion(idx) {
  const totalInSec = currentSection().questionIds.length;
  if (idx < 0 || idx >= totalInSec) return;
  state.currentQIdxInSection = idx;
  renderQuestion();
  renderPalette();
  saveProgress();
}

function handleSaveNext() {
  const qIdxInSec = state.currentQIdxInSection;
  const totalInSec = currentSection().questionIds.length;
  if (qIdxInSec < totalInSec - 1) {
    moveToQuestion(qIdxInSec + 1);
  } else {
    renderPalette();
    saveProgress();
  }
}

function handleMarkNext() {
  const qid = currentQuestionId();
  state.responses[qid].marked = true;
  handleSaveNext();
}

function handleClear() {
  const qid = currentQuestionId();
  state.responses[qid].selected = null;
  renderQuestion();
  renderPalette();
  saveProgress();
}

function handlePrev() {
  moveToQuestion(state.currentQIdxInSection - 1);
}

function questionStatusClass(qid) {
  const r = state.responses[qid];
  if (!r.visited) return "";
  if (r.selected && r.marked) return "answered-marked";
  if (r.marked) return "marked";
  if (r.selected) return "answered";
  return "not-answered";
}

function renderPalette() {
  const grid = $("#palette-grid");
  grid.innerHTML = "";
  const ids = currentSection().questionIds;
  let answered = 0, notAnswered = 0, notVisited = 0, marked = 0, answeredMarked = 0;
  ids.forEach((qid, i) => {
    const r = state.responses[qid];
    const btn = document.createElement("button");
    btn.className = "palette-btn " + questionStatusClass(qid);
    if (i === state.currentQIdxInSection) btn.classList.add("current");
    btn.textContent = i + 1;
    btn.onclick = () => moveToQuestion(i);
    grid.appendChild(btn);

    if (!r.visited) notVisited++;
    else if (r.selected && r.marked) answeredMarked++;
    else if (r.marked) marked++;
    else if (r.selected) answered++;
    else notAnswered++;
  });
  $("#summary-answered").textContent = answered + answeredMarked;
  $("#summary-not-answered").textContent = notAnswered;
  $("#summary-not-visited").textContent = notVisited;
  $("#summary-marked").textContent = marked + answeredMarked;
}

function submitCurrentSection(auto) {
  const secState = currentSectionState();
  if (secState.submitted) return;
  secState.submitted = true;
  clearInterval(timerInterval);
  saveProgress();

  const isLastSection = state.currentSectionIdx === examData.sections.length - 1;
  if (isLastSection) {
    finishExam();
  } else {
    if (auto) {
      alert(`Time up for ${currentSection().name}. Moving to the next section.`);
    }
    state.currentSectionIdx += 1;
    state.currentQIdxInSection = 0;
    ensureSectionClockStarted(state.currentSectionIdx);
    renderSectionTabs();
    startSectionTimer();
    renderQuestion();
    renderPalette();
    saveProgress();
  }
}

function confirmSubmitSection() {
  const secState = currentSectionState();
  const ids = currentSection().questionIds;
  const unanswered = ids.filter(id => !state.responses[id].selected).length;
  const msg = unanswered > 0
    ? `You have ${unanswered} unanswered question(s) in ${currentSection().name}. Submit this section anyway?`
    : `Submit ${currentSection().name} and move on? You cannot return to this section.`;
  if (confirm(msg)) submitCurrentSection(false);
}

function confirmSubmitExam() {
  if (confirm("Submit the entire exam now? This cannot be undone.")) {
    // submit all remaining (non-submitted) sections as-is
    for (let i = state.currentSectionIdx; i < examData.sections.length; i++) {
      state.sectionState[i].submitted = true;
    }
    clearInterval(timerInterval);
    finishExam();
  }
}

// ---------------- Scoring & results ----------------
function computeResults() {
  let totalScore = 0, correctCount = 0, wrongCount = 0, unattemptedCount = 0;
  const sectionBreakdown = [];
  const perQuestion = [];

  examData.sections.forEach(sec => {
    let secScore = 0, secCorrect = 0, secWrong = 0, secUnattempted = 0;
    sec.questionIds.forEach(qid => {
      const q = questionById(qid);
      const r = state.responses[qid];
      let outcome = "unattempted";
      let marks = 0;
      if (r.selected) {
        if (r.selected === q.correct) {
          marks = examData.marksPerCorrect;
          outcome = "correct";
          secCorrect++;
        } else {
          marks = examData.marksPerWrong;
          outcome = "incorrect";
          secWrong++;
        }
      } else {
        secUnattempted++;
      }
      secScore += marks;
      perQuestion.push({ qid, outcome, selected: r.selected, marks, section: sec.name });
    });
    totalScore += secScore;
    correctCount += secCorrect;
    wrongCount += secWrong;
    unattemptedCount += secUnattempted;
    sectionBreakdown.push({
      name: sec.name, score: secScore, correct: secCorrect, wrong: secWrong,
      unattempted: secUnattempted, total: sec.questionIds.length
    });
  });

  const percentage = ((totalScore / examData.totalMarks) * 100).toFixed(1);
  return { totalScore, correctCount, wrongCount, unattemptedCount, sectionBreakdown, perQuestion, percentage };
}

function finishExam() {
  state.submitted = true;
  const results = computeResults();
  const entry = {
    date: nowTs(),
    weekId: currentWeek.id,
    examTitle: examData.examTitle,
    score: results.totalScore,
    totalMarks: examData.totalMarks,
    percentage: results.percentage,
    correctCount: results.correctCount,
    wrongCount: results.wrongCount,
    unattemptedCount: results.unattemptedCount,
    sectionBreakdown: results.sectionBreakdown,
    perQuestion: results.perQuestion,
  };
  saveHistoryEntry(entry);
  clearProgress();
  renderResult(entry);
  show("#screen-result");
}

// ---------------- Result screen ----------------
function renderResult(entry) {
  $("#result-score").textContent = `${entry.score} / ${entry.totalMarks}`;
  $("#result-percentage").textContent = `${entry.percentage}%`;
  $("#result-correct").textContent = entry.correctCount;
  $("#result-wrong").textContent = entry.wrongCount;
  $("#result-unattempted").textContent = entry.unattemptedCount;

  const tbody = $("#section-breakdown-body");
  tbody.innerHTML = "";
  entry.sectionBreakdown.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${s.name}</td><td>${s.score}</td><td>${s.correct}</td><td>${s.wrong}</td><td>${s.unattempted}</td><td>${s.total}</td>`;
    tbody.appendChild(tr);
  });

  const reviewWrap = $("#review-list");
  reviewWrap.innerHTML = "";
  entry.perQuestion.forEach(pq => {
    const q = questionById(pq.qid);
    const div = document.createElement("div");
    div.className = `review-item ${pq.outcome}`;
    let optionsHtml = "";
    ["A", "B", "C", "D"].forEach(letter => {
      let cls = "";
      if (letter === q.correct) cls = "correct-answer";
      else if (letter === pq.selected) cls = "wrong-selected";
      optionsHtml += `<div class="review-option ${cls}">${letter}. ${q.options[letter]}</div>`;
    });
    div.innerHTML = `
      <span class="review-tag">${pq.outcome.toUpperCase()} (${pq.marks > 0 ? "+" : ""}${pq.marks})</span>
      <div style="font-size:12px;color:#777;margin-bottom:6px;">${pq.section} \u00b7 ${q.subject} \u2014 ${q.topic}</div>
      <div style="font-weight:bold;margin-bottom:10px;">${q.question}</div>
      ${optionsHtml}
      <div class="review-explanation"><b>Explanation:</b> ${q.explanation}</div>
    `;
    reviewWrap.appendChild(div);
  });
}

// ---------------- History dashboard ----------------
function renderHistory() {
  const hist = getHistory();
  const wrap = $("#history-content");
  if (hist.length === 0) {
    wrap.innerHTML = `<div class="history-empty">No attempts yet. Take your first weekly exam to see results here.</div>`;
    return;
  }
  let html = `<table class="history-table"><thead><tr>
    <th>Date</th><th>Exam</th><th>Score</th><th>%</th><th>Correct</th><th>Wrong</th><th>Unattempted</th>
  </tr></thead><tbody>`;
  hist.forEach(h => {
    html += `<tr>
      <td>${new Date(h.date).toLocaleString()}</td>
      <td>${h.examTitle}</td>
      <td>${h.score} / ${h.totalMarks}</td>
      <td>${h.percentage}%</td>
      <td>${h.correctCount}</td>
      <td>${h.wrongCount}</td>
      <td>${h.unattemptedCount}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  wrap.innerHTML = html;
}

// ---------------- Wire up navigation buttons ----------------
function wireStaticButtons() {
  $("#btn-prev-question").onclick = handlePrev;
  $("#btn-save-next").onclick = handleSaveNext;
  $("#btn-mark-next").onclick = handleMarkNext;
  $("#btn-clear-response").onclick = handleClear;
  $("#btn-submit-section").onclick = confirmSubmitSection;
  $("#btn-submit-exam").onclick = confirmSubmitExam;
  $("#btn-back-to-landing-from-result").onclick = () => { initLanding(); show("#screen-landing"); };
  $("#btn-back-to-landing-from-history").onclick = () => { initLanding(); show("#screen-landing"); };
  $("#btn-export-history").onclick = exportHistory;
  $("#btn-import-history").onclick = () => $("#import-file-input").click();
  $("#import-file-input").addEventListener("change", importHistory);
}

function exportHistory() {
  const hist = getHistory();
  const blob = new Blob([JSON.stringify(hist, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `neetpg-results-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importHistory(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      const existing = getHistory();
      const merged = existing.concat(imported);
      localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(merged));
      renderHistory();
      alert("Results imported successfully.");
    } catch (err) {
      alert("Could not read that file. Make sure it's a results JSON exported from this site.");
    }
  };
  reader.readAsText(file);
}

// ---------------- Boot ----------------
async function boot() {
  await loadWeeksManifest();
  wireStaticButtons();
  initInstructions();
  initLanding();
  show("#screen-landing");

  // Keep the "Unlocks in Xd Xh Xm" countdown live while the landing screen is visible.
  setInterval(() => {
    if (!$("#screen-landing").classList.contains("hidden")) renderWeekList();
  }, 30000);
}

document.addEventListener("DOMContentLoaded", boot);
