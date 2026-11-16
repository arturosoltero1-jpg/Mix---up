// Genera pistas WAV de prueba con bombo + hi-hat + acorde: node scripts/gen-tracks.js <carpeta>
const fs = require('fs'), path = require('path');
const sr = 22050, out = process.argv[2] || '.';
function wav(name, bpm, off, secs, freq) {
  const n = sr * secs, d = new Float32Array(n), beat = 60 / bpm;
  for (let i = 0; i < n; i++) d[i] = 0.06 * Math.sin(2 * Math.PI * freq * i / sr) + 0.04 * Math.sin(2 * Math.PI * freq * 1.5 * i / sr);
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let t = off; t < secs - 0.3; t += beat) {
    const s0 = Math.floor(t * sr);
    for (let i = 0; i < 0.18 * sr; i++) { const tt = i / sr; d[s0 + i] += Math.sin(2 * Math.PI * (110 * Math.exp(-tt * 18) + 45) * tt) * Math.exp(-tt * 14) * 0.9; }
    const h0 = Math.floor((t + beat / 2) * sr);
    for (let i = 0; i < 0.03 * sr; i++) d[h0 + i] += rnd() * 0.2 * Math.exp(-i / (0.01 * sr));
  }
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(d[i] * 28000))), 44 + i * 2);
  fs.writeFileSync(path.join(out, name), b);
}
wav('01 House 124.wav', 124, 0.31, 45, 220);
wav('02 House 126.wav', 126, 0.12, 45, 247);
wav('03 Hiphop 100.wav', 100, 0.40, 45, 196);
