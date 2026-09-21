// Drives the real app in a real browser with a real audio pipeline: worklet,
// worker, service worker, the lot. The offline harnesses measure the DSP; this
// measures the PLUMBING, which DESIGN §12.12 says is the actual risk -- "CPU is
// not the risk; plumbing is."
//
//   node tools/browser-test.mjs [sample.wav]
import { chromium } from 'playwright';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { readWav, writeWav } from './wav.mjs';

const SAMPLE = process.argv[2] || 'samples/e2-2-normal.wav';
const PORT = 8137;

// The fake-audio device wants 16-bit mono PCM. Prepend a lead-in for the
// hold-to-calibrate step -- taken from the recording's OWN opening room tone,
// not synthesised.
//
// That distinction is not fussiness. Calibrating on synthetic silence tells
// the engine the room is empty, which switches off the frequency-domain
// masking that this recording's real 58 Hz rumble needs, and the tuner then
// fails for a reason that exists only in the test rig. A user holding the
// button measures the room they are actually in.
const wav = '/tmp/tunedup-fake.wav';
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
  executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
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
});
const page = await context.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto(`http://localhost:${PORT}/index.html`);
await page.waitForSelector('#hold');

// Hold the start button for the full calibration.
const box = await page.locator('#hold').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.waitForTimeout(2300);
await page.mouse.up();

await page.waitForSelector('#tuner:not([hidden])', { timeout: 6000 }).catch(() => {});
const started = await page.locator('#tuner').isVisible();

// Watch for a while and record what the UI actually shows.
// Capture the start screen before tuning begins, too.
const seen = [];
let shot = false;
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(200);
  // Wait past the acknowledgement flash before capturing, or the screenshot
  // is of the flash rather than of the meter.
  if (!shot && i > 6 && await page.locator('#meter.live').count()) {
    shot = true;
    await page.waitForTimeout(500);
    await page.screenshot({ path: 'tools/last-screenshot.png' });
  }
  seen.push(await page.evaluate(() => ({
    note: document.getElementById('note').textContent.trim(),
    octave: document.getElementById('octave').textContent.trim(),
    cents: document.getElementById('cents').textContent.trim(),
    status: document.getElementById('status').textContent.trim(),
    live: document.getElementById('meter').classList.contains('live'),
    good: document.getElementById('meter').classList.contains('good'),
    raw: window.__tunedup || null,
  })));
}

const readings = seen.filter((s) => s.live && s.cents && s.cents !== ' ');
const notes = [...new Set(readings.map((s) => s.note + s.octave))];
const statuses = [...new Set(seen.map((s) => s.status).filter(Boolean))];

if (!shot) await page.screenshot({ path: 'tools/last-screenshot.png' });

console.log(`sample         ${path.basename(SAMPLE)}`);
console.log(`started        ${started ? 'yes' : 'NO -- calibration did not complete'}`);
console.log(`frames seen    ${seen.length}, with a live reading ${readings.length}`);
console.log(`notes shown    ${notes.join(', ') || '(none)'}`);
console.log(`cents range    ${readings.length ? `${Math.min(...readings.map((r) => parseFloat(r.cents.replace('\u2212','-'))))} .. ${Math.max(...readings.map((r) => parseFloat(r.cents.replace('\u2212','-'))))}` : '(none)'}`);
console.log(`in-tune shown  ${seen.filter((s) => s.good).length} frames`);
console.log(`statuses       ${statuses.join(' | ') || '(none)'}`);
const raws = seen.map((s) => s.raw).filter(Boolean);
if (raws.length) {
  const withNote = raws.filter((r) => r.heard);
  console.log(`heard frames   ${withNote.length}`);
  const sigmas = withNote.map((r) => r.sigma).filter((x) => x != null);
  if (sigmas.length) console.log(`sigma seen     ${Math.min(...sigmas).toFixed(2)} .. ${Math.max(...sigmas).toFixed(2)}`);
  const gateCounts = {};
  for (const r of withNote) for (const g of r.gates || []) gateCounts[g] = (gateCounts[g] || 0) + 1;
  console.log(`gates          ${JSON.stringify(gateCounts)}`);
  console.log(`partials seen  ${JSON.stringify([...new Set(withNote.map((r) => r.partials))])}`);
  console.log(`states         ${JSON.stringify([...new Set(withNote.map((r) => r.state))])}`);
}
console.log(`errors         ${errors.length ? errors.join('\n               ') : 'none'}`);
console.log(`screenshot     tools/last-screenshot.png`);

await browser.close();
server.kill();
process.exit(errors.length || !started ? 1 : 0);
