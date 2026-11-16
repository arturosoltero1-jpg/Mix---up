/* Motor de scratch: lee un buffer decodificado a velocidad variable (también hacia atrás),
 * como una aguja sobre el disco. Velocidad = pasos de muestra por muestra de salida. */
class ScratchProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null; this.n = 0; this.sr = sampleRate;
    this.pos = 0; this.rate = 0; this.target = 0; this.tau = 0.008;
    this.on = false; this.g = 0; this.gT = 0; this.stopping = false; this.cnt = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'load') { this.ch = m.ch; this.n = m.ch[0].length; this.sr = m.sr || sampleRate; }
      else if (m.type === 'free') { this.ch = null; this.n = 0; this.on = false; this.g = 0; }
      else if (m.type === 'start') {
        this.pos = Math.max(0, m.pos * this.sr); this.rate = m.rate; this.target = m.rate;
        this.tau = 0.008; this.on = !!this.ch; this.gT = 1; this.g = 0; this.stopping = false;
      }
      else if (m.type === 'rate') { this.target = m.rate; this.tau = m.motor ? 0.09 : 0.008; }
      else if (m.type === 'stop') { this.gT = 0; this.stopping = true; }
    };
  }
  process(inputs, outputs) {
    if (!this.on || !this.ch) return true;
    const out = outputs[0], L = out[0], R = out[1] || out[0], N = L.length;
    const a = 1 - Math.exp(-1 / (sampleRate * this.tau));
    const ag = 1 - Math.exp(-1 / (sampleRate * 0.006));
    const step = this.sr / sampleRate, c0 = this.ch[0], c1 = this.ch[1] || c0, last = this.n - 2;
    for (let i = 0; i < N; i++) {
      this.rate += (this.target - this.rate) * a;
      this.g += (this.gT - this.g) * ag;
      this.pos += this.rate * step;
      if (this.pos < 0) { this.pos = 0; if (this.rate < 0) this.rate = 0; }
      else if (this.pos > last) { this.pos = last; if (this.rate > 0) this.rate = 0; }
      const ip = this.pos | 0, f = this.pos - ip;
      const amp = this.g * Math.min(1, Math.abs(this.rate) * 5);   // disco parado = silencio
      L[i] = (c0[ip] * (1 - f) + c0[ip + 1] * f) * amp;
      R[i] = (c1[ip] * (1 - f) + c1[ip + 1] * f) * amp;
    }
    if (++this.cnt % 8 === 0) this.port.postMessage({ type: 'pos', pos: this.pos / this.sr, t: currentTime, rate: this.rate });
    if (this.stopping && this.g < 0.003) { this.on = false; this.stopping = false; this.port.postMessage({ type: 'stopped' }); }
    return true;
  }
}
registerProcessor('scratch-proc', ScratchProc);
