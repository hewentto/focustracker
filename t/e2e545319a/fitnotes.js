"use strict";
/* ============================================================
   FitNotes CSV import.

   FitNotes (Android, by James Gay) is offline-first with no API, but
   it exports a CSV by email / Google Drive / Dropbox. That export is
   a far better source for lift detail than asking anyone to type
   loads on a gym floor -- which is the diet-logging cost profile that
   collapses to 21% sustained adherence.

   The header differs between platforms, so this parses BY COLUMN NAME
   and never by position:

     Android : Date, Exercise, Category, Weight, Weight Unit, Reps,
               Distance, Distance Unit, Time [, Comment]
     iOS     : Date, Exercise, Category, Weight (kg), Weight (lbs),
               Reps, Distance, Distance Unit, Time, Notes, Kind

   Everything here is pure. It reads a string and returns data; the
   caller decides what to commit.
   ============================================================ */

/* ---------- RFC4180-ish line splitter (quotes, embedded commas) ---------- */
function fnSplitCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || "").trim() !== "");
}

function fnNorm(s) { return String(s || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, ""); }

/* Map the header row to indices, accepting either platform's names. */
function fnColumns(header) {
  const ix = {}, seen = header.map(fnNorm);
  function find() {
    for (let a = 0; a < arguments.length; a++) {
      const k = seen.indexOf(fnNorm(arguments[a]));
      if (k >= 0) return k;
    }
    return -1;
  }
  ix.date = find("Date");
  ix.exercise = find("Exercise");
  ix.category = find("Category");
  ix.weight = find("Weight", "Weight (kg)", "Weightkg");
  ix.weightLbs = find("Weight (lbs)", "Weightlbs");
  ix.weightUnit = find("Weight Unit", "WeightUnit", "Unit");
  ix.reps = find("Reps");
  ix.distance = find("Distance");
  ix.distanceUnit = find("Distance Unit", "DistanceUnit");
  ix.time = find("Time");
  ix.note = find("Comment", "Notes", "Note");
  return ix;
}

const LBS_TO_KG = 0.45359237;

