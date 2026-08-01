"use strict";

/* GATE_HASH and GATE_SALT come from gate.js. Static programme content
   from programme.js. Chart harness from charts.js. */

const LS_UNLOCK = "ft.unlocked.v1";
const LS_DATA = "ft.data.v1", LS_PREF = "ft.prefs.v1", LS_TOK = "ft.tok.v1";
const LS_GIST = "ft.gist.v1", LS_THEME = "ft.theme.v1", LS_DIRTY = "ft.dirty.v1";
const LS_LIFTS = "ft.lifts.v1";
const GIST_FILE = "focus-tracker-data.json";
const CSV_FILE = "focus-log.csv";

/* Core Three first -- a bad day that hits these three is a win. */
const KEYS = ["wake", "light", "train", "caff", "block", "log"];
const CORE3 = ["wake", "light", "train"];
const NAMES = { wake: "Wake ±30m", light: "Morning light", train: "Trained",
                caff: "Caffeine plan", block: "Both blocks", log: "Logged" };

/* Every user-editable day field. Drives dirty-tracking and emptiness.
   `focus` is retired from the UI but stays in the schema: removing it
   would break every CSV already downloaded and the JS/Python parity. */
const FIELDS = KEYS.concat(["wakeT", "bedT", "focus", "trainType", "train2",
                            "runKm", "liftTpl", "social", "protein", "note"]);

/* Weekly targets (PLAN §2). */
const T_LIFT = 3, T_RUN = 2, T_SOCIAL = 2, T_PROTEIN = 5;

const DEFAULT_PREFS = {
  programStart: "", targetWake: "06:30", targetWakeWeekend: "08:00",
  bodyweightKg: "", hrMax: "", week17: "",
  cDose: "160", cTime: "12:30", cBed: "23:00", cHalf: "5",
  loads: {}, parked: {}, _u: 0,
};

let DB = {}, PREFS = Object.assign({}, DEFAULT_PREFS);
/* Imported FitNotes lift detail, keyed by ISO date. Kept OUT of the day
   record on purpose: it is a variable-length list of sets, the day
   record is a flat row that has to survive a CSV round trip, and
   FitNotes -- not this app -- is its source of truth. */
let LIFTS = {}, LIFTS_U = 0;
let CUR = isoDay(new Date()), syncTimer = null;
/* Top-level gist keys we don't understand. Preserved verbatim on write
   so a future field added by any other client isn't destroyed. */
let REMOTE_EXTRA = {};
let VIEW = "today", WINDOW_DAYS = 56, DAYFILTER = "all", REVIEW_TABLE = false;

/* ---------- gate ---------- */
async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}
async function mkHash() {
  const v = el("gNew").value;
  el("gHash").textContent = v ? await sha256(GATE_SALT + v) : "—";
}
async function tryUnlock() {
  const h = await sha256(GATE_SALT + el("gPass").value);
  if (h === GATE_HASH) { lsSet(LS_UNLOCK, h); reveal(); }
  else { el("gErr").textContent = "Not that one."; el("gPass").select(); }
}
function lockNow() {
  lsDel(LS_UNLOCK);
  el("app").style.display = "none";
  el("gate").style.display = "flex";
  el("gPass").value = ""; el("gErr").textContent = "";
}
function reveal() {
  el("gate").style.display = "none";
  el("app").style.display = "block";
  boot();
}

/* ---------- helpers ---------- */
function el(id) { return document.getElementById(id); }
function isoDay(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
         "-" + String(d.getDate()).padStart(2, "0");
}
function dayFromIso(s) { const p = s.split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
function fmtDay(s) {
  return dayFromIso(s).toLocaleDateString(undefined,
    { weekday: "long", month: "short", day: "numeric" });
}
function fmtShortDay(s) {
  return dayFromIso(s).toLocaleDateString(undefined,
    { weekday: "short", month: "short", day: "numeric" });
}
function isWeekend(iso) { const w = dayFromIso(iso).getDay(); return w === 0 || w === 6; }
function hhmmToMin(t) { if (!t) return null; const p = t.split(":"); return (+p[0]) * 60 + (+p[1]); }
function minToHHMM(m) {
  m = Math.round(((m % 1440) + 1440) % 1440);
  return String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
}
const mins = hhmmToMin;
function pretty(m) {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), x = m % 60, ap = h < 12 ? "am" : "pm";
  return (h % 12 === 0 ? 12 : h % 12) + ":" + String(x).padStart(2, "0") + ap;
}
function addDays(iso, n) { const d = dayFromIso(iso); d.setDate(d.getDate() + n); return isoDay(d); }
function daysBetween(a, b) {
  return Math.round((dayFromIso(b) - dayFromIso(a)) / 86400000);
}

function blank() {
  return { wake: false, light: false, train: false, caff: false, block: false, log: false,
    wakeT: "", bedT: "", focus: "", trainType: "", train2: "", runKm: "", liftTpl: "",
    social: false, protein: false, note: "", _u: 0 };
}
/* Reading a day must never create it. Only save() brings one into being. */
function rec() { return DB[CUR] || blank(); }
function recW() { if (!DB[CUR]) DB[CUR] = blank(); return DB[CUR]; }
function sleepMins(r) {
  if (!r || !r.wakeT || !r.bedT) return null;
  let x = mins(r.wakeT) - mins(r.bedT); if (x < 0) x += 1440; return x;
}
function hasVal(v) { return v !== null && v !== undefined && v !== ""; }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function isEmpty(r) {
  if (!r) return true;
  if (KEYS.some(k => r[k]) || r.social || r.protein) return false;
  return !["wakeT", "bedT", "focus", "trainType", "train2", "runKm", "liftTpl", "note"]
    .some(f => hasVal(r[f]));
}
function prune(db) { Object.keys(db).forEach(d => { if (isEmpty(db[d])) delete db[d]; }); return db; }

/* A record existing is not evidence a human was there. Three writers make
   day records with nobody in the room: garmin_sync.py, fitnotes_sync.py,
   and the browser FitNotes import above (`if (!DB[iso]) DB[iso] = blank()`).
   Between them the machines own wake, train, wakeT, bedT, trainType, train2
   and runKm -- so none of those can attest to anything. What is left below
   is what only a person can put there.
   Without this, machine-made days both inflate coverage and sit in the
   denominator for light, caff, block and log, which no machine can write:
   the triage table would then judge you on days you never saw, deflating
   exactly the four items it exists to judge.
   `skipped` is listed although the field does not exist yet -- marking a day
   not-applicable is a human act, and hasVal() on an absent key is false, so
   naming it here costs nothing until Phase 6 ships the control. */
function attested(r) {
  return !!r && (["light", "caff", "block", "log"].some(k => r[k]) || r.social || r.protein ||
                 ["note", "liftTpl", "focus", "skipped"].some(f => hasVal(r[f])));
}

/* Latched the moment any write is refused -- a full disk, Safari private
   mode, storage blocked outright. Read by persist() and renderToday().
   Only a successful persist() clears it, because the whole day record
   landing is the evidence the store is usable again. */
let STORAGE_FAILED = false;
/* What navigator.storage.persist() answered at boot. Advisory. */
let STORAGE_PERSISTED = null;

function lsGet(k, f) { try { const v = localStorage.getItem(k); return v === null ? f : v; } catch (e) { return f; } }
/* Reports whether the value actually reached the disk. The old body
   swallowed QuotaExceededError, so persist() printed "saved" over a write
   that never happened -- a tap that looked recorded and was not, in an app
   whose only claim is an honest record. Callers that ignore the return
   behave exactly as before. */
function lsSet(k, v) {
  try { localStorage.setItem(k, v); return true; }
  catch (e) { STORAGE_FAILED = true; return false; }
}
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

/* WebKit's ITP evicts script-writable storage after seven days of Safari
   use without interaction, and the Review tab gets opened about six times
   a year -- so the log can be evicted between two visits that both felt
   normal. A persisted bucket is exempt. Advisory only: a false answer is
   not worth alarming anyone with, and boot must not wait on the promise. */
function askPersistentStorage() {
  if (!navigator.storage || typeof navigator.storage.persist !== "function") return;
  try {
    navigator.storage.persist().then(g => { STORAGE_PERSISTED = !!g; },
                                     () => { STORAGE_PERSISTED = false; });
  } catch (e) { STORAGE_PERSISTED = false; }
}

function persist() {
  const ok = lsSet(LS_DATA, JSON.stringify(DB));
  if (ok) STORAGE_FAILED = false;
  const p = el("savePill");
  if (p) {
    /* The word carries the state, not the border colour: .pill.err is a
       hue and a hairline, and neither survives a glance in morning sun. */
    p.textContent = ok
      ? "saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : "NOT SAVED";
    p.className = ok ? "pill ok" : "pill err";
  }
  /* The record is still whole in memory. Push it somewhere with room
     before the tab closes and takes it. */
  if (!ok) forcePush();
}
function loadLocal() { try { DB = prune(JSON.parse(lsGet(LS_DATA, "{}")) || {}); } catch (e) { DB = {}; } }
function loadLifts() {
  try {
    const o = JSON.parse(lsGet(LS_LIFTS, "{}")) || {};
    /* Older builds stored the day map bare. Accept both shapes. */
    if (o.days && typeof o.days === "object") { LIFTS = o.days; LIFTS_U = o._u || 0; }
    else { LIFTS = o; LIFTS_U = 0; }
  } catch (e) { LIFTS = {}; LIFTS_U = 0; }
}
function saveLifts() { lsSet(LS_LIFTS, JSON.stringify({ _u: LIFTS_U, days: LIFTS })); }

/* ---------- FitNotes import ----------
   FitNotes has no API and its Google Drive auto-backup lands in Drive's
   appDataFolder, which is scoped so ONLY the creating app can read it --
   not hidden, genuinely inaccessible to everything else. So the route in
   is the separate Spreadsheet Export (Settings > Data > Spreadsheet
   Export > Save Export), which writes an ordinary CSV. */
let FN_PENDING = null;

