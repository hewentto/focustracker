<!-- Derived from the prior-art survey of 190 DIY tracking dashboards (2026-08-01).
     Every line-number claim below was checked against the source before this file was
     written; the load-bearing ones are listed as verified in the preamble. -->

# Roadmap

What the prior-art survey actually implies for this app, after seven feature specs were
written against the real call sites, adversarially reviewed, and put through a migration
critic and a sequencing critic. Most of the survey's headline recommendations were cut.
The reasons are in section 2, and they are the useful part.

**Verified against source before writing** — all confirmed:

| Claim | Site | Status |
|---|---|---|
| `logged` counts machine-created records | `app.js:1007` | confirmed |
| Garmin/FitNotes create day records unprompted | `garmin_sync.py:337`, `fitnotes_sync.py:160`, `app.js:247` | confirmed |
| `merge()` is whole-record LWW, not field-level | `app.js:1301` | confirmed — `README.md:93` overstates it |
| A corrupt gist read still PATCHes, wiping `REMOTE_EXTRA` | `app.js:1349` | confirmed — destroys `fitnotesSource` |
| `lsSet` swallows `QuotaExceededError` silently | `app.js:131` | confirmed |
| `navigator.storage.persist()` is never called | — | confirmed by grep |
| `markDirty` uses `!==`, so an object field would stay dirty forever | `app.js:335` | confirmed |
| `applyRoute` coerces unknown hashes to `today` | `app.js:353` | confirmed — kills any in-page TOC |
| Gist `v` is written in 3 places and read in 0 | `app.js:1326`, `garmin_sync.py:198`, `fitnotes_sync.py:135` | confirmed |
| The `flags` loop is dead code | `app.js:648` | confirmed |
| Twin empty-state `colSpan` is 18 against 16 headers | `app.js:1194` | confirmed |
| Heat cells are ~3.8px at the 56-day phone default | `charts.js:317`, gate at `:351` | confirmed — tooltips already off there |
| A 4th hand-copy of the day schema, absent from the README checklist | `fitnotes_sync.py:161` | confirmed |

Already done, so deliberately not re-proposed: the Garmin cron is offset (`20 14 * * *`),
both workflows share `concurrency: tracker-gist`, there is a failure explainer and a
`workflow_dispatch` button, the heatmap already encodes missed-twice as an outline rather
than by hue, and the data-table twin already ships.

---

## 1. The shape of it

The one real defect underneath five of the seven specs is that `logged` at `app.js:1007` means "a record exists", and three writers create records with no human involved — `garmin_sync.py:337-358`, `fitnotes_sync.py:159-176`, and the browser FitNotes import at `app.js:247`/`:280`. Everything in Phase 1 follows from replacing that one predicate, and it is a pure-render change: no field, no column, no Python, no device reload. The tri-state binary is deferred but its **wire format is frozen now**, because it determines both the CSV slot order and the field list inside the new predicate: a day gains one string field `skipped`, holding a **space-joined** list of `KEYS` names in `KEYS` order (`"train block"`), sitting *beside* the six booleans, which never change their value domain. Space-joined, not comma-joined, because a comma forces CSV quoting and the quoting would then have to agree byte-for-byte between `csvEsc` (`/[",\n\r]/`, app.js:1266) and `csv_escape` (`,"\n\r`, garmin_sync.py:147) — they agree today, and there is no reason to put the one new field into the one path where the two languages could diverge. A string primitive, not an object, because `markDirty` compares `base[f] !== after[f]` at `app.js:335`, which on an object is a reference compare and would mark the day dirty on every save forever. A key is not-applicable only if it is listed **and** its boolean is false, so Garmin and FitNotes stay skip-blind and `int(bool(...))` at `garmin_sync.py:156-158` is never handed a truthy sentinel.

---

## 2. Cut from the plan

