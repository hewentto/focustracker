"use strict";
/* ============================================================
   Static reference content, transcribed from PLAN.md §3 and §4.

   This file is DATA, not logic. It is the reason the Programme tab
   is fully correct on install day with zero logged days: every
   prescription here is derived from the programme start date and
   the day of the week, never from history.

   If PLAN.md changes, change this file in the same commit.
   ============================================================ */

/* ---------- §3 Lifting — 3x/week full body, A/B alternating ---------- */

const LIFT_TEMPLATES = {
  A: [
    { lift: "Squat or leg press",        sets: 3, reps: "5–8",   rir: "2",   muscles: ["quads", "glutes"] },
    { lift: "Bench press or DB press",   sets: 3, reps: "6–10",  rir: "2",   muscles: ["chest", "triceps"] },
    { lift: "Row (barbell/cable/DB)",    sets: 3, reps: "8–12",  rir: "2",   muscles: ["back", "biceps"] },
    { lift: "Romanian deadlift",         sets: 2, reps: "8–12",  rir: "2–3", muscles: ["hams", "glutes"] },
    { lift: "Lateral raise",             sets: 2, reps: "12–15", rir: "1–2", muscles: ["delts"] },
  ],
  B: [
    { lift: "Deadlift or trap-bar DL",   sets: 2, reps: "4–6",   rir: "2–3", muscles: ["back", "hams", "glutes"] },
    { lift: "Overhead press",            sets: 3, reps: "6–10",  rir: "2",   muscles: ["delts", "triceps"] },
    { lift: "Pull-up or lat pulldown",   sets: 3, reps: "6–12",  rir: "2",   muscles: ["back", "biceps"] },
    { lift: "Split squat or leg curl",   sets: 2, reps: "10–15", rir: "2",   muscles: ["quads", "hams"] },
    { lift: "Curl + triceps superset",   sets: 2, reps: "10–15", rir: "1–2", muscles: ["biceps", "triceps"] },
  ],
};

const LIFT_PROGRESSION =
  "Top of the rep range on all sets at the prescribed RIR → add load next session. " +
  "2.5–5 kg lower body, 1–2.5 kg upper. No periodisation needed at this training age.";

/* The two things PLAN.md explicitly tells you to stop worrying about. */
const LIFT_NEGATIONS = [
  "Soreness is not a marker of adaptation — it tracks novelty and eccentric damage, not growth.",
  "No scheduled deload needed at 3 sessions/week at RIR 2. Take an easy week when you feel beaten up, not on a calendar.",
];

const SETS_PER_MUSCLE = { min: 4, bandLow: 8, bandHigh: 12,
  note: "Pelland 2025 (67 studies, N=2,058): hypertrophy follows a square-root curve, +0.24% per weekly set. " +
        "~4 sets/muscle/week is the minimum effective dose; 8–12 is the useful band." };

/* ---------- §4 Running — the 16-week Tue/Thu onramp ---------- */
/* Weeks are explicit rather than computed so each one is auditable
   against PLAN.md §4 line by line. */

function runWeek(n, tue, thu, note) { return { week: n, tue: tue, thu: thu, note: note || "" }; }

