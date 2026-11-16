/* Detector de BPM y de primer golpe (beat grid) — JS puro, sin dependencias.
 * Uso: BPMDetect.analyze(Float32Array mono, sampleRate) -> {bpm, firstBeat, confidence}
 * firstBeat = segundos (relativos al inicio del arreglo) del primer pulso. */
(function (root) {
  'use strict';
  var ENV_HZ = 200;
  var BPM_MIN = 78, BPM_MAX = 168;

  function at(arr, x) {
    var i = Math.floor(x);
    if (i < 0 || i >= arr.length - 1) return 0;
    var f = x - i;
    return arr[i] * (1 - f) + arr[i + 1] * f;
  }

  function buildOnset(data, sr) {
    var hop = Math.max(1, Math.round(sr / ENV_HZ));
    var envHz = sr / hop;
    var n = Math.floor(data.length / hop);
    var env = new Float32Array(n);
    var lp = 0, a = 1 - Math.exp(-2 * Math.PI * 180 / sr), idx = 0, f, k;
    for (f = 0; f < n; f++) {
      var s = 0;
      for (k = 0; k < hop; k++) { lp += a * (data[idx++] - lp); s += lp * lp; }
      env[f] = Math.sqrt(s / hop);
    }
    var on = new Float32Array(n);
    var prev = Math.log(1 + 100 * env[0]);
    for (f = 1; f < n; f++) {
      var c = Math.log(1 + 100 * env[f]);
      var d = c - prev;
      on[f] = d > 0 ? d : 0;
      prev = c;
    }
    // quita la media local (~0.5 s) para quedarse solo con los picos
    var win = Math.round(envHz * 0.5), pre = new Float64Array(n + 1);
    for (f = 0; f < n; f++) pre[f + 1] = pre[f] + on[f];
    var out = new Float32Array(n);
    for (f = 0; f < n; f++) {
      var lo = Math.max(0, f - win), hi = Math.min(n, f + win + 1);
      var m = (pre[hi] - pre[lo]) / (hi - lo);
      var v = on[f] - m * 1.2;
      out[f] = v > 0 ? v : 0;
    }
    return { on: out, envHz: envHz };
  }

  function tempoScore(on, envHz, bpm) {
    var P = 60 * envHz / bpm, n = on.length, s = 0, i;
    var lim = n - 4 * P - 2;
    for (i = 0; i < lim; i++) {
      var v = on[i];
      if (v > 0) s += v * (at(on, i + P) + 0.5 * at(on, i + 2 * P) + 0.5 * at(on, i + 4 * P));
    }
    return s;
  }

  function analyze(data, sr) {
    var o = buildOnset(data, sr), on = o.on, envHz = o.envHz;
    if (on.length < envHz * 10) return null;
    var scores = [], bpm, best = -1, bestBpm = 120, sum = 0;
    for (bpm = BPM_MIN; bpm <= BPM_MAX; bpm += 0.25) {
      var sc = tempoScore(on, envHz, bpm);
      // prior suave hacia 120 BPM para elegir bien entre octavas
      var oct = Math.log(bpm / 120) / Math.LN2;
      sc *= Math.exp(-(oct * oct) / (2 * 0.7 * 0.7));
      scores.push(sc); sum += sc;
      if (sc > best) { best = sc; bestBpm = bpm; }
    }
    // refinamiento fino: peine de pulsos (tempo + fase a la vez) alrededor del mejor candidato
    var sm = new Float32Array(on.length), q;
    for (q = 1; q < on.length - 1; q++) sm[q] = 0.25 * on[q - 1] + 0.5 * on[q] + 0.25 * on[q + 1];
    var rb = bestBpm, rs = -1, rph = 0, ph0;
    for (bpm = bestBpm - 0.6; bpm <= bestBpm + 0.6; bpm += 0.02) {
      var Pc = 60 * envHz / bpm;
      for (ph0 = 0; ph0 < Pc; ph0 += 1) {
        var cs = 0, kk;
        for (kk = ph0; kk < sm.length - 1; kk += Pc) cs += at(sm, kk);
        if (cs > rs) { rs = cs; rb = bpm; rph = ph0; }
      }
    }
    bestBpm = Math.round(rb * 100) / 100;
    var sorted = scores.slice().sort(function (x, y) { return x - y; });
    var median = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    var confidence = best / (median + 1e-12);

    // fase fina para el tempo elegido
    var P = 60 * envHz / bestBpm, bestPh = rph, bestPs = -1, ph, k, ps;
    for (ph = rph - 1.5; ph <= rph + 1.5; ph += 0.25) {
      ps = 0;
      for (k = ph; k < sm.length - 1; k += P) ps += at(sm, k);
      if (ps > bestPs) { bestPs = ps; bestPh = ph; }
    }
    if (bestPh < 0) bestPh += P;
    return { bpm: bestBpm, firstBeat: bestPh / envHz, confidence: confidence };
  }

  var api = { analyze: analyze };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BPMDetect = api;
})(typeof self !== 'undefined' ? self : this);