**Compare-and-swap revision protocol (spec 5, Phase 2). Cut.** A consistency protocol implemented three times against an API with no `If-Match` support, verified only by hand, in a codebase with no test framework — to protect against a race the system already self-heals from. `garmin_sync.py:294` rewrites 3 days every morning and only writes when `rec != before` (`:356`), so a clobbered `wakeT` returns within 72h unaided. Both workflows already share `concurrency: group tracker-gist` and run 20 minutes apart. Its own reviewer found the repair loop overwrites the user's unsynced tap (`dropDirty(sent)` at `app.js:1372` runs before the repair, and `merge()` at `:1301` is record-level LWW) and resurrects every day ever cleared (`:1299` has no tombstone). The residual protected case is one person with two devices on a 4-second debounce.

**`h:1` answeredness stamp (spec 2). Cut, superseded.** Spec 2 is spec 3 plus a stored field. Because `h` cannot be backfilled, spec 2 must keep the `HUMAN_FIELDS` heuristic permanently anyway — so the field buys exactly one edge case (a day where the human ticked only `wake` and/or `train`) at the cost of a schema change, a CSV column, a Python parity pass and a deploy gate. Take the heuristic alone. Spec 2's *rewiring list* is kept in full; only the stored field is dropped.

**Heatmap cursor, keyboard nav, prev/next steppers, "Open this day". Cut.** At the 56-day default on 375px, `plotW = w - padL - 8 ≈ 211` and `cw ≈ 3.8` (charts.js:317-318). That is the selection target. The table twin at `app.js:1173`, toggled at `index.html:800`, already is the accessible equivalent and already ships.

**QS three-question notes (spec 7). Cut.** ~230px of empty form on Today every day, three day fields, three CSV columns on both sides, and a `reconcileNotes` invariant whose only job is defending against a merge hazard the feature itself creates by making `note` derived. Change the `placeholder` on `#fNote` instead — costs nothing, reversible, delivers the framing.

**Day-of-week baseline card (spec 4). Cut; keep the weekend bands.** Its own design-law section concedes the published prior only covers the Tue/Thu run-day collision and "the other five cells are along for the ride." Seven cells at n≈8, blank below 28 logged days *and* a ≥56-day window, sitting three cards above `index.html:885-887` where the app refuses correlations between binaries. The **weekend bands** behind `drawWakeDots` are twenty lines and reinforce an encoding `charts.js:273` already commits to — keep those.

**Self-contained HTML export, masthead, TOC (spec 7). Cut.** The TOC breaks the app: `applyRoute()` at `app.js:353-355` coerces any hash outside `VIEWS` to `"today"`, and `hashchange` is bound at `:1444` — every TOC click navigates off Review. The export inlines a 470-line stylesheet to produce a file for an audience of one who already has the live app and `downloadCSV()`. Keep the chart legends.

**Garmin catch-up sized from `okAt` (spec 6). Cut.** The likeliest cause of a multi-day gap is the account-level 429 documented at `garmin_sync.py:68-70`, which *extends if you retry*. Reacting to a rate-limit block by tripling call volume is backwards.

**Tri-state control (spec 1). Deferred, not deleted.** Wire format frozen in Phase 0, CSV slot 20 reserved by name, `attested()` written to accept it. Revisit after Phase 1 lands — see Phase 6.

---

## 3. Phases

### Phase 0 — Freeze the contract (docs only)

**Lands:** `README.md` only. (a) Correct line 93: merging is **not** "field-level, newest wins per field" — `app.js:1301` is `Object.assign({}, older, newer)`, whole-record LWW where the older side only supplies absent keys. `blank()` guarantees both sides carry every legacy field, which is why it *looks* per-field. Three later phases write copy describing the real behaviour. (b) Record that gist `v` stays **2**: it is written at `app.js:1326`, `garmin_sync.py:198`, `fitnotes_sync.py:135` and read *nowhere*; bumping it would also desynchronise, since Python would keep writing `2`. (c) Reserve CSV slot 20 by name for `not_applicable` so nothing else claims it. (d) Fix the "two rules if you add a day field" checklist at README:125 — it lists ten places and omits the **fourth** hand-copy of the day schema, the inline literal at `fitnotes_sync.py:161-164`, which a grep for `blank_day` does not find.

