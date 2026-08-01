"use strict";
/* ============================================================
   Chart harness + renderers.

   ONE registry, ONE ResizeObserver, ONE tooltip. Every chart in the
   app draws through here. The alternative — each chart carrying its
   own observer, its own zero-width guard and its own tooltip div —
   is six slightly different implementations of the same four things,
   which is exactly where the bugs would live.

   Conventions held by every renderer below:
     - 1 SVG user unit == 1 CSS pixel. The viewBox is measured, never
       scaled, so a 2px hairline is 2px at every container width.
     - Gridlines and axes are SOLID hairlines one step off the surface.
     - Markers carry a 2px ring in the surface colour so they stay
       legible where they overlap.
     - Labels go in with textContent. Never innerHTML: a note or a
       series name can contain anything.
     - Every chart has a designed zero/one/three-point state. With
       ~3 days of data that IS the normal state, for weeks.
   ============================================================ */

const SVGNS = "http://www.w3.org/2000/svg";

/* ---------- tiny DOM helpers ---------- */
function svgEl(name, attrs) {
  const e = document.createElementNS(SVGNS, name);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}
function svgText(str, attrs) {
  const t = svgEl("text", attrs);
  t.textContent = str;                 /* untrusted-safe */
  return t;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/* ---------- the registry ---------- */

const CHARTS = [];
let ro = null;

/* Register an element + its draw function. drawFn(svg, width) is called
   with a cleared <svg> and the measured content width. */
function registerChart(el, drawFn) {
  CHARTS.push({ el: el, draw: drawFn });
  if (!ro && typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(entries => {
      let pending = false;
      entries.forEach(() => { pending = true; });
      if (pending) scheduleRedraw();
    });
  }
  if (ro) ro.observe(el);
}

let raf = 0, fbTimer = 0;
function scheduleRedraw() {
  if (raf || fbTimer) return;
  const run = () => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (fbTimer) { clearTimeout(fbTimer); fbTimer = 0; }
    drawAll();
  };
  /* rAF coalesces resize storms, but it does NOT fire in a tab that
     isn't compositing -- so a chart registered while off-screen would
     never draw at all. The timer is the floor under that. */
  raf = requestAnimationFrame(run);
  fbTimer = setTimeout(run, 120);
}

function drawAll() {
  CHARTS.forEach(c => {
    /* A chart inside a hidden tab measures 0. Drawing into a
       zero-width viewBox produces an invisible mess that never
       repairs itself, so skip and let the tab-show broadcast
       redraw it once it has a size. */
    const w = c.el.clientWidth;
    if (!w) return;
    let svg = c.el.querySelector("svg");
    if (!svg) { svg = svgEl("svg"); c.el.appendChild(svg); }
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    /* One bad chart must not blank the whole tab -- but it must not be
       silent either, or a chart that never draws looks like empty data. */
    try { c.draw(svg, w); }
    catch (e) { if (window.console) console.error("chart draw failed", c.el.id, e); }
  });
}

/* Called by the router when a tab becomes visible. */
function chartsOnShow() { scheduleRedraw(); }

/* ---------- the one tooltip ---------- */

let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement("div");
    tipEl.className = "charttip";
    tipEl.setAttribute("role", "status");
    document.body.appendChild(tipEl);
  }
  return tipEl;
}
function showTip(target, lines) {
  const t = tip();
  while (t.firstChild) t.removeChild(t.firstChild);
  lines.forEach(l => {
    const row = document.createElement("div");
    row.className = "tiprow";
    if (l.swatch) {
      const s = document.createElement("i");
      s.className = "tipkey";
      s.style.background = l.swatch;
      row.appendChild(s);
    }
    /* Value leads, label follows -- the reader already has the series. */
    const v = document.createElement("b");
    v.textContent = l.value;
    row.appendChild(v);
    if (l.label) {
      const s2 = document.createElement("span");
      s2.textContent = " " + l.label;
      row.appendChild(s2);
    }
    t.appendChild(row);
  });
  const r = target.getBoundingClientRect();
  t.style.display = "block";
  const tr = t.getBoundingClientRect();
  let left = r.left + r.width / 2 - tr.width / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
  let top = r.top - tr.height - 10;
  if (top < 8) top = r.bottom + 10;
  t.style.left = Math.round(left + window.scrollX) + "px";
  t.style.top = Math.round(top + window.scrollY) + "px";
}
function hideTip() { if (tipEl) tipEl.style.display = "none"; }

/* Attach hover+focus+touch to a mark. The hit target is a separate,
   larger, transparent rect -- never the painted pixels. */
