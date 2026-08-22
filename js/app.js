// ============================================================
// NEET PG-style CBT practice exam engine
// Pure vanilla JS, localStorage persistence, no backend.
// ============================================================

const STORAGE_KEY_HISTORY_PREFIX = "neetpg_history_";
const STORAGE_KEY_PROFILES = "neetpg_profiles";
const STORAGE_KEY_CURRENT_PROFILE = "neetpg_current_profile";
const WEEKS_FILE = "data/weeks.json";

// Once an exam is in progress, leaving fullscreen or switching tabs/apps counts
// as a violation. After this many violations the exam is force-submitted.
// (No website can block OS-level app-switching like Alt+Tab/Cmd+Tab -- this
// is the detect-and-consequence approach real proctored exam platforms use.)
const MAX_VIOLATIONS = 3;

// A week's exam unlocks at 1:00 PM IST on that week's weekEndDate (the Sunday
// closing out the study week), regardless of what timezone the browser is in.
const UNLOCK_HOUR_IST = 13; // 1 PM

let currentProfile = null; // { id, name } -- whose progress/history is currently active
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
  if (isAdminUser) return true; // signed-in admin can start any week early
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

// ---------------- Local user profiles (name + PIN) ----------------
// Lightweight, device-local separation so multiple people sharing this site/device
// each see only their own progress and results -- NOT a real security boundary (the
// PIN is just a switch-guard, not encryption), and separate from the Supabase sign-in
// above (which is about cross-device cloud sync of one person's own results).
function loadProfiles() {
  const raw = localStorage.getItem(STORAGE_KEY_PROFILES);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function saveProfiles(profiles) {
  localStorage.setItem(STORAGE_KEY_PROFILES, JSON.stringify(profiles));
}
function normalizeProfileName(name) { return name.trim(); }
function profileKeyFromName(name) { return normalizeProfileName(name).toLowerCase(); }

async function hashPin(pin) {
  const data = new TextEncoder().encode("neetpg-pin-salt::" + pin);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function findProfile(name) {
  const key = profileKeyFromName(name);
  return loadProfiles().find(p => p.id === key) || null;
}

// Returns { ok: true, profile } or { ok: false, message }
async function attemptLogin(name, pin) {
  const trimmedName = normalizeProfileName(name);
  if (!trimmedName) return { ok: false, message: "Enter your name." };
  if (!pin || pin.length < 4) return { ok: false, message: "PIN must be at least 4 digits." };

  const profiles = loadProfiles();
  const key = profileKeyFromName(trimmedName);
  const existing = profiles.find(p => p.id === key);
  const pinHash = await hashPin(pin);

  if (existing) {
    if (existing.pinHash !== pinHash) {
      return { ok: false, message: "Incorrect PIN for that name." };
    }
    return { ok: true, profile: existing };
  }

  const newProfile = { id: key, name: trimmedName, pinHash };
  profiles.push(newProfile);
  saveProfiles(profiles);
  return { ok: true, profile: newProfile };
}

function setActiveProfile(profile) {
  currentProfile = { id: profile.id, name: profile.name };
  localStorage.setItem(STORAGE_KEY_CURRENT_PROFILE, JSON.stringify(currentProfile));
}

function loadRememberedProfile() {
  const raw = localStorage.getItem(STORAGE_KEY_CURRENT_PROFILE);
  if (!raw) return null;
  try {
    const remembered = JSON.parse(raw);
    return findProfile(remembered.name) ? remembered : null;
  } catch (e) { return null; }
}

function historyStorageKey() { return STORAGE_KEY_HISTORY_PREFIX + currentProfile.id; }

function updateCandidateNameDisplays() {
  document.querySelectorAll(".candidate-name-display").forEach(el => { el.textContent = currentProfile.name; });
  const avatar = $("#candidate-avatar");
  if (avatar) avatar.textContent = currentProfile.name.charAt(0).toUpperCase();
}

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
  pushHistoryEntryToCloud(entry); // no-op if not signed in / not configured
}

// ---------------- Cross-device sync (Supabase) ----------------
// Entirely optional and additive: if SUPABASE_ANON_KEY hasn't been filled in, or the
// Supabase SDK didn't load, every function below silently no-ops and the site behaves
// exactly as it did with localStorage only. Nothing here can break offline/local use.
let supabaseClient = null;
let syncUser = null;   // current signed-in Supabase user, or null
let isAdminUser = false; // whether the signed-in user is confirmed admin (via is_admin() RPC)

function isSyncConfigured() {
  return typeof SUPABASE_URL === "string" &&
    typeof SUPABASE_ANON_KEY === "string" &&
    !SUPABASE_ANON_KEY.includes("PASTE_YOUR");
}

async function initSync() {
  if (!isSyncConfigured() || typeof window.supabase === "undefined") {
    renderSyncStatus();
    return;
  }
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    syncUser = session ? session.user : null;
    isAdminUser = false;
    renderSyncStatus();
    if (syncUser) { syncHistoryWithCloud(); checkAdminStatus(); }
  });

  const { data } = await supabaseClient.auth.getSession();
  syncUser = data.session ? data.session.user : null;
  renderSyncStatus();
  if (syncUser) { syncHistoryWithCloud(); await checkAdminStatus(); }
}

