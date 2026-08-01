#!/usr/bin/env python3
"""
Daily FitNotes -> Gist sync.

Fetches the newest .fitnotes backup from a Google Drive folder, parses it
with fitnotes_db.py, and merges the result into the tracker's secret gist.

Design rules, same posture as garmin_sync.py:

1.  BEST EFFORT, NEVER A DEPENDENCY. Any failure leaves the gist completely
    untouched and the dashboard keeps working from whatever it already has.
2.  FITNOTES OWNS LIFT DETAIL ONLY. It writes `lifts`, `prefs.loads`,
    `prefs.routine`, `prefs.unit`, and sets train/trainType on days that
    hold a lift. It never touches wake, light, caff, block, log, social,
    protein, notes, sleep times or run distances.
3.  WHOLESALE, NOT INCREMENTAL. A FitNotes export is a complete snapshot of
    all history, so `lifts` is replaced entire and stamped with
    `liftsUpdated`. The browser takes whichever side is newer. Merging
    per-day would strand days that FitNotes has since corrected.
4.  NO-OP WHEN NOTHING CHANGED. If the newest backup is the same file we
    already ingested (same Drive id + modifiedTime), exit without writing.

Env:
    GIST_ID            required -- the secret gist holding the tracker data
    GIST_TOKEN         required -- fine-grained PAT, Gists: Read and write
    GDRIVE_SA_JSON     required -- service-account key JSON (the whole blob)
    GDRIVE_FOLDER_ID   required -- the Drive folder shared with that account
"""

import json
import os
import sys
import tempfile
import time

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fitnotes_db import build  # noqa: E402

API = "https://api.github.com"
GIST_FILE = "focus-tracker-data.json"
DRIVE = "https://www.googleapis.com/drive/v3"


def log(msg):
    print(msg, flush=True)


# ---------- Google Drive ----------

def drive_token(sa_json):
    """Service-account access token. Scoped read-only on purpose."""
    try:
        from google.oauth2 import service_account
        from google.auth.transport.requests import Request
    except ImportError:
        raise SystemExit("google-auth is not installed; see sync/requirements.txt")
    info = json.loads(sa_json)
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/drive.readonly"])
    creds.refresh(Request())
    log("drive: authenticated as " + info.get("client_email", "?"))
    return creds.token


def drive_newest(token, folder_id):
    """Newest *.fitnotes in the folder, or None."""
    r = requests.get(
        DRIVE + "/files",
        headers={"Authorization": "Bearer " + token},
        params={
            "q": "'%s' in parents and trashed = false" % folder_id,
            "orderBy": "modifiedTime desc",
            "pageSize": 25,
            "fields": "files(id,name,size,modifiedTime)",
            "supportsAllDrives": "true",
            "includeItemsFromAllDrives": "true",
        },
        timeout=30)
    r.raise_for_status()
    files = r.json().get("files", [])
    hits = [f for f in files if f["name"].lower().endswith(".fitnotes")]
    if not hits:
        log("drive: no .fitnotes files in that folder (saw %d other file(s))" % len(files))
        return None
    f = hits[0]
    log("drive: newest is %s (%s bytes, modified %s)" %
        (f["name"], f.get("size", "?"), f["modifiedTime"]))
    return f


def drive_download(token, file_id, dest):
    r = requests.get(DRIVE + "/files/" + file_id,
                     headers={"Authorization": "Bearer " + token},
                     params={"alt": "media", "supportsAllDrives": "true"},
                     stream=True, timeout=120)
    r.raise_for_status()
    n = 0
    with open(dest, "wb") as fh:
        for chunk in r.iter_content(65536):
            fh.write(chunk)
            n += len(chunk)
    return n


# ---------- gist ----------

