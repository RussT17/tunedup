// The trace view: what the tuner actually saw during the last pluck.
//
// Two panels sharing one time axis — pitch on top, signal level below. They are
// deliberately separate plots rather than one chart with two y-scales.

const COLORS = {
  raw: '#7b848f',        // recessive: dots, not a line
  reading: '#6aa8ff',    // what the tuner is showing you
  fit: '#3ddc97',        // the settled-pitch model
  grid: '#232a33',
  axis: '#3a424c',
  ink: '#7b848f',
};

const W = 360;
const LEGEND_Y = 10;
const PLOT = { left: 40, right: 350, top: 34, bottom: 178 };
const STRIP = { top: 198, bottom: 238 };
const H = 262;

const cents = (a, b) => 1200 * Math.log2(a / b);

function niceStep(span) {
  for (const step of [2, 5, 10, 20, 25, 50, 100]) {
    if (span / step <= 6) return step;
  }
  return 200;
}

/** Returns the SVG markup for a trace, plus the scales the crosshair needs. */
export function renderTrace(trace) {
  const { points, noteHz, fit } = trace;
  if (!points.length || !noteHz) {
    return { svg: '<text x="180" y="130" text-anchor="middle" fill="#3a424c" font-size="13">Play a note to see its trace</text>', scales: null };
  }

  const values = [];
  for (const p of points) {
    if (p.raw) values.push(cents(p.raw, noteHz));
    if (p.reported) values.push(cents(p.reported, noteHz));
  }
  const clamped = values.map((v) => Math.max(-60, Math.min(60, v)));
  let lo = Math.min(-6, ...clamped);
  let hi = Math.max(6, ...clamped);
  const pad = Math.max(2, (hi - lo) * 0.12);
  lo -= pad; hi += pad;

  const duration = Math.max(0.8, points[points.length - 1].t);
  const x = (t) => PLOT.left + (t / duration) * (PLOT.right - PLOT.left);
  const y = (c) => PLOT.bottom - ((c - lo) / (hi - lo)) * (PLOT.bottom - PLOT.top);
  const peakRms = Math.max(1e-9, ...points.map((p) => p.rms));
  const yStrip = (r) => STRIP.bottom - (r / peakRms) * (STRIP.bottom - STRIP.top);

  const parts = [];

  // --- grid: recessive, with the in-tune line carrying the emphasis ---
  const step = niceStep(hi - lo);
  for (let c = Math.ceil(lo / step) * step; c <= hi; c += step) {
    const isZero = Math.abs(c) < 1e-9;
    parts.push(
      `<line x1="${PLOT.left}" y1="${y(c).toFixed(1)}" x2="${PLOT.right}" y2="${y(c).toFixed(1)}" ` +
      `stroke="${isZero ? COLORS.axis : COLORS.grid}" stroke-width="1"${isZero ? '' : ' stroke-dasharray="1 3"'} />`,
      `<text x="${PLOT.left - 6}" y="${(y(c) + 4).toFixed(1)}" text-anchor="end" fill="${COLORS.ink}" font-size="10">${c > 0 ? '+' : ''}${c}</text>`
    );
  }
  parts.push(`<text x="${PLOT.left - 6}" y="${PLOT.top - 4}" text-anchor="end" fill="${COLORS.axis}" font-size="9">cents</text>`);

  for (let t = 0; t <= duration + 1e-6; t += duration > 3 ? 1 : 0.5) {
    parts.push(
      `<line x1="${x(t).toFixed(1)}" y1="${STRIP.bottom}" x2="${x(t).toFixed(1)}" y2="${STRIP.bottom + 4}" stroke="${COLORS.axis}" stroke-width="1" />`,
      `<text x="${x(t).toFixed(1)}" y="${STRIP.bottom + 17}" text-anchor="middle" fill="${COLORS.ink}" font-size="10">${t.toFixed(t % 1 ? 1 : 0)}s</text>`
    );
  }

  // --- signal level strip (its own panel, its own scale) ---
  const strip = points.map((p) => `${x(p.t).toFixed(1)},${yStrip(p.rms).toFixed(1)}`).join(' ');
  parts.push(
    `<polygon points="${x(0).toFixed(1)},${STRIP.bottom} ${strip} ${x(points[points.length - 1].t).toFixed(1)},${STRIP.bottom}" fill="${COLORS.raw}" fill-opacity="0.18" />`,
    `<text x="${PLOT.left - 6}" y="${STRIP.top + 10}" text-anchor="end" fill="${COLORS.axis}" font-size="9">level</text>`
  );

  // --- raw detections: every frame the pitch detector produced ---
  for (const p of points) {
    if (!p.raw) continue;
    const c = cents(p.raw, noteHz);
    if (c < lo || c > hi) continue;
    parts.push(`<circle cx="${x(p.t).toFixed(1)}" cy="${y(c).toFixed(1)}" r="2" fill="${COLORS.raw}" fill-opacity="${(0.25 + 0.6 * p.clarity).toFixed(2)}" />`);
  }

  // --- the reading the tuner showed ---
  let path = '';
  let open = false;
  for (const p of points) {
    if (!p.reported || p.status === 'idle') { open = false; continue; }
    const c = Math.max(lo, Math.min(hi, cents(p.reported, noteHz)));
    path += `${open ? 'L' : 'M'}${x(p.t).toFixed(1)} ${c.toFixed ? y(c).toFixed(1) : y(c)} `;
    open = true;
  }
  if (path) parts.push(`<path d="${path}" fill="none" stroke="${COLORS.reading}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`);

  // --- the fitted decay and the pitch it extrapolates to ---
  if (fit) {
    const settledHz = fit.anchor * Math.pow(2, fit.settled / 1200);
    const settledCents = cents(settledHz, noteHz);
    let curve = '';
    for (let i = 0; i <= 60; i++) {
      const t = (i / 60) * duration;
      const modelled = fit.settled + fit.amplitude * Math.exp(-Math.max(0, t - fit.originT) / fit.theta);
      const c = cents(fit.anchor * Math.pow(2, modelled / 1200), noteHz);
      if (c < lo - 20 || c > hi + 20) continue;
      curve += `${curve ? 'L' : 'M'}${x(t).toFixed(1)} ${y(Math.max(lo, Math.min(hi, c))).toFixed(1)} `;
    }
    if (curve) parts.push(`<path d="${curve}" fill="none" stroke="${COLORS.fit}" stroke-width="2" stroke-dasharray="5 4" stroke-opacity="0.9" />`);
    if (settledCents > lo && settledCents < hi) {
      parts.push(
        `<line x1="${PLOT.left}" y1="${y(settledCents).toFixed(1)}" x2="${PLOT.right}" y2="${y(settledCents).toFixed(1)}" stroke="${COLORS.fit}" stroke-width="1" stroke-dasharray="2 3" stroke-opacity="0.65" />`,
        `<text x="${PLOT.right - 2}" y="${(y(settledCents) + (settledCents - lo < (hi - lo) * 0.2 ? 14 : -7)).toFixed(1)}" text-anchor="end" fill="${COLORS.fit}" font-size="11" font-weight="600">settles at ${settledCents >= 0 ? '+' : '−'}${Math.abs(settledCents).toFixed(1)} cents</text>`
      );
    }
  }

  // --- legend: identity never by colour alone ---
  const legend = [
    ['raw detections', COLORS.raw, 'dot'],
    ['reading shown', COLORS.reading, 'line'],
    ...(fit ? [['settled fit', COLORS.fit, 'dash']] : []),
  ];
  let lx = PLOT.left;
  for (const [label, color, shape] of legend) {
    parts.push(shape === 'dot'
      ? `<circle cx="${lx + 4}" cy="${LEGEND_Y - 3}" r="2.5" fill="${color}" />`
      : `<line x1="${lx}" y1="${LEGEND_Y - 3}" x2="${lx + 9}" y2="${LEGEND_Y - 3}" stroke="${color}" stroke-width="2"${shape === 'dash' ? ' stroke-dasharray="4 3"' : ''} />`);
    parts.push(`<text x="${lx + 14}" y="${LEGEND_Y}" fill="${COLORS.ink}" font-size="10">${label}</text>`);
    lx += 20 + label.length * 5.6;
  }

  return {
    svg: parts.join(''),
    scales: { x, y, lo, hi, duration, noteHz },
  };
}

export { W, H, PLOT };
