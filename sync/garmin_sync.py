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
from datetime import date, datetime, timedelta, timezone

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

# Garmin activityType.typeKey -> our session type. This is a STRICT whitelist:
# anything not listed (walking, cycling, yoga) is not a session and must not
# tick "Trained", which is a Core Three item.
TRAIN_MAP = {
    "running": "run", "trail_running": "run", "treadmill_running": "run",
    "track_running": "run", "virtual_run": "run", "indoor_running": "run",
    "strength_training": "lift", "indoor_cardio": "lift",
    "stair_climbing": "snack",
}
# When a day holds more than one session, highest priority wins -- so the
# result doesn't depend on the order Garmin happens to return them in.
TRAIN_PRIORITY = {"lift": 3, "run": 2, "snack": 1}
MIN_ACTIVITY_SECONDS = 8 * 60


class RateLimited(Exception):
    """Garmin answered 429. Stop at once and leave the gist alone."""


def is_rate_limited(exc):
    """Blocks are account-level, last 48-72h, and extend if you keep asking.

    Matched by class name rather than importing garminconnect, so this module
    still imports (and its CSV half stays testable) without the library.
    """
    if type(exc).__name__ == "GarminConnectTooManyRequestsError":
        return True
    if getattr(getattr(exc, "response", None), "status_code", None) == 429:
        return True
    text = str(exc).lower()
    return "429" in text or "too many requests" in text


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
    """Garmin's dailySleepDTO returns epoch MILLISECONDS, not ISO strings.

    The "...Local" variants are pre-shifted by the local UTC offset, so reading
    them as UTC gives local wall-clock time -- converting with the runner's own
    timezone would shift them a second time. Using Local rather than GMT also
    means a trip abroad records the wall-clock time you actually woke at.

    ISO strings are still accepted because other endpoints (HRV) use them, and
    because getting this wrong is silent: feeding "1761100200000" to
    fromisoformat parses it as the year 1761 and yields a plausible "00:00".
    """
    if ts is None or ts == "" or isinstance(ts, bool):
        return ""
    if isinstance(ts, (int, float)):
        try:
            return datetime.fromtimestamp(ts / 1000, tz=timezone.utc).strftime("%H:%M")
        except (OverflowError, OSError, ValueError):
            return ""
    text = str(ts).strip()
    # Epoch millis that arrived as a string. The length guard keeps a bare
    # YYYYMMDD date from being mistaken for one.
    if text.isdigit():
        return hhmm(int(text)) if len(text) >= 10 else ""
    try:
        return datetime.fromisoformat(text.split(".")[0]).strftime("%H:%M")
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
    # The library defaults to 3 internal retries. Against an account-level
    # block that works against us, so keep it to one attempt.
    client = Garmin(retry_attempts=1)
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
            if is_rate_limited(exc):
                raise RateLimited(str(exc)) from exc
            log("garmin: no sleep for " + iso + " (" + str(exc) + ")")

        try:
            acts = client.get_activities_by_date(iso, iso) or []
            best = ""
            for a in acts:
                if (a.get("duration") or 0) < MIN_ACTIVITY_SECONDS:
                    continue
                key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
                mapped = TRAIN_MAP.get(key)
                if mapped is None:
                    continue  # a walk is not a session
                if not best or TRAIN_PRIORITY[mapped] > TRAIN_PRIORITY[best]:
                    best = mapped
            if best:
                entry["trainType"] = best
                entry["train"] = True
        except Exception as exc:  # noqa: BLE001
            if is_rate_limited(exc):
                raise RateLimited(str(exc)) from exc
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

    # `or 390` would swallow a legitimate midnight target, since minutes()
    # returns 0 for "00:00".
    target = minutes(os.environ.get("TARGET_WAKE", "06:30"))
    if target is None:
        log("warning: TARGET_WAKE is not HH:MM -- falling back to 06:30")
        target = 390
    try:
        days_back = max(1, min(14, int(os.environ.get("DAYS_BACK", "3"))))
    except ValueError:
        log("warning: DAYS_BACK is not a number -- falling back to 3")
        days_back = 3

    # Garmin first. If this throws we exit before touching the gist.
    try:
        garmin = fetch_garmin(days_back)
    except RateLimited as exc:
        log("error: Garmin answered 429 -- stopped at the first refusal.")
        log("The block is ACCOUNT-level, lasts 48-72h, and EXTENDS if you "
            "retry. Do not re-run this workflow today.")
        log("The gist was not modified. " + str(exc))
        return 1
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