**Why first:** three specs each wanted CSV slot 20. Naming the owner costs nothing and removes the only way two branches can produce two incompatible 20-column CSVs.

**Reversible:** yes, docs. **Effort:** 30 min.

---

### Phase 1 — A day nobody answered is not a logged day

**Lands.** New predicate beside `isEmpty()` at `app.js:122`:

```js
/* Three writers create day records with no human involved: garmin_sync.py,
   fitnotes_sync.py, and the browser FitNotes import (app.js:247, :280).
   None of them can write these fields. `skipped` is listed because marking
   a day not-applicable is a human act — it must attest even before the
   control ships (see Phase 6). */
function attested(r) {
  return !!r && (["light","caff","block","log"].some(k => r[k]) || r.social || r.protein ||
                 ["note","liftTpl","focus","skipped"].some(f => hasVal(r[f])));
}
```

Rewires, all pure reads:

| Site | Change |
|---|---|
| `app.js:1007` | `past.filter(d => attested(DB[d]))`; add `ghost = past.filter(d => DB[d] && !attested(DB[d]))` |
| `app.js:1037` | `weeks[w].some(d => attested(DB[d]))` — **must move with :1007** |
| `app.js:657-658` | `attested(DB[yest]) && attested(DB[yest2]) && …` |
| `app.js:1008` | `"N of M days in the record"` + `" · +G hold synced data only"` |
| `app.js:1058, 1089, 1143, 1452` | "logged" → "in the record" |
| `app.js:1093` | wrap `wkVerdict` in the existing `enough` (`:1054`) |
| `app.js:1349` | on `JSON.parse` failure **return before the PATCH** |
| `app.js:648-655` | delete the dead `flags` loop |
| `app.js:1194` | `colSpan = 18` → `16` |
| `index.html:1016-1020` | `?v=4` → `?v=5`, all five |

`countIn()` at `:1040-1043` stays ungated — it reads `trainType`/`train2`, which the machines legitimately own.

**Three live bugs ride along.** (1) `app.js:1349` — `let body = {}; try { body = JSON.parse(...) } catch(e) {}` means a truncated or corrupt gist resets `REMOTE_EXTRA` to `{}` and `:1371` PATCHes that loss, **destroying `fitnotesSource` today**. (2) The wake verdict at `:1093-1130` gates only on `wakes.length`, so one wake time renders a `v-crit` "Variable" citing Phillips 2017 — while `:1054` suppresses every other verdict below 14 days. (3) The `flags` loop at `:648-655` is computed and never read; its `if (CUR >= todayIso) return;` inside a `forEach` is a no-op.

**Why here:** three specs converge on this bug with incompatible mechanisms. Landing the cheapest correct version settles which one wins before anything irreversible commits.

**Reversible:** completely. Nothing on disk changes; reverting restores every number.

**Verify by hand.** Baseline first: run `downloadCSV()`, record `logged.length`, `alive`, `enough`, `canPark`, `rvNoteCount`. Then in a **private window** (`importData` at `:1411` merges, there is no undo): seed five days holding only `{wakeT:"06:41", bedT:"23:10", wake:true, _u:1}` and five holding only `{train:true, trainType:"lift", _u:1}`. Expect both classes excluded from `logged`, counted in the ghost clause, and the Today "missed twice" banner silent where it previously named four behaviours. Add a note to two and confirm the banner returns. Corrupt the gist file to `{not json` and confirm the app refuses to PATCH and `fitnotesSource` survives. Finally re-run `downloadCSV()` and **diff byte-for-byte against the baseline** — any difference means a schema change crept into a render commit.

**Brace for:** `enough` and `canPark` move to the honest denominator, so verdicts and Park buttons can vanish. If a FitNotes CSV covering a year was ever pasted, `app.js:280` created a year of records in one tap and the drop will be large. The ghost clause on `rvCoverage` is the only thing that explains it and is not optional. Do **not** attribute ghosts to Garmin in the copy.

**Effort:** ~60 lines, one file plus the version bump. Half a day including verification.

---

### Phase 2 — Stop claiming saves that failed

**Lands.** `lsSet` (`app.js:131`) returns a boolean and sets a module-level `LS_STATE`. `persist()` (`:134-141`) captures it: on failure the pill reads `NOT SAVED` with the existing `.pill.err` class (`index.html:177` — no new CSS) and, if a token and gist id are known, forces a push so the tap survives anyway. That force **requires** `TOK_MEM`/`GID_MEM` accessors, because when localStorage is unavailable `lsGet` returns `""` and the gate at `:1331`/`:1339` reads the token as absent — the mitigation is otherwise dead code in exactly the state it exists for. Guard the recursion: `persist()` → `syncNow()` → `persist()` at `:1368` loops, so early-return when a sync is in flight **and** check-and-set a 30s brake before the call. `saveDirty` (`:331`) assigns an in-memory copy before attempting the write. Add a `#storageWarn` callout cloned from `#missedTwice` (`index.html:567-570`), mutually exclusive with it, using `--warn-text` (not raw `--st-warning`, which is `#fab219` in both themes and sits near 1.8:1 on light `--surface-1`).

**Why here:** independent of Phase 1, and its parse-failure sibling already landed there. It must precede Phase 4, or the browser will eat the new provenance key while you are testing it.

**Reversible:** yes.

**Verify.** In the console: `for(let i=0;;i++) localStorage.setItem('junk'+i,'x'.repeat(60000))` until it throws. Tap a Core Three box: pill reads `NOT SAVED`, callout appears, `#missedTwice` hidden. With a token configured, watch the network tab: exactly **one** PATCH within a second and none for 30s regardless of further taps. Paste a token *while* full — the password field must not clear. Then `localStorage.clear()` and reload.

**Effort:** ~1 day.

---

### Phase 3 — The charts stop lying

**Lands.** (a) `charts.js:342-350` — replace the `days[i-1]` column-neighbour lookup with `addDays(d,-1)`. Under `DAYFILTER="weekdays"` (`app.js:548`) the previous *column* for a Monday is the previous Friday, so the missed-twice outline is currently wrong whenever a filter is on. Also require both days to hold attested records, matching Today. **Expect outlines to disappear from unlogged stretches** — note which cells before you start so you can tell the change from a leak. (b) `charts.js:402` vs `:411` — `var(--s1)` means *both* "Core Three row" and "the lowest bar" in one chart with one legend (`index.html:813`). Give the lowest row a `▲` prefix on its SVG row label so rank is carried by a mark, and fix `app.js:1088`, which says "the accent marks the lowest" when the code paints `--s1`. (c) Weekend bands behind `drawWakeDots` (`charts.js:205`): one new chart-only neutral `--band` in **all three** palette blocks (`index.html:35`, `:70`, `:84` — dark is declared twice), runs coalesced into one rect, suppressed below 3px/day and when every day is a weekend. (d) Honest legends on all three charts, naming the encodings that are currently silent: future days at 0.35 opacity, and an empty heat cell conflating "not ticked" with "never logged".

**Why here:** the legend sentence "you answered, and the answer was no" is only true after Phase 1.

**Reversible:** yes, chart-only.

**Verify.** Set `DAYFILTER="weekdays"`, log a Friday and a Monday both missed for `light`, confirm no outline. At 375px screenshot the heat at 28/56/84/365-day windows in both themes. Toggle theme ten times, confirm no listener accumulation. Confirm the wake chart draws no band under "Weekends only" and none at 365 days.

**Effort:** ~1 day.

---

### Phase 4 — Sync freshness (`sources`)

**Lands.** A new **top-level** gist key `sources`, holding per source `{okAt, through}`. It never enters `blank()`, `FIELDS`, `isEmpty()`, `toCSV()` or `int(bool(...))` — that is why provenance goes at document level. Both Python jobs stamp it, including on their no-op paths, because "ran fine, found nothing" and "did not run" are different facts. In `garmin_sync.main`, `gist_get` (`:318`) and `now_ms` (`:334`) move **above** the `if not garmin: return 0` at `:314-316` — but a `gist_get` failure must still `return 1` with **no write**, because `gist_put` at `:199`/`:205` sets `out["data"] = db` *and* regenerates the CSV, so one transient 502 followed by a heartbeat PATCH would wipe the record. The browser reads `sources` out of `REMOTE_EXTRA` into a read-only mirror plus a second clock recording when this device last *heard* from the gist; without that clock an unsynced phone confidently reports a healthy robot as dead.

**Do not add `sources` to the `known` map at `app.js:1350`.** That one line is what routes it into `REMOTE_EXTRA` and back out at `:1325`; adding it there makes every browser sync silently wipe both Actions' stamps.

**Reversible:** semi. Reverting leaves an inert key the old code preserves forever.

**Verify.** Hand-edit `sources` into the gist, sync twice, reload, confirm byte-identical — this validates the transport with zero code written, and `fitnotesSource` surviving today is the existence proof. Break `GIST_TOKEN` so `gist_get` 401s and confirm the job exits non-zero having written nothing and the gist still holds every day. Run on a no-Garmin-data day: exit 0, one PATCH, `okAt` advanced, `data` byte-identical; run again same day and confirm **no** second PATCH.

**Effort:** ~1.5 days (two Python files).

---

### Phase 5 — Longest break

**Lands.** A derived-only `#rvBreaks` block between `#triageRows` (`index.html:815`) and `#rvTriageSub` (`:816`), reporting per item the longest maximal run of non-hit days over **attested** days only, with unattested days transparent — dropped from the sequence and counted as a gap, never as misses and never as resets. Gated on `DAYFILTER === "all"`: under "Weekends only" a 56-day window yields 16 weekend days on which `dayPlan` (`app.js:490-516`) prescribes rest, so `train` is never ticked and any threshold prints a red break on a perfectly executed programme. Censored-left rule: flag `+` whenever the **oldest attested day in scope is a miss**, not only when the longest run starts at index 0. `createElement`/`textContent` only — `charts.js:17-18` states the rule.

**Reversible:** yes. **Depends on:** Phase 1's `attested`.

**Verify.** Ghost day between two hand-logged misses → "longest break 2, across 3 calendar days". A leading run of 3 at the window edge, a hit, then an interior run of 5 → `5+`, the `+` present even though the longest run is not the leading one. Switch to "Weekends only" and confirm the block collapses to one explanatory line.

**Effort:** ~1 day.

---

### Phase 6 — Tri-state, `train` row only (conditional)

**Do not start this until Phase 1 has been lived with for a fortnight.** Open it only if rest days are still visibly poisoning the `train` denominator.

**Lands.** `skipped:""` in `blank()` (`app.js:105`), `garmin_sync.blank_day()` (`:85-91`) and the inline literal at `fitnotes_sync.py:161-164`. `"skipped"` in `FIELDS` (`:22`) and in the `hasVal` list of `isEmpty()` (`:125`) — **not** in the `KEYS.some` truthy test at `:124`. `skipList`/`isSkip`/`setSkip` after `:127`. **Two** missed-twice predicates, not one: Today asks about the two opportunities strictly *before* today; the heat cell asks about its own day and the previous opportunity. Collapsing them shifts every outline one column right. CSV slot 20 on both sides in one commit. The control goes inside the existing `.evidence` disclosure as a full-width 56px button — the inline 32px variant costs ~44px of the `flex:1` tapzone and needs a fold gate; this one does not.

**`wake` is the weakest key to skip** and must not get the control: `garmin_sync.py:348-354` recomputes `rec["wake"]` unconditionally for every day in `days_back`, so a wake-skip is retired retroactively by the next Action run.

**Irreversible.** **Effort:** L, and this is the estimate most likely to be light.

---

## 4. The migration contract

**Gist version.** Stays `2`. Written in three places, read in zero. A bump would oscillate between 2 and 3 depending on which writer went last.

**CSV.** 19 columns today (`app.js:1269-1272` ≡ `garmin_sync.py:40-46`). Only Phase 6 appends, at slot 20, `not_applicable`, space-joined so it never triggers quoting in either language. `core3_all` (`app.js:1276`, `garmin_sync.py:159`) keeps meaning "all three literally done" while the on-screen latch counts a skip as satisfied — **the first place this project's archival record and its UI will disagree about a number they both display.** That belongs in the README, not a code comment.

**Lockstep.** Any CSV change is atomic across both languages. `app.js:1327-1328` and `garmin_sync.py:203-206` both write `focus-log.csv` to the same gist, so during disagreement the file *alternates* between 19 and 20 columns. The window does not close at deploy: `queueSync` (`:1330-1334`) fires on a 4s debounce from any tab still serving `app.js?v=4`, so a stale phone tab keeps writing 19 columns for as long as it lives. Phase 6 needs the `?v=` bump **and** a hard reload of every device.

Two things Python may lag safely: the `blank_day` literals. Missing keys are inert — Python never reads them, `to_csv` uses `r.get(k,"")`, and `merge()`'s union means a Python-created record cannot erase a browser's. Idempotence is safe by construction: `garmin_sync.py:338-339` takes `before = dict(rec)` **after** `blank_day()` runs, so added keys cannot make `rec != before` true at `:356` and cannot rewrite `_u` across history.

**Old client, new document.** Top-level keys are safe — `app.js:1350-1352` diverts unknowns to `REMOTE_EXTRA`, `:1325` spreads them back, and `garmin_sync.gist_put:197` does `out = dict(body)`. Day-record keys are safe on the read/write path: `merge():1301` unions, `recW()` mutates in place, `persist()` stringifies wholesale. The **one hole** is `isEmpty`/`prune`: `isEmpty()` is a hardcoded list and `prune()` runs at three sites, one of them *inside* `syncNow` at `:1353` immediately before the PATCH. So an un-reloaded tab deletes any day whose only content is a field it does not know — and writes that deletion to the gist. Phases 1–5 add no day field and are immune. Phase 6 is not: a day marked "train n/a" and nothing else is exactly that case, and it is the most likely first use of the feature.

**One known bug you inherit, unrelated to any phase:** `fitnotes_sync.apply_to_body:166-172` writes `train`/`trainType`/`train2` — CSV columns 4, 9, 17 — but `gist_put:125-130` PATCHes the JSON file only. `focus-log.csv` is already stale after every FitNotes run until a browser or Garmin push regenerates it.

---

## 5. Open decisions

**Do you accept losing verdicts on first load?** Phase 1 moves `enough` (`:1054`) and `canPark` (`:1069`) to the honest denominator; a user sitting at 15 inflated days drops below 14 and loses every chip. The alternative is keeping the gates on record-exists while percentages use the honest count — two denominators in one card, which is the confusion the change exists to remove. **Recommendation: take the hit.** Ship Phase 1 alone so the drop is not entangled with anything new appearing on the same screen.

**Should the tri-state control ever ship?** The correctness argument is real — a planned rest day poisons `missedTwice` and the `train` denominator. But 90% of the value is one row, `wake` is structurally undurable, and the cost is a schema change plus a deploy gate. **Recommendation: decide empirically.** After a fortnight on Phase 1, if `train` breaks and denominators still read wrong on rest weeks, ship Phase 6 on `train` alone. If they read fine, close it and keep the frozen wire format in the README as a reserved slot.

**Is 230px of QS form on Today worth it?** I cut it. But `log` — "Logged today, in writing" — is one of the six binaries, and three labelled boxes are its evidence in a way one blank textarea is not. **Recommendation: change the `placeholder` on `#fNote` to the three prompts first.** If after a month the notes have actually taken that shape, the fields are earned; if the box is still empty, you have your answer for free.

**Does the export deserve a second look?** I cut it on the TOC bug and the audience-of-one argument. If the real want is *durability* rather than sharing, `downloadCSV()` already gives you that and the honest upgrade is a "print this tab" stylesheet, not a 470-line inliner. **Recommendation: no, and revisit only if you find yourself wanting to send a review to someone.**