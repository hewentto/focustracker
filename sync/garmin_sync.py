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
# APPEND-ONLY. New columns go on the end, never inserted, or every CSV
# already downloaded misaligns against a new one. Must stay byte-identical
# to the `hdr` array in t/e2e545319a/app.js toCSV().
# `longest_block_min` is retired from the UI but kept so historical CSVs
# and the two-sided parity both survive.
CSV_HEADER = [
    "date", "wake_within_30m", "morning_light", "trained", "caffeine_plan",
    "both_blocks", "logged", "core3_all", "training_type", "wake_time",
    "bed_time", "sleep_hours", "longest_block_min",
    "social_contact", "protein_target", "note",
    "training_type_2", "run_km", "lift_template",
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
        "trainType": "", "train2": "", "runKm": "", "liftTpl": "",
        "social": False, "protein": False, "note": "", "_u": 0,
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


def _hhmm(m):
    return "%02d:%02d" % (m // 60, m % 60) if m is not None else "--:--"


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
            r.get("train2", ""), r.get("runKm", ""), r.get("liftTpl", ""),
        ]))
    return ",".join(CSV_HEADER) + "\n" + "\n".join(rows) + "\n"


def gh_headers(token):
    return {"Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def gist_get(gist_id, token):
    """Return the WHOLE document, not just its `data` key.

    Returning only `data` and rebuilding {v, data} on write silently
    destroyed every sibling key -- which is why the app's prefs could
    not live in the gist. Whatever else is in there, we hand it back
    untouched.
    """
    r = requests.get(API + "/gists/" + gist_id,
                     headers=gh_headers(token), timeout=30)
    r.raise_for_status()
    files = r.json().get("files", {})
    raw = (files.get(GIST_FILE) or {}).get("content")
    if not raw:
        log("note: " + GIST_FILE + " not in gist yet, starting fresh")
        return {}
    body = json.loads(raw)
    return body if isinstance(body, dict) else {}


def gist_put(gist_id, token, body, db):
    """Write db back into the document we read, preserving unknown keys."""
    out = dict(body)
    out["v"] = 2
    out["data"] = db
    r = requests.patch(
        API + "/gists/" + gist_id,
        headers=gh_headers(token),
        json={"files": {
            GIST_FILE: {"content": json.dumps(out, indent=1)},
            CSV_FILE: {"content": to_csv(db)},
        }},
        timeout=30)
    r.raise_for_status()


def _day_of(ms):
    """Local calendar date of an epoch-ms stamp, or "" if it isn't one.

    The runner's clock is UTC and datetime.now() below is naive-local on
    that same clock, so "same day" here means the same UTC day -- which
    is exactly what a once-a-day cron means by it.
    """
    try:
        return datetime.fromtimestamp(int(ms) / 1000).date().isoformat()
    except (TypeError, ValueError, OverflowError, OSError):
        return ""


def stamp_source(body, name, now_ms, through):
    """Record that this job finished, and the newest date it has data for.

    `sources` is a TOP-LEVEL key -- {name: {okAt, through}} -- sitting
    beside `data` rather than inside any day record. That is the whole
    point of it: provenance is a fact about the document, so it never
    reaches blank_day(), CSV_HEADER, to_csv() or int(bool(...)), and this
    phase adds no day field at all.

    Call it on the no-op paths too. "Ran fine, found nothing" and "did
    not run" are different facts, and with no stamp on the quiet path a
    stream that dies is indistinguishable from a person who stopped.

    Returns True only if the document actually changed, so a caller with
    nothing else to say can skip the PATCH. A same-day re-run (the
    workflow_dispatch button) that learned nothing new does NOT re-stamp:
    a write, a new gist revision and a full CSV regeneration to move a
    clock by four minutes buys nothing the date already said.
    """
    sources = body.get("sources")
    if not isinstance(sources, dict):
        sources = {}
    prev = sources.get(name)
    if not isinstance(prev, dict):
        prev = {}

    # Never rewind `through`. This run only ever looked at its own window,
    # so an empty answer is ignorance -- not evidence the older date was
    # wrong. Both sides are coerced to str first because the comparison is
    # lexicographic on ISO dates and must not raise on a stray number.
    was = str(prev.get("through") or "")
    best = was
    if through and str(through) > best:
        best = str(through)

    if best == was and _day_of(prev.get("okAt")) == _day_of(now_ms):
        return False

    # dict(prev), not a fresh literal -- the same posture gist_put() takes
    # with dict(body). If a later writer put a third key in here, keep it.
    entry = dict(prev)
    entry["okAt"] = now_ms
    entry["through"] = best
    sources[name] = entry
    body["sources"] = sources
    return True


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
            kinds, run_m = [], 0.0
            for a in acts:
                if (a.get("duration") or 0) < MIN_ACTIVITY_SECONDS:
                    continue
                key = ((a.get("activityType") or {}).get("typeKey") or "").lower()
                mapped = TRAIN_MAP.get(key)
                if mapped is None:
                    continue  # a walk is not a session
                kinds.append(mapped)
                # Distance arrives in METRES, and only a run should carry one --
                # indoor_cardio maps to "lift" and would otherwise attach a
                # distance to a lifting day.
                if mapped == "run":
                    run_m += float(a.get("distance") or 0)
            if kinds:
                # Highest priority is the day's session; the best DIFFERENT
                # kind becomes the second, so a lift-plus-run day stops
                # undercounting one of them.
                ordered = sorted(set(kinds), key=lambda k: -TRAIN_PRIORITY[k])
                entry["trainType"] = ordered[0]
                entry["train"] = True
                if len(ordered) > 1:
                    entry["train2"] = ordered[1]
            if run_m > 0:
                entry["runKm"] = "%.2f" % (run_m / 1000.0)
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

    # The document has to be in hand BEFORE the "no data" exit below,
    # because a quiet day still owes a heartbeat. But a read that failed
    # must never turn into a write: gist_put() sets out["data"] = db AND
    # regenerates the CSV from it, so one transient 502 followed by a
    # heartbeat PATCH would replace the entire record with an empty one.
    # Exit non-zero having written nothing whatsoever -- rule 1.
    try:
        body = gist_get(gist_id, gist_token)
    except Exception as exc:  # noqa: BLE001
        log("error: could not read the gist -- NOTHING was written, not even "
            "a heartbeat. " + str(exc))
        return 1
    db = body.get("data", {}) if isinstance(body.get("data"), dict) else {}

    now_ms = int(datetime.now().timestamp() * 1000)
    # The newest day this run actually saw data for -- empty on a quiet
    # day, in which case stamp_source() keeps whatever an earlier run
    # recorded. ISO keys, so max() is the latest date.
    newest = max(garmin) if garmin else ""
    stamped = stamp_source(body, "garmin", now_ms, newest)

    if not garmin:
        if not stamped:
            log("nothing to write, and today's heartbeat is already stamped")
            return 0
        # `db` is the dict we just read, untouched, so `data` and the CSV
        # regenerate byte-identical. The only change is sources.garmin.
        gist_put(gist_id, gist_token, body, db)
        log("nothing to write; stamped sources.garmin so a silent day still "
            "reads as 'ran, found nothing'")
        return 0

    # The app owns the wake targets. Reading them from the gist is what
    # stops Python judging Saturday against 06:30 and writing wake=False
    # while the app's own band says the day was fine.
    prefs = body.get("prefs") if isinstance(body.get("prefs"), dict) else {}
    t_week = minutes(prefs.get("targetWake", "")) if prefs else None
    t_wknd = minutes(prefs.get("targetWakeWeekend", "")) if prefs else None
    if t_week is None:
        t_week = target
    if t_wknd is None:
        t_wknd = t_week
    log("targets: weekday %s, weekend %s%s" % (
        _hhmm(t_week), _hhmm(t_wknd), " (from gist prefs)" if prefs else " (from env)"))

    changed = 0

    for iso, fields in garmin.items():
        rec = db.get(iso) or blank_day()
        before = dict(rec)

        # Objective fields only. Everything else is left exactly as-is.
        for key in ("wakeT", "bedT", "trainType", "train2", "runKm"):
            if fields.get(key):
                rec[key] = fields[key]
        if fields.get("train"):
            rec["train"] = True

        wake_m = minutes(rec.get("wakeT", ""))
        if wake_m is not None:
            weekend = date.fromisoformat(iso).weekday() >= 5
            tgt = t_wknd if weekend else t_week
            delta = abs(wake_m - tgt)
            delta = min(delta, 1440 - delta)
            rec["wake"] = delta <= 30

        if rec != before:
            rec["_u"] = now_ms
            db[iso] = rec
            changed += 1

    # `stamped` keeps a genuinely quiet day from PATCHing twice a morning,
    # but it must not suppress the write when a day did change.
    if not changed and not stamped:
        log("no changes")
        return 0

    # The only PATCH on this path -- the heartbeat rides along with the
    # days rather than costing a second write.
    gist_put(gist_id, gist_token, body, db)
    if changed:
        log("wrote " + str(changed) + " day(s) to gist; " + str(len(db)) + " total")
    else:
        log("no day changed; wrote the sources.garmin heartbeat only")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