async function checkAdminStatus() {
  if (!supabaseClient || !syncUser) { isAdminUser = false; return; }
  const { data, error } = await supabaseClient.rpc("is_admin");
  isAdminUser = !error && data === true;
  renderSyncStatus();
  if (!$("#screen-landing").classList.contains("hidden")) renderWeekList();
}

async function requestMagicLink(email) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href },
  });
  const msgEl = $("#sync-status-message");
  if (error) {
    if (msgEl) { msgEl.textContent = "Couldn't send link: " + error.message; msgEl.classList.remove("hidden"); }
  } else if (msgEl) {
    msgEl.textContent = `Check ${email} for a sign-in link, then open it on this device.`;
    msgEl.classList.remove("hidden");
  }
}

async function signOutSync() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  syncUser = null;
  isAdminUser = false;
  renderSyncStatus();
  renderWeekList();
}

function historyEntryToRow(h, userId) {
  return {
    id: h.id,
    user_id: userId,
    user_email: syncUser ? syncUser.email : null,
    week_id: h.weekId,
    exam_title: h.examTitle,
    score: h.score,
    total_marks: h.totalMarks,
    percentage: h.percentage,
    correct_count: h.correctCount,
    wrong_count: h.wrongCount,
    unattempted_count: h.unattemptedCount,
    violations: h.violations || 0,
    auto_submitted_for_violations: !!h.autoSubmittedForViolations,
    section_breakdown: h.sectionBreakdown,
    per_question: h.perQuestion,
    attempt_date: new Date(h.date).toISOString(),
  };
}

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
    userEmail: r.user_email,
  };
}

// ---------------- Admin panel ----------------
let resultBackTarget = "landing"; // "landing" or "admin" -- where the result screen's Back button goes

async function openAdminPanel() {
  show("#screen-admin");
  await loadAndRenderAdminResults();
}

