# Building the Best Jared

A single-page health dashboard that executes the programme in [PLAN.md](PLAN.md) rather than just recording against it. No build step, no dependencies, no backend — four scripts and one HTML file on GitHub Pages.

**Live:** `https://hewentto.github.io/focustracker/t/e2e545319a/`

The root path deliberately 404s.

---

## The three tabs

| Tab | Answers | Opens |
|---|---|---|
| **Today** | Am I done? | ~365×/year |
| **Programme** | What am I supposed to do? | ~5×/week |
| **Review** | What's actually getting ticked? | ~6×/year |

Frequency decides the shell. Today is what the app protects: the six taps sit above the fold on a 375×812 phone, each row a 56px target, and the Core Three hero above them is a **read-out, not a control** — one state, one write target.

### Today

A `2/3` hero, the Core Three meter, then the six one-tap dailies. Below them a two-line prescription strip naming today's session, the calendar-week counters, and the caffeine cutoff collapsed to the one number it exists to produce.

The six behaviours, and what they rest on:

| # | Behaviour | Evidence |
|---|---|---|
| 1 | Woke within ±30 min of target | Sleep regularity beat duration for predicting mortality, and duration added nothing once regularity was in the model (Windred 2024, UK Biobank, N=60,977) |
| 2 | Outside within 90 min of waking, 10+ min | One week of natural light advanced melatonin onset ~2 h, within-subject (Wright 2013) |
| 3 | Trained — lift, run, or stair snacks | Exercise logging is the only self-monitoring category that survives: 61% sustained at 11 months vs 21% for diet logging |
| 4 | Caffeine within plan | Pooled cost −45 min sleep, −11.4 min deep sleep (Gardiner 2023, 24 studies) |
| 5 | Both binding blocks ran | Imposed blocking +22–24% productivity; the same tool self-administered produced nothing (WEIS 2017, N=455) |
| 6 | Logged the day in writing | Progress monitoring → goal attainment d+ = 0.40 (Harkin 2016, 138 RCTs, N=19,951) |

**1–3 are the Core Three.** Hit those on a day that's falling apart and the day counts. That isn't softness — Lally 2010 measured what a missed day costs: 0.29 automaticity points, no significant long-term effect. The app flags **missed twice running**, never streaks, and never flags a day still in progress.

### Programme

Renders entirely from a start date plus static content transcribed from PLAN §3 and §4, so it is **correct on install day with zero logged days**: today's session in full, the A/B lifting template with sets × reps × RIR, the 16-week Tue/Thu running onramp, the run-load ceiling (110% of your longest run in 30 days), the week-17 answer card, and the guardrails.

Lift loads persist forward — typed once, edited when they change, never retyped per session.

### Review

One filter row scopes everything below it, and every percentage is read against a stated coverage denominator. Verdicts stay suppressed below 14 logged days, because judging an item at day 3 is noise when median habit formation is 66 days.

- **Wake dot plot** — weekdays in the accent, weekends gray, the ±30 min target band behind. Regularity and hour are different problems and the chart separates them.
- **Triage table** — the ten tracked items, worst-marked, answering §9's *"which items are actually getting ticked, and park the ones that aren't."*
- **Behaviour heatmap** — one column per day, no aggregation, so a bad week stays visible as itself.
- **Notes and a full table twin** — every value in a chart is also reachable without hovering.

What it refuses to do: no composite score, no outcome metrics, no correlations between the binaries (45 pairwise comparisons at n=56 is a p-hacking machine), no projections.

---

## Files

```
t/e2e545319a/
  index.html     markup + CSS (design tokens, three tab subtrees)
  gate.js        passphrase gate config
  programme.js   static PLAN.md content — data, not logic
  charts.js      one chart registry, one ResizeObserver, one tooltip
  app.js         router, state, prefs, the four views
sync/
  garmin_sync.py daily Garmin → Gist sync (GitHub Action)
  auth_setup.py  one-time local login, emits a token blob
```

---

## Privacy — read this before trusting it

This repo is public and GitHub Pages serves public sites. Two things follow, and they are different.

