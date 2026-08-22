// ============================================================
// NEET PG-style CBT practice exam engine
// Pure vanilla JS, localStorage persistence, no backend.
// ============================================================

const STORAGE_KEY_HISTORY_PREFIX = "neetpg_history_";
const STORAGE_KEY_CURRENT_PROFILE = "neetpg_current_profile";
const STORAGE_KEY_KNOWN_NAMES = "neetpg_known_names";
const WEEKS_FILE = "data/weeks.json";

// Once an exam is in progress, leaving fullscreen or switching tabs/apps counts
// as a violation. After this many violations the exam is force-submitted.
// (No website can block OS-level app-switching like Alt+Tab/Cmd+Tab -- this
// is the detect-and-consequence approach real proctored exam platforms use.)
const MAX_VIOLATIONS = 3;

// A week's exam unlocks at 1:00 PM IST on that week's weekEndDate (the Sunday
// closing out the study week), regardless of what timezone the browser is in.
const UNLOCK_HOUR_IST = 13; // 1 PM

let currentProfile = null; // { id, name, userType } -- the logged-in account (id is the DB row's uuid)
let weekOverrides = {};    // weekId -> boolean, admin-controlled, applies to everyone
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

// Escapes any string before it's interpolated into an innerHTML template literal.
// Needed anywhere content originated from a user (a registered name) or from data an
// authenticated client could submit directly via RPC (week IDs, exam titles, section
// breakdowns, per-question review data) -- none of that is guaranteed safe HTML just
// because it came from our own database. Content from our own static exam JSON files
// (question text, options, explanations) doesn't need this, since only the site owner
// ever edits those files.
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------- Custom modal (replaces native confirm/alert) ----------------
// Native confirm()/alert() are OS-rendered and can interact unpredictably with the
// Fullscreen API on some browsers (notably iPadOS Safari briefly drops fullscreen when
// one appears). A plain in-page HTML modal has no such side effect, since there's no
// native browser chrome involved at all.
function customAlert(message) {
  return new Promise(resolve => {
    showCustomModal(message, false, () => resolve());
  });
}

function customConfirm(message) {
  return new Promise(resolve => {
    showCustomModal(message, true, (result) => resolve(result));
  });
}

function showCustomModal(message, isConfirm, callback) {
  const overlay = $("#custom-modal-overlay");
  const msgEl = $("#custom-modal-message");
  const okBtn = $("#custom-modal-ok");
  const cancelBtn = $("#custom-modal-cancel");
  msgEl.textContent = message;
  cancelBtn.classList.toggle("hidden", !isConfirm);
  overlay.classList.remove("hidden");

  function cleanup() {
    overlay.classList.add("hidden");
    okBtn.onclick = null;
    cancelBtn.onclick = null;
  }
  okBtn.onclick = () => { cleanup(); callback(true); };
  cancelBtn.onclick = () => { cleanup(); callback(false); };
}

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
  if (weekOverrides[week.id]) return true; // admin has force-unlocked this week for everyone
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
    violations: 0,
    breachLog: [],
  };
}

// ---------------- User login (custom name + PIN accounts) ----------------
// No Supabase Auth involved at all -- name+PIN is checked against our own `users`
// table (PIN hashed with pgcrypto) via the register_user/login_user SQL functions.
// This is deliberately low-security by design (a small personal-use project): the
// `users` table itself is locked down so pin hashes can't be fetched directly, but
// exam_history and week_overrides are left fully open, as requested.
let supabaseClient = null;

function isSyncConfigured() {
  return typeof SUPABASE_URL === "string" &&
    typeof SUPABASE_ANON_KEY === "string" &&
    !SUPABASE_ANON_KEY.includes("PASTE_YOUR");
}

function initSupabaseClient() {
  if (!isSyncConfigured() || typeof window.supabase === "undefined") return false;
  if (!supabaseClient) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return true;
}

function normalizeProfileName(name) { return name.trim(); }

function rememberNameLocally(name) {
  const raw = localStorage.getItem(STORAGE_KEY_KNOWN_NAMES);
  let names = [];
  try { names = raw ? JSON.parse(raw) : []; } catch (e) { names = []; }
  if (!names.includes(name)) names.push(name);
  localStorage.setItem(STORAGE_KEY_KNOWN_NAMES, JSON.stringify(names));
}
function loadRememberedNames() {
  const raw = localStorage.getItem(STORAGE_KEY_KNOWN_NAMES);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}