function hoverable(svg, hit, lines, label) {
  hit.setAttribute("fill", "transparent");
  hit.setAttribute("tabindex", "0");
  hit.setAttribute("role", "img");
  if (label) hit.setAttribute("aria-label", label);
  hit.addEventListener("pointerenter", () => showTip(hit, lines));
  hit.addEventListener("pointerleave", hideTip);
  hit.addEventListener("focus", () => showTip(hit, lines));
  hit.addEventListener("blur", hideTip);
  svg.appendChild(hit);
}

/* ---------- shared scale helpers ---------- */

function niceTimeTicks(lo, hi) {
  /* Clock-time axis: hourly if the span is small, else 2-hourly. */
  const span = hi - lo, step = span <= 300 ? 60 : 120;
  const out = [];
  for (let m = Math.ceil(lo / step) * step; m <= hi; m += step) out.push(m);
  return out;
}
function clockLabel(m) {
  m = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60), ap = h < 12 ? "a" : "p", hh = h % 12 === 0 ? 12 : h % 12;
  return hh + ap;
}

/* Choose ~6 evenly spaced date labels regardless of window length. */
function dateTicks(days, max) {
  const n = days.length;
  if (n <= (max || 7)) return days.map((d, i) => i);
  const step = Math.ceil(n / (max || 6)), out = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

function emptyNote(svg, w, h, msg, sub) {
  svg.setAttribute("viewBox", "0 0 " + w + " " + h);
  svg.setAttribute("width", w); svg.setAttribute("height", h);
  const t = svgText(msg, { x: w / 2, y: h / 2 - 4, "text-anchor": "middle",
    fill: "var(--text-secondary)", "font-size": "13", "font-weight": "600" });
  svg.appendChild(t);
  if (sub) {
    svg.appendChild(svgText(sub, { x: w / 2, y: h / 2 + 15, "text-anchor": "middle",
      fill: "var(--text-muted)", "font-size": "11.5" }));
  }
}

/* ============================================================
   1. Wake-time dot plot -- the anchor at full resolution.

   EMPHASIS form, not categorical: weekdays carry the accent, weekends
   recede to gray. The story is "the weekday hour is wrong", not
   "compare two equal groups". A target BAND (not a line) because the
   behaviour is defined as +/-30 min, so the band IS the rule.

   Deliberately NOT connected into a line: a gap between Tuesday and
   Friday is missing data, and a line would draw an interpolation
   through days that never happened.
   ============================================================ */

function drawWakeDots(svg, w, days, db, targetFor) {
  const H = 220, padL = 34, padR = 12, padT = 12, padB = 26;
  const pts = [];
  days.forEach((d, i) => {
    const r = db[d];
    if (r && r.wakeT) pts.push({ i: i, d: d, m: hhmmToMin(r.wakeT), wknd: isWeekend(d) });
  });

  if (!pts.length) {
    emptyNote(svg, w, H, "No wake times logged yet",
      "Garmin fills these in each morning, or add one under Details.");
    return;
  }

  /* Domain always contains the target band plus the data, with air. */
  const tgts = days.map(targetFor).filter(v => v !== null);
  let lo = Math.min.apply(null, pts.map(p => p.m).concat(tgts.map(t => t - 45)));
  let hi = Math.max.apply(null, pts.map(p => p.m).concat(tgts.map(t => t + 45)));
  lo = Math.floor((lo - 20) / 30) * 30; hi = Math.ceil((hi + 20) / 30) * 30;
  if (hi - lo < 180) { const mid = (lo + hi) / 2; lo = mid - 90; hi = mid + 90; }

  svg.setAttribute("viewBox", "0 0 " + w + " " + H);
  svg.setAttribute("width", w); svg.setAttribute("height", H);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label",
    "Wake time per day against the target band. " + pts.length + " days logged.");

  const plotW = w - padL - padR, plotH = H - padT - padB;
  const x = i => padL + (days.length === 1 ? plotW / 2
    : (i / (days.length - 1)) * plotW);
  const y = m => padT + ((m - lo) / (hi - lo)) * plotH;   /* earlier = higher */

  /* target band, drawn first so everything sits on top of it */
  let bandLo = null, bandHi = null;
  days.forEach((d, i) => {
    const t = targetFor(d);
    if (t === null) return;
    const yTop = y(t - 30), yBot = y(t + 30);
    const x0 = i === 0 ? padL : (x(i) + x(i - 1)) / 2;
    const x1 = i === days.length - 1 ? w - padR : (x(i) + x(i + 1)) / 2;
    svg.appendChild(svgEl("rect", { x: x0, y: yTop, width: Math.max(0, x1 - x0),
      height: Math.max(0, yBot - yTop), fill: "var(--s1)", opacity: "0.10" }));
    if (bandLo === null) { bandLo = yTop; bandHi = yBot; }
  });

  /* gridlines + y ticks: solid hairlines, recessive */
  niceTimeTicks(lo, hi).forEach(m => {
    svg.appendChild(svgEl("line", { x1: padL, x2: w - padR, y1: y(m), y2: y(m),
      stroke: "var(--grid)", "stroke-width": "1" }));
    svg.appendChild(svgText(clockLabel(m), { x: padL - 6, y: y(m) + 3.5,
      "text-anchor": "end", fill: "var(--text-muted)", "font-size": "10",
      "font-variant-numeric": "tabular-nums" }));
  });
  /* baseline */
  svg.appendChild(svgEl("line", { x1: padL, x2: w - padR, y1: H - padB, y2: H - padB,
    stroke: "var(--axis)", "stroke-width": "1" }));

  /* x ticks */
  dateTicks(days, 6).forEach(i => {
    const dd = new Date(days[i] + "T00:00:00");
    svg.appendChild(svgText((dd.getMonth() + 1) + "/" + dd.getDate(),
      { x: x(i), y: H - padB + 14, "text-anchor": "middle",
        fill: "var(--text-muted)", "font-size": "10" }));
  });

  /* dots: 9px marker (r 4.5) + 2px surface ring */
  pts.forEach(p => {
    const cx = x(p.i), cy = y(p.m);
    const fill = p.wknd ? "var(--text-muted)" : "var(--s1)";
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 6.5,
      fill: "var(--surface-1)" }));                       /* the ring */
    svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 4.5, fill: fill }));
    const t = targetFor(p.d);
    const dev = t === null ? null : p.m - t;
    hoverable(svg, svgEl("rect", { x: cx - 14, y: cy - 14, width: 28, height: 28 }),
      [{ value: minToHHMM(p.m), label: "· " + fmtShortDay(p.d), swatch: null },
       dev === null ? { value: "", label: "" }
         : { value: (dev > 0 ? "+" : "") + Math.round(dev) + " min", label: "vs target" }]
        .filter(l => l.value !== ""),
      fmtShortDay(p.d) + ", woke " + minToHHMM(p.m));
  });

  /* Direct-label only the most recent point -- never every point. */
  const last = pts[pts.length - 1];
  if (last) {
    const lx = x(last.i), ly = y(last.m);
    const anchor = lx > w - 70 ? "end" : "start";
    svg.appendChild(svgText(minToHHMM(last.m),
      { x: lx + (anchor === "end" ? -10 : 10), y: ly + 3.5, "text-anchor": anchor,
        fill: "var(--text-primary)", "font-size": "11", "font-weight": "700" }));
  }
}