async function loadAndRenderAdminResults() {
  const content = $("#admin-content");
  if (!supabaseClient || !isAdminUser) { content.innerHTML = "<p>Not authorized.</p>"; return; }
  content.innerHTML = "<p>Loading...</p>";

  const { data, error } = await supabaseClient
    .from("exam_history").select("*").order("attempt_date", { ascending: false });
  if (error) { content.innerHTML = `<p>Couldn't load results: ${error.message}</p>`; return; }

  if (!data || data.length === 0) {
    content.innerHTML = "<p>No synced results yet from any user.</p>";
    return;
  }

  const rows = data.map(rowToHistoryEntry);
  const weekLabelById = {};
  (weeksManifest || []).forEach(w => { weekLabelById[w.id] = w.label; });

  const table = document.createElement("table");
  table.className = "section-breakdown admin-results-table";
  table.innerHTML = `
    <thead><tr><th>User</th><th>Week</th><th>Score</th><th>%</th><th>Violations</th><th>Date</th><th></th></tr></thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");
  rows.forEach(entry => {
    const tr = document.createElement("tr");
    const dateLabel = new Date(entry.date).toLocaleString();
    tr.innerHTML = `
      <td>${entry.userEmail || "(unknown)"}</td>
      <td>${weekLabelById[entry.weekId] || entry.weekId}</td>
      <td>${entry.score}/${entry.totalMarks}</td>
      <td>${entry.percentage}%</td>
      <td>${entry.violations || 0}</td>
      <td>${dateLabel}</td>
      <td><button class="btn btn-clear admin-view-btn">View</button></td>
    `;
    tr.querySelector(".admin-view-btn").onclick = () => viewResultAsAdmin(entry);
    tbody.appendChild(tr);
  });

  content.innerHTML = "";
  content.appendChild(table);
}

async function viewResultAsAdmin(entry) {
  const week = (weeksManifest || []).find(w => w.id === entry.weekId);
  if (!week) { alert("Couldn't find that week's question file."); return; }
  currentWeek = week;
  await loadExamData();
  resultBackTarget = "admin";
  renderResult(entry);
  show("#screen-result");
}

function pushHistoryEntryToCloud(entry) {
  if (!supabaseClient || !syncUser) return;
  supabaseClient.from("exam_history").insert([historyEntryToRow(entry, syncUser.id)])
    .then(({ error }) => { if (error) console.error("cloud sync (push) failed:", error); });
}

async function syncHistoryWithCloud() {
  if (!supabaseClient || !syncUser) return;
  const { data: remoteRows, error } = await supabaseClient
    .from("exam_history").select("*").eq("user_id", syncUser.id);
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
  if (localOnly.length) {
    const rows = localOnly.map(h => historyEntryToRow(h, syncUser.id));
    const { error: insertError } = await supabaseClient.from("exam_history").insert(rows);
    if (insertError) console.error("cloud sync (initial push) failed:", insertError);
  }

  initLanding();
  if (!$("#screen-history").classList.contains("hidden")) renderHistory();
}

function renderSyncStatus() {
  const box = $("#sync-status-box");
  if (!box) return;

  if (!isSyncConfigured() || typeof window.supabase === "undefined") {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");

  if (syncUser) {
    const adminBadge = isAdminUser
      ? ` <span class="admin-badge">Admin</span> <button id="btn-open-admin" class="btn btn-mark" style="margin-left:0;">Admin Panel</button>`
      : "";
    box.innerHTML = `
      <span>Syncing as <b>${syncUser.email}</b>${adminBadge}</span>
      <button id="btn-sync-signout" class="btn btn-clear" style="margin-left:0;">Sign out</button>
    `;
    $("#btn-sync-signout").onclick = signOutSync;
    const adminBtn = $("#btn-open-admin");
    if (adminBtn) adminBtn.onclick = openAdminPanel;
  } else {
    box.innerHTML = `
      <span>Sync results across devices:</span>
      <input id="sync-email-input" type="email" placeholder="you@example.com" />
      <button id="btn-sync-signin" class="btn btn-mark" style="margin-left:0;">Email me a sign-in link</button>
      <div id="sync-status-message" class="hidden"></div>
    `;
    $("#btn-sync-signin").onclick = () => {
      const email = $("#sync-email-input").value.trim();
      if (email) requestMagicLink(email);
    };
  }
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
    const adminOverride = unlocked && !scheduledUnlocked && isAdminUser;
    const savedProgress = unlocked ? loadProgressFor(week.id) : null;
    const inProgress = !!(savedProgress && !savedProgress.submitted);
    const weekHistory = getHistoryForWeek(week.id);
    const hasCompleted = weekHistory.length > 0 && !inProgress;

    const card = document.createElement("div");
    card.className = "week-card" + (unlocked ? "" : " locked");

    let statusHtml, actionsHtml;
    const adminNote = adminOverride
      ? `<div class="admin-override-note">Unlocked early (admin) &mdash; normally unlocks ${formatUnlockLabel(week.unlockTimestamp)}</div>`
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

function enterLockdown() {
  if (lockdownActive) return;
  lockdownActive = true;
  document.body.classList.add("exam-lockdown");
  requestExamFullscreen();
  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("fullscreenchange", handleFullscreenChange);
  document.addEventListener("contextmenu", blockContextMenu);
  window.addEventListener("beforeunload", handleBeforeUnload);
}

function exitLockdown() {
  if (!lockdownActive) return;
  lockdownActive = false;
  document.body.classList.remove("exam-lockdown");
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  document.removeEventListener("fullscreenchange", handleFullscreenChange);
  document.removeEventListener("contextmenu", blockContextMenu);
  window.removeEventListener("beforeunload", handleBeforeUnload);
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

function recordViolation(reason) {
  if (!state || state.submitted) return;
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
    renderKnownProfilesRow();
    $("#login-name-input").value = "";
    $("#login-pin-input").value = "";
    $("#login-error").classList.add("hidden");
    show("#screen-login");
  };
  $("#btn-refresh-admin").onclick = loadAndRenderAdminResults;
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
      alert("Results imported successfully.");
    } catch (err) {
      alert("Could not read that file. Make sure it's a results JSON exported from this site.");
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
    currentProfile = remembered;
    await startAppForCurrentProfile();
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
    initSync();
    // Keep the "Unlocks in Xd Xh Xm" countdown live while the landing screen is visible.
    setInterval(() => {
      if (!$("#screen-landing").classList.contains("hidden")) renderWeekList();
    }, 30000);
  }
  initLanding();
  show("#screen-landing");
}

function wireLoginScreen() {
  renderKnownProfilesRow();
  $("#btn-login-continue").onclick = handleLoginSubmit;
  $("#login-pin-input").addEventListener("keydown", (e) => { if (e.key === "Enter") handleLoginSubmit(); });
  $("#login-name-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#login-pin-input").focus(); });
}

async function handleLoginSubmit() {
  const name = $("#login-name-input").value;
  const pin = $("#login-pin-input").value;
  const errorEl = $("#login-error");
  errorEl.classList.add("hidden");

  const result = await attemptLogin(name, pin);
  if (!result.ok) {
    errorEl.textContent = result.message;
    errorEl.classList.remove("hidden");
    return;
  }
  setActiveProfile(result.profile);
  $("#login-name-input").value = "";
  $("#login-pin-input").value = "";
  await startAppForCurrentProfile();
}

function renderKnownProfilesRow() {
  const row = $("#known-profiles-row");
  if (!row) return;
  const profiles = loadProfiles();
  row.innerHTML = "";
  if (profiles.length === 0) return;

  const label = document.createElement("div");
  label.className = "known-profiles-label";
  label.textContent = "Known on this device:";
  row.appendChild(label);

  profiles.forEach(p => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "profile-chip";
    chip.textContent = p.name;
    chip.onclick = () => {
      $("#login-name-input").value = p.name;
      $("#login-pin-input").value = "";
      $("#login-pin-input").focus();
    };
    row.appendChild(chip);
  });
}

document.addEventListener("DOMContentLoaded", boot);
