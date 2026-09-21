// Measures the minimum-statistics bias compensation against a real room-tone
// recording: how far below the true per-bin mean does the running minimum sit?
// The answer is a single factor in RoomProfile; the residual is absorbed by
// alpha. Run: node tools/calibrate-room.mjs samples/room-tone.wav
import { readWav } from './wav.mjs';
import { FFT, powerSpectrum } from '../src/dsp/fft.js';
import { blackmanHarris } from '../src/dsp/window.js';
import { RoomProfile } from '../src/dsp/room.js';

const file = process.argv[2] || 'samples/room-tone.wav';
const { samples, sampleRate } = readWav(file);
const N = 4096, HOP = Math.round(sampleRate * 0.01);
const fft = new FFT(N), win = blackmanHarris(N);
const frame = new Float64Array(N), re = new Float64Array(N), im = new Float64Array(N);
const power = new Float64Array(N / 2 + 1);

const room = new RoomProfile(N / 2 + 1, sampleRate, N);
room.biasComp = 1;                       // measure raw, then report the factor
const mean = new Float64Array(N / 2 + 1);
let frames = 0;

for (let at = 0; at + N <= samples.length; at += HOP) {
  for (let i = 0; i < N; i++) frame[i] = samples[at + i] * win[i];
  powerSpectrum(fft, frame, re, im, power);
  room.observe(power, HOP / sampleRate);
  for (let k = 0; k <= N / 2; k++) mean[k] += power[k];
  frames++;
}
for (let k = 0; k <= N / 2; k++) mean[k] /= frames;

const ratios = [];
const binHz = sampleRate / N;
for (let k = 1; k <= N / 2; k++) {
  const f = k * binHz;
  if (f < 40 || f > 3000) continue;
  if (room.noise[k] > 0) ratios.push(mean[k] / room.noise[k]);
}
ratios.sort((a, b) => a - b);
const q = (p) => ratios[Math.floor(p * (ratios.length - 1))];
console.log(`${file}: ${frames} frames, ${ratios.length} bins in 40-3000 Hz`);
console.log(`mean / min  p10 ${q(0.1).toFixed(2)}  median ${q(0.5).toFixed(2)}  p90 ${q(0.9).toFixed(2)}  p99 ${q(0.99).toFixed(2)}`);
console.log(`=> biasComp should be about ${q(0.5).toFixed(2)} (median), ${q(0.9).toFixed(2)} to cover p90`);
console.log(`mains detected: ${room.mainsHz || 'none'} Hz`);
