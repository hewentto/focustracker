#!/usr/bin/env python3
"""
Daily Garmin -> Gist sync for the Best Jared tracker.

Design rules, in priority order:

1.  BEST EFFORT, NEVER A DEPENDENCY. If anything fails, the gist is left
    completely untouched and the tracker keeps working with manual entry.
2.  GARMIN OWNS OBJECTIVE FIELDS ONLY. It writes wakeT, bedT, trainType,
    train and the wake checkbox. It never touches light, caff, block, log,
    social, protein or note -- those are yours.
3.  ONE API CALL SET PER DAY. Garmin rate limits at the ACCOUNT level and
    blocks last 48-72h. Sleep finalises each morning, so daily loses nothing.
4.  TOKEN ONLY. No password ever reaches CI.

Env:
    GIST_ID       required -- the secret gist holding the tracker data
    GIST_TOKEN    required -- fine-grained PAT, Gists: Read and write
    GARMINTOKENS  optional -- token dir (default ~/.garminconnect)
    TARGET_WAKE   optional -- HH:MM, default 06:30
    DAYS_BACK     optional -- how many days to refresh, default 3
"""

import json
import os
from datetime import date, datetime, timedelta

import requests

GIST_FILE = "focus-tracker-data.json"
CSV_FILE = "focus-log.csv"
API = "https://api.github.com"

CORE3 = ("wake", "light", "train")
CSV_HEADER = [
    "date", "wake_within_30m", "morning_light", "trained", "caffeine_plan",
    "both_blocks", "logged", "core3_all", "training_type", "wake_time",
    "bed_time", "sleep_hours", "longest_block_min",
    "social_contact", "protein_target", "note",
]

# Garmin activityType.typeKey -> our session type.
TRAIN_MAP = {
    "running": "run", "trail_running": "run", "treadmill_running": "run",
    "track_running": "run", "virtual_run": "run", "indoor_running": "run",
    "strength_training": "lift", "indoor_cardio": "lift",
    "stair_climbing": "snack",
}
MIN_ACTIVITY_SECONDS = 8 * 60


def log(msg):
    print(msg, flush=True)


def blank_day():
    return {
        "wake": False, "light": False, "train": False, "caff": False,
        "block": False, "log": False, "wakeT": "", "bedT": "", "focus": "",
        "trainType": "", "social": False, "protein": False,
        "note": "", "_u": 0,
    }


def hhmm(ts):
    """Garmin local timestamps look like '2026-07-31T06:41:00.0'."""
    if not ts:
        return ""
    try:
        return datetime.fromisoformat(str(ts).split(".")[0]).strftime("%H:%M")
    except ValueError:
        return ""


def minutes(hm):
    if not hm or ":" not in hm:
        return None
    h, m = hm.split(":")[:2]
    return int(h) * 60 + int(m)


def sleep_hours(rec):
    a, b = minutes(rec.get("wakeT", "")), minutes(rec.get("bedT", ""))
    if a is None or b is None:
        return ""
    d = a - b
    if d < 0:
        d += 1440
    return "%.2f" % (d / 60)


def csv_escape(v):
    s = "" if v is None else str(v)
    return '"' + s.replace('"', '""') + '"' if any(c in s for c in ',"\n\r') else s


def to_csv(db):
    rows = []
    for day in sorted(db):
        r = db[day]
        rows.append(",".join(csv_escape(v) for v in [
            day,
            int(bool(r.get("wake"))), int(bool(r.get("light"))),
            int(bool(r.get("train"))), int(bool(r.get("caff"))),
            int(bool(r.get("block"))), int(bool(r.get("log"))),
            int(all(r.get(k) for k in CORE3)),
            r.get("trainType", ""), r.get("wakeT", ""), r.get("bedT", ""),
            sleep_hours(r), r.get("focus", ""),
            int(bool(r.get("social"))), int(bool(r.get("protein"))),
            r.get("note", ""),
        ]))
    return ",".join(CSV_HEADER) + "\n" + "\n".join(rows) + "\n"


