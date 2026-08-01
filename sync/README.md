# Garmin sync

Pulls bedtime, wake time and training sessions from Garmin once a day and writes
them into the tracker's secret Gist. Everything else stays manual.

**This is a best-effort enhancement, never a dependency.** If Garmin breaks it —
and they will — the workflow fails, the Gist is left untouched, and you carry on
entering things by hand.

---

## Why it works this way

**There is no official API.** Garmin's Connect Developer Program is *paused to
all new applicants*, companies included. Oura and Whoop both offer personal
OAuth; Garmin is the deliberate outlier. So this uses
[`python-garminconnect`](https://github.com/cyberjunky/python-garminconnect),
which talks to the mobile app's own endpoints. That is unsanctioned — a grey
area, not clearly prohibited, but Garmin has no obligation to keep it working.

**No password ever reaches CI.** You log in once locally, which also handles
MFA. The workflow only ever restores a token. This matters because a fresh SSO
login from a datacenter IP is exactly what trips Garmin's Cloudflare bot
detection.

**It polls once a day, and stops dead on a 429.** Reported rate-limit blocks are
**account-level, not IP-level**, last 48–72 hours, arrive with no warning email,
and *extend if you retry*. So the script aborts on the first refusal rather than
working through the remaining days, and the library's own retry count is turned
down to 1. Sleep finalises each morning, so daily polling costs nothing.

**Garmin only writes objective fields.** `wakeT`, `bedT`, `trainType`, `train`,
and the wake-within-±30min checkbox. It never touches morning light, caffeine,
blocks, logged, social, protein or your note — the merge is field-level,
not record-level, so your manual entries survive.

**"Trained" is a strict whitelist.** Only runs, strength training and stair
climbing count. A walk, a bike ride or a yoga session is ignored entirely rather
than being recorded as a generic session — ticking a Core Three item off the
back of an eight-minute walk would make the number meaningless. If a day holds
more than one session, **lift wins, then run, then stairs**, so the result
doesn't depend on the order Garmin returns them in.

---

## Setup

### 1. Get the token (once, on your own machine)

```bash
cd sync
pip install -r requirements.txt
python auth_setup.py
```

Enter your Garmin email, password, and an MFA code if you have 2FA. It prints a
base64 blob.

### 2. Add three repository secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `GARMIN_TOKENS` | the base64 blob from step 1 |
| `GIST_ID` | your tracker's gist ID (the app's Sync panel shows it) |
| `GIST_TOKEN` | fine-grained PAT with **only** Account permissions → Gists: Read and write |

Optionally, under **Variables**: `TARGET_WAKE` (default `06:30`) and `DAYS_BACK`
(default `3` — re-checks recent days in case sleep was scored late).

### 3. Run it

**Actions → Garmin sync → Run workflow.** Then check the gist.

After that it runs daily at 14:20 UTC (08:20 Denver).

---

## Secrets in a public repo — is that safe?

Yes, with two rules. Secrets are encrypted with a Libsodium sealed box, are
**not passed to workflows triggered from forks**, and Actions redacts them from
logs.

The two rules:

1. **Never add a `pull_request_target` workflow that checks out untrusted PR
   code.** That is the classic exfiltration hole.
2. **Never `echo` a secret.** Log redaction is not guaranteed once a value has
   been transformed — the runner can't redact what it didn't see.

Anyone with push access can trivially exfiltrate secrets, so protect `main`.

---

## Maintenance

**Expect breakage.** In March 2026 Garmin deployed Cloudflare TLS fingerprinting
and killed `garth` outright — seven releases in 36 hours, then deprecation.
`python-garminconnect` rebuilt auth natively and survived, but it is one library
with one maintainer talking to undocumented endpoints.

| Symptom | Cause | Fix |
|---|---|---|
| Auth error | OAuth1 token expired (~1 year) | Re-run `auth_setup.py`, update `GARMIN_TOKENS` |
| HTTP 429 | Account-level rate limit | The run aborts itself. **Wait 48–72h. Do not re-run** — retrying extends it |
| Sudden total failure | Garmin changed endpoints | Check for a `python-garminconnect` release, bump `requirements.txt` |

`requirements.txt` pins `garminconnect>=0.3.8,<0.4` on purpose. Patch releases
are usually the fix for "Garmin changed something overnight" and you want those
automatically; a minor bump has already removed a piece of the auth surface once
(`client.garth` vanished when the library dropped `garth`), so that should be a
decision rather than a surprise at 08:20.

---

## Backfill your history separately

Before relying on any of this, request a bulk export:
**Garmin Connect → Account Management Center → Export Your Data.**

24–48h turnaround, free, zero ToS ambiguity, zero rate-limit risk. The archive
contains `DI-Connect-Wellness/*_sleepData.json` with
`sleepStartTimestampGMT` / `sleepEndTimestampGMT` going back **years** — your
entire wake-time regularity history, banked, whether or not this automation ever
works.

Do not backfill by hammering the API.