function profileFromRpcRow(row) {
  return { id: row.id, name: row.name, userType: row.user_type, token: row.token };
}

// Returns { ok: true, profile } or { ok: false, message }
async function registerUser(name, pin) {
  const trimmedName = normalizeProfileName(name);
  if (!trimmedName) return { ok: false, message: "Enter your name." };
  if (!pin || !passwordMeetsAllRules(pin)) return { ok: false, message: "Password doesn't meet all the requirements above." };
  if (!initSupabaseClient()) return { ok: false, message: "Can't reach the server right now -- check your internet connection." };

  const { data, error } = await supabaseClient.rpc("register_user", { p_name: trimmedName, p_pin: pin });
  if (error) {
    if (error.message && error.message.includes("NAME_TAKEN")) {
      return { ok: false, message: "That name is already registered -- use Login instead." };
    }
    return { ok: false, message: error.message };
  }
  rememberNameLocally(trimmedName);
  return { ok: true, profile: profileFromRpcRow(data[0]) };
}

// Returns { ok: true, profile } or { ok: false, message }
async function loginUser(name, pin) {
  const trimmedName = normalizeProfileName(name);
  if (!trimmedName) return { ok: false, message: "Enter your name." };
  if (!pin) return { ok: false, message: "Enter your password." };
  if (!initSupabaseClient()) return { ok: false, message: "Can't reach the server right now -- check your internet connection." };

  const { data, error } = await supabaseClient.rpc("login_user", { p_name: trimmedName, p_pin: pin });
  if (error) {
    if (error.message && error.message.startsWith("ACCOUNT_LOCKED:")) {
      const seconds = parseInt(error.message.split(":")[1], 10) || 0;
      const mins = Math.max(1, Math.ceil(seconds / 60));
      return { ok: false, message: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.` };
    }
    return { ok: false, message: error.message };
  }
  if (!data || data.length === 0) return { ok: false, message: "Incorrect name or password." };
  rememberNameLocally(trimmedName);
  return { ok: true, profile: profileFromRpcRow(data[0]) };
}

// Re-checks a remembered session against the server. The server always derives the
// REAL id/name/user_type from the token's verified signature -- a locally-edited
// localStorage value (e.g. someone setting userType to "ADMIN" in dev tools) has no
// effect the moment this runs, since we discard the local copy's fields in favor of
// what the server returns. Returns:
//   { status: "ok", profile }      -- verified; profile reflects the real DB values
//   { status: "invalid" }          -- token missing/bad signature/expired -- must re-login
//   { status: "offline" }          -- couldn't reach the server right now (not a rejection;
//                                     lets offline exam-taking keep working from cached data)
async function verifySessionToken(token) {
  if (!token) return { status: "invalid" };
  if (!initSupabaseClient()) return { status: "offline" };
  try {
    const { data, error } = await supabaseClient.rpc("verify_session", { p_token: token });
    if (error) return { status: "offline" };
    if (!data || data.length === 0) return { status: "invalid" };
    const row = data[0];
    return { status: "ok", profile: { id: row.user_id, name: row.name, userType: row.user_type, token } };
  } catch (e) {
    return { status: "offline" };
  }
}

function saveRememberedProfile(profile) {
  localStorage.setItem(STORAGE_KEY_CURRENT_PROFILE, JSON.stringify(profile));
}
function loadRememberedProfile() {
  const raw = localStorage.getItem(STORAGE_KEY_CURRENT_PROFILE);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
function clearRememberedProfile() {
  localStorage.removeItem(STORAGE_KEY_CURRENT_PROFILE);
}

async function establishSessionAsProfile(profile) {
  currentProfile = profile;
  saveRememberedProfile(profile);
  updateCandidateNameDisplays();
  if (initSupabaseClient()) {
    await loadWeekOverrides();
    await syncHistoryWithCloud();
  }
  await startAppForCurrentProfile();
}

function logoutCurrentProfile() {
  clearRememberedProfile();
  currentProfile = null;
}

function historyStorageKey() { return STORAGE_KEY_HISTORY_PREFIX + currentProfile.id; }

function updateCandidateNameDisplays() {
  document.querySelectorAll(".candidate-name-display").forEach(el => { el.textContent = currentProfile.name; });
  const avatar = $("#candidate-avatar");
  if (avatar) avatar.textContent = currentProfile.name.charAt(0).toUpperCase();
  const adminBtn = $("#btn-open-admin");
  if (adminBtn) {
    adminBtn.classList.toggle("hidden", !isAdmin());
    adminBtn.onclick = openAdminPanel;
  }
}

function isAdmin() { return !!currentProfile && currentProfile.userType === "ADMIN"; }

// ---------------- Progress & history (namespaced per active profile) ----------------
function progressKey(weekId) { return `neetpg_inprogress_${currentProfile.id}_${weekId}`; }


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
  const raw = localStorage.getItem(historyStorageKey());
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function getHistoryForWeek(weekId) {
  return getHistory().filter(h => h.weekId === weekId);
}
function generateId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now() + "-" + Math.random().toString(36).slice(2);
}
function saveHistoryEntry(entry) {
  if (!entry.id) entry.id = generateId();
  const hist = getHistory();
  hist.unshift(entry);
  localStorage.setItem(historyStorageKey(), JSON.stringify(hist));
  pushHistoryEntryToCloud(entry); // no-op if not configured
}

// ---------------- Week unlock overrides (admin-controlled, applies to everyone) ----------------
async function loadWeekOverrides() {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.from("week_overrides").select("*");
  if (error) { console.error("couldn't load week overrides:", error); return; }
  weekOverrides = {};
  (data || []).forEach(row => { weekOverrides[row.week_id] = row.force_unlocked; });
}

async function setWeekOverride(weekId, forceUnlocked) {
  if (!supabaseClient || !currentProfile) return;
  const { error } = await supabaseClient.rpc("set_week_override", {
    p_token: currentProfile.token,
    p_week_id: weekId,
    p_force_unlocked: forceUnlocked,
  });
  if (error) { customAlert("Couldn't update that week's lock: " + error.message); return; }
  weekOverrides[weekId] = forceUnlocked;
  renderWeekList();
  if (!$("#screen-admin").classList.contains("hidden")) renderAdminWeekControls();
}

// ---------------- Exam history sync (via token-verified RPC functions) ----------------
function rowToHistoryEntry(r) {
  return {
    id: r.id,
    weekId: r.week_id,
    examTitle: r.exam_title,
    score: r.score,
    totalMarks: r.total_marks,
    percentage: r.percentage,
    correctCount: r.correct_count,
    wrongCount: r.wrong_count,
    unattemptedCount: r.unattempted_count,
    violations: r.violations,
    autoSubmittedForViolations: r.auto_submitted_for_violations,
    sectionBreakdown: r.section_breakdown,
    perQuestion: r.per_question,
    date: new Date(r.attempt_date).getTime(),
    userName: r.user_name,
  };
}

function pushHistoryEntryToCloud(entry) {
  if (!supabaseClient || !currentProfile) return;
  submitExamResultToCloud(entry).then(({ error }) => {
    if (error) console.error("cloud sync (push) failed:", error);
  });
}

function submitExamResultToCloud(entry) {
  return supabaseClient.rpc("submit_exam_result", {
    p_token: currentProfile.token,
    p_id: entry.id,
    p_week_id: entry.weekId,
    p_exam_title: entry.examTitle,
    p_score: entry.score,
    p_total_marks: entry.totalMarks,
    p_percentage: entry.percentage,
    p_correct_count: entry.correctCount,
    p_wrong_count: entry.wrongCount,
    p_unattempted_count: entry.unattemptedCount,
    p_violations: entry.violations || 0,
    p_auto_submitted_for_violations: !!entry.autoSubmittedForViolations,
    p_section_breakdown: entry.sectionBreakdown,
    p_per_question: entry.perQuestion,
    p_attempt_date: new Date(entry.date).toISOString(),
  });
}

async function syncHistoryWithCloud() {
  if (!supabaseClient || !currentProfile) return;
  const { data: remoteRows, error } = await supabaseClient.rpc("get_my_history", { p_token: currentProfile.token });
  if (error) { console.error("cloud sync (pull) failed:", error); return; }

  const localHistory = getHistory();
  const localIds = new Set(localHistory.map(h => h.id));
  const remoteIds = new Set((remoteRows || []).map(r => r.id));

  const remoteOnly = (remoteRows || []).filter(r => !localIds.has(r.id)).map(rowToHistoryEntry);
  if (remoteOnly.length) {
    const merged = [...localHistory, ...remoteOnly].sort((a, b) => b.date - a.date);
    localStorage.setItem(historyStorageKey(), JSON.stringify(merged));
  }

  const localOnly = localHistory.filter(h => !remoteIds.has(h.id));
  for (const entry of localOnly) {
    const { error: insertError } = await submitExamResultToCloud(entry);
    if (insertError) console.error("cloud sync (initial push) failed:", insertError);
  }
}

// ---------------- Admin panel ----------------
let resultBackTarget = "landing"; // "landing" or "admin" -- where the result screen's Back button goes
let adminUsersCache = [];

async function openAdminPanel() {
  show("#screen-admin");
  renderAdminWeekControls();
  await loadAndRenderAdminUsers();
}

function renderAdminWeekControls() {
  const wrap = $("#admin-week-controls");
  if (!wrap || !weeksManifest) return;
  wrap.innerHTML = "";
  weeksManifest.forEach(week => {
    const forced = !!weekOverrides[week.id];
    const row = document.createElement("div");
    row.className = "admin-week-row";
    row.innerHTML = `
      <span class="admin-week-label">${week.label} <span class="admin-week-dates">${week.dateRangeLabel}</span></span>
      <button class="btn ${forced ? "btn-submit" : "btn-clear"} admin-toggle-btn">${forced ? "Unlocked early (click to reset to schedule)" : "Force unlock now"}</button>
    `;
    row.querySelector(".admin-toggle-btn").onclick = () => setWeekOverride(week.id, !forced);
    wrap.appendChild(row);
  });
}

async function loadAndRenderAdminUsers() {
  const content = $("#admin-content");
  if (!supabaseClient || !isAdmin()) { content.innerHTML = "<p>Not authorized.</p>"; return; }
  content.innerHTML = "<p>Loading...</p>";

  const { data: users, error } = await supabaseClient
    .from("users_public").select("*").order("created_at", { ascending: true });
  if (error) { content.innerHTML = `<p>Couldn't load users: ${escapeHtml(error.message)}</p>`; return; }

  adminUsersCache = users || [];
  if (adminUsersCache.length === 0) {
    content.innerHTML = "<p>No users registered yet.</p>";
    return;
  }

  content.innerHTML = "";
  const list = document.createElement("div");
  list.className = "admin-users-list";
  adminUsersCache.forEach(u => {
    const row = document.createElement("div");
    row.className = "admin-user-row";
    row.innerHTML = `
      <div class="admin-user-header">
        <span>${escapeHtml(u.name)}${u.user_type === "ADMIN" ? ' <span class="admin-badge">Admin</span>' : ""}</span>
        <button class="btn btn-clear admin-expand-btn">Show Attempts</button>
      </div>
      <div class="admin-user-attempts hidden"></div>
    `;
    const expandBtn = row.querySelector(".admin-expand-btn");
    const attemptsWrap = row.querySelector(".admin-user-attempts");
    expandBtn.onclick = async () => {
      const isHidden = attemptsWrap.classList.contains("hidden");
      if (isHidden) {
        attemptsWrap.classList.remove("hidden");
        expandBtn.textContent = "Hide Attempts";
        await loadAndRenderUserAttempts(u, attemptsWrap);
      } else {
        attemptsWrap.classList.add("hidden");
        expandBtn.textContent = "Show Attempts";
      }
    };
    list.appendChild(row);
  });
  content.appendChild(list);
}

async function loadAndRenderUserAttempts(user, container) {
  container.innerHTML = "<p>Loading...</p>";
  const { data, error } = await supabaseClient.rpc("get_user_history_admin", {
    p_token: currentProfile.token,
    p_target_user_id: user.id,
  });
  if (error) { container.innerHTML = `<p>Couldn't load attempts: ${escapeHtml(error.message)}</p>`; return; }
  if (!data || data.length === 0) { container.innerHTML = "<p>No attempts yet.</p>"; return; }

  const weekLabelById = {};
  (weeksManifest || []).forEach(w => { weekLabelById[w.id] = w.label; });

  const table = document.createElement("table");
  table.className = "section-breakdown admin-results-table";
  table.innerHTML = `
    <thead><tr><th>Week</th><th>Score</th><th>%</th><th>Violations</th><th>Date</th><th></th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  data.map(rowToHistoryEntry).forEach(entry => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${weekLabelById[entry.weekId] || escapeHtml(entry.weekId)}</td>
      <td>${entry.score}/${entry.totalMarks}</td>
      <td>${entry.percentage}%</td>
      <td>${entry.violations || 0}</td>
      <td>${new Date(entry.date).toLocaleString()}</td>
      <td><button class="btn btn-clear admin-view-btn">View</button></td>
    `;
    tr.querySelector(".admin-view-btn").onclick = () => viewResultAsAdmin(entry);
    tbody.appendChild(tr);
  });
  container.innerHTML = "";
  container.appendChild(table);
}

async function viewResultAsAdmin(entry) {
  const week = (weeksManifest || []).find(w => w.id === entry.weekId);
  if (!week) { customAlert("Couldn't find that week's question file."); return; }
  currentWeek = week;
  await loadExamData();
  resultBackTarget = "admin";
  renderResult(entry);
  show("#screen-result");
}

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
    const scheduledUnlocked = nowTs() >= week.unlockTimestamp;
    const adminOverride = unlocked && !scheduledUnlocked && weekOverrides[week.id];
    const savedProgress = unlocked ? loadProgressFor(week.id) : null;
    const inProgress = !!(savedProgress && !savedProgress.submitted);
    const weekHistory = getHistoryForWeek(week.id);
    const hasCompleted = weekHistory.length > 0 && !inProgress;

    const card = document.createElement("div");
    card.className = "week-card" + (unlocked ? "" : " locked");

    let statusHtml, actionsHtml;
    const adminNote = adminOverride
      ? `<div class="admin-override-note">Unlocked early by admin &mdash; normally unlocks ${formatUnlockLabel(week.unlockTimestamp)}</div>`
      : "";

    if (!unlocked) {
      statusHtml = `<span class="week-status-badge locked">Locked</span>`;
      actionsHtml = `<div class="week-lock-note">Unlocks ${formatUnlockLabel(week.unlockTimestamp)}
        <span class="week-countdown">(in ${formatCountdown(week.unlockTimestamp - nowTs())})</span></div>`;
    } else if (inProgress) {
      statusHtml = `<span class="week-status-badge inprogress">In Progress</span>`;
      actionsHtml = adminNote + `<button class="btn btn-mark" data-action="resume" data-week="${week.id}">Resume Exam</button>`;
    } else if (hasCompleted) {
      const best = weekHistory[0];
      statusHtml = `<span class="week-status-badge completed">Completed &mdash; ${best.score}/${best.totalMarks} (${best.percentage}%)</span>`;
      actionsHtml = adminNote + `
        <button class="btn btn-clear" data-action="view" data-week="${week.id}">View Result</button>
        <button class="btn btn-submit" data-action="start" data-week="${week.id}">Retake Exam</button>`;
    } else {
      statusHtml = `<span class="week-status-badge available">Available</span>`;
      actionsHtml = adminNote + `<button class="btn btn-submit" data-action="start" data-week="${week.id}">Start Exam</button>`;
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

// ---------------- Exam lockdown (fullscreen + tab/app-switch detection) ----------------
// Honest limitation: no webpage can block OS-level app switching (Alt+Tab / Cmd+Tab) --
// browsers deliberately don't expose that control to any site. What this DOES do,
// matching how real browser-based proctored exams work: force fullscreen, detect every
// exit from fullscreen or the tab/window (visibilitychange), log it as a violation with
// a visible warning, and auto-submit the exam once MAX_VIOLATIONS is reached.
let lockdownActive = false;
let blurDebounceTimer = null;
let lastViolationAt = 0;

function enterLockdown() {
  if (lockdownActive) return;
  lockdownActive = true;
  document.body.classList.add("exam-lockdown");
  requestExamFullscreen();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("contextmenu", blockContextMenu);
  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("blur", handleWindowBlur);
  window.addEventListener("focus", handleWindowFocus);
}

function exitLockdown() {
  if (!lockdownActive) return;
  lockdownActive = false;
  document.body.classList.remove("exam-lockdown");
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.removeEventListener("contextmenu", blockContextMenu);
  window.removeEventListener("beforeunload", handleBeforeUnload);
  window.removeEventListener("blur", handleWindowBlur);
  window.removeEventListener("focus", handleWindowFocus);
  if (blurDebounceTimer) { clearTimeout(blurDebounceTimer); blurDebounceTimer = null; }
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {}); // no-op if browser refuses; not critical
  }
  hideViolationOverlay();
  const tip = $("#guided-access-tip");
  if (tip) tip.classList.add("hidden");
}

function requestExamFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen) {
    el.requestFullscreen().catch(() => {
      // Fullscreen was rejected (e.g. Screen Time/MDM content restrictions) -- the
      // tab/app-switch detection below still works without it.
      showGuidedAccessTip();
    });
  } else {
    // No Fullscreen API at all (e.g. iPhone Safari, some in-app browsers).
    showGuidedAccessTip();
  }
}

function showGuidedAccessTip() {
  const tip = $("#guided-access-tip");
  if (tip) tip.classList.remove("hidden");
}

function blockContextMenu(e) { e.preventDefault(); }

function handleBeforeUnload(e) {
  e.preventDefault();
  e.returnValue = ""; // browsers show their own generic "leave site?" text; can't be customized
}

function handleVisibilityChange() {
  if (!lockdownActive || state.submitted) return;
  if (document.hidden) recordViolation("Left the exam tab/window (switched app or tab)");
}

function handleFullscreenChange() {
  if (!lockdownActive || state.submitted) return;
  if (!document.fullscreenElement) recordViolation("Exited fullscreen mode");
}

// Catches switching to a different APPLICATION while this tab stays open in the
// background -- visibilitychange alone doesn't reliably catch this, since a page can
// remain "visible" per the Page Visibility spec even when the window itself has lost
// OS-level focus (e.g. Alt+Tab/Cmd+Tab to another app without minimizing the browser).
// Debounced by 400ms so brief internal focus flickers (nothing to do with switching
// apps) don't get counted -- a genuine app switch lasts much longer than that.
function handleWindowBlur() {
  if (!lockdownActive || state.submitted) return;
  if (blurDebounceTimer) clearTimeout(blurDebounceTimer);
  blurDebounceTimer = setTimeout(() => {
    if (!document.hasFocus()) recordViolation("Switched to another app (window lost focus)");
  }, 400);
}