function fnNum(v) {
  const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, ""));
  return isNaN(n) ? null : n;
}
/* "HH:MM:ss" or "MM:ss" -> seconds */
function fnSeconds(v) {
  const s = String(v || "").trim();
  if (!s || s.indexOf(":") < 0) return null;
  const p = s.split(":").map(x => parseInt(x, 10));
  if (p.some(isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/* ============================================================
   parseFitNotes(text) -> {
     ok, error,
     days:   { iso: { exercises: [ {name, category, sets:[{kg,reps}],
                                    distanceKm, seconds} ] } },
     loads:  { exerciseName: "60 kg x 8" }   // most recent working set
     stats:  { workouts, sets, exercises, from, to, cardioRows, skipped }
     warnings: [ ... ]
   }
   ============================================================ */
function parseFitNotes(text) {
  const out = { ok: false, error: "", days: {}, loads: {}, warnings: [],
    stats: { workouts: 0, sets: 0, exercises: 0, from: "", to: "", cardioRows: 0, skipped: 0 } };

  const rows = fnSplitCSV(String(text || "").trim());
  if (rows.length < 2) { out.error = "That doesn't look like a CSV — no header and rows found."; return out; }

  const ix = fnColumns(rows[0]);
  if (ix.date < 0 || ix.exercise < 0) {
    out.error = "No Date and Exercise columns. Expected a FitNotes export; got: " +
      rows[0].join(", ").slice(0, 120);
    return out;
  }

  const names = {}, order = [];
  let unitWarned = false;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const iso = String(row[ix.date] || "").trim();
    const name = String(row[ix.exercise] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || !name) { out.stats.skipped++; continue; }

    /* Weight: Android gives one column plus a unit; iOS gives two. */
    let kg = null;
    if (ix.weight >= 0) kg = fnNum(row[ix.weight]);
    if (kg !== null && ix.weightUnit >= 0) {
      const u = fnNorm(row[ix.weightUnit]);
      if (u === "lbs" || u === "lb" || u === "pounds") kg = kg * LBS_TO_KG;
      else if (u && u !== "kg" && u !== "kgs" && !unitWarned) {
        out.warnings.push("Unrecognised weight unit “" + row[ix.weightUnit] + "” — treated as kg.");
        unitWarned = true;
      }
    }
    if ((kg === null || kg === 0) && ix.weightLbs >= 0) {
      const lb = fnNum(row[ix.weightLbs]);
      if (lb) kg = lb * LBS_TO_KG;
    }

    const reps = ix.reps >= 0 ? fnNum(row[ix.reps]) : null;
    const distKm = (function () {
      if (ix.distance < 0) return null;
      const d = fnNum(row[ix.distance]); if (d === null || !d) return null;
      const u = ix.distanceUnit >= 0 ? fnNorm(row[ix.distanceUnit]) : "km";
      if (u === "mi" || u === "miles" || u === "mile") return d * 1.609344;
      if (u === "m" || u === "metres" || u === "meters") return d / 1000;
      return d;
    })();
    const secs = ix.time >= 0 ? fnSeconds(row[ix.time]) : null;

    const isStrength = reps !== null && reps > 0;
    const isCardio = !isStrength && (distKm !== null || secs !== null);
    if (!isStrength && !isCardio) { out.stats.skipped++; continue; }

    const day = out.days[iso] || (out.days[iso] = { exercises: [] });
    let ex = null;
    for (let i = 0; i < day.exercises.length; i++) {
      if (day.exercises[i].name === name) { ex = day.exercises[i]; break; }
    }
    if (!ex) {
      ex = { name: name, category: ix.category >= 0 ? String(row[ix.category] || "").trim() : "",
             sets: [], distanceKm: 0, seconds: 0 };
      day.exercises.push(ex);
    }
    if (!names[name]) { names[name] = 1; order.push(name); }

    if (isStrength) {
      ex.sets.push({ kg: kg === null ? 0 : Math.round(kg * 100) / 100, reps: reps });
      out.stats.sets++;
      /* Rows arrive date-ascending, so the last write per exercise is
         the most recent -- exactly what "last load" should mean. */
      out.loads[name] = (kg ? (Math.round(kg * 100) / 100) + " kg" : "bodyweight") + " × " + reps;
    } else {
      if (distKm) ex.distanceKm += distKm;
      if (secs) ex.seconds += secs;
      out.stats.cardioRows++;
    }
  }

  const isos = Object.keys(out.days).sort();
  out.stats.workouts = isos.length;
  out.stats.exercises = order.length;
  out.stats.from = isos[0] || "";
  out.stats.to = isos[isos.length - 1] || "";
  if (!isos.length) { out.error = "Parsed the file but found no dated sets in it."; return out; }
  out.ok = true;
  return out;
}

/* Weekly set count per FitNotes Category, for PLAN §3's 8–12 band.
   Real counts beat the alternation estimate the app derives otherwise. */
function fitnotesWeeklySets(lifts, days) {
  const out = {};
  days.forEach(iso => {
    const d = lifts[iso]; if (!d) return;
    d.exercises.forEach(ex => {
      if (!ex.sets || !ex.sets.length) return;
      const cat = ex.category || "Uncategorised";
      out[cat] = (out[cat] || 0) + ex.sets.length;
    });
  });
  return out;
}

/* A day counts as a lift if it holds at least one weighted/rep set. */
function fitnotesIsLiftDay(dayEntry) {
  return !!(dayEntry && dayEntry.exercises &&
    dayEntry.exercises.some(e => e.sets && e.sets.length));
}

/* Which template row does a FitNotes exercise name belong to?
   Longest matching keyword wins; `not` vetoes. Returns null rather
   than guessing -- showing the wrong weight is worse than showing none. */
function fitnotesMatchRow(exerciseName, row) {
  const n = " " + String(exerciseName || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() + " ";
  if (row.not && row.not.some(k => n.indexOf(" " + k.toLowerCase() + " ") >= 0 ||
                                   n.indexOf(k.toLowerCase()) >= 0)) return 0;
  let best = 0;
  (row.match || []).forEach(k => {
    const kk = k.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (kk && n.indexOf(kk) >= 0 && kk.length > best) best = kk.length;
  });
  return best;
}

/* Best (name, load) from an imported loads map for one template row. */
function fitnotesLoadFor(loads, row) {
  let bestName = null, bestScore = 0;
  Object.keys(loads || {}).forEach(name => {
    const s = fitnotesMatchRow(name, row);
    if (s > bestScore) { bestScore = s; bestName = name; }
  });
  return bestName ? { name: bestName, load: loads[bestName] } : null;
}

function fnPlural(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }
