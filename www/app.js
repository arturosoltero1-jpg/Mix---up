/* Mix up-ear — motor de mezcla automática (audio + video) con dos decks.
 * Detecta BPM, iguala tempo, alinea el golpe, hace crossfade con intercambio de graves. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const LAT = 0.045;                 // latencia estimada de play() para adelantar el arranque (s)
  const MAX_ANALYZE_BYTES = 160 * 1024 * 1024;
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v)$/i;

  /* ---------- ajustes ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio / privado */ } }
  };
  const settings = Object.assign({ mix: 12, sync: true, bass: true, loop: false, video: true, cutOn: false, cut: 150 }, store.get('automix:settings', {}));
  const saveSettings = () => store.set('automix:settings', settings);

  /* ---------- audio graph ---------- */
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const master = ctx.createGain(); master.gain.value = 0.92;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.82;
  master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);

  const videosEl = $('videos');
  function makeDeck(i) {
    const el = document.createElement('video');
    el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto';
    el.preservesPitch = true; el.webkitPreservesPitch = true;
    videosEl.appendChild(el);
    const src = ctx.createMediaElementSource(el);
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 220; shelf.gain.value = 0;
    const gain = ctx.createGain(); gain.gain.value = i === 0 ? 1 : 0;
    src.connect(shelf); shelf.connect(gain); gain.connect(master);
    return { i, el, shelf, gain, track: null, loadedId: null, loadingId: null, loadP: null, glide: null };
  }
  const D = [makeDeck(0), makeDeck(1)];
  const setParam = (p, v) => { p.cancelScheduledValues(0); p.setValueAtTime(v, ctx.currentTime); };

  /* ---------- estado ---------- */
  let queue = [];
  let seq = 0;
  let active = 0;          // deck que suena "principal"
  let curId = null;        // id de la pista principal
  let paused = true;
  let mix = null;          // {phase:'plan'|'armed'|'running', ...}

  const curIndex = () => queue.findIndex((t) => t.id === curId);
  function nextIndex() {
    const n = queue.length, i = curIndex();
    if (!n || i < 0) return -1;
    for (let k = 1; k <= n; k++) {
      let j = i + k;
      if (j >= n) { if (!settings.loop) return -1; j -= n; }
      if (queue[j].status !== 'error') return j;
    }
    return -1;
  }

  /* ---------- utilidades UI ---------- */
  const toastEl = $('toast'); let toastT;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2800); }
  const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------- biblioteca ---------- */
  function addFiles(fileList) {
    const all = Array.from(fileList || []);
    const files = all.filter((f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name) || VIDEO_EXT.test(f.name));
    if (!files.length) { toast('No encontré audio ni video en esa selección'); return; }
    files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: 'base' }));
    let added = 0;
    for (const f of files) {
      if (queue.some((t) => t.file.name === f.name && t.file.size === f.size)) continue;
      const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/') : null;
      const isVideo = /^video\//.test(f.type) || VIDEO_EXT.test(f.name);
      const t = {
        id: ++seq, order: seq, file: f, url: URL.createObjectURL(f), kind: isVideo ? 'video' : 'audio',
        name: f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim(),
        sub: rel && rel.length > 1 ? rel[rel.length - 2] : (f.name.split('.').pop() || '').toUpperCase(),
        bpm: null, firstBeat: null, status: 'new'
      };
      const c = store.get('automix:bpm:' + f.name + ':' + f.size, null);
      if (c) { t.bpm = c.bpm; t.firstBeat = c.fb; t.status = 'ready'; }
      queue.push(t); added++;
    }
    if (added) { toast(added + (added === 1 ? ' pista agregada' : ' pistas agregadas')); scheduleAnalysis(); }
    else toast('Esas pistas ya estaban en la lista');
    render();
  }

  /* ---------- análisis de BPM ---------- */
  const analyzing = new Map();
  let chain = Promise.resolve();
  function analyze(t) {
    if (t.status === 'ready' || t.status === 'error') return Promise.resolve();
    if (analyzing.has(t.id)) return analyzing.get(t.id);
    const p = (async () => {
      t.status = 'analyzing'; render();
      try {
        if (t.file.size > MAX_ANALYZE_BYTES) throw new Error('archivo muy grande para analizar');
        const buf = await t.file.arrayBuffer();
        const OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const ab = await new OC(1, 1, 22050).decodeAudioData(buf);
        const sr = ab.sampleRate, total = ab.length;
        const winLen = Math.min(total, Math.floor(90 * sr));
        const start = Math.floor(Math.max(0, Math.min(total * 0.25, total - winLen)));
        const mono = new Float32Array(winLen), nch = ab.numberOfChannels;
        for (let c = 0; c < nch; c++) { const ch = ab.getChannelData(c); for (let i = 0; i < winLen; i++) mono[i] += ch[start + i] / nch; }
        const r = BPMDetect.analyze(mono, sr);
        if (r && r.confidence >= 3) {
          const P = 60 / r.bpm;
          t.bpm = r.bpm; t.firstBeat = (((start / sr + r.firstBeat) % P) + P) % P;
          store.set('automix:bpm:' + t.file.name + ':' + t.file.size, { bpm: t.bpm, fb: t.firstBeat });
        }
      } catch (e) { /* sin BPM: la pista igual se mezcla con crossfade simple */ }
      t.status = 'ready'; render();
      if (!queue.some((q) => q.status === 'new' || q.status === 'analyzing') && /^bpm/.test($('sortMode').value)) sortQueue();
    })().finally(() => analyzing.delete(t.id));
    analyzing.set(t.id, p);
    return p;
  }
  function scheduleAnalysis() {
    for (const t of queue) if (t.status === 'new') chain = chain.then(() => analyze(t)).catch(() => {});
  }

  /* ---------- orden ---------- */
  function sortQueue() {
    const mode = $('sortMode').value, ci = curIndex();
    const head = ci >= 0 ? queue.slice(0, ci + 1) : [], rest = ci >= 0 ? queue.slice(ci + 1) : queue.slice();
    if (mode === 'shuffle') { for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } }
    else if (mode === 'list') rest.sort((a, b) => a.order - b.order);
    else {
      const dir = mode === 'bpm-asc' ? 1 : -1;
      rest.sort((a, b) => (a.bpm == null) - (b.bpm == null) || (a.bpm == null ? a.order - b.order : dir * (a.bpm - b.bpm)));
    }
    queue = head.concat(rest); render();
  }

  /* ---------- carga de decks ---------- */
  function loadDeck(d, t) {
    if (d.loadedId === t.id) return Promise.resolve();
    if (d.loadingId === t.id) return d.loadP;
    d.loadedId = null; d.loadingId = t.id;
    d.loadP = new Promise((res, rej) => {
      const el = d.el; let to;
      const done = (ok, err) => {
        el.removeEventListener('loadedmetadata', onOk); el.removeEventListener('error', onErr); clearTimeout(to);
        d.loadingId = null;
        if (ok) { d.loadedId = t.id; d.track = t; res(); } else rej(err || new Error('no se pudo cargar'));
      };
      const onOk = () => done(true), onErr = () => done(false, el.error);
      el.addEventListener('loadedmetadata', onOk); el.addEventListener('error', onErr);
      to = setTimeout(() => done(false, new Error('tiempo agotado')), 15000);
      el.src = t.url; el.load();
    });
    return d.loadP;
  }
  function markError(t) { t.status = 'error'; render(); }
  function preload(ni) {
    const t = queue[ni], nxt = D[1 - active];
    if (!t || nxt.loadedId === t.id || nxt.loadingId === t.id) return;
    loadDeck(nxt, t).catch(() => markError(t));
  }

  /* ---------- visual de video ---------- */
  function fadeVisual(d, show, secs) {
    const vis = show && d.track && d.track.kind === 'video' ? 1 : 0;
    d.el.style.transition = secs > 0 ? 'opacity ' + secs + 's linear' : 'none';
    d.el.style.opacity = vis;
  }

  /* ---------- reproducción directa ---------- */
  function stopGlide(d) { if (d.glide) { clearInterval(d.glide); d.glide = null; } }
  function startGlide(d) {
    stopGlide(d);
    if (Math.abs(d.el.playbackRate - 1) < 0.003) { d.el.playbackRate = 1; return; }
    d.glide = setInterval(() => {
      const r = d.el.playbackRate, nr = r + (1 - r) * 0.07;
      if (Math.abs(nr - 1) < 0.002) { d.el.playbackRate = 1; stopGlide(d); } else d.el.playbackRate = nr;
    }, 250);
  }
  function cancelMix() {
    mix = null;
    D.forEach((d) => { stopGlide(d); d.gain.gain.cancelScheduledValues(0); d.shelf.gain.cancelScheduledValues(0); });
  }

  async function hardPlay(index) {
    const t = queue[index]; if (!t) return;
    cancelMix();
    try { await ctx.resume(); } catch (e) { /* ignorado */ }
    const d = D[active], o = D[1 - active];
    o.el.pause(); setParam(o.gain.gain, 0); setParam(o.shelf.gain, 0); fadeVisual(o, false, 0);
    curId = t.id; paused = false; render();
    try { await loadDeck(d, t); }
    catch (e) {
      markError(t); toast('No se pudo reproducir: ' + t.name);
      const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll();
      return;
    }
    d.el.playbackRate = 1; setParam(d.gain.gain, 1); setParam(d.shelf.gain, 0);
    d.el.style.zIndex = 1; fadeVisual(d, true, 0);
    d.el.currentTime = 0;
    try { await d.el.play(); } catch (e) { toast('Toca Play para iniciar'); paused = true; }
    setMediaSession(t); wake(); updatePlayIcon(); analyze(t);
  }
  function stopAll() {
    cancelMix(); D.forEach((d) => { d.el.pause(); fadeVisual(d, false, 0); });
    paused = true; updatePlayIcon();
  }

  function togglePlay() {
    if (!queue.length) { toast('Primero agrega música'); return; }
    if (curId == null || curIndex() < 0) { hardPlay(0); return; }
    if (paused) {
      ctx.resume();
      D[active].el.play();
      if (mix && mix.phase === 'running') D[1 - active].el.play();
      paused = false; wake();
    } else {
      D.forEach((d) => d.el.pause());
      ctx.suspend(); paused = true;
    }
    updatePlayIcon();
  }

  /* ---------- el automix ---------- */
  // Minuto fijo de cambio: solo vale si la pista dura lo suficiente para mezclar después de ese punto
  function cutPoint(dur) {
    if (!settings.cutOn || !isFinite(dur)) return null;
    return settings.cut <= dur - 3 ? settings.cut : null;
  }
  async function startMix(force) {
    if (mix) return;
    const ni = nextIndex();
    if (ni < 0) { if (force) toast('Es la última pista de la lista'); return; }
    const my = (mix = { phase: 'plan' });
    const nt = queue[ni], cur = D[active], nxt = D[1 - active], ct = cur.track;
    stopGlide(cur);
    try {
      await Promise.race([analyze(nt), sleep(6000)]);
      if (mix !== my) return;
      await loadDeck(nxt, nt);
      if (mix !== my) return;
    } catch (e) {
      if (mix === my) mix = null;
      markError(nt); toast('No se pudo leer: ' + nt.name);
      return;
    }
    const tc = cur.el.currentTime, rateC = cur.el.playbackRate || 1;
    let r = 1, synced = false;
    if (settings.sync && ct && ct.bpm && nt.bpm) {
      r = (ct.bpm * rateC) / nt.bpm;
      while (r > 1.34) r /= 2;
      while (r < 0.67) r *= 2;
      if (Math.abs(r - 1) <= 0.12) synced = true; else r = 1;
    }
    const cutAt = cutPoint(cur.el.duration);                    // minuto fijo de cambio (o null)
    const minDelay = !force && cutAt != null ? Math.max(0, (cutAt - tc) / rateC) : 0;
    let delay = minDelay;
    if (synced && ct.firstBeat != null) {
      const bl = 60 / ct.bpm;                                   // pulso en tiempo de pista
      const ph = (((tc - ct.firstBeat) % bl) + bl) % bl;
      delay = (bl - ph) / rateC;                                // hasta el próximo golpe del deck actual
      if (delay < 0.12) delay += bl / rateC;
      while (delay < minDelay) delay += bl / rateC;             // el golpe queda en/después del minuto fijado
    }
    const remReal = (cur.el.duration - tc) / rateC;
    let len = force ? Math.min(settings.mix, 6) : settings.mix;
    len = Math.max(2, Math.min(len, remReal - delay - 0.25));
    nxt.el.playbackRate = r;
    nxt.el.currentTime = synced && nt.firstBeat != null ? nt.firstBeat : 0;
    setParam(nxt.gain.gain, 0); setParam(nxt.shelf.gain, synced && settings.bass ? -30 : 0);
    nxt.el.style.zIndex = 2; cur.el.style.zIndex = 1;
    mix = { phase: 'armed', ni, nt, r, synced, len, t0: ctx.currentTime + delay, bpmFrom: ct ? ct.bpm * rateC : null, bpmTo: nt.bpm ? nt.bpm * r : null };
  }

  function fireMix() {
    const m = mix; if (!m || m.phase !== 'armed') return;
    m.phase = 'running';
    const cur = D[active], nxt = D[1 - active];
    nxt.el.play().catch(() => toast('El sistema bloqueó el arranque; toca Play'));
    const now = ctx.currentTime, len = m.len;
    m.end = now + len; m.startedAt = now;
    const N = 64, up = new Float32Array(N), dn = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * Math.PI / 2; up[i] = Math.sin(x); dn[i] = Math.cos(x); }
    const g1 = cur.gain.gain, g2 = nxt.gain.gain;
    g1.cancelScheduledValues(now); g1.setValueCurveAtTime(dn, now, len);
    g2.cancelScheduledValues(now); g2.setValueCurveAtTime(up, now, len);
    if (m.synced && settings.bass) {
      const so = cur.shelf.gain, si = nxt.shelf.gain;
      so.cancelScheduledValues(now); so.setValueAtTime(0, now); so.setValueAtTime(0, now + len * 0.42); so.linearRampToValueAtTime(-30, now + len * 0.58);
      si.cancelScheduledValues(now); si.setValueAtTime(-30, now); si.setValueAtTime(-30, now + len * 0.42); si.linearRampToValueAtTime(0, now + len * 0.58);
    }
    nxt.track = m.nt;
    fadeVisual(nxt, false, 0); void nxt.el.offsetWidth;        // reinicia la transición
    fadeVisual(nxt, true, len); fadeVisual(cur, false, len);
    setMediaSession(m.nt);
  }

  function finishMix() {
    const m = mix; if (!m) return;
    const cur = D[active], nxt = D[1 - active];
    cur.el.pause(); setParam(cur.gain.gain, 0); setParam(cur.shelf.gain, 0); fadeVisual(cur, false, 0);
    setParam(nxt.gain.gain, 1); setParam(nxt.shelf.gain, 0);
    active = 1 - active; curId = m.nt.id; mix = null;
    startGlide(D[active]);
    render();
  }

  function tick() {
    if (paused || curId == null) return;
    const d = D[active];
    if (!mix) {
      const dur = d.el.duration, t = d.el.currentTime;
      if (!isFinite(dur) || dur <= 0 || d.el.readyState < 2) return;
      const ni = nextIndex(); if (ni < 0) return;
      const rate = d.el.playbackRate || 1, cutAt = cutPoint(dur);
      if (cutAt != null) {
        const toCut = (cutAt - t) / rate;                       // segundos reales hasta el minuto fijado
        if (toCut < 40) preload(ni);
        if (toCut <= 2.4) startMix(false);
      } else {
        const rem = (dur - t) / rate;
        if (rem < 40) preload(ni);
        if (settings.mix > 0 && rem <= settings.mix + 2.4) startMix(false);
      }
    } else if (mix.phase === 'armed') {
      if (ctx.currentTime >= mix.t0 - LAT) fireMix();
    } else if (mix.phase === 'running') {
      if (ctx.currentTime >= mix.end) finishMix();
    }
  }
  setInterval(tick, 20);

  D.forEach((d) => d.el.addEventListener('ended', () => {
    if (d.i !== active || mix) return;
    const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll();
  }));

  /* ---------- controles ---------- */
  $('btnPlay').onclick = togglePlay;
  $('btnNext').onclick = () => {
    if (!queue.length) return toast('Primero agrega música');
    if (curId == null || curIndex() < 0) return hardPlay(0);
    if (mix) return;
    if (paused) { const ni = nextIndex(); if (ni >= 0) hardPlay(ni); return; }
    startMix(true);
  };
  $('btnPrev').onclick = () => {
    const i = curIndex(); if (i < 0) return;
    if (D[active].el.currentTime > 3 || i === 0) { if (!mix) D[active].el.currentTime = 0; return; }
    hardPlay(i - 1);
  };
  $('progress').addEventListener('pointerdown', (e) => {
    if (mix || curId == null) return;
    const el = D[active].el, r = e.currentTarget.getBoundingClientRect();
    if (isFinite(el.duration)) el.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * el.duration;
  });
  $('btnFiles').onclick = () => $('inFiles').click();
  $('btnFolder').onclick = () => $('inFolder').click();
  $('inFiles').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('inFolder').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('btnClear').onclick = () => {
    if (!queue.length) return;
    stopAll(); D.forEach((d) => { d.el.removeAttribute('src'); d.el.load(); d.loadedId = null; d.track = null; });
    queue.forEach((t) => URL.revokeObjectURL(t.url)); queue = []; curId = null; render();
  };
  $('sortMode').onchange = sortQueue;
  $('btnSettings').onclick = () => { const s = $('settings'); s.hidden = !s.hidden; };
  $('list').addEventListener('click', (e) => {
    const li = e.target.closest('.item'); if (!li) return;
    const id = +li.dataset.id, i = queue.findIndex((t) => t.id === id);
    if (e.target.closest('.rm')) {
      if (id === curId || (mix && mix.nt && mix.nt.id === id)) return toast('No puedes quitar la pista que está sonando');
      URL.revokeObjectURL(queue[i].url);
      D.forEach((d) => { if (d.loadedId === id) d.loadedId = null; });
      queue.splice(i, 1); render(); return;
    }
    if (queue[i].status === 'error') { queue[i].status = 'ready'; }
    hardPlay(i);
  });

  const mixLen = $('mixLen');
  mixLen.value = settings.mix; $('mixVal').textContent = settings.mix + ' s';
  mixLen.oninput = () => { settings.mix = +mixLen.value; $('mixVal').textContent = settings.mix + ' s'; saveSettings(); };
  [['optSync', 'sync'], ['optBass', 'bass'], ['optLoop', 'loop'], ['optVideo', 'video']].forEach(([id, key]) => {
    const el = $(id); el.checked = !!settings[key];
    el.onchange = () => { settings[key] = el.checked; saveSettings(); applyVideoSetting(); };
  });
  const fmtMin = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const cutLen = $('cutLen'), optCut = $('optCut');
  cutLen.value = settings.cut; optCut.checked = !!settings.cutOn;
  const applyCut = () => { $('cutVal').textContent = fmtMin(settings.cut); $('cutRow').hidden = !settings.cutOn; };
  cutLen.oninput = () => { settings.cut = +cutLen.value; applyCut(); saveSettings(); };
  optCut.onchange = () => { settings.cutOn = optCut.checked; applyCut(); saveSettings(); };
  applyCut();
  function applyVideoSetting() { $('stage').classList.toggle('novideo', !settings.video); }
  applyVideoSetting();

  /* ---------- UI ---------- */
  function updatePlayIcon() {
    $('playIcon').innerHTML = '<use href="#' + (paused ? 'i-play' : 'i-pause') + '"/>';
    $('btnPlay').setAttribute('aria-label', paused ? 'Reproducir' : 'Pausar');
  }
  function render() {
    const list = $('list');
    list.innerHTML = queue.map((t, i) => {
      const cls = 'item' + (t.id === curId ? ' playing' : '') + (t.status === 'error' ? ' error' : '');
      const chip = t.status === 'error' ? '<span class="bpm">error</span>'
        : t.status === 'analyzing' ? '<span class="bpm ana">analizando</span>'
        : t.status === 'new' ? '<span class="bpm ana">en cola</span>'
        : '<span class="bpm">' + (t.bpm ? t.bpm.toFixed(1) + ' BPM' : '— BPM') + '</span>';
      const v = t.kind === 'video' ? '<span class="vtag"><svg><use href="#i-video"/></svg>video</span>' : '';
      return '<li class="' + cls + '" data-id="' + t.id + '"><span class="n">' + (t.id === curId ? '▶' : i + 1) + '</span>' +
        '<div class="t"><b>' + esc(t.name) + '</b><small>' + esc(t.sub) + v + '</small></div>' + chip +
        '<button class="rm" aria-label="Quitar"><svg><use href="#i-x"/></svg></button></li>';
    }).join('');
    $('empty').hidden = queue.length > 0;
    $('qCount').textContent = queue.length;
  }

  const dur0 = (d) => d.el.duration;
  const cache = {};
  const setText = (id, v) => { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } };
  const vizC = $('viz'), vctx = vizC.getContext('2d'), fq = new Uint8Array(analyser.frequencyBinCount);
  function sizeViz() { const r = vizC.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; vizC.width = r.width * dpr; vizC.height = r.height * dpr; }
  window.addEventListener('resize', sizeViz); sizeViz();

  function frame() {
    requestAnimationFrame(frame);
    if (document.hidden) return;
    const d = D[active], o = D[1 - active];
    const running = mix && mix.phase === 'running';
    let pos = active === 0 ? 0 : 1, prog = 0;
    if (running) { prog = Math.min(1, Math.max(0, (ctx.currentTime - mix.startedAt) / mix.len)); pos = active === 0 ? prog : 1 - prog; }

    for (const x of D) {
      const live = x === d || (running && x === o);
      $(x.i ? 'deckB' : 'deckA').classList.toggle('live', !!live && !paused);
      const t = x.loadedId != null ? x.track : null;
      const rate = x.el.playbackRate || 1;
      setText(x.i ? 'nameB' : 'nameA', t ? t.name : '—');
      setText(x.i ? 'bpmB' : 'bpmA', t && t.bpm ? (t.bpm * (x === d || running ? rate : 1)).toFixed(1) + ' BPM' : '— BPM');
    }
    const cm = $('cutMark'), cp = curId != null ? cutPoint(dur0(d)) : null;
    if (cp != null) { cm.hidden = false; cm.style.left = (cp / d.el.duration * 100) + '%'; } else cm.hidden = true;
    $('xfKnob').style.left = (pos * 100) + '%';
    setText('xfLabel', mix ? (mix.synced ? 'SYNC' : 'FADE') : '');

    const cur = queue[curIndex()];
    if (running) {
      setText('npLabel', 'Mezclando' + (mix.synced && mix.bpmFrom && mix.bpmTo ? ' · ' + mix.bpmFrom.toFixed(0) + ' → ' + mix.bpmTo.toFixed(0) + ' BPM' : ''));
      setText('npTitle', (d.track ? d.track.name : '') + '  →  ' + mix.nt.name);
    } else {
      setText('npLabel', cur ? (paused ? 'En pausa' : 'Reproduciendo') : 'Sin reproducción');
      setText('npTitle', cur ? cur.name : 'Agrega música para empezar');
    }
    const dur = d.el.duration, t = d.el.currentTime;
    if (curId != null && isFinite(dur) && dur > 0) {
      $('progressFill').style.width = (t / dur * 100) + '%';
      setText('tCur', fmt(t)); setText('tTot', fmt(dur));
    } else { $('progressFill').style.width = '0%'; setText('tCur', '0:00'); setText('tTot', '0:00'); }
    setText('hint', mix ? (mix.phase === 'plan' ? 'Preparando mezcla…' : mix.phase === 'armed' ? 'Esperando el golpe…' : 'Mezcla en curso') : queue.length ? 'Siguiente ▸ hace la transición con beatmatch ahora' : 'Agrega una carpeta o archivos');

    // visualizador
    const w = vizC.width, h = vizC.height;
    vctx.clearRect(0, 0, w, h);
    if (!paused) analyser.getByteFrequencyData(fq); else fq.fill(0);
    const bars = 32, bw = w / bars, ca = [255, 179, 71], cb = [61, 224, 192];
    const col = ca.map((v, k) => Math.round(v + (cb[k] - v) * pos));
    vctx.fillStyle = 'rgba(' + col.join(',') + ',0.55)';
    for (let i = 0; i < bars; i++) {
      const v = fq[Math.min(fq.length - 1, Math.floor(i * 1.6))] / 255, bh = Math.max(2, v * v * h * 0.8);
      vctx.fillRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh);
    }
  }
  requestAnimationFrame(frame);

  /* ---------- sistema: pantalla, controles de bloqueo ---------- */
  let lock = null;
  async function wake() { try { if (navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) { /* no disponible */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused) wake(); });
  function setMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: 'Mix up-ear', album: t.sub });
      navigator.mediaSession.setActionHandler('play', togglePlay);
      navigator.mediaSession.setActionHandler('pause', togglePlay);
      navigator.mediaSession.setActionHandler('nexttrack', () => $('btnNext').click());
      navigator.mediaSession.setActionHandler('previoustrack', () => $('btnPrev').click());
    } catch (e) { /* ignorado */ }
  }
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});

  // utilidades para pruebas automáticas
  window.__automix = { get state() { return { active, curId, paused, mix: mix && { phase: mix.phase, synced: mix.synced, len: mix.len, r: mix.r }, queue: queue.map((t) => ({ name: t.name, bpm: t.bpm, fb: t.firstBeat, status: t.status })) }; }, D, ctx };

  render(); updatePlayIcon();
})();