function fnFile(input) {
  const f = input.files && input.files[0];
  if (!f) return;
  const rd = new FileReader();
  rd.onload = () => fnPreview(String(rd.result || ""));
  rd.onerror = () => fnSay("Couldn't read that file.", true);
  rd.readAsText(f);
}
function fnPastePreview() { fnPreview(el("fnBox").value); }

/* Accepts either the FitNotes CSV export or the richer JSON emitted by
   sync/fitnotes_db.py, which carries PR flags and the routine the CSV
   throws away. Detected by shape, not by asking. */
function fnPreview(text) {
  const raw = String(text || "").trim();
  if (raw.charAt(0) === "{") return fnPreviewJSON(raw);
  const p = parseFitNotes(text);
  FN_PENDING = p.ok ? p : null;
  const box = el("fnResult");
  box.innerHTML = "";
  if (!p.ok) { fnSay(p.error, true); el("fnCommit").disabled = true; return; }

  const s = p.stats;
  const known = Object.keys(p.days).filter(d => DB[d]).length;
  const lines = [
    s.workouts + " workouts · " + s.sets + " sets · " + s.exercises + " exercises",
    s.from + " → " + s.to,
    known + " of those days already exist here and will be updated, not replaced",
  ];
  if (s.cardioRows) lines.push(s.cardioRows + " cardio rows kept as detail (Garmin still owns runs)");
  if (s.skipped) lines.push(s.skipped + " rows skipped — no usable date, exercise or reps");
  lines.forEach(t => { const d = document.createElement("div"); d.textContent = t; box.appendChild(d); });
  p.warnings.forEach(w => {
    const d = document.createElement("div"); d.className = "fnwarn"; d.textContent = "⚠ " + w; box.appendChild(d);
  });
  el("fnCommit").disabled = false;
  fnSay("");
}
function fnSay(t, bad) {
  const n = el("fnMsg"); if (!n) return;
  n.textContent = t || ""; n.className = "note" + (bad ? " bad" : "");
}

function fnPreviewJSON(raw) {
  const box = el("fnResult"); box.innerHTML = "";
  let o = null;
  try { o = JSON.parse(raw); } catch (e) { o = null; }
  if (!o || o.source !== "fitnotes-db" || !o.lifts) {
    FN_PENDING = null; el("fnCommit").disabled = true;
    fnSay("That JSON isn't from sync/fitnotes_db.py — expected a fitnotes-db document.", true);
    return;
  }
  FN_PENDING = { json: o };
  const t = o.totals || {};
  const known = Object.keys(o.lifts).filter(d => DB[d]).length;
  const lines = [
    (t.sets || 0) + " sets over " + (t.days || 0) + " days · " + (t.exercises || 0) +
      " exercises · " + (t.prs || 0) + " personal records",
    (o.range && o.range.from ? o.range.from + " → " + o.range.to : ""),
    "weights shown in " + (o.displayUnit === "kg" ? "kilograms" : "pounds") + ", as FitNotes has them",
    known + " of those days already exist here and will be updated, not replaced",
  ];
  if (o.routine) {
    const d = o.routine.days || {};
    const n = ["0", "1", "2", "3", "4", "5", "6"].filter(k => d[k]).length;
    lines.push("routine “" + o.routine.name + "” — " + n + " scheduled days, which will replace the built-in template");
  }
  lines.filter(Boolean).forEach(x => {
    const n = document.createElement("div"); n.textContent = x; box.appendChild(n);
  });
  if (o.userVersion && o.userVersion !== 22) {
    const w = document.createElement("div"); w.className = "fnwarn";
    w.textContent = "⚠ FitNotes schema version " + o.userVersion +
      " — the parser was written against 22. Check the numbers before trusting them.";
    box.appendChild(w);
  }
  el("fnCommit").disabled = false;
  fnSay("");
}

function fnCommitJSON(o) {
  let marked = 0;
  Object.keys(o.lifts).forEach(iso => {
    LIFTS[iso] = o.lifts[iso];
    if (!fitnotesIsLiftDay(o.lifts[iso])) return;
    const before = DB[iso] ? Object.assign({}, DB[iso]) : null;
    if (!DB[iso]) DB[iso] = blank();
    const r = DB[iso];
    r.train = true;
    if (!r.trainType) r.trainType = "lift";
    else if (r.trainType !== "lift" && !r.train2) r.train2 = "lift";
    r._u = Date.now();
    markDirty(iso, before, r);
    marked++;
  });
  PREFS.loads = o.loads || {};
  PREFS.unit = o.displayUnit === "kg" ? "kg" : "lb";
  if (o.routine) PREFS.routine = o.routine;
  LIFTS_U = Date.now();          /* this snapshot is now the newest */
  saveLifts(); persist(); savePrefs(); render();
  FN_PENDING = null;
  el("fnCommit").disabled = true;
  el("fnBox").value = "";
  fnSay("Imported " + marked + " training days, " +
    Object.keys(PREFS.loads).length + " exercise loads and " +
    ((o.totals && o.totals.prs) || 0) + " personal records" +
    (o.routine ? ", plus the “" + o.routine.name + "” routine." : "."));
}

function fnCommit() {
  const p = FN_PENDING;
  if (!p) return;
  if (p.json) return fnCommitJSON(p.json);
  if (!p.ok) return;
  let marked = 0;
  Object.keys(p.days).forEach(iso => {
    LIFTS[iso] = p.days[iso];
    if (!fitnotesIsLiftDay(p.days[iso])) return;
    const before = DB[iso] ? Object.assign({}, DB[iso]) : null;
    if (!DB[iso]) DB[iso] = blank();
    const r = DB[iso];
    r.train = true;
    /* Never clobber what Garmin recorded -- if the day already has a
       run, the lift becomes the second session rather than replacing it. */
    if (!r.trainType) r.trainType = "lift";
    else if (r.trainType !== "lift" && !r.train2) r.train2 = "lift";
    r._u = Date.now();
    markDirty(iso, before, r);
    marked++;
  });
  Object.keys(p.loads).forEach(k => { PREFS.loads[k] = p.loads[k]; });
  LIFTS_U = Date.now();
  saveLifts(); persist(); savePrefs(); render();
  FN_PENDING = null;
  el("fnCommit").disabled = true;
  el("fnBox").value = "";
  fnSay("Imported. " + marked + " days marked as lift sessions and " +
    Object.keys(p.loads).length + " exercise loads updated.");
}
function fnClear() {
  LIFTS = {}; LIFTS_U = Date.now(); saveLifts();
  fnSay("Imported lift detail cleared. Your day records and ticks are untouched.");
  render();
}

/* ---------- prefs ---------- */
/* Prefs are configuration, not a day record: one object, its own _u,
   last-write-wins as a whole. They change about four times a year, so
   per-key timestamps would be machinery for a problem that won't occur. */
function loadPrefs() {
  try {
    const p = JSON.parse(lsGet(LS_PREF, "null"));
    if (p) PREFS = Object.assign({}, DEFAULT_PREFS, p);
  } catch (e) {}
  if (!PREFS.loads) PREFS.loads = {};
  if (!PREFS.parked) PREFS.parked = {};
}
function savePrefs(touch) {
  if (touch !== false) PREFS._u = Date.now();
  lsSet(LS_PREF, JSON.stringify(PREFS));
  queueSync();
}
function targetFor(iso) {
  const t = isWeekend(iso) ? PREFS.targetWakeWeekend : PREFS.targetWake;
  return hasVal(t) ? mins(t) : null;
}
function isParked(k) { return !!PREFS.parked[k]; }

/* ---------- unsynced-edit tracking ---------- */
/* The in-memory copy is the authority. Re-reading the store after a
   refused write hands back the list from before the tap, so the field just
   edited stops counting as unsynced and the merge overlay drops it on the
   next pull -- the failed save would take the edit twice.
   Callers get a copy, not the live object: syncNow holds one across the
   PATCH await as the snapshot it will later drop, and a tap made during
   that flight must not be dropped along with it. */
let DIRTY_MEM = null;
function loadDirty() {
  if (!DIRTY_MEM) {
    try { DIRTY_MEM = JSON.parse(lsGet(LS_DIRTY, "{}")) || {}; } catch (e) { DIRTY_MEM = {}; }
  }
  const out = {};
  Object.keys(DIRTY_MEM).forEach(day => { out[day] = DIRTY_MEM[day].slice(); });
  return out;
}
function saveDirty(d) { DIRTY_MEM = d; lsSet(LS_DIRTY, JSON.stringify(d)); }
function markDirty(day, before, after) {
  const d = loadDirty(), set = {}, base = before || blank();
  (d[day] || []).forEach(f => set[f] = 1);
  FIELDS.forEach(f => { if (base[f] !== after[f]) set[f] = 1; });
  const list = Object.keys(set);
  if (list.length) { d[day] = list; saveDirty(d); }
}
function dropDirty(sent) {
  const d = loadDirty();
  Object.keys(sent).forEach(day => {
    if (!d[day]) return;
    const gone = {}; sent[day].forEach(f => gone[f] = 1);
    const left = d[day].filter(f => !gone[f]);
    if (left.length) d[day] = left; else delete d[day];
  });
  saveDirty(d);
}

/* ---------- router ---------- */
const VIEWS = ["today", "programme", "review", "setup"];
function go(v) { location.hash = "#" + v; }
function applyRoute() {
  let v = (location.hash || "#today").replace("#", "");
  if (VIEWS.indexOf(v) < 0) v = "today";
  VIEW = v;
  VIEWS.forEach(name => {
    const node = el("v-" + name);
    if (node) node.style.display = name === v ? "block" : "none";
    const tab = el("tab-" + name);
    if (tab) {
      tab.classList.toggle("on", name === v);
      tab.setAttribute("aria-current", name === v ? "page" : "false");
    }
  });
  render();
  window.scrollTo(0, 0);
  if (typeof chartsOnShow === "function") chartsOnShow();
}

