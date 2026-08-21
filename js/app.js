// ============================================================
// NEET PG-style CBT practice exam engine
// Pure vanilla JS, localStorage persistence, no backend.
// ============================================================

const STORAGE_KEY_PROGRESS = "neetpg_inprogress";
const STORAGE_KEY_HISTORY = "neetpg_history";
const QUESTION_FILE = "data/questions-week1.json";

let examData = null;       // loaded JSON
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

// ---------------- Loading question data ----------------
async function loadExamData() {
  const res = await fetch(QUESTION_FILE);
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

function saveProgress() {
  localStorage.setItem(STORAGE_KEY_PROGRESS, JSON.stringify(state));
}
function loadProgress() {
  const raw = localStorage.getItem(STORAGE_KEY_PROGRESS);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearProgress() {
  localStorage.removeItem(STORAGE_KEY_PROGRESS);
}

function getHistory() {
  const raw = localStorage.getItem(STORAGE_KEY_HISTORY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function saveHistoryEntry(entry) {
  const hist = getHistory();
  hist.unshift(entry);
  localStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(hist));
}

// ---------------- Landing screen ----------------
function initLanding() {
  const existing = loadProgress();
  const resumeBtn = $("#btn-resume-exam");
  const startBtn = $("#btn-start-exam");
  if (existing && !existing.submitted) {
    resumeBtn.classList.remove("hidden");
  } else {
    resumeBtn.classList.add("hidden");
  }
  startBtn.onclick = () => show("#screen-instructions");
  resumeBtn.onclick = () => { state = existing; enterExam(true); };
  $("#btn-view-history").onclick = () => { renderHistory(); show("#screen-history"); };
  renderLandingHistoryPreview();
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
  await loadExamData();
  wireStaticButtons();
  initInstructions();
  initLanding();
  show("#screen-landing");
}

document.addEventListener("DOMContentLoaded", boot);