def gh_headers(token):
    return {"Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def gist_get(gist_id, token):
    r = requests.get(API + "/gists/" + gist_id,
                     headers=gh_headers(token), timeout=30)
    r.raise_for_status()
    files = r.json().get("files", {})
    raw = (files.get(GIST_FILE) or {}).get("content")
    if not raw:
        log("note: " + GIST_FILE + " not in gist yet, starting fresh")
        return {}
    return json.loads(raw).get("data", {})


def gist_put(gist_id, token, db):
    r = requests.patch(
        API + "/gists/" + gist_id,
        headers=gh_headers(token),
        json={"files": {
            GIST_FILE: {"content": json.dumps({"v": 2, "data": db}, indent=1)},
            CSV_FILE: {"content": to_csv(db)},
        }},
        timeout=30)
    r.raise_for_status()


def fetch_garmin(days_back):
    """Returns {iso_date: {wakeT, bedT, trainType, train}}. Raises on auth failure."""
    from garminconnect import Garmin

    tokenstore = os.environ.get(
        "GARMINTOKENS", os.path.expanduser("~/.garminconnect"))
    client = Garmin()
    client.login(tokenstore)
    log("garmin: authenticated from stored token")

    out = {}
    today = date.today()
    for offset in range(days_back):
        iso = (today - timedelta(days=offset)).isoformat()
        entry = {}

        try:
            dto = (client.get_sleep_data(iso) or {}).get("dailySleepDTO") or {}
            bed = hhmm(dto.get("sleepStartTimestampLocal"))
            wake = hhmm(dto.get("sleepEndTimestampLocal"))
            if wake:
                entry["wakeT"] = wake
            if bed:
                entry["bedT"] = bed
        except Exception as exc:  # noqa: BLE001
            log("garmin: no sleep for " + iso + " (" + str(exc) + ")")

        try:
            acts = client.get_activities_by_date(iso, iso) or []
            best = ""
            for a in acts:
                if (a.get("duration") or 0) < MIN_ACTIVITY_SECONDS:
                    continue
                key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
                mapped = TRAIN_MAP.get(key, "other")
                # Prefer a real session over a walk if the day has both.
                if best in ("", "other") or mapped in ("lift", "run"):
                    best = mapped
            if best:
                entry["trainType"] = best
                entry["train"] = True
        except Exception as exc:  # noqa: BLE001
            log("garmin: no activities for " + iso + " (" + str(exc) + ")")

        if entry:
            out[iso] = entry
            log("garmin: " + iso + " -> " + json.dumps(entry))
    return out


def main():
    gist_id = os.environ.get("GIST_ID", "").strip()
    gist_token = os.environ.get("GIST_TOKEN", "").strip()
    if not gist_id or not gist_token:
        log("error: GIST_ID and GIST_TOKEN are required")
        return 2

    target = minutes(os.environ.get("TARGET_WAKE", "06:30")) or 390
    days_back = int(os.environ.get("DAYS_BACK", "3"))

    # Garmin first. If this throws we exit before touching the gist.
    try:
        garmin = fetch_garmin(days_back)
    except Exception as exc:  # noqa: BLE001
        log("error: garmin fetch failed -- gist NOT modified. " + str(exc))
        log("If this is an auth error, re-run sync/auth_setup.py locally and "
            "update the GARMIN_TOKENS secret.")
        return 1

    if not garmin:
        log("nothing to write")
        return 0

    db = gist_get(gist_id, gist_token)
    now_ms = int(datetime.now().timestamp() * 1000)
    changed = 0

    for iso, fields in garmin.items():
        rec = db.get(iso) or blank_day()
        before = dict(rec)

        # Objective fields only. Everything else is left exactly as-is.
        for key in ("wakeT", "bedT", "trainType"):
            if fields.get(key):
                rec[key] = fields[key]
        if fields.get("train"):
            rec["train"] = True

        wake_m = minutes(rec.get("wakeT", ""))
        if wake_m is not None:
            delta = abs(wake_m - target)
            delta = min(delta, 1440 - delta)
            rec["wake"] = delta <= 30

        if rec != before:
            rec["_u"] = now_ms
            db[iso] = rec
            changed += 1

    if not changed:
        log("no changes")
        return 0

    gist_put(gist_id, gist_token, db)
    log("wrote " + str(changed) + " day(s) to gist; " + str(len(db)) + " total")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