const RUN_WEEKS = [
  runWeek(1,  "5 min walk → 6 × (1:00 jog / 2:00 walk) → 5 min walk. ~28 min.",
              "5 min walk → 6 × (1:00 jog / 2:00 walk) → 5 min walk. ~28 min.",
              "Cap this week at ~3 km total running. Starting at 3 km/week rather than 6 cut novice injury risk by 31.2% — the one number here with a per-protocol RCT behind it."),
  runWeek(2,  "5 min walk → 6 × (1:30 jog / 2:00 walk) → 5 min walk.",
              "5 min walk → 6 × (1:30 jog / 2:00 walk) → 5 min walk."),
  runWeek(3,  "5 min walk → 6 × (2:00 jog / 2:00 walk) → 5 min walk.",
              "5 min walk → 6 × (2:00 jog / 2:00 walk) → 5 min walk."),
  runWeek(4,  "5 min walk → 6 × (2:30 jog / 2:00 walk) → 5 min walk.",
              "5 min walk → 6 × (2:30 jog / 2:00 walk) → 5 min walk."),
  runWeek(5,  "4 × (3:00 jog / 2:00 walk).", "4 × (3:00 jog / 2:00 walk)."),
  runWeek(6,  "4 × (3:30 jog / 2:00 walk).",
              "Harder day starts: 4 × 1:00 hard-but-controlled, 2:00 walk between.",
              "From this week Thursday becomes the harder day."),
  runWeek(7,  "4 × (4:00 jog / 2:00 walk).", "4 × 1:00 hard, 2:00 walk between."),
  runWeek(8,  "4 × (4:00 jog / 2:00 walk).", "4 × 1:00 hard, 2:00 walk between."),
  runWeek(9,  "Easy continuous 20 min. Conversational.",
              "4 × 4:00 at ~90–95% HRmax, 3:00 active recovery.",
              "Helgerud's 4×4 protocol: +7.2% VO2max in 8 weeks, and the only arm that moved VO2max when total work was matched against 45 min of steady running (which produced no change)."),
  runWeek(10, "Easy continuous 22 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(11, "Easy continuous 24 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(12, "Easy continuous 26 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(13, "Easy continuous 28 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(14, "Easy continuous 30 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(15, "Easy continuous 30 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery."),
  runWeek(16, "Easy continuous 30 min.", "4 × 4:00 at ~90–95% HRmax, 3:00 recovery.",
              "Last programmed week. What happens in week 17 is the question to have already answered."),
];

const RUN_GUARDRAILS = [
  { id: "ceiling", rule: "Never let a single run exceed 110% of your longest run in the last 30 days.",
    why: "Nielsen 2024 (5,205 runners, 588,071 sessions): injuries are acute load-spike events, not gradual accumulation. A 10–30% jump over your recent peak carried +64% injury risk; >100% carried +128%." },
  { id: "restart", rule: "Two missed weeks → restart the previous 4-week block.",
    why: "Detraining plus a load spike is the classic novice injury path." },
  { id: "pain", rule: "Any pain that changes your gait ends the session.",
    why: "One avoided injury is worth more than four weeks of progression." },
];

const TEN_PERCENT_RULE_IS_DEAD =
  "Forget the 10% rule. Buist et al. 2008 (N=532) tested a graded programme built on it: " +
  "injury 20.8% vs 20.3%, p = .90. Null.";

const STAIR_SNACK = {
  protocol: "3 × 30 s all-out stair climbs, at least an hour apart.",
  why: "Yin et al. 2024 (RCT, N=42): 3 days/week for 6 weeks — about 27 total minutes of work — " +
       "produced +2.5 mL/kg/min VO2peak (+7%), while a moderate continuous training arm gained nothing significant.",
};

const NOVICE_INJURY_WINDOW = {
  throughWeek: 13,
  note: "Novice injury incidence is 17.8 per 1000 hours vs 7.7 for established recreational runners, " +
        "front-loaded into the first 8–13 weeks. 29.5% of novices stop by 26 weeks and 48% of quitters cite injury. " +
        "Injury prevention IS the adherence strategy — they are not competing goals.",
};

const CONCURRENT_RULE =
  "Separate lifting and running by ≥3 hours, or put them on different days. Never run hard legs before a leg session. " +
  "Schumann 2022 (43 studies, N=1,090) found no interference for strength (−0.06 ns) or hypertrophy (−0.01 ns) — " +
  "only explosive strength (−0.28), and mainly same-session.";

/* ---------- §9 Expectations — the anti-quit content ---------- */

const HABIT_HORIZON = {
  medianDays: 66, exerciseDays: 91, rangeLow: 18, rangeHigh: 254,
  note: "Median 66 days to habit formation, range 18–254, ~91 days for exercise specifically. " +
        "Only 48% of Lally's participants formed a fittable habit curve at all. Anyone promising 21 days is selling something.",
};

const CLIFF = { fromWeek: 17, toWeek: 30,
  note: "Among people who eventually disengage from tracking, 57–74% do it in months 4–7. " +
        "Expect it. 33–46% of people who fall off come back if there is something to come back to." };

const OUTCOME_EXPECTATIONS = [
  "Running: at 2 sessions/week with one interval day, a realistic 16-week expectation is +3 to +6 mL/kg/min VO2max.",
  "Lifting: at 8–12 sets/muscle/week and consistent attendance, visible change on a 12–16 week horizon, not a 4-week one.",
];

const REVIEW_FRAMING =
  "Not to grade yourself — to see which items are actually getting ticked, and park the ones that aren't.";

/* ---------- §6 Nutrition ---------- */

const PROTEIN = { gPerKg: 1.6, daysPerWeek: 5,
  note: "Morton et al. 2018 (49 RCTs, N=1,863): +0.30 kg FFM and +2.49 kg 1RM, plateauing around 1.6 g/kg. " +
        "Note the honest magnitude — 0.30 kg is the entire pooled effect. Protein is a floor to clear, not a lever to obsess over." };

const CREATINE = { dose: "3–5 g/day monohydrate",
  note: "The most consistently supported supplement in the category, cheap, and it needs no loading or cycling. " +
        "Deliberately not a daily tap — see the parked register for why item count is capped." };

/* ---------- §5 Social ---------- */

const SOCIAL = {
  target: "2 substantive contacts (≥30 min, non-work, ≥1 in person) + 1 recurring group commitment",
  note: "The mortality-predictive measure was complex social integration (OR 1.91) — network breadth and role diversity. " +
        "Binary living-alone status was null. A standing weekly thing is the only item that builds breadth rather than one-to-one contact.",
  framing: "Do this for how it feels, not for the mortality table. Zhang 2024 (N=476,100, MR): of 26 diseases, " +
           "20 showed non-causal associations. What survives is the mental-health link, and it survives strongly.",
  nudge: "Epley & Schroeder 2014: people assigned to talk to a stranger on their commute had a better journey " +
         "(d = 0.56–0.63) with no productivity cost — while separate samples predicted the opposite. " +
         "You will systematically underestimate how good small social contact feels.",
};

/* ---------- §6 and §7 — the parked register, as data ---------- */

const PARKED = [
  { name: "Cold plunge after lifting", severity: "counterproductive",
    why: "Roberts et al. 2015 (J Physiol): 12 weeks with post-session cold water immersion vs active recovery — type II fibre CSA +17% in the NON-cold arm only, myonuclei +26% non-cold only, worse strength and mass gains with cold. Fyfe 2019 replicated the fibre-level blunting (ES −1.37). If you do cold, keep it ≥4 hours away from lifting." },
  { name: "5am club", severity: "unsupported",
    why: "No causal support. Genotype end-to-end difference in actual sleep timing: 25 minutes (N=697,828). Consistency is the evidenced variable; earliness is aesthetics." },
  { name: "Zone 2 as the priority", severity: "wrong-dose",
    why: "At 2 sessions/week this is the wrong emphasis. Work-matched, 45 min of steady running produced no VO2max change while 4×4 intervals produced +7.2%. The 80/20 rule comes from athletes training 10–20 h/week." },
  { name: "Reading as brain health", severity: "unsupported",
    why: "Anderson et al. 2020 (MR, 17,008 AD cases): education's protective effect null once intelligence was controlled. Bavishi 2016's book-reading survival advantage shrank from 23 months to 4 and was fully mediated by cognition. Read because you want to." },
  { name: "Meditation", severity: "weak",
    why: "Goyal et al. 2014 (47 RCTs with ACTIVE controls): anxiety 0.22–0.38, depression 0.23–0.30, and no evidence meditation beat any active treatment. Cognitive effects vs active controls: g = 0.07, null. Keep it if you already do it." },
  { name: "Gratitude journaling", severity: "weak",
    why: "vs measurement-only control d = .31; vs an alternative activity d = .17; vs a psychologically active control d = .03, ns (Davis 2016). Roughly as good as any other structured daily reflection." },
  { name: "16:8 fasting", severity: "counterproductive",
    why: "TREAT (N=116): p = .63 on weight, p = .005 on losing MORE lean mass. Zero human RCTs with mortality endpoints." },
  { name: "Blue-blocker glasses", severity: "unsupported",
    why: "Cochrane 2023, 17 RCTs: findings do not support prescribing blue-light filtering lenses to the general population." },
  { name: "Sauna", severity: "confounded",
    why: "HR 0.37 for sudden cardiac death is a single observational Finnish cohort where the exposure is near-perfectly confounded with being well enough to sit in an 80°C room five times a week. Pleasant. Not evidenced as an intervention." },
  { name: "“Dopamine detox”", severity: "renamed",
    why: "The term's originator says it isn't about dopamine — it's CBT stimulus control with a catchy name. The behaviour is already in the system as binding blocks." },
  { name: "Macro tracking / diet mode", severity: "null",
    why: "DIETFITS (N=609, 12 months): no significant difference between healthy low-fat and healthy low-carb, and no interaction with genotype or insulin secretion. POUNDS Lost (N=811, 2 years) found the same across four macro splits. Whatever you'll actually stick to is the correct diet." },
  { name: "Meal timing", severity: "null",
    why: "TREAT: p = .63 on weight, and the fasting group lost significantly more lean mass (p = .005). Time-restricted eating is a calorie-reduction tactic that works if it reduces your calories and does nothing if it doesn't." },
];

/* ---------- §8 — the structural warning ---------- */

const CALIBRATION =
  "In the gym megastudy (Nature 2021, N = 61,293, 54 expert-designed arms) expert forecasts of which " +
  "interventions would work correlated with results at r = 0.02 and were 9.1× too optimistic; 45% of arms " +
  "worked at 4 weeks and 8% still did at week 10. This system is ranked by evidence quality, which is " +
  "knowable — not by what will work for you, which isn't.";

const NO_BENCHMARKING =
  "No top-performer benchmarking, no borrowed routines, no comparison to anyone else. When Rosenzweig went " +
  "back to In Search of Excellence's 35 “excellent” companies with Compustat data, 30 had declined. Those " +
  "books had auditable financials and still got it 30-out-of-35 wrong; morning-routine listicles have " +
  "retrospective self-report from people who already know they succeeded.";
