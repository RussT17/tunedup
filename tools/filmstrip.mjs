// Watches one pluck, frame by frame, and lays the frames out as a contact
// sheet so a human (or I) can actually LOOK at what the app does over the life
// of a note.
//
// tools/browser-test.mjs checks that the right values arrive: it polls text and
// class names at 5 Hz and takes a single screenshot. That is a test of the
// data, not of the experience. It cannot see the needle move, the
// acknowledgement flash, a transition that stutters, a reading that appears and
// vanishes twice, or the moment the number drops out -- and those are exactly
// what someone using the tuner notices first. The one UI bug found so far (an
// overlay covering the whole screen) was caught because a screenshot happened
// to land on it, which is luck, not method.
//
//   node tools/filmstrip.mjs [sample.wav] [frameMs] [frames]
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readWav, writeWav } from './wav.mjs';

const SAMPLE = process.argv[2] || 'samples/g3-2-normal.wav';
const FRAME_MS = Number(process.argv[3]) || 130;
const FRAMES = Number(process.argv[4]) || 30;
const PORT = 8139;

const wav = '/tmp/tunedup-film.wav';
{
  const { samples, sampleRate } = readWav(SAMPLE);
  const grab = Math.min(Math.round(sampleRate * 1.0), samples.length);
  const lead = Math.round(sampleRate * 3.0);
  const out = new Float32Array(lead + samples.length);
  for (let i = 0; i < lead; i++) out[i] = samples[i % grab];
  out.set(samples, lead);
  writeWav(wav, out, sampleRate);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: process.cwd(), stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 700));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const context = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 390, height: 844 },
  colorScheme: process.env.LIGHT ? 'light' : 'dark',
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForSelector('#hold');

// --- the hold, captured too: this animation has never been looked at either.
const holdShots = [];
const box = await page.locator('#hold').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(450);
  holdShots.push({ label: `hold ${((i + 1) * 0.45).toFixed(2)}s`, buf: await page.screenshot() });
}
await page.mouse.up();
await page.waitForSelector('#tuner:not([hidden])', { timeout: 6000 });

// --- wait for the pluck, then film it.
const t0 = Date.now();
while (Date.now() - t0 < 12000) {
  if (await page.evaluate(() => !!(window.__tunedup && window.__tunedup.heard))) break;
  await page.waitForTimeout(25);
}
const onset = Date.now();

const clip = { x: 0, y: 190, width: 390, height: 440 };
const shots = [];
for (let i = 0; i < FRAMES; i++) {
  const state = await page.evaluate(() => {
    const r = window.__tunedup || {};
    return { sigma: r.sigma, live: !!r.showReading, cents: r.cents, gates: (r.gates || []).join(','), d: r.d };
  });
  const buf = await page.screenshot({ clip });
  const t = ((Date.now() - onset) / 1000).toFixed(2);
  shots.push({
    label: `${t}s  ${state.live ? `${state.cents >= 0 ? '+' : ''}${state.cents.toFixed(1)}c σ${state.sigma.toFixed(2)}` : 'no reading'}`,
    buf,
  });
  await page.waitForTimeout(FRAME_MS);
}

// --- composite in the browser: no image library, no extra dependency.
async function sheet(items, cols, outFile, title) {
  const data = items.map((s) => ({ label: s.label, src: `data:image/png;base64,${s.buf.toString('base64')}` }));
  const sheetPage = await context.newPage();
  await sheetPage.setViewportSize({ width: cols * 210 + 24, height: 400 });
  await sheetPage.setContent(`<!doctype html><meta charset=utf-8>
    <style>
      body{margin:0;background:#0b0e11;color:#cfd8e3;font:12px system-ui;padding:12px}
      h1{font:600 14px system-ui;margin:0 0 10px}
      .g{display:grid;grid-template-columns:repeat(${cols},200px);gap:8px}
      figure{margin:0}
      img{width:200px;display:block;border:1px solid #222c36;border-radius:4px}
      figcaption{padding:3px 2px;font-variant-numeric:tabular-nums;color:#8c9aa8}
    </style>
    <h1>${title}</h1>
    <div class=g>${data.map((d) => `<figure><img src="${d.src}"><figcaption>${d.label}</figcaption></figure>`).join('')}</div>`);
  await sheetPage.waitForTimeout(300);
  await sheetPage.screenshot({ path: outFile, fullPage: true });
  await sheetPage.close();
}

await sheet(holdShots, 5, 'tools/film-hold.png', `Hold to start — ${path.basename(SAMPLE)}`);
await sheet(shots, 6, 'tools/film-note.png', `One pluck, every ${FRAME_MS} ms — ${path.basename(SAMPLE)}`);

console.log(`frames: ${shots.length}, with a reading: ${shots.filter((s) => !s.label.includes('no reading')).length}`);
console.log(`errors: ${errors.length ? errors.join(' | ') : 'none'}`);
console.log('wrote tools/film-hold.png and tools/film-note.png');

await browser.close();
server.kill();