/* ============================================================
   2. Behaviour heatmap -- 6 rows x N days.

   Binary two-step SEQUENTIAL in one hue (unfilled surface-2 -> filled
   --s3). Not categorical: the six rows are not competing series, each
   cell just means done / not done. No aggregation -- one column is
   one day, so a bad week is visible as itself rather than averaged
   into a number that hides it.
   ============================================================ */

function drawBehaviourHeat(svg, w, days, db, keys, names, core) {
  const rowH = 22, gap = 2, padL = 92, padT = 16, padB = 18;
  const H = padT + keys.length * rowH + padB;
  svg.setAttribute("viewBox", "0 0 " + w + " " + H);
  svg.setAttribute("width", w); svg.setAttribute("height", H);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Behaviour grid, " + keys.length +
    " behaviours across " + days.length + " days.");

  const plotW = Math.max(10, w - padL - 8);
  const cw = plotW / days.length;
  const cellW = Math.max(3, cw - gap);
  const todayIso = isoDay(new Date());

  keys.forEach((k, r) => {
    const yTop = padT + r * rowH;
    svg.appendChild(svgText(names[k], { x: 0, y: yTop + rowH / 2 + 3.5,
      fill: "var(--text-secondary)", "font-size": "11.5",
      "font-weight": core.indexOf(k) >= 0 ? "700" : "500" }));
    if (core.indexOf(k) >= 0) {
      svg.appendChild(svgEl("circle", { cx: padL - 10, cy: yTop + rowH / 2, r: 3,
        fill: "var(--s1)" }));
    }
    days.forEach((d, i) => {
      const rec = db[d], done = !!(rec && rec[k]);
      const future = d > todayIso;
      const x0 = padL + i * cw;
      svg.appendChild(svgEl("rect", {
        x: x0, y: yTop + 2, width: cellW, height: rowH - gap - 2, rx: 3,
        fill: done ? "var(--s3)" : "var(--surface-2)",
        opacity: future ? "0.35" : "1",
      }));
      /* Missed twice running: an outline mark, never a colour alone,
         and never on a day still in progress. */
      if (!done && !future && d < todayIso && i > 0) {
        const prev = db[days[i - 1]];
        if (prev && !prev[k]) {
          svg.appendChild(svgEl("rect", {
            x: x0 + 0.75, y: yTop + 2.75, width: Math.max(1, cellW - 1.5),
            height: rowH - gap - 3.5, rx: 3, fill: "none",
            stroke: "var(--st-critical)", "stroke-width": "1.5" }));
        }
      }
      if (cw >= 6) {
        hoverable(svg, svgEl("rect", { x: x0 - 2, y: yTop, width: cw + 4, height: rowH }),
          [{ value: done ? "Done" : (future ? "Not yet" : "Not done"),
             label: "· " + names[k], swatch: done ? cssVar("--s3") : null },
           { value: fmtShortDay(d), label: "" }],
          names[k] + " " + d + ": " + (done ? "done" : "not done"));
      }
    });
  });

  dateTicks(days, 5).forEach(i => {
    const dd = new Date(days[i] + "T00:00:00");
    svg.appendChild(svgText((dd.getMonth() + 1) + "/" + dd.getDate(),
      { x: padL + i * cw + cellW / 2, y: H - 5, "text-anchor": "middle",
        fill: "var(--text-muted)", "font-size": "10" }));
  });
}