function handleWindowFocus() {
  if (blurDebounceTimer) { clearTimeout(blurDebounceTimer); blurDebounceTimer = null; }
}

function recordViolation(reason) {
  if (!state || state.submitted) return;
  // Some real switch-away events fire BOTH visibilitychange and blur nearly
  // simultaneously (e.g. minimizing the whole browser) -- treat anything within a
  // second of the last recorded violation as the same event, not two separate ones.
  const now = nowTs();
  if (now - lastViolationAt < 1000) return;
  lastViolationAt = now;

  state.violations += 1;
  state.breachLog.push({ reason, at: nowTs() });
  saveProgress();

  if (state.violations >= MAX_VIOLATIONS) {
    showViolationOverlay(reason, true);
    forceSubmitDueToViolations();
  } else {
    showViolationOverlay(reason, false);
  }
}

function showViolationOverlay(reason, isFinal) {
  const overlay = $("#lockdown-warning");
  if (!overlay) return;
  const remaining = Math.max(0, MAX_VIOLATIONS - state.violations);
  $("#lockdown-warning-reason").textContent = reason;
  $("#lockdown-warning-count").textContent = isFinal
    ? `That was violation ${state.violations} of ${MAX_VIOLATIONS} -- the exam has been auto-submitted.`
    : `Violation ${state.violations} of ${MAX_VIOLATIONS}. ${remaining} more and the exam auto-submits.`;
  $("#btn-lockdown-return").classList.toggle("hidden", isFinal);
  overlay.classList.remove("hidden");
}