/* ---------- day nav ---------- */
/* Clamped at today. A day that has not happened cannot be ticked. */
function shiftDay(n) {
  const next = addDays(CUR, n), todayIso = isoDay(new Date());
  CUR = next > todayIso ? todayIso : next;
  loadDay(); render();
}
function goToday() { CUR = isoDay(new Date()); loadDay(); render(); }

function save() {
  const before = DB[CUR] ? Object.assign({}, DB[CUR]) : null;
  const day = CUR, t = recW();
  document.querySelectorAll("#tapList input[type=checkbox]").forEach(cb => {
    t[cb.dataset.k] = cb.checked;
  });
  t.wakeT = el("fWake").value;
  t.bedT = el("fBed").value;
  t.trainType = el("fTrain").value;
  t.train2 = el("fTrain2").value;
  t.runKm = el("fRunKm").value;
  t.liftTpl = el("fLiftTpl").value;
  t.social = el("fSocial").checked;
  t.protein = el("fProtein").checked;
  t.note = el("fNote").value;
  t._u = Date.now();
  markDirty(day, before, t);
  if (isEmpty(t)) delete DB[day];
  persist(); render(); queueSync();
}
function loadDay() {
  const t = rec();
  document.querySelectorAll("#tapList input[type=checkbox]").forEach(cb => {
    cb.checked = !!t[cb.dataset.k];
  });
  el("fWake").value = t.wakeT || "";
  el("fBed").value = t.bedT || "";
  el("fTrain").value = t.trainType || "";
  el("fTrain2").value = t.train2 || "";
  el("fRunKm").value = t.runKm || "";
  el("fLiftTpl").value = t.liftTpl || "";
  el("fSocial").checked = !!t.social;
  el("fProtein").checked = !!t.protein;
  el("fNote").value = t.note || "";
}

/* ---------- caffeine ---------- */
function calcCaff() {
  const dose = +el("cDose").value || 0;
  const tk = mins(el("cTime").value), bd = mins(el("cBed").value);
  const hl = +el("cHalf").value;
  if (tk === null || bd === null || !dose) return;
  let elapsed = bd - tk; if (elapsed < 0) elapsed += 1440;
  const frac = Math.pow(0.5, (elapsed / 60) / hl);
  const cutoffH = 4.54 + 0.0398 * dose;
  const latest = bd - Math.round(cutoffH * 60);
  const overBy = (cutoffH * 60) - elapsed;
  const okDose = Math.max(0, Math.round((elapsed / 60 - 4.54) / 0.0398));
  setText("cMg", (dose * frac).toFixed(0) + " mg");
  setText("cPct", (frac * 100).toFixed(0) + "%");
  setText("cCut", pretty(latest));
  setText("caffSummary", "Latest coffee " + pretty(latest) + " · " + dose + " mg at " + el("cTime").value);
  const v = el("cVerdict"); v.className = "verdict";
  let cls, t, d;
  if (overBy <= 0) {
    cls = "v-good"; t = "Inside the modelled window";
    d = "Clear by " + Math.round(-overBy) + " min. Ignores guarana's unlabelled caffeine — keep margin.";
  } else if (overBy <= 60) {
    cls = "v-warn"; t = "Marginal — about " + Math.round(overBy) + " min late";
    d = "Move it " + Math.round(overBy) + " min earlier, or drop to ~" + okDose +
        " mg. Lower dose keeps nearly all the evidenced benefit.";
  } else {
    cls = "v-crit"; t = "About " + (overBy / 60).toFixed(1) + "h too late";
    d = "At this dose you'd need it by " + pretty(latest) + ", or cut to ~" + okDose +
        " mg. Drake et al.: 400 mg six hours pre-bed cost >1h of sleep objectively, with no self-reported signal.";
  }
  v.classList.add(cls);
  setText("cvT", t); setText("cvD", d);
  PREFS.cDose = el("cDose").value; PREFS.cTime = el("cTime").value;
  PREFS.cBed = el("cBed").value; PREFS.cHalf = el("cHalf").value;
}
function setText(id, s) { const n = el(id); if (n) n.textContent = s; }

/* ---------- programme clock (PLAN §3, §4) ---------- */
/* Everything here derives from programStart + weekday. No history
   required, which is why the Programme tab is correct on install day. */
function progWeek(iso) {
  if (!hasVal(PREFS.programStart)) return null;
  const n = daysBetween(PREFS.programStart, iso || isoDay(new Date()));
  if (n < 0) return null;
  return Math.floor(n / 7) + 1;
}
/* Your imported routine wins over the built-in A/B template. PLAN §3's
   EVIDENCE still applies -- the 8–12 sets/muscle/week band, RIR 2, the
   progression rule -- but the prescription is the split you actually run,
   not one you don't. */
function routineDay(iso) {
  const r = PREFS.routine;
  if (!r || !r.days) return null;
  return r.days[String(dayFromIso(iso).getDay())] || null;
}
function unitLabel() { return PREFS.unit === "kg" ? "kg" : "lb"; }
/* Stored weights are always kg; FitNotes converts for display. Round to the
   nearest half unit so a 135 lb lift that round-tripped through kg reads
   "135 lb" and not "135.0" or "134.9". */
function showWeight(kg) {
  if (kg === null || kg === undefined || kg === "") return "";
  const n = +kg; if (!isFinite(n)) return "";
  if (!n) return "bodyweight";
  let v = PREFS.unit === "kg" ? n : n / 0.45359237;
  v = Math.round(v * 2) / 2;
  return (v % 1 === 0 ? String(v) : v.toFixed(1)) + " " + unitLabel();
}
function loadText(name) {
  const l = PREFS.loads && PREFS.loads[name];
  if (!l) return "";
  if (typeof l === "string") return l;            /* legacy CSV import */
  return showWeight(l.kg) + " × " + l.reps;
}

function dayPlan(iso) {
  const dow = dayFromIso(iso).getDay();       /* 0 Sun .. 6 Sat */
  const wk = progWeek(iso);
  const rd = routineDay(iso);
  if (rd) {
    return { kind: "lift", week: wk, routine: rd, template: null,
      detail: rd.section + " — " + rd.exercises.length + " exercises, " +
        rd.exercises.reduce((a, e) => a + (e.sets || 0), 0) + " sets." };
  }
  if (PREFS.routine) {                        /* routine exists, nothing today */
    return { kind: "rest", week: wk, detail: "Rest. Nothing prescribed today." };
  }
  if (dow === 2 || dow === 4) {               /* Tue / Thu = run */
    const w = wk && wk >= 1 && wk <= RUN_WEEKS.length ? RUN_WEEKS[wk - 1] : null;
    return { kind: "run", week: wk,
      detail: w ? (dow === 2 ? w.tue : w.thu)
                : "Set a programme start date in Setup to see this week's protocol.",
      note: w ? w.note : "" };
  }
  if (dow === 1 || dow === 3 || dow === 5) {  /* Mon / Wed / Fri = lift */
    const idx = ["", 0, "", 1, "", 2, ""][dow];
    const tpl = wk ? (((wk - 1) * 3 + idx) % 2 === 0 ? "A" : "B") : null;
    return { kind: "lift", week: wk, template: tpl,
      detail: tpl ? ("Session " + tpl + " — five lifts, ~45–55 min.")
                  : "Set a programme start date in Setup to see whether today is A or B." };
  }
  return { kind: "rest", week: wk, detail: "Rest. Nothing prescribed today." };
}
/* 110% of the longest run in the previous 30 days (PLAN §4). */
function runCeiling(iso) {
  let longest = 0, seen = 0;
  for (let i = 1; i <= 30; i++) {
    const r = DB[addDays(iso, -i)];
    if (r && hasVal(r.runKm)) { const v = +r.runKm; if (!isNaN(v)) { seen++; if (v > longest) longest = v; } }
  }
  if (!seen || !longest) return { known: false, longest: 0, ceiling: 0 };
  return { known: true, longest: longest, ceiling: longest * 1.1 };
}

/* ---------- week windows ---------- */
/* CALENDAR week (Mon-Sun). §2's targets are per-week and §4 counts
   programme weeks, so a rolling 7-day window makes both wrong. */
function weekOf(iso) {
  const d = dayFromIso(iso), dow = (d.getDay() + 6) % 7;   /* Mon = 0 */
  const mon = addDays(iso, -dow), out = [];
  for (let i = 0; i < 7; i++) out.push(addDays(mon, i));
  return out;
}
function windowDays(n) {
  const out = [], today = isoDay(new Date());
  for (let i = n - 1; i >= 0; i--) out.push(addDays(today, -i));
  return out;
}
function filteredDays() {
  let d = windowDays(WINDOW_DAYS);
  if (hasVal(PREFS.programStart) && WINDOW_DAYS >= 9999) {
    d = d.filter(x => x >= PREFS.programStart);
  }
  if (DAYFILTER === "weekdays") d = d.filter(x => !isWeekend(x));
  if (DAYFILTER === "weekends") d = d.filter(isWeekend);
  return d;
}

/* ---------- render ---------- */
/* Persistent header chrome. Lives outside the four view renderers
   because the header does: reloading on #review used to leave the week
   label blank until you happened to visit Today. */
function renderChrome() {
  const hw = el("hdrWeek");
  if (!hw) return;
  const w = progWeek(isoDay(new Date()));
  hw.textContent = w ? "Week " + w + (w <= 16 ? " of 16" : "") : "";
}

function render() {
  renderChrome();
  if (VIEW === "today") renderToday();
  else if (VIEW === "programme") renderProgramme();
  else if (VIEW === "review") renderReview();
  else if (VIEW === "setup") renderSetup();
  if (typeof chartsOnShow === "function") chartsOnShow();
}

