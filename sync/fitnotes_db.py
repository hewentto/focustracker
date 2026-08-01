#!/usr/bin/env python3
"""
Read a FitNotes .fitnotes backup and emit the dashboard's import JSON.

    python sync/fitnotes_db.py private/FitNotes_Backup.fitnotes > out.json
    python sync/fitnotes_db.py            # picks the newest in private/

Why this exists: the Spreadsheet Export CSV drops personal-record flags and
the entire routine structure. Both are in the backup, which is a plain
SQLite database. Standard library only -- this has to run in the same
GitHub Actions job as garmin_sync.py with no extra dependencies.

The file is opened STRICTLY READ-ONLY. This never writes to your backup.

UNITS. training_log.metric_weight is always KILOGRAMS regardless of what
the app displays; settings.metric selects the display unit (0 = imperial).
Verified against real data: a stored 61.235042773811365 is exactly 135 lb.
We emit kg as the canonical number and a displayUnit for the UI, so the
number shown matches the number that was actually lifted.
"""

import glob
import json
import os
import sqlite3
import sys

SCHEMA_VERSION_TESTED = 22
KG_PER_LB = 0.45359237

# RoutineSection names in this backup start "Mon - ", "Tue - " and so on.
# Map to JS getDay(): 0 = Sunday.
DOW = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
       "monday": 1, "tuesday": 2, "wednesday": 3, "thursday": 4,
       "friday": 5, "saturday": 6, "sunday": 0}


def find_backup(argv):
    if len(argv) > 1:
        return argv[1]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    hits = sorted(glob.glob(os.path.join(here, "private", "*.fitnotes")),
                  key=os.path.getmtime)
    return hits[-1] if hits else None


def open_ro(path):
    with open(path, "rb") as fh:
        if not fh.read(16).startswith(b"SQLite format 3"):
            raise SystemExit("Not a SQLite database: " + path)
    con = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f"), uri=True)
    con.row_factory = sqlite3.Row
    return con


def weekday_of(section_name):
    """'Tue - Lower Heavy + Abs' -> 2. None when the name carries no day."""
    head = section_name.strip().lower().replace("-", " ").split()
    return DOW.get(head[0]) if head else None


def build_routine(con):
    """Pick the routine that maps onto weekdays; fall back to the biggest."""
    best, best_score = None, -1
    for r in con.execute("SELECT _id, name FROM Routine ORDER BY _id"):
        secs = con.execute(
            "SELECT _id, name, sort_order FROM RoutineSection "
            "WHERE routine_id=? ORDER BY sort_order", (r["_id"],)).fetchall()
        mapped = sum(1 for s in secs if weekday_of(s["name"]) is not None)
        nsets = con.execute(
            "SELECT COUNT(*) FROM RoutineSectionExerciseSet s "
            "JOIN RoutineSectionExercise e ON e._id = s.routine_section_exercise_id "
            "JOIN RoutineSection sec ON sec._id = e.routine_section_id "
            "WHERE sec.routine_id=?", (r["_id"],)).fetchone()[0]
        # A routine that names weekdays AND prescribes sets is the real one.
        score = mapped * 1000 + nsets
        if score > best_score:
            best, best_score = (r, secs), score
    if not best or best_score <= 0:
        return None

    r, secs = best
    days = {}
    for s in secs:
        exercises = []
        rows = con.execute(
            "SELECT rse._id rid, e.name, c.name cat "
            "FROM RoutineSectionExercise rse "
            "JOIN exercise e ON e._id = rse.exercise_id "
            "LEFT JOIN Category c ON c._id = e.category_id "
            "WHERE rse.routine_section_id=? ORDER BY rse.sort_order", (s["_id"],))
        for x in rows:
            sets = con.execute(
                "SELECT reps, metric_weight FROM RoutineSectionExerciseSet "
                "WHERE routine_section_exercise_id=? ORDER BY sort_order",
                (x["rid"],)).fetchall()
            exercises.append({
                "name": x["name"],
                "category": x["cat"] or "",
                "sets": len(sets),
                "reps": [z["reps"] for z in sets],
            })
        dow = weekday_of(s["name"])
        entry = {"section": s["name"], "exercises": exercises}
        if dow is None:
            days.setdefault("unscheduled", []).append(entry)
        else:
            days[str(dow)] = entry
    return {"name": r["name"], "days": days}