function hideViolationOverlay() {
  const overlay = $("#lockdown-warning");
  if (overlay) overlay.classList.add("hidden");
}

function forceSubmitDueToViolations() {
  for (let i = state.currentSectionIdx; i < examData.sections.length; i++) {
    state.sectionState[i].submitted = true;
  }
  clearInterval(timerInterval);
  finishExam();
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
  enterLockdown();
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

async function submitCurrentSection(auto) {
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
      await customAlert(`Time up for ${currentSection().name}. Moving to the next section.`);
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

async function confirmSubmitSection() {
  const secState = currentSectionState();
  const ids = currentSection().questionIds;
  const unanswered = ids.filter(id => !state.responses[id].selected).length;
  const msg = unanswered > 0
    ? `You have ${unanswered} unanswered question(s) in ${currentSection().name}. Submit this section anyway?`
    : `Submit ${currentSection().name} and move on? You cannot return to this section.`;
  const ok = await customConfirm(msg);
  if (ok) submitCurrentSection(false);
}

async function confirmSubmitExam() {
  const ok = await customConfirm("Submit the entire exam now? This cannot be undone.");
  if (ok) {
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
  exitLockdown();
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
    violations: state.violations,
    autoSubmittedForViolations: state.violations >= MAX_VIOLATIONS,
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

  const integrityNote = $("#result-integrity-note");
  const violations = entry.violations || 0;
  if (entry.autoSubmittedForViolations) {
    integrityNote.textContent = `⚠️ This exam was auto-submitted after ${violations} exam-window violations (left the tab/app or exited fullscreen ${MAX_VIOLATIONS} times).`;
    integrityNote.classList.remove("hidden");
  } else if (violations > 0) {
    integrityNote.textContent = `Note: ${violations} exam-window violation${violations > 1 ? "s" : ""} recorded during this attempt (left the tab/app or exited fullscreen).`;
    integrityNote.classList.remove("hidden");
  } else {
    integrityNote.classList.add("hidden");
  }

  const tbody = $("#section-breakdown-body");
  tbody.innerHTML = "";
  entry.sectionBreakdown.forEach(s => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(s.name)}</td><td>${s.score}</td><td>${s.correct}</td><td>${s.wrong}</td><td>${s.unattempted}</td><td>${s.total}</td>`;
    tbody.appendChild(tr);
  });

  const reviewWrap = $("#review-list");
  reviewWrap.innerHTML = "";
  entry.perQuestion.forEach(pq => {
    const q = questionById(pq.qid);
    if (!q) return; // guards against a malformed/forged qid that doesn't match a real question
    const div = document.createElement("div");
    div.className = `review-item ${pq.outcome}`;
    let optionsHtml = "";
    ["A", "B", "C", "D"].forEach(letter => {
      let cls = "";
      if (letter === q.correct) cls = "correct-answer";
      else if (letter === pq.selected) cls = "wrong-selected";
      optionsHtml += `<div class="review-option ${cls}">${letter}. ${escapeHtml(q.options[letter])}</div>`;
    });
    div.innerHTML = `
      <span class="review-tag">${escapeHtml(pq.outcome.toUpperCase())} (${pq.marks > 0 ? "+" : ""}${pq.marks})</span>
      <div style="font-size:12px;color:#777;margin-bottom:6px;">${escapeHtml(pq.section)} \u00b7 ${escapeHtml(q.subject)} \u2014 ${escapeHtml(q.topic)}</div>
      <div style="font-weight:bold;margin-bottom:10px;">${escapeHtml(q.question)}</div>
      ${optionsHtml}
      <div class="review-explanation"><b>Explanation:</b> ${escapeHtml(q.explanation)}</div>
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
      <td>${escapeHtml(h.examTitle)}</td>
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
  $("#btn-back-to-landing-from-result").onclick = () => {
    if (resultBackTarget === "admin") { resultBackTarget = "landing"; openAdminPanel(); }
    else { initLanding(); show("#screen-landing"); }
  };
  $("#btn-back-to-landing-from-history").onclick = () => { initLanding(); show("#screen-landing"); };
  $("#btn-export-history").onclick = exportHistory;
  $("#btn-import-history").onclick = () => $("#import-file-input").click();
  $("#import-file-input").addEventListener("change", importHistory);
  $("#btn-lockdown-return").onclick = () => { hideViolationOverlay(); requestExamFullscreen(); };
  const dismissTip = $("#btn-dismiss-guided-access-tip");
  if (dismissTip) dismissTip.onclick = () => $("#guided-access-tip").classList.add("hidden");
  $("#btn-switch-user").onclick = () => {
    logoutCurrentProfile();
    renderKnownProfilesRow();
    $("#login-name-input").value = "";
    $("#login-pin-input").value = "";
    $("#login-error").classList.add("hidden");
    show("#screen-login");
  };
  $("#btn-refresh-admin").onclick = () => { renderAdminWeekControls(); loadAndRenderAdminUsers(); };
  $("#btn-back-to-landing-from-admin").onclick = () => { initLanding(); show("#screen-landing"); };
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
      localStorage.setItem(historyStorageKey(), JSON.stringify(merged));
      renderHistory();
      customAlert("Results imported successfully.");
    } catch (err) {
      customAlert("Could not read that file. Make sure it's a results JSON exported from this site.");
    }
  };
  reader.readAsText(file);
}

// ---------------- Boot ----------------
let appStarted = false;

async function boot() {
  wireLoginScreen();
  const remembered = loadRememberedProfile();
  if (remembered) {
    const result = await verifySessionToken(remembered.token);
    if (result.status === "ok") {
      currentProfile = result.profile;
      saveRememberedProfile(result.profile); // refresh local copy with server-confirmed values
      updateCandidateNameDisplays();
      await loadWeekOverrides();
      await syncHistoryWithCloud();
      await startAppForCurrentProfile();
    } else if (result.status === "offline") {
      // Can't reach the server right now -- proceed from cache so offline exam-taking
      // still works. Real verification resumes the next time this runs while online.
      currentProfile = remembered;
      updateCandidateNameDisplays();
      await startAppForCurrentProfile();
    } else {
      // Genuinely rejected: missing, bad signature, expired, or tampered with -- require
      // a fresh login rather than trusting anything already in localStorage.
      clearRememberedProfile();
      renderKnownProfilesRow();
      show("#screen-login");
    }
  } else {
    renderKnownProfilesRow();
    show("#screen-login");
  }
}

async function startAppForCurrentProfile() {
  updateCandidateNameDisplays();
  if (!appStarted) {
    appStarted = true;
    await loadWeeksManifest();
    wireStaticButtons();
    initInstructions();
    // Keep the "Unlocks in Xd Xh Xm" countdown live while the landing screen is visible.
    setInterval(() => {
      if (!$("#screen-landing").classList.contains("hidden")) renderWeekList();
    }, 30000);
  }
  initLanding();
  show("#screen-landing");
}

// ---------------- Password rules (live checklist as the user types) ----------------
const PASSWORD_RULES = [
  { key: "length", label: "At least 8 characters", test: (pw) => pw.length >= 8 },
  { key: "uppercase", label: "At least one uppercase letter", test: (pw) => /[A-Z]/.test(pw) },
  { key: "lowercase", label: "At least one lowercase letter", test: (pw) => /[a-z]/.test(pw) },
  { key: "number", label: "At least one number", test: (pw) => /[0-9]/.test(pw) },
  { key: "special", label: "At least one special character (e.g. ! @ # $ %)", test: (pw) => /[^A-Za-z0-9]/.test(pw) },
];

function passwordMeetsAllRules(pw) {
  return PASSWORD_RULES.every(rule => rule.test(pw));
}

function renderPasswordRulesChecklist(pw) {
  const list = $("#password-rules");
  if (!list) return;
  list.innerHTML = PASSWORD_RULES.map(rule => {
    const passed = rule.test(pw);
    return `<li class="${passed ? "rule-passed" : "rule-pending"}">${passed ? "&#10003;" : "&#9675;"} ${rule.label}</li>`;
  }).join("");
}

function wireLoginScreen() {
  renderKnownProfilesRow();
  renderPasswordRulesChecklist("");
  $("#btn-register").onclick = () => handleAuthSubmit("register");
  $("#btn-login").onclick = () => handleAuthSubmit("login");
  $("#login-pin-input").addEventListener("input", (e) => renderPasswordRulesChecklist(e.target.value));
  $("#login-pin-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleAuthSubmit("login"); });
  $("#login-name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-pin-input").focus(); });
}

async function handleAuthSubmit(mode) {
  const name = $("#login-name-input").value;
  const pin = $("#login-pin-input").value;
  const errorEl = $("#login-error");
  errorEl.classList.add("hidden");

  if (mode === "register" && !passwordMeetsAllRules(pin)) {
    errorEl.textContent = "Please meet all the password requirements above before registering.";
    errorEl.classList.remove("hidden");
    return;
  }

  $("#btn-register").disabled = true;
  $("#btn-login").disabled = true;
  const result = mode === "register" ? await registerUser(name, pin) : await loginUser(name, pin);
  $("#btn-register").disabled = false;
  $("#btn-login").disabled = false;

  if (!result.ok) {
    errorEl.textContent = result.message;
    errorEl.classList.remove("hidden");
    return;
  }
  $("#login-name-input").value = "";
  $("#login-pin-input").value = "";
  renderPasswordRulesChecklist("");
  await establishSessionAsProfile(result.profile);
}

function renderKnownProfilesRow() {
  const row = $("#known-profiles-row");
  if (!row) return;
  const names = loadRememberedNames();
  row.innerHTML = "";
  if (names.length === 0) return;

  const label = document.createElement("div");
  label.className = "known-profiles-label";
  label.textContent = "Used on this device before:";
  row.appendChild(label);

  names.forEach(name => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "profile-chip";
    chip.textContent = name;
    chip.onclick = () => {
      $("#login-name-input").value = name;
      $("#login-pin-input").value = "";
      $("#login-pin-input").focus();
    };
    row.appendChild(chip);
  });
}

document.addEventListener("DOMContentLoaded", boot);
