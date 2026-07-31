# Focus &amp; Energy Tracker

A single-file daily tracker for five behaviours, ranked by the quality of the evidence behind them — plus a caffeine-at-bedtime calculator and a wake-time regularity readout.

**Live:** https://hewentto.github.io/focustracker/

No build step, no dependencies, no backend. One HTML file.

---

## The five behaviours

| # | Behaviour | Tier | Evidence |
|---|---|---|---|
| 1 | Woke within ±30 min of target | 1 | Sleep Regularity Index predicted mortality better than duration, and duration added nothing beyond it (Windred et al. 2024, UK Biobank, N=60,977) |
| 2 | Caffeine within plan | 1 | Pooled caffeine cost: −45 min sleep, −7% efficiency, −11.4 min deep sleep (Gardiner et al. 2023, 24 studies) |
| 3 | Ran both binding blocks (phone + laptop) | 1 | Imposed blocking +22–24% productivity; the same tool self-administered produced nothing (WEIS 2017, N=455) |
| 4 | 15–20 min walk at the afternoon dip | 2 | Acute exercise → feelings of energy Δ = 0.47 (Loy, O'Connor & Dishman 2013) |
| 5 | Logged the day in writing | 2 | Progress monitoring → goal attainment d+ = 0.40 (Harkin et al. 2016, 138 RCTs, N=19,951) |

The tracker deliberately counts **behaviours, not outcomes**. Harkin's matching principle: monitoring behaviour improves behaviour (d+ = 0.79) while monitoring outcomes improves outcomes (d+ = 0.62) — they do not cross over.

---

## Setup

### 1. Turn on GitHub Pages

**Settings → Pages → Build and deployment → Source: _Deploy from a branch_ → Branch: `main`, folder `/ (root)` → Save.**

Give it a minute, then the site is live at `https://hewentto.github.io/focustracker/`.

### 2. Add it to your phone

Open the URL in Safari or Chrome on your phone → Share → **Add to Home Screen**. It gets an icon and opens without browser chrome.

### 3. (Optional) Sync across devices

The tracker saves automatically in each browser's local storage. That's per-device — your phone and laptop keep separate logs until you connect them.

To sync, the app writes to a **secret Gist** on your own account:

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → *Generate new token*
2. Set an expiry. **Skip repository access entirely.**
3. Under **Account permissions**, set **Gists → Read and write**. Nothing else.
4. Generate, copy, paste it into the tracker's *Sync* panel, press **Save token & sync now**.
5. The first sync creates a secret gist called `focus-tracker-data.json` and shows you its ID. Paste that ID into the tracker on your other device so both point at the same gist.

**Data never touches this repo.** It lives in browser local storage and, if you enable sync, in a secret gist on your account.

#### On a work laptop

Consider skipping the token there. It sits in that browser's local storage — fine on a personal device, a judgement call on a managed one. Without a token the tracker still saves locally; you just don't get sync on that machine. The token scope is deliberately minimal: `Gists: Read and write` can read and write your gists and nothing else — no repos, no code, no account settings.

If you'd rather move data by hand, the sync panel has **Copy data as text** / **Restore from text**, which needs no token at all.

---

## How the data is stored

```json
{
  "v": 1,
  "data": {
    "2026-07-31": {
      "wake": true, "caff": true, "block": false, "walk": true, "log": true,
      "wakeT": "06:45", "bedT": "23:10", "focus": "50",
      "note": "ticket was vague, spent an hour scoping it",
      "_u": 1753977600000
    }
  }
}
```

`_u` is the last-edit timestamp. Sync merges per-day, newest edit wins — so editing on your phone and then your laptop doesn't lose anything, as long as you don't edit the *same day* on both while offline.

---

## Notes on the caffeine calculator

Defaults are set for a 160 mg drink at 12:30pm with an 11pm bedtime. It computes:

- **mg remaining at bedtime** — first-order elimination, `dose × 0.5^(hours / half-life)`
- **latest safe time** — interpolated between Gardiner et al.'s two published anchors (107 mg → 8.8 h before bed; 217.5 mg → 13.2 h). *The interpolation is mine, not the authors'.*

Half-life in healthy adults ranges 2.3–9.9 h, and roughly 54% of people carry the slow-metabolising CYP1A2 variant. You don't know which you are without a test, so the sensible default is to plan for the slower end. Label doses also understate the real total, because guarana's caffeine content isn't required on the label.

---

## What this is not

A plan that will definitely work.

In the Milkman et al. gym megastudy (*Nature* 2021, N = 61,293, 54 arms designed by 30 scientist teams), expert forecasts of which interventions would succeed correlated with actual results at **r = 0.02** and were on average **9.1× too optimistic**. 45% of arms beat control at 4 weeks; **8% still did at week 10**.

These five are ranked by evidence *quality*, which is knowable — not by what will work for one person, which isn't. Expect decay, expect to swap items out, and treat a missed day as data rather than a verdict. Lally et al. 2010 measured what a missed day actually costs: 0.29 automaticity points, no significant long-term effect. **"Never miss twice" is supported. "Never miss once" is not.**

Not medical advice.

---

## Licence

MIT. Take it, fork it, change the five behaviours to whatever your own evidence review points at.