**Your data is genuinely private.** The log lives in your browser's local storage and, if you enable sync, in a *secret* gist on your account. It is never committed here. Someone who finds the URL sees an empty form.

**The passphrase gate is a curtain, not a lock.** It hashes your input with SHA-256 and compares it to a hash baked into `gate.js`. Anyone can view-source, read the hash, and bypass the check. It stops casual discovery and someone opening the tab over your shoulder — nothing more. For real access control you need a host that authenticates before serving the HTML; Cloudflare Pages with Access does this on the free tier.

A "secret" gist is *unlisted*, not access-controlled: anyone with the ID can read it.

### Setting the passphrase

Open the app, expand **Set or change the passphrase** on the lock screen, type the phrase, and copy the SHA-256 hash it shows into `GATE_HASH` in [`t/e2e545319a/gate.js`](t/e2e545319a/gate.js). While `GATE_HASH` is empty the gate is disabled, so you are never locked out before configuring it.

---

## Sync

Saves automatically per browser. To share across devices, paste a GitHub fine-grained token (**Account permissions → Gists: Read and write**, no repository access) into Setup. The first sync creates a secret gist and shows its ID; paste that ID on your other device.

Merging is **field-level**: the newest edit wins per field, and anything this device changed since its last successful push is re-applied after every merge. So the 08:20 Garmin job cannot swallow a tick or a note you made that morning and hadn't synced.

On a work laptop, consider skipping the token — the tracker still saves locally and Download CSV still works.

### Garmin

A GitHub Action pulls sleep and activities once a day. Setup and the failure modes are in [`sync/README.md`](sync/README.md). It is a **best-effort enhancement, never a dependency**: if it breaks, the gist is left untouched and you keep logging by hand.

---

## How the data is stored

```json
{
  "v": 2,
  "data": {
    "2026-07-31": {
      "wake": true, "light": true, "train": true,
      "caff": false, "block": false, "log": true,
      "wakeT": "06:41", "bedT": "23:10",
      "trainType": "lift", "train2": "run", "runKm": "5.20",
      "social": false, "protein": true,
      "note": "ticket was vague, spent an hour scoping it",
      "_u": 1753977600000
    }
  },
  "prefs": { "programStart": "2026-08-01", "targetWake": "06:30", "_u": 1753977600000 }
}
```

`_u` is the last-edit timestamp. Both the app and the Python sync **preserve top-level keys they don't recognise**, so adding a field on one side can't destroy one written by the other.

Two rules if you add a day field: it must be touched in all ten places (JS `blank()`, `FIELDS`, `isEmpty()`, `save()`, `loadDay()`, `toCSV()` header *and* row, the HTML control, plus Python `blank_day()`, `CSV_HEADER`, `to_csv()`), and **CSV columns are append-only** — inserting one misaligns every CSV already downloaded.

---

## Notes on the caffeine calculator

Defaults: 160 mg at 12:30pm, 11pm bedtime. It computes mg remaining at bedtime by first-order elimination, and a latest-safe-time interpolated between Gardiner et al.'s two published anchors (107 mg → 8.8 h; 217.5 mg → 13.2 h). *The interpolation is mine, not the authors'.*

Half-life in healthy adults ranges 2.3–9.9 h and roughly 54% of people carry the slow-metabolising CYP1A2 variant, so plan for the slower end. Label doses understate the real total — guarana's caffeine isn't required on the label.

---

## What this is not

A plan that will definitely work.

In the Milkman et al. gym megastudy (*Nature* 2021, N = 61,293, 54 arms designed by 30 scientist teams), expert forecasts of which interventions would succeed correlated with actual results at **r = 0.02** and were on average **9.1× too optimistic**. 45% of arms beat control at 4 weeks; **8% still did at week 10**.

These items are ranked by evidence *quality*, which is knowable — not by what will work for one person, which isn't. Expect decay, expect to swap items out, and treat a missed day as data rather than a verdict. **"Never miss twice" is supported. "Never miss once" is not.**

Not medical advice.

---

## Licence

MIT.