/* ===== TODAY ===== */
function renderToday() {
  const todayIso = isoDay(new Date());
  const r = DB[CUR];
  const hit = CORE3.filter(k => r && r[k]).length;

  /* Date nav. You cannot walk into the future: ticking a day that has
     not happened is the one way to put a lie in the record, and the
     rest of the app is built on not doing that. */
  const away = CUR !== todayIso;
  setText("todayLabel", fmtDay(CUR) + (away ? "" : " · today"));
  const bt = el("btnToday");
  if (bt) {
    bt.classList.toggle("away", away);
    bt.disabled = !away;
    /* Keep the date in the accessible name. An aria-label REPLACES the
       visible text, so "Back to today" alone would drop the one thing
       this control exists to report: which day the six taps write to. */
    bt.setAttribute("aria-label",
      away ? fmtDay(CUR) + ", back to today" : fmtDay(CUR) + ", today");
  }
  const nx = el("btnNextDay");
  if (nx) nx.disabled = CUR >= todayIso;

  /* THE LATCH -- a READ-OUT, not a control. The six rows below are the
     only place the record is written: one state, one write target.
     Bars are reused rather than rebuilt so the fill actually animates
     when one closes. */
  setText("heroNum", hit + "/3");
  const segs = el("coreMeter");
  if (segs) {
    if (segs.children.length !== CORE3.length) {
      segs.innerHTML = "";
      CORE3.forEach(() => segs.appendChild(document.createElement("div")));
    }
    CORE3.forEach((k, i) => {
      segs.children[i].className = "bar" + (r && r[k] ? " on" : "");
    });
    segs.setAttribute("aria-label",
      "Core Three: " + hit + " of 3 closed — " +
      CORE3.map(k => NAMES[k] + " " + (r && r[k] ? "done" : "open")).join(", "));
  }

  const left = CORE3.filter(k => !(r && r[k])).map(k => NAMES[k].toLowerCase());
  const others = ["caff", "block", "log"].filter(k => !(r && r[k])).length;
  const state = el("latchState");
  if (state) state.classList.toggle("counts", hit === 3);
  if (hit === 3) {
    setText("heroSub", "Day counts.");
    setText("heroRest", others ? others + " of the other three still open." : "All six in.");
  } else {
    const list = left.length === 1 ? left[0]
      : left.slice(0, -1).join(", ") + " and " + left[left.length - 1];
    setText("heroSub", list[0].toUpperCase() + list.slice(1) + " to go.");
    setText("heroRest", hit ? hit + " of the Core Three done."
                            : "The three that make a bad day count.");
  }

  /* The measurement sits ON the row it evidences. Before this, the
     Garmin wake time backing tap 1 was hidden inside a collapsed panel.

     Everything printed here must come from THIS day's record. There is
     no per-day caffeine field in the schema, so the caffeine row gets
     no measurement: showing PREFS.cDose there printed the dose you have
     configured today onto every day in history, in the same tabular
     style as a real Garmin reading. The caffeine card below owns that
     number, where it is correctly labelled as a plan. */
  setText("mWake", r && r.wakeT ? r.wakeT : "");
  const sess = r ? [r.trainType, r.train2].filter(Boolean) : [];
  const km = r && hasVal(r.runKm) ? +r.runKm : NaN;
  setText("mTrain", isFinite(km) && km > 0 ? km.toFixed(1) + " km"
                  : sess.length ? sess.join(" + ") : "");

  /* Missed twice: never on a day still in progress. Flagging "Trained"
     at 9am on a day you have not finished is manufacturing a failure.
     Both days must also be attested. A Garmin-only record is a day nobody
     answered, and "you missed it twice" is a claim about answers -- on a
     synced-but-unanswered day every box reads false because no one was
     asked, not because anything was missed. */
  const yest = addDays(todayIso, -1), yest2 = addDays(todayIso, -2);
  const liveFlags = KEYS.filter(k => !isParked(k) &&
    attested(DB[yest]) && attested(DB[yest2]) && !DB[yest][k] && !DB[yest2][k]).map(k => NAMES[k]);
  /* One callout at a time, and the storage one always wins. Both sit in the
     same slot above the taps; stacked they compete, and a warning that
     yesterday's tick is missing is worth nothing next to the news that
     today's tick is not on the disk. */
  const sw = el("storageWarn");
  if (sw) {
    sw.style.display = STORAGE_FAILED ? "flex" : "none";
    if (STORAGE_FAILED) {
      setText("storageWarnText", "this device refused the write, so the newest changes exist " +
        "only in this tab — closing it loses them. " +
        (tokVal() && gidVal() ? "A push to your gist was forced so they survive anyway. " : "") +
        "Free some space, or take a copy with Download CSV in Setup.");
    }
  }
  const fb = el("missedTwice");
  if (fb) {
    if (liveFlags.length && !STORAGE_FAILED) {
      fb.style.display = "flex";
      setText("missedTwiceText", liveFlags.join(", ") + " missed two days running");
    } else fb.style.display = "none";
  }

  /* prescription strip -- below the taps, deliberately */
  const plan = dayPlan(CUR);
  const dowName = dayFromIso(CUR).toLocaleDateString(undefined, { weekday: "short" });
  let line1 = dowName + " · ";
  if (plan.kind === "run") line1 += "Run" + (plan.week ? " · W" + plan.week : "") + ": " + plan.detail;
  else if (plan.kind === "lift") line1 += "Lift" + (plan.template ? " " + plan.template : "") + ": " + plan.detail;
  else line1 += plan.detail;
  setText("rxLine1", line1);

  let line2 = "";
  if (plan.kind === "run") {
    const c = runCeiling(CUR);
    line2 = c.known
      ? "Ceiling " + c.ceiling.toFixed(1) + " km — 110% of your longest run in the last 30 days (" + c.longest.toFixed(1) + " km)."
      : (plan.week === 1 ? "Week 1 caps you at ~3 km total. The one figure here with a per-protocol RCT behind it."
                         : "No run distances logged yet, so no ceiling can be computed.");
  } else if (plan.kind === "lift" && plan.template) {
    const t = LIFT_TEMPLATES[plan.template];
    line2 = t.map(x => x.lift.split(" or ")[0]).join(" · ");
  }
  setText("rxLine2", line2);
  const prov = plan.week
    ? dowName + " = " + plan.kind + " day · week " + plan.week + " of 16"
    : "Set a programme start date in Setup to switch this on.";
  setText("rxProv", prov);

  /* Stair-snack rescue: only on a run day, only late, only if no run. */
  const rescue = el("rescue");
  if (rescue) {
    const late = new Date().getHours() >= 20;
    const noRun = !(r && (r.trainType === "run" || r.train2 === "run"));
    rescue.style.display = (plan.kind === "run" && late && noRun && CUR === todayIso) ? "block" : "none";
    setText("rescueText", STAIR_SNACK.protocol);
  }

  /* week meters (calendar week, CSS not SVG) */
  const wk = weekOf(CUR);
  let lifts = 0, runs = 0, social = 0, protein = 0, core3days = 0;
  wk.forEach(d => {
    const x = DB[d]; if (!x) return;
    [x.trainType, x.train2].forEach(t => {
      if (t === "lift") lifts++; else if (t === "run") runs++;
    });
    if (x.social) social++;
    if (x.protein) protein++;
    if (d <= todayIso && CORE3.every(k => x[k])) core3days++;
  });
  meter("mLift", "Lifts", lifts, T_LIFT);
  meter("mRun", "Runs", runs, T_RUN);
  meter("mSocial", "Social", social, T_SOCIAL);
  meter("mProtein", "Protein", protein, T_PROTEIN);
  meter("mCore", "Core Three days", core3days, 7);

  const gp = el("garminPill");
  if (gp) gp.style.display = (r && (r.wakeT || r.bedT)) ? "inline-block" : "none";
}

function meter(id, label, val, target) {
  const n = el(id); if (!n) return;
  const pct = target ? Math.min(100, Math.round((val / target) * 100)) : 0;
  const done = val >= target;
  n.innerHTML = "";
  const head = document.createElement("div");
  head.className = "mhead";
  const l = document.createElement("span"); l.textContent = label;
  const v = document.createElement("b");
  v.textContent = val + "/" + target;
  v.className = done ? "ok" : "";
  head.appendChild(l); head.appendChild(v);
  const track = document.createElement("div"); track.className = "mtrack";
  const fill = document.createElement("i");
  fill.className = "mfill" + (done ? " ok" : "");
  fill.style.width = pct + "%";
  track.appendChild(fill);
  n.appendChild(head); n.appendChild(track);
}