def build_log(con):
    """Per-day training log, plus the most recent load per exercise."""
    lifts, loads = {}, {}
    rows = con.execute(
        "SELECT t.date, e.name, c.name cat, t.metric_weight kg, t.reps, "
        "       t.is_personal_record pr, t.distance, t.duration_seconds secs "
        "FROM training_log t "
        "JOIN exercise e ON e._id = t.exercise_id "
        "LEFT JOIN Category c ON c._id = e.category_id "
        "ORDER BY t.date ASC, t._id ASC")
    for r in rows:
        day = lifts.setdefault(r["date"], {"exercises": []})
        ex = None
        for cand in day["exercises"]:
            if cand["name"] == r["name"]:
                ex = cand
                break
        if ex is None:
            ex = {"name": r["name"], "category": r["cat"] or "",
                  "sets": [], "distanceKm": 0.0, "seconds": 0}
            day["exercises"].append(ex)

        reps = r["reps"] or 0
        if reps > 0:
            kg = round(float(r["kg"] or 0), 2)
            ex["sets"].append({"kg": kg, "reps": reps, "pr": bool(r["pr"])})
            # Rows are date-ascending, so the last write per exercise is the
            # most recent -- which is what "last load" has to mean.
            loads[r["name"]] = {"kg": kg, "reps": reps, "date": r["date"]}
        else:
            # FitNotes stores cardio distance in metres.
            if r["distance"]:
                ex["distanceKm"] += float(r["distance"]) / 1000.0
            if r["secs"]:
                ex["seconds"] += int(r["secs"])
    for d in lifts.values():
        for ex in d["exercises"]:
            ex["distanceKm"] = round(ex["distanceKm"], 3)
    return lifts, loads


def build(path):
    con = open_ro(path)
    uv = con.execute("PRAGMA user_version").fetchone()[0]
    if uv != SCHEMA_VERSION_TESTED:
        # Loud, not silent. A changed schema means the joins below may be
        # quietly wrong, and quietly wrong training data is worse than none.
        sys.stderr.write(
            "WARNING: schema user_version=%s, tested against %s. "
            "Check the output before trusting it.\n" % (uv, SCHEMA_VERSION_TESTED))

    metric = 0
    try:
        metric = con.execute("SELECT metric FROM settings LIMIT 1").fetchone()[0]
    except sqlite3.Error:
        pass

    lifts, loads = build_log(con)
    routine = build_routine(con)
    days = sorted(lifts)
    cats = {}
    for d in lifts.values():
        for ex in d["exercises"]:
            if ex["sets"]:
                cats[ex["category"] or "Uncategorised"] = \
                    cats.get(ex["category"] or "Uncategorised", 0) + len(ex["sets"])

    out = {
        "v": 1,
        "source": "fitnotes-db",
        "userVersion": uv,
        "displayUnit": "kg" if metric else "lb",
        "range": {"from": days[0] if days else "", "to": days[-1] if days else ""},
        "totals": {
            "days": len(days),
            "sets": sum(len(e["sets"]) for d in lifts.values() for e in d["exercises"]),
            "exercises": len(loads),
            "prs": sum(1 for d in lifts.values() for e in d["exercises"]
                       for s in e["sets"] if s["pr"]),
            "setsByCategory": cats,
        },
        "routine": routine,
        "lifts": lifts,
        "loads": loads,
    }
    con.close()
    return out


def main():
    path = find_backup(sys.argv)
    if not path or not os.path.exists(path):
        sys.stderr.write("No .fitnotes file found. Pass a path, or put one in private/.\n")
        return 1
    out = build(path)
    t = out["totals"]
    sys.stderr.write(
        "%s: %d sets over %d days (%s -> %s), %d exercises, %d PRs, unit=%s, routine=%s\n" % (
            os.path.basename(path), t["sets"], t["days"], out["range"]["from"],
            out["range"]["to"], t["exercises"], t["prs"], out["displayUnit"],
            (out["routine"] or {}).get("name", "none")))
    json.dump(out, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