def gh_headers(token):
    return {"Authorization": "Bearer " + token,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def gist_get(gist_id, token):
    r = requests.get(API + "/gists/" + gist_id, headers=gh_headers(token), timeout=30)
    r.raise_for_status()
    raw = ((r.json().get("files") or {}).get(GIST_FILE) or {}).get("content")
    if not raw:
        return {}
    body = json.loads(raw)
    return body if isinstance(body, dict) else {}


def gist_put(gist_id, token, body):
    r = requests.patch(
        API + "/gists/" + gist_id, headers=gh_headers(token),
        json={"files": {GIST_FILE: {"content": json.dumps(body, indent=1)}}},
        timeout=30)
    r.raise_for_status()


def apply_to_body(body, parsed, stamp_ms):
    """Fold a parsed backup into the gist document. Returns days marked."""
    body["v"] = 2
    data = body.get("data")
    if not isinstance(data, dict):
        data = {}
    body["data"] = data

    body["lifts"] = parsed["lifts"]
    body["liftsUpdated"] = stamp_ms

    prefs = body.get("prefs")
    if not isinstance(prefs, dict):
        prefs = {}
    prefs["loads"] = parsed["loads"]
    prefs["unit"] = parsed["displayUnit"]
    if parsed.get("routine"):
        prefs["routine"] = parsed["routine"]
    # Bump so the browser takes these prefs, but never rewind a newer edit.
    prefs["_u"] = max(int(prefs.get("_u") or 0) + 1, stamp_ms)
    body["prefs"] = prefs

    marked = 0
    for iso, day in parsed["lifts"].items():
        if not any(e.get("sets") for e in day.get("exercises", [])):
            continue
        rec = data.get(iso)
        if not isinstance(rec, dict):
            rec = {"wake": False, "light": False, "train": False, "caff": False,
                   "block": False, "log": False, "wakeT": "", "bedT": "", "focus": "",
                   "trainType": "", "train2": "", "runKm": "", "liftTpl": "",
                   "social": False, "protein": False, "note": "", "_u": 0}
        before = dict(rec)
        rec["train"] = True
        # Never displace what Garmin recorded: a day that already holds a run
        # gains the lift as its second session.
        if not rec.get("trainType"):
            rec["trainType"] = "lift"
        elif rec["trainType"] != "lift" and not rec.get("train2"):
            rec["train2"] = "lift"
        if rec != before:
            rec["_u"] = stamp_ms
            data[iso] = rec
            marked += 1
    return marked


def main():
    gist_id = os.environ.get("GIST_ID", "").strip()
    gist_token = os.environ.get("GIST_TOKEN", "").strip()
    sa_json = os.environ.get("GDRIVE_SA_JSON", "").strip()
    folder = os.environ.get("GDRIVE_FOLDER_ID", "").strip()
    missing = [n for n, v in [("GIST_ID", gist_id), ("GIST_TOKEN", gist_token),
                              ("GDRIVE_SA_JSON", sa_json),
                              ("GDRIVE_FOLDER_ID", folder)] if not v]
    if missing:
        log("error: missing " + ", ".join(missing))
        return 2

    # Drive first. If any of this throws we exit before touching the gist.
    try:
        token = drive_token(sa_json)
        newest = drive_newest(token, folder)
    except Exception as exc:  # noqa: BLE001
        log("error: Drive fetch failed -- gist NOT modified. " + str(exc))
        return 1
    if not newest:
        log("nothing to do")
        return 0

    body = gist_get(gist_id, gist_token)
    fingerprint = newest["id"] + "@" + newest["modifiedTime"]
    if body.get("fitnotesSource") == fingerprint:
        log("already ingested %s -- no changes" % newest["name"])
        return 0

    tmp = os.path.join(tempfile.gettempdir(), "latest.fitnotes")
    try:
        n = drive_download(token, newest["id"], tmp)
        log("drive: downloaded %s bytes" % format(n, ","))
        parsed = build(tmp)
    except Exception as exc:  # noqa: BLE001
        log("error: could not read the backup -- gist NOT modified. " + str(exc))
        return 1
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)

    t = parsed["totals"]
    log("parsed: %d sets over %d days (%s -> %s), %d exercises, %d PRs, unit=%s" % (
        t["sets"], t["days"], parsed["range"]["from"], parsed["range"]["to"],
        t["exercises"], t["prs"], parsed["displayUnit"]))
    if not t["sets"]:
        log("backup holds no sets -- refusing to overwrite the gist with nothing")
        return 1

    stamp = int(time.time() * 1000)
    marked = apply_to_body(body, parsed, stamp)
    body["fitnotesSource"] = fingerprint
    gist_put(gist_id, gist_token, body)
    log("wrote lifts for %d days; marked %d day(s) as lift sessions" % (t["days"], marked))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