/* ===== PROGRAMME ===== */
function renderProgramme() {
  const wk = progWeek(isoDay(new Date()));
  setText("pgWeekNum", wk ? String(wk) : "—");
  setText("pgWeekOf", wk ? (wk <= 16 ? "of 16" : "past week 16") : "no start date set");

  const plan = dayPlan(CUR);
  const box = el("pgToday");
  box.innerHTML = "";
  const h = document.createElement("div"); h.className = "pgkind";
  h.textContent = plan.kind === "run" ? "Run day"
    : plan.kind === "lift" ? (plan.template ? "Lift day — session " + plan.template : "Lift day")
    : "Rest day";
  box.appendChild(h);
  const d = document.createElement("p"); d.className = "note"; d.textContent = plan.detail;
  box.appendChild(d);
  if (plan.note) { const n = document.createElement("p"); n.className = "why"; n.textContent = plan.note; box.appendChild(n); }

  /* --- your own routine, when one has been imported --- */
  if (plan.kind === "lift" && plan.routine) {
    const tbl = document.createElement("table"); tbl.className = "lift";
    const hd = document.createElement("tr");
    ["Exercise", "Sets × reps", "Last load", ""].forEach(x => {
      const th = document.createElement("th"); th.textContent = x; hd.appendChild(th);
    });
    tbl.appendChild(hd);
    /* Has this exercise ever been logged? A prescribed lift you have never
       once done is the most useful thing this table can tell you. */
    const everLogged = {};
    Object.keys(LIFTS).forEach(d => (LIFTS[d].exercises || []).forEach(e => {
      if (e.sets && e.sets.length) everLogged[e.name] = 1;
    }));
    plan.routine.exercises.forEach(row => {
      const tr = document.createElement("tr");
      const c1 = document.createElement("td");
      c1.textContent = row.name; c1.className = "rowh";
      const c2 = document.createElement("td");
      const reps = row.reps && row.reps.length ? row.reps[0] : null;
      c2.textContent = row.sets ? (row.sets + " × " + (reps === null ? "?" : reps)) : "—";
      const c3 = document.createElement("td");
      c3.textContent = loadText(row.name) || "—";
      const c4 = document.createElement("td");
      if (!everLogged[row.name]) {
        c4.innerHTML = '<span class="chip park">never logged</span>';
      }
      [c1, c2, c3, c4].forEach(c => tr.appendChild(c));
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    const done = plan.routine.exercises.filter(e => everLogged[e.name]).length;
    const p = document.createElement("p"); p.className = "why";
    p.textContent = done + " of " + plan.routine.exercises.length +
      " of these have ever been logged. " + LIFT_PROGRESSION;
    box.appendChild(p);
  } else if (plan.kind === "lift" && plan.template) {
    const tbl = document.createElement("table"); tbl.className = "lift";
    const hd = document.createElement("tr");
    ["Exercise", "Sets × reps", "RIR", "Last load"].forEach(x => {
      const th = document.createElement("th"); th.textContent = x; hd.appendChild(th);
    });
    tbl.appendChild(hd);
    LIFT_TEMPLATES[plan.template].forEach(row => {
      const tr = document.createElement("tr");
      const c1 = document.createElement("td"); c1.textContent = row.lift; c1.className = "rowh";
      const c2 = document.createElement("td"); c2.textContent = row.sets + " × " + row.reps;
      const c3 = document.createElement("td"); c3.textContent = row.rir;
      const c4 = document.createElement("td");
      /* Prefer an imported FitNotes match; fall back to a hand-typed
         value stored under the template's own name. */
      const hit = fitnotesLoadFor(PREFS.loads, row);
      if (hit && hit.name !== row.lift) {
        const b = document.createElement("div");
        b.className = "fnload";
        b.textContent = hit.load;
        const src = document.createElement("span");
        src.className = "fnsrc";
        src.textContent = hit.name;
        b.appendChild(src);
        c4.appendChild(b);
      } else {
        const inp = document.createElement("input");
        inp.type = "text"; inp.className = "loadin"; inp.placeholder = "—";
        inp.value = PREFS.loads[row.lift] || "";
        inp.setAttribute("aria-label", "Last load for " + row.lift);
        inp.addEventListener("change", () => {
          if (inp.value.trim()) PREFS.loads[row.lift] = inp.value.trim();
          else delete PREFS.loads[row.lift];
          savePrefs();
        });
        c4.appendChild(inp);
      }
      [c1, c2, c3, c4].forEach(c => tr.appendChild(c));
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);
    const pr = document.createElement("p"); pr.className = "why"; pr.textContent = LIFT_PROGRESSION;
    box.appendChild(pr);
  }

  if (plan.kind === "run") {
    const c = runCeiling(isoDay(new Date()));
    const m = el("pgCeiling");
    m.innerHTML = "";
    if (c.known) {
      meterInto(m, "Longest run, last 30 days " + c.longest.toFixed(1) + " km",
        "Ceiling today " + c.ceiling.toFixed(1) + " km", 1);
    } else {
      const p = document.createElement("p"); p.className = "note";
      p.textContent = (wk === 1 || !wk)
        ? "Week 1 caps you at ~3 km total running. Starting at 3 km/week rather than 6 cut novice injury risk by 31.2% — the one number here with a per-protocol RCT behind it."
        : "No run distances logged in the last 30 days, so no ceiling can be computed yet. Garmin fills this in once you log a run.";
      m.appendChild(p);
    }
  } else { el("pgCeiling").innerHTML = ""; }

  /* 16-week rail */
  const rail = el("pgRail");
  rail.innerHTML = "";
  for (let i = 1; i <= 16; i++) {
    const cell = document.createElement("div");
    cell.className = "wkcell" + (wk === i ? " now" : "") + (wk && i < wk ? " past" : "");
    const n = document.createElement("b"); n.textContent = String(i);
    cell.appendChild(n);
    const dots = document.createElement("div"); dots.className = "wkdots";
    [2, 4].forEach(dow => {
      const dot = document.createElement("i");
      let cls = "dot";
      if (wk && hasVal(PREFS.programStart)) {
        const iso = addDays(PREFS.programStart, (i - 1) * 7 + ((dow - dayFromIso(PREFS.programStart).getDay() + 7) % 7));
        const r = DB[iso];
        if (r && (r.trainType === "run" || r.train2 === "run")) cls += " done";
        else if (i < wk) cls += " miss";
      }
      dot.className = cls;
      dots.appendChild(dot);
    });
    cell.appendChild(dots);
    cell.title = "Week " + i;
    rail.appendChild(cell);
  }

  /* week 17 answer */
  const w17 = el("pgW17");
  w17.value = PREFS.week17 || "";
  setText("pgHorizon", horizonLine());
  setText("pgInjury", (wk && wk <= NOVICE_INJURY_WINDOW.throughWeek) ? NOVICE_INJURY_WINDOW.note : "");

  /* --- real volume from FitNotes, if any has been imported --- */
  const fnBox = el("pgFitnotes");
  fnBox.innerHTML = "";
  const liftDates = Object.keys(LIFTS).sort();
  if (!liftDates.length) {
    const p = document.createElement("p"); p.className = "note";
    p.textContent = "No FitNotes export imported yet. Setup → Import from FitNotes turns the " +
      "estimated set counts below into real ones, and fills in every last load.";
    fnBox.appendChild(p);
  } else {
    const wk = weekOf(isoDay(new Date()));
    const sets = fitnotesWeeklySets(LIFTS, wk);
    const cats = Object.keys(sets).sort((a, b) => sets[b] - sets[a]);
    const h = document.createElement("p"); h.className = "note";
    h.textContent = "Sets per muscle group this week, from " + liftDates.length +
      " imported sessions (" + liftDates[0] + " → " + liftDates[liftDates.length - 1] + "):";
    fnBox.appendChild(h);
    if (!cats.length) {
      const p = document.createElement("p"); p.className = "why";
      p.textContent = "Nothing logged in FitNotes this calendar week yet.";
      fnBox.appendChild(p);
    } else cats.forEach(c => {
      const row = document.createElement("div");
      const n = sets[c];
      /* PLAN §3: ~4 sets/muscle/week is the minimum effective dose,
         8–12 the useful band. Under-dose is worth naming; over is not
         an error, just diminishing returns. */
      meterInto(row, c + (n < SETS_PER_MUSCLE.min ? " — under the ~4-set minimum" : ""),
        fnPlural(n, "set"), Math.min(1, n / SETS_PER_MUSCLE.bandHigh));
      fnBox.appendChild(row);
    });
    /* the most recent session, so "what did I lift last time" is answered */
    const last = liftDates[liftDates.length - 1];
    const d = LIFTS[last];
    if (d && d.exercises.length) {
      const t = document.createElement("p"); t.className = "note";
      t.textContent = "Last session — " + fmtShortDay(last) + ":";
      fnBox.appendChild(t);
      const ul = document.createElement("ul"); ul.className = "note"; ul.style.paddingLeft = "18px";
      d.exercises.forEach(ex => {
        if (!ex.sets.length) return;
        const li = document.createElement("li");
        const top = ex.sets.reduce((a, s) => (s.kg > a.kg ? s : a), ex.sets[0]);
        li.textContent = ex.name + " — " + fnPlural(ex.sets.length, "set") + ", top " +
          showWeight(top.kg) + " × " + top.reps +
          (ex.sets.some(s => s.pr) ? "  ★ PR" : "");
        ul.appendChild(li);
      });
      fnBox.appendChild(ul);
    }

    /* The prescribed-vs-executed gap, per routine day. This is the number
       that says "your programme is fine, Tuesdays aren't happening". */
    if (PREFS.routine && PREFS.routine.days) {
      const everLogged = {};
      Object.keys(LIFTS).forEach(dd => (LIFTS[dd].exercises || []).forEach(e => {
        if (e.sets && e.sets.length) everLogged[e.name] = 1;
      }));
      const h2 = document.createElement("p"); h2.className = "note";
      h2.textContent = "“" + PREFS.routine.name + "” — how much of each day you actually run:";
      fnBox.appendChild(h2);
      ["1", "2", "3", "4", "5", "6", "0"].forEach(k => {
        const day = PREFS.routine.days[k]; if (!day) return;
        const done = day.exercises.filter(e => everLogged[e.name]).length;
        const row = document.createElement("div");
        meterInto(row, day.section, done + "/" + day.exercises.length,
          day.exercises.length ? done / day.exercises.length : 0);
        fnBox.appendChild(row);
      });
      const n2 = document.createElement("p"); n2.className = "why";
      n2.textContent = "Ever-logged, not this week — a day sitting near zero is a day " +
        "that has never really happened, which is a different problem from a bad week.";
      fnBox.appendChild(n2);
    }
  }

  const gl = el("pgGuards"); gl.innerHTML = "";
  RUN_GUARDRAILS.forEach(g => {
    const li = document.createElement("li");
    const b = document.createElement("b"); b.textContent = g.rule;
    const s = document.createElement("span"); s.textContent = " " + g.why;
    li.appendChild(b); li.appendChild(s); gl.appendChild(li);
  });
  setText("pgTenPct", TEN_PERCENT_RULE_IS_DEAD);
  setText("pgConcurrent", CONCURRENT_RULE);
  const neg = el("pgNegations"); neg.innerHTML = "";
  LIFT_NEGATIONS.forEach(t => { const li = document.createElement("li"); li.textContent = t; neg.appendChild(li); });
  setText("pgSets", SETS_PER_MUSCLE.note);
  const oe = el("pgExpect"); oe.innerHTML = "";
  OUTCOME_EXPECTATIONS.forEach(t => { const li = document.createElement("li"); li.textContent = t; oe.appendChild(li); });
}

function meterInto(node, label, valueText, pct) {
  const head = document.createElement("div"); head.className = "mhead";
  const l = document.createElement("span"); l.textContent = label;
  const v = document.createElement("b"); v.textContent = valueText;
  head.appendChild(l); head.appendChild(v);
  const track = document.createElement("div"); track.className = "mtrack";
  const fill = document.createElement("i"); fill.className = "mfill";
  fill.style.width = Math.round(pct * 100) + "%";
  track.appendChild(fill);
  node.appendChild(head); node.appendChild(track);
}

function horizonLine() {
  if (!hasVal(PREFS.programStart)) return "";
  const n = daysBetween(PREFS.programStart, isoDay(new Date())) + 1;
  return "Day " + n + " of a median " + HABIT_HORIZON.medianDays + " to habit formation (~" +
    HABIT_HORIZON.exerciseDays + " for exercise). Range " + HABIT_HORIZON.rangeLow + "–" +
    HABIT_HORIZON.rangeHigh + " days. This number only goes up — a missed day does not reset it.";
}

/* ===== REVIEW ===== */
function renderReview() {
  const days = filteredDays(), todayIso = isoDay(new Date());
  const past = days.filter(d => d <= todayIso);
  /* Every percentage on this view is read against `logged`, so it has to
     mean "a person answered here", not "a record exists". The ghosts are
     named separately rather than dropped in silence: this number falls the
     day attestation lands, and the clause is the only thing that explains
     why. Do not attribute them to any one writer -- three of them make
     records unasked. */
  const logged = past.filter(d => attested(DB[d]));
  const ghost = past.filter(d => DB[d] && !attested(DB[d]));
  setText("rvCoverage", logged.length + " of " + past.length + " days in the record (" +
    (past.length ? Math.round(logged.length / past.length * 100) : 0) + "%)" +
    (ghost.length ? " · " + ghost.length + " more hold synced data only" : ""));
  setText("rvFraming", REVIEW_FRAMING);

  /* review date */
  if (hasVal(PREFS.programStart)) {
    const n = daysBetween(PREFS.programStart, todayIso) + 1;
    const due = addDays(PREFS.programStart, 55);
    setText("rvReviewDate", "Day " + n + " of 56 · review due " + fmtShortDay(due));
    const m = el("rvReviewMeter");
    if (m) m.style.width = Math.min(100, Math.round(n / 56 * 100)) + "%";
  } else {
    setText("rvReviewDate", "Set a programme start date in Setup to get a review date.");
    const m = el("rvReviewMeter"); if (m) m.style.width = "0%";
  }

  /* triage rows: 10 items, days-LOGGED denominator, fixed order */
  const rows = [];
  KEYS.forEach(k => {
    if (isParked(k)) return;
    const poss = logged.length, hitN = logged.filter(d => DB[d][k]).length;
    rows.push({ key: k, name: NAMES[k], core: CORE3.indexOf(k) >= 0,
      hit: hitN, poss: poss, rate: poss ? hitN / poss : 0 });
  });
  const weeks = {};
  past.forEach(d => { const w = weekOf(d)[0]; (weeks[w] = weeks[w] || []).push(d); });
  const wkKeys = Object.keys(weeks).sort();
  function weeklyRate(pick) {
    let hitN = 0, poss = 0;
    /* Same predicate as `logged` above, and it has to move with it: if a
       week counts as possible on a Garmin-only day, the weekly rows are
       scored against a wider denominator than the daily rows and the two
       halves of one table disagree. */
    wkKeys.forEach(w => { if (weeks[w].some(d => attested(DB[d]))) { poss++; if (pick(weeks[w])) hitN++; } });
    return { hit: hitN, poss: poss, rate: poss ? hitN / poss : 0 };
  }
  const countIn = (ds, t) => ds.reduce((a, d) => {
    const r = DB[d]; if (!r) return a;
    return a + (r.trainType === t ? 1 : 0) + (r.train2 === t ? 1 : 0);
  }, 0);
  if (!isParked("wkLift")) { const s = weeklyRate(ds => countIn(ds, "lift") >= T_LIFT);
    rows.push({ key: "wkLift", name: "Lifts ≥3/wk", core: false, hit: s.hit, poss: s.poss, rate: s.rate }); }
  if (!isParked("wkRun")) { const s = weeklyRate(ds => countIn(ds, "run") >= T_RUN);
    rows.push({ key: "wkRun", name: "Runs ≥2/wk", core: false, hit: s.hit, poss: s.poss, rate: s.rate }); }
  if (!isParked("wkSocial")) { const s = weeklyRate(ds => ds.filter(d => DB[d] && DB[d].social).length >= T_SOCIAL);
    rows.push({ key: "wkSocial", name: "Social ≥2/wk", core: false, hit: s.hit, poss: s.poss, rate: s.rate }); }
  if (!isParked("wkProtein")) { const s = weeklyRate(ds => ds.filter(d => DB[d] && DB[d].protein).length >= T_PROTEIN);
    rows.push({ key: "wkProtein", name: "Protein ≥5/wk", core: false, hit: s.hit, poss: s.poss, rate: s.rate }); }

  const alive = rows.filter(r => r.rate >= 0.5).length;
  const enough = logged.length >= 14;
  setText("rvLead", enough ? String(alive) : String(logged.length));
  setText("rvLeadLabel", enough
    ? "of " + rows.length + " tracked items still getting ticked"
    : "days in the record — verdicts start at 14");

  const tri = el("triageRows"); tri.innerHTML = "";
  rows.forEach(r => {
    const div = document.createElement("div"); div.className = "trow";
    const nm = document.createElement("span"); nm.className = "tname";
    if (r.core) { const dot = document.createElement("i"); dot.className = "core-dot"; nm.appendChild(dot); }
    nm.appendChild(document.createTextNode(r.name));
    const chip = document.createElement("span");
    if (enough) {
      const v = r.rate >= 0.7 ? "keep" : r.rate >= 0.4 ? "watch" : "park";
      const canPark = logged.length >= 28 && !r.core;
      chip.className = "chip " + v;
      chip.textContent = v === "keep" ? "✓ Keep" : v === "watch" ? "● Watch"
        : (canPark ? "▲ Park candidate" : "▲ Low");
      if (canPark) {
        const b = document.createElement("button");
        b.className = "parkbtn"; b.textContent = "Park";
        b.addEventListener("click", () => {
          PREFS.parked[r.key] = isoDay(new Date()); savePrefs(); render();
        });
        chip.appendChild(b);
      }
    } else { chip.className = "chip"; chip.textContent = "—"; }
    const cnt = document.createElement("span"); cnt.className = "tcount";
    cnt.textContent = r.hit + "/" + r.poss;
    div.appendChild(nm); div.appendChild(cnt); div.appendChild(chip);
    tri.appendChild(div);
  });
  setText("rvTriageSub", enough
    /* Said "the accent marks the lowest", which was wrong twice: the chart
       paints --s1, a chart series slot, and --accent is chrome only and may
       never encode data. The mark is what carries rank now, so the sentence
       names the mark. */
    ? "Sorted in fixed order, never re-ranked under you. In the chart ▲ marks the single lowest item — the park candidate, not a verdict."
    : "Verdicts are suppressed until 14 days are in the record. Median habit formation is 66 days; judging an item at day " +
      logged.length + " would be noise.");

  /* wake diagnosis stats */
  const wakes = past.filter(d => DB[d] && DB[d].wakeT).map(d => mins(DB[d].wakeT)).sort((a, b) => a - b);
  if (wakes.length) {
    const med = wakes[Math.floor(wakes.length / 2)];
    const q1 = wakes[Math.floor(wakes.length * 0.25)], q3 = wakes[Math.floor(wakes.length * 0.75)];
    setText("wkMedian", minToHHMM(med));
    setText("wkIQR", (q3 - q1) + "m");
    let diffs = 0, dn = 0;
    for (let i = 1; i < past.length; i++) {
      const a = DB[past[i - 1]], b = DB[past[i]];
      if (a && b && a.wakeT && b.wakeT) { diffs += Math.abs(mins(b.wakeT) - mins(a.wakeT)); dn++; }
    }
    setText("wkNight", dn ? Math.round(diffs / dn) + "m" : "—");
    const inBand = past.filter(d => {
      const r = DB[d], t = targetFor(d);
      return r && r.wakeT && t !== null && Math.abs(mins(r.wakeT) - t) <= 30;
    }).length;
    setText("wkBand", wakes.length ? Math.round(inBand / wakes.length * 100) + "%" : "—");
    const v = el("wkVerdict");
    const spread = wakes[wakes.length - 1] - wakes[0];
    const tgt = targetFor(past[past.length - 1]);
    const off = tgt === null ? null : med - tgt;
    let cls, t, d;
    if (dn && (diffs / dn) <= 30 && off !== null && Math.abs(off) > 45) {
      cls = "v-warn"; t = "Regular, but phase-shifted";
      d = "Night-to-night change averages " + Math.round(diffs / dn) + " min — that is anchored. " +
          "But the median is " + minToHHMM(med) + " against a " + minToHHMM(tgt) + " target, " +
          Math.round(Math.abs(off)) + " min " + (off > 0 ? "late" : "early") +
          ". That is a phase problem, not a regularity problem, and morning light is the lever that moves it.";
    } else if (dn && (diffs / dn) <= 30) {
      cls = "v-good"; t = "Anchored";
      d = "Night-to-night change averages " + Math.round(diffs / dn) + " min and the median sits on target. This is the state the regularity literature associates with better outcomes.";
    } else {
      cls = "v-crit"; t = "Variable";
      d = "Wake time moves " + (dn ? Math.round(diffs / dn) : spread) +
          " min night to night. Phillips 2017: irregular sleepers with identical total sleep time still had melatonin onset ~2.6h later. Phase, not duration.";
    }
    /* Gated on the same `enough` as the triage chips. Ungated, a single
       wake time rendered a v-crit "Variable" citing Phillips 2017 off a
       spread of nothing, while every other verdict on the page stayed
       silent below 14 days. The statistics above still show — they are a
       description. This is a judgement, and it waits. */
    if (enough) {
      v.className = "verdict " + cls;
      setText("wkvT", t); setText("wkvD", d);
    } else {
      v.className = "verdict";
      setText("wkvT", "Not enough days to call it");
      setText("wkvD", "The figures above are every wake time in this window. The verdict waits for " +
        "14 days in the record, the same threshold the triage table uses — " + logged.length + " so far.");
    }
    const durs = past.map(d => sleepMins(DB[d])).filter(x => x !== null).sort((a, b) => a - b);
    setText("wkSleep", durs.length ? (durs[Math.floor(durs.length / 2)] / 60).toFixed(1) + "h" : "—");
  } else {
    ["wkMedian", "wkIQR", "wkNight", "wkBand", "wkSleep"].forEach(id => setText(id, "—"));
    const v = el("wkVerdict"); v.className = "verdict v-warn";
    setText("wkvT", "No wake times in this window");
    setText("wkvD", "Garmin writes these each morning once the sync is running, or add one by hand under Details on Today.");
  }

  /* notes */
  const nt = el("noteRows"); nt.innerHTML = "";
  const noted = past.filter(d => DB[d] && DB[d].note).reverse();
  setText("rvNoteCount", "notes on " + noted.length + " of " + logged.length + " days in the record");
  noted.slice(0, 60).forEach(d => {
    const tr = document.createElement("tr");
    const a = document.createElement("td"); a.textContent = fmtShortDay(d); a.className = "rowh";
    const b = document.createElement("td"); b.textContent = DB[d].note; b.className = "notecell";
    const c = document.createElement("td");
    const missed = KEYS.filter(k => !DB[d][k]).map(k => NAMES[k]);
    c.textContent = missed.length ? missed.join(", ") : "—";
    c.className = "misscell";
    tr.appendChild(a); tr.appendChild(b); tr.appendChild(c);
    nt.appendChild(tr);
  });
  if (!noted.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 3; td.className = "empty";
    td.textContent = "No notes yet. Harkin 2016: recorded beats unrecorded.";
    tr.appendChild(td); nt.appendChild(tr);
  }

  renderTableTwin(past);
  el("rvCharts").style.display = REVIEW_TABLE ? "none" : "block";
  el("rvTable").style.display = REVIEW_TABLE ? "block" : "none";
  setText("rvToggle", REVIEW_TABLE ? "Show charts" : "Show table");

  /* hand the charts their data */
  WAKE_DAYS = days; TRIAGE_ROWS = rows; HEAT_DAYS = days;
}

let WAKE_DAYS = [], TRIAGE_ROWS = [], HEAT_DAYS = [];

function renderTableTwin(days) {
  const tb = el("twinBody"); tb.innerHTML = "";
  const rows = days.filter(d => DB[d]).reverse();
  rows.slice(0, 200).forEach(d => {
    const r = DB[d], tr = document.createElement("tr");
    const sm = sleepMins(r);
    const cells = [fmtShortDay(d)]
      .concat(KEYS.map(k => r[k] ? "✓" : "–"))
      .concat([r.wakeT || "–", r.bedT || "–", sm === null ? "–" : (sm / 60).toFixed(1) + "h",
               r.trainType || "–", r.train2 || "–", hasVal(r.runKm) ? r.runKm + " km" : "–",
               r.social ? "✓" : "–", r.protein ? "✓" : "–", r.note || ""]);
    cells.forEach((c, i) => {
      const td = document.createElement("td");
      td.textContent = c;
      if (i === 0) td.className = "rowh";
      tr.appendChild(td);
    });
    tb.appendChild(tr);
  });
  if (!rows.length) {
    const tr = document.createElement("tr"), td = document.createElement("td");
    td.colSpan = 16; td.className = "empty"; td.textContent = "Nothing logged in this window.";
    tr.appendChild(td); tb.appendChild(tr);
  }
}
function toggleReviewTable() { REVIEW_TABLE = !REVIEW_TABLE; render(); }
function setWindow(n) { WINDOW_DAYS = +n; render(); }
function setDayFilter(v) { DAYFILTER = v; render(); }

/* ===== SETUP ===== */
function renderSetup() {
  el("sProgStart").value = PREFS.programStart || "";
  el("sTargetWake").value = PREFS.targetWake || "";
  el("sTargetWakeWknd").value = PREFS.targetWakeWeekend || "";
  el("sBodyweight").value = PREFS.bodyweightKg || "";
  el("sHrMax").value = PREFS.hrMax || "";
  const bw = +PREFS.bodyweightKg;
  setText("sProteinTarget", bw ? Math.round(bw * PROTEIN.gPerKg) + " g/day on " + PROTEIN.daysPerWeek + "+ days" : "set bodyweight to get a number");
  setText("sProteinNote", PROTEIN.note);
  const hm = +PREFS.hrMax;
  setText("sHrNote", hm ? "Weeks 9–16 target 90–95% HRmax = " + Math.round(hm * 0.9) + "–" + Math.round(hm * 0.95) + " bpm."
    : "Without this, the weeks 9–16 interval prescription is a percentage of an unknown number.");
  setText("sCreatine", CREATINE.dose + " — " + CREATINE.note);
  setText("sSocialNote", SOCIAL.note + " " + SOCIAL.framing);
  setText("sCalibration", CALIBRATION);
  setText("sNoBench", NO_BENCHMARKING);

  const pk = el("parkedList"); pk.innerHTML = "";
  PARKED.forEach(p => {
    const d = document.createElement("details");
    const s = document.createElement("summary");
    s.textContent = p.name;
    const tag = document.createElement("span");
    tag.className = "ptag " + p.severity;
    tag.textContent = p.severity.replace("-", " ");
    s.appendChild(tag);
    const body = document.createElement("p"); body.className = "why"; body.textContent = p.why;
    d.appendChild(s); d.appendChild(body);
    pk.appendChild(d);
  });

  const un = el("unparkList"); un.innerHTML = "";
  const parkedKeys = Object.keys(PREFS.parked);
  if (!parkedKeys.length) {
    const p = document.createElement("p"); p.className = "note";
    p.textContent = "Nothing parked. Items become parkable on the Review tab after 28 days in the record.";
    un.appendChild(p);
  } else parkedKeys.forEach(k => {
    const row = document.createElement("div"); row.className = "unpark";
    const s = document.createElement("span");
    s.textContent = (NAMES[k] || k) + " — parked " + PREFS.parked[k];
    const b = document.createElement("button"); b.textContent = "Un-park";
    b.addEventListener("click", () => { delete PREFS.parked[k]; savePrefs(); render(); });
    row.appendChild(s); row.appendChild(b);
    un.appendChild(row);
  });
}
function savePrefsFromSetup() {
  PREFS.programStart = el("sProgStart").value;
  PREFS.targetWake = el("sTargetWake").value;
  PREFS.targetWakeWeekend = el("sTargetWakeWknd").value;
  PREFS.bodyweightKg = el("sBodyweight").value;
  PREFS.hrMax = el("sHrMax").value;
  savePrefs(); render();
}
function saveW17() { PREFS.week17 = el("pgW17").value; savePrefs(); }

/* ---------- CSV ----------
   APPEND-ONLY. New columns go on the end, never inserted, or every
   CSV already downloaded misaligns against a new one. This header
   must stay byte-identical to CSV_HEADER in sync/garmin_sync.py. */
function csvEsc(s) {
  s = String(s == null ? "" : s);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV() {
  const hdr = ["date", "wake_within_30m", "morning_light", "trained", "caffeine_plan",
    "both_blocks", "logged", "core3_all", "training_type", "wake_time", "bed_time",
    "sleep_hours", "longest_block_min", "social_contact", "protein_target", "note",
    "training_type_2", "run_km", "lift_template"];
  const rows = Object.keys(DB).sort().map(d => {
    const r = DB[d] || {}, sm = sleepMins(r);
    return [d, r.wake ? 1 : 0, r.light ? 1 : 0, r.train ? 1 : 0, r.caff ? 1 : 0,
      r.block ? 1 : 0, r.log ? 1 : 0, CORE3.every(k => r[k]) ? 1 : 0, r.trainType || "",
      r.wakeT || "", r.bedT || "", sm === null ? "" : (sm / 60).toFixed(2), r.focus || "",
      r.social ? 1 : 0, r.protein ? 1 : 0, r.note || "",
      r.train2 || "", r.runKm || "", r.liftTpl || ""].map(csvEsc).join(",");
  });
  return hdr.join(",") + "\n" + rows.join("\n") + "\n";
}
function downloadCSV() {
  const blob = new Blob([toCSV()], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = "best-jared-" + isoDay(new Date()) + ".csv";
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  msg("CSV downloaded — " + Object.keys(DB).length + " day(s).");
}

/* ---------- merge + gist sync ---------- */
function merge(local, remote, dirty) {
  dirty = dirty || {};
  const out = {};
  Object.keys(local).forEach(k => out[k] = local[k]);
  Object.keys(remote).forEach(day => {
    const mine = out[day], theirs = remote[day];
    if (!mine) { out[day] = theirs; return; }
    const theirsNewer = (theirs._u || 0) > (mine._u || 0);
    const merged = Object.assign({}, theirsNewer ? mine : theirs, theirsNewer ? theirs : mine);
    (dirty[day] || []).forEach(f => { if (f in mine) merged[f] = mine[f]; });
    merged._u = Math.max(mine._u || 0, theirs._u || 0);
    out[day] = merged;
  });
  return out;
}
function setPill(id, txt, cls) { const p = el(id); if (p) { p.textContent = txt; p.className = "pill" + (cls ? " " + cls : ""); } }
function msg(t) { setText("syncMsg", t || ""); }

async function gh(path, opts, tok) {
  const r = await fetch("https://api.github.com" + path, Object.assign({
    headers: { "Authorization": "Bearer " + tok, "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28" }
  }, opts || {}));
  if (!r.ok) {
    let detail = ""; try { detail = (await r.json()).message || ""; } catch (e) {}
    throw new Error("GitHub " + r.status + (detail ? " — " + detail : ""));
  }
  return r.json();
}
/* Spread REMOTE_EXTRA first so any top-level key this build doesn't
   know about survives the round trip instead of being destroyed. */
function gistPayload() {
  const body = Object.assign({}, REMOTE_EXTRA,
    { v: 2, data: DB, prefs: PREFS, lifts: LIFTS, liftsUpdated: LIFTS_U });
  return { [GIST_FILE]: { content: JSON.stringify(body, null, 1) },
           [CSV_FILE]: { content: toCSV() } };
}
/* Mirrors of the two credentials, because lsGet cannot be trusted in the
   one state the forced push exists for: when storage is unavailable it
   returns the fallback, the gate below reads the token as absent, and the
   mitigation is dead code exactly when it is needed. Hydrated lazily from
   the store and written on every set, so within a session they are never
   staler than the disk. */
let TOK_MEM = "", GID_MEM = "";
function tokVal() { if (!TOK_MEM) TOK_MEM = lsGet(LS_TOK, ""); return TOK_MEM; }
function gidVal() { if (!GID_MEM) GID_MEM = lsGet(LS_GIST, ""); return GID_MEM; }

/* persist() -> forcePush() -> syncNow() -> persist() is a loop. The flag
   breaks the recursion; the 30s window stops a user tapping repeatedly
   against a full disk from spraying PATCHes at GitHub. */
let SYNC_INFLIGHT = false, LAST_FORCE = 0;
const FORCE_MS = 30000;
function forcePush() {
  if (SYNC_INFLIGHT) return;
  const now = Date.now();
  if (now - LAST_FORCE < FORCE_MS) return;
  if (!tokVal() || !gidVal()) return;
  LAST_FORCE = now;              /* claim the window BEFORE the call, or the
                                    re-entry from syncNow's persist() sees
                                    an unclaimed one and pushes again */
  clearTimeout(syncTimer);       /* the queued sync would only repeat this */
  syncNow(true);
}
function queueSync() {
  if (!tokVal() || !gidVal()) return;
  /* While writes are failing, forcePush is already pushing under the brake.
     Re-arming the 4s debounce on top of it doubles every PATCH and puts the
     brake back where it started. */
  if (STORAGE_FAILED && Date.now() - LAST_FORCE < FORCE_MS) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncNow(true), 4000);
}
async function syncNow(quiet) {
  if (SYNC_INFLIGHT) return;
  const tokIn = el("ghTok").value.trim(), gidIn = el("ghGist").value.trim();
  /* Clear the field only once the token is on the disk. Clearing it after a
     refused write leaves a password box that looks accepted and a token
     that will not survive the reload. */
  if (tokIn) { TOK_MEM = tokIn; if (lsSet(LS_TOK, tokIn)) el("ghTok").value = ""; }
  if (gidIn) { GID_MEM = gidIn; lsSet(LS_GIST, gidIn); }
  const tok = tokVal(); let gid = gidVal();
  if (!tok) { setPill("syncPill", "not configured", ""); msg("Paste a token first, or keep local-only saving plus Download CSV."); return; }

  setPill("syncPill", "syncing…", "busy"); if (!quiet) msg("");
  el("btnSync").disabled = true;
  SYNC_INFLIGHT = true;
  try {
    if (gid) {
      const g = await gh("/gists/" + gid, null, tok);
      const f = g.files && g.files[GIST_FILE];
      if (f && f.content) {
        /* A read that failed must never become a write. Swallowing this
           left body = {}, which emptied REMOTE_EXTRA, and the PATCH below
           then wrote that emptiness back -- destroying fitnotesSource, the
           fingerprint fitnotes_sync.py stores and re-reads to stay
           idempotent. Stop before the PATCH: the gist on disk is still
           whole, and the next sync recovers it. */
        let body;
        try { body = JSON.parse(f.content) || {}; }
        catch (bad) {
          setPill("syncPill", "sync stopped", "err");
          msg("The gist file did not parse (" + bad.message + "). Nothing was written — " +
              "your local log is untouched and the gist still holds what it held. " +
              "Open the gist and check it before syncing again.");
          return;
        }
        const known = { v: 1, data: 1, prefs: 1, lifts: 1, liftsUpdated: 1 };
        REMOTE_EXTRA = {};
        Object.keys(body).forEach(k => { if (!known[k]) REMOTE_EXTRA[k] = body[k]; });
        DB = prune(merge(DB, body.data || {}, loadDirty()));
        /* A FitNotes export is a COMPLETE snapshot of all history, not a
           delta -- so the newer writer replaces wholesale rather than the
           two sides being unioned. A per-day union looks safer and isn't:
           it strands days the other side has since corrected, and it made
           a browser copy silently shadow anything the Action wrote. */
        if (body.lifts && (body.liftsUpdated || 0) > LIFTS_U) {
          LIFTS = body.lifts; LIFTS_U = body.liftsUpdated || 0; saveLifts();
        }
        if (body.prefs && (body.prefs._u || 0) > (PREFS._u || 0)) {
          PREFS = Object.assign({}, DEFAULT_PREFS, body.prefs);
          if (!PREFS.loads) PREFS.loads = {};
          if (!PREFS.parked) PREFS.parked = {};
          lsSet(LS_PREF, JSON.stringify(PREFS));
        }
        persist(); loadDay(); render();
      }
      const sent = loadDirty();
      await gh("/gists/" + gid, { method: "PATCH", body: JSON.stringify({ files: gistPayload() }) }, tok);
      dropDirty(sent);
    } else {
      const sent = loadDirty();
      const g = await gh("/gists", { method: "POST", body: JSON.stringify({
        description: "Building the Best Jared — private log", public: false, files: gistPayload()
      }) }, tok);
      dropDirty(sent);
      gid = g.id; GID_MEM = gid; lsSet(LS_GIST, gid); el("ghGist").value = gid;
      msg("Created secret gist " + gid + " — copy that ID onto your other device.");
    }
    el("ghGist").value = gidVal();
    setPill("syncPill", "synced " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), "ok");
  } catch (e) {
    setPill("syncPill", "sync failed", "err");
    msg(e.message + ". A 401/403 means the token is wrong, expired, or missing Gists: Read and write.");
  } finally { el("btnSync").disabled = false; SYNC_INFLIGHT = false; }
}
function forgetToken() {
  /* The mirror has to go too, or "removed from this device" is false for
     the rest of the session and the forced push keeps using it. */
  TOK_MEM = "";
  lsDel(LS_TOK); el("ghTok").value = "";
  setPill("syncPill", "not configured", "");
  msg("Token removed from this device. Log still saved locally; gist untouched.");
}
function openGist() {
  const gid = gidVal();
  if (!gid) { msg("No gist yet — sync once to create it."); return; }
  window.open("https://gist.github.com/" + gid, "_blank", "noopener");
}
function exportData() {
  const box = el("ioBox");
  box.value = JSON.stringify({ v: 2, data: DB, prefs: PREFS });
  box.select();
  try { document.execCommand("copy"); } catch (e) {}
  msg("Copied to clipboard.");
}
function importData() {
  const raw = el("ioBox").value.trim();
  if (!raw) { msg("Paste exported text into the box first."); return; }
  try {
    const o = JSON.parse(raw); if (!o.data) throw 0;
    DB = prune(merge(DB, o.data));
    if (o.prefs) { PREFS = Object.assign({}, DEFAULT_PREFS, o.prefs); lsSet(LS_PREF, JSON.stringify(PREFS)); }
    persist(); loadDay(); render();
    msg("Merged " + Object.keys(o.data).length + " day(s).");
  } catch (e) { msg("That doesn't look like exported data."); }
}

/* ---------- ui bits ---------- */
function toggleWhy(btn) {
  const row = btn.closest(".item");
  if (row) row.classList.toggle("open");
}
function toggleTheme() {
  const r = document.documentElement;
  const next = r.getAttribute("data-theme") === "dark" ? "light" : "dark";
  r.setAttribute("data-theme", next); lsSet(LS_THEME, next);
  if (typeof chartsOnShow === "function") chartsOnShow();
}

/* ---------- boot ---------- */
let booted = false;
function boot() {
  if (booted) return; booted = true;
  askPersistentStorage();
  loadLocal(); loadPrefs(); loadLifts();
  el("cDose").value = PREFS.cDose; el("cTime").value = PREFS.cTime;
  el("cBed").value = PREFS.cBed; el("cHalf").value = PREFS.cHalf;
  CUR = isoDay(new Date());                 /* cold start is always today */
  loadDay(); calcCaff();

  registerChart(el("chWake"), (svg, w) => drawWakeDots(svg, w, WAKE_DAYS, DB, targetFor));
  registerChart(el("chTriage"), (svg, w) => drawTriage(svg, w, TRIAGE_ROWS));
  registerChart(el("chHeat"), (svg, w) => drawBehaviourHeat(svg, w, HEAT_DAYS, DB, KEYS, NAMES, CORE3));

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  const gid = gidVal(); if (gid) el("ghGist").value = gid;
  if (tokVal()) { setPill("syncPill", "token saved on this device", "ok"); syncNow(true); }
  /* Counts attested days, not stored ones. "Days in the record" has to name
     the same quantity here as on Review or the phrase means two numbers. */
  const keys = Object.keys(DB);
  const n = keys.filter(d => attested(DB[d])).length, ghosts = keys.length - n;
  const sp = el("savePill");
  if (!n && !ghosts) sp.textContent = "saves automatically";
  else if (!n) { sp.textContent = ghosts + " days synced, none answered"; sp.className = "pill ok"; }
  else { sp.textContent = n + " days in the record"; sp.className = "pill ok"; }
}

(function () {
  const th = lsGet(LS_THEME, ""); if (th) document.documentElement.setAttribute("data-theme", th);
  if (typeof GATE_HASH === "undefined" || !GATE_HASH) { reveal(); return; }
  if (lsGet(LS_UNLOCK, "") === GATE_HASH) { reveal(); return; }
  el("gPass").focus();
})();
