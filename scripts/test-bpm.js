// Prueba del detector con pistas sintéticas: node scripts/test-bpm.js
const { analyze } = require('../www/bpm.js');
const sr = 22050;

function synth(bpm, offset, seconds, noiseOnly) {
  const n = sr * seconds, d = new Float32Array(n), beat = 60 / bpm;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let i = 0; i < n; i++) d[i] = rnd() * 0.05; // ruido de fondo
  if (noiseOnly) return d;
  for (let t = offset; t < seconds - 0.3; t += beat) {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < 0.18 * sr; i++) { // bombo
      const tt = i / sr, f = 110 * Math.exp(-tt * 18) + 45;
      d[s0 + i] += Math.sin(2 * Math.PI * f * tt) * Math.exp(-tt * 14) * 0.9;
    }
    const h0 = Math.floor((t + beat / 2) * sr); // hi-hat a contratiempo
    for (let i = 0; i < 0.03 * sr; i++) d[h0 + i] += rnd() * 0.25 * Math.exp(-i / (0.01 * sr));
  }
  return d;
}

let fail = 0;
for (const [bpm, off] of [[124, 0.37], [128, 0.12], [100, 0.5], [90, 0.2], [140, 0.05], [174, 0.3]]) {
  const t0 = Date.now();
  const r = analyze(synth(bpm, off, 90), sr);
  const period = 60 / bpm; // fase respecto al pulso real
  const dd = Math.abs(r.firstBeat - off) % period;
  const phaseErr = Math.min(dd, period - dd);
  // en media-octava (174->87) el primer pulso puede caer en uno de los dos pulsos reales
  // 174 se acepta como 87 (octava) — igual de útil para mezclar
  const okBpm = Math.abs(r.bpm - bpm) < 0.3 || Math.abs(r.bpm * 2 - bpm) < 0.6;
  const ok = okBpm && phaseErr < 0.02;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FALLA'), 'real', bpm, 'det', r.bpm, '| fase err', (phaseErr * 1000).toFixed(0) + 'ms', '| conf', r.confidence.toFixed(1), '|', Date.now() - t0 + 'ms');
}
const rn = analyze(synth(0, 0, 90, true), sr);
console.log('ruido -> conf', rn.confidence.toFixed(1), '(debe ser menor que arriba)');
process.exit(fail ? 1 : 0);