/* ============================================================
   3. Triage bars -- "which item is dying?"

   EMPHASIS form: the lowest-adherence item takes the accent, every
   other row is de-emphasis gray. Deliberately bending "colour follows
   the entity, never its rank", because here rank IS the question the
   chart exists to answer. Fenced so it stays honest: row order is
   fixed (never re-sorted under the reader), the highlighted item is
   named in the subhead, ties break deterministically, and nothing is
   highlighted at all when every item is healthy.
   ============================================================ */

function drawTriage(svg, w, rows) {
  if (!rows.length) { emptyNote(svg, w, 120, "Nothing logged in this window yet"); return; }
  const rowH = 26, padL = 116, padR = 44, padT = 6, padB = 6;
  const H = padT + rows.length * rowH + padB;
  svg.setAttribute("viewBox", "0 0 " + w + " " + H);
  svg.setAttribute("width", w); svg.setAttribute("height", H);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Adherence by item.");

  const plotW = Math.max(20, w - padL - padR);
  let worst = -1, worstV = 2;
  rows.forEach((r, i) => { if (r.rate < worstV - 1e-9) { worstV = r.rate; worst = i; } });
  const anyAtRisk = worstV < 0.6;          /* no victim when all are healthy */

  rows.forEach((r, i) => {
    const yTop = padT + i * rowH, bh = 14;
    svg.appendChild(svgText(r.name, { x: 0, y: yTop + rowH / 2 + 4,
      fill: "var(--text-secondary)", "font-size": "11.5",
      "font-weight": r.core ? "700" : "500" }));
    if (r.core) {
      svg.appendChild(svgEl("circle", { cx: padL - 10, cy: yTop + rowH / 2, r: 3,
        fill: "var(--s1)" }));
    }
    /* track */
    svg.appendChild(svgEl("rect", { x: padL, y: yTop + (rowH - bh) / 2,
      width: plotW, height: bh, rx: 4, fill: "var(--surface-2)" }));
    const bw = Math.max(0, Math.round(plotW * r.rate));
    if (bw > 0) {
      svg.appendChild(svgEl("rect", { x: padL, y: yTop + (rowH - bh) / 2,
        width: bw, height: bh, rx: 4,
        fill: (anyAtRisk && i === worst) ? "var(--s1)" : "var(--text-muted)" }));
    }
    /* every row direct-labelled: 10 rows, and the number IS the point */
    svg.appendChild(svgText(Math.round(r.rate * 100) + "%",
      { x: w - 4, y: yTop + rowH / 2 + 4, "text-anchor": "end",
        fill: "var(--text-primary)", "font-size": "11",
        "font-weight": (anyAtRisk && i === worst) ? "700" : "500",
        "font-variant-numeric": "tabular-nums" }));
    hoverable(svg, svgEl("rect", { x: padL, y: yTop, width: plotW, height: rowH }),
      [{ value: r.hit + " of " + r.poss + " days", label: "· " + r.name },
       { value: Math.round(r.rate * 100) + "%", label: "adherence" }],
      r.name + ": " + r.hit + " of " + r.poss + " days");
  });
}
