/* Mix up-ear — automix con tocadiscos, ecualizador, carátulas y listas en línea. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const LAT = 0.045;                       // latencia aprox. de play() para adelantar el arranque (s)
  const BASE_W = 2 * Math.PI * (100 / 3) / 60;   // rad/s de un plato a 33⅓ rpm
  const MAX_ANALYZE_BYTES = 160 * 1024 * 1024;
  const AUDIO_EXT = /\.(mp3|m4a|aac|wav|flac|ogg|oga|opus|wma)$/i;
  const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v)$/i;
  const IMG_EXT = /\.(jpe?g|png|webp)$/i;
  const COVER_NAME = /^(cover|folder|front|album|albumart|artwork)/i;

  /* ---------- ajustes ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin espacio / privado */ } }
  };
  const EQ_FREQS = [60, 230, 910, 3600, 14000];
  const EQ_PRESETS = [
    ['flat', 'Plano', [0, 0, 0, 0, 0]], ['bass', 'Graves+', [7, 5, 1, 0, 0]], ['treble', 'Agudos+', [0, 0, 1, 4, 7]],
    ['vocal', 'Voz', [-2, 0, 4, 3, -1]], ['rock', 'Rock', [5, 3, -2, 3, 5]], ['pop', 'Pop', [-1, 2, 4, 2, -1]],
    ['edm', 'Electrónica', [6, 3, 0, 2, 5]], ['hiphop', 'Hip-hop', [6, 4, 0, 1, 3]], ['reggaeton', 'Reggaetón', [7, 4, -1, 1, 3]],
    ['latino', 'Latino', [4, 2, 1, 3, 4]], ['jazz', 'Jazz', [3, 2, -2, 2, 4]], ['classic', 'Clásica', [2, 1, 0, -2, -3]],
    ['acoustic', 'Acústico', [3, 3, 1, 2, 3]], ['loud', 'Loudness', [6, 3, -1, 2, 5]], ['lessbass', 'Menos graves', [-6, -3, 0, 0, 0]]
  ];
  const settings = Object.assign({ mix: 12, sync: true, bass: true, loop: false, view: 'disc', cutOn: false, cut: 150, eq: [0, 0, 0, 0, 0], eqPreset: 'flat' }, store.get('automix:settings', {}));
  const saveSettings = () => store.set('automix:settings', settings);

  /* ---------- audio graph ---------- */
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const bus = ctx.createGain();
  const eq = EQ_FREQS.map((f, i) => {
    const b = ctx.createBiquadFilter();
    b.type = i === 0 ? 'lowshelf' : i === 4 ? 'highshelf' : 'peaking'; b.frequency.value = f; b.Q.value = 1; b.gain.value = settings.eq[i] || 0; return b;
  });
  const pre = ctx.createGain();
  const master = ctx.createGain(); master.gain.value = 0.92;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.2;
  const analyser = ctx.createAnalyser(); analyser.fftSize = 128; analyser.smoothingTimeConstant = 0.82;
  bus.connect(eq[0]); eq.slice(1).reduce((a, b) => { a.connect(b); return b; }, eq[0]); eq[4].connect(pre);
  pre.connect(master); master.connect(comp); comp.connect(analyser); analyser.connect(ctx.destination);
  function applyEQ(instant) {
    const t = ctx.currentTime, tc = instant ? 0.001 : 0.03;
    eq.forEach((b, i) => b.gain.setTargetAtTime(settings.eq[i] || 0, t, tc));
    pre.gain.setTargetAtTime(Math.pow(10, -(Math.max(0, ...settings.eq) * 0.6) / 20), t, tc);   // evita saturar al subir bandas
  }
  applyEQ(true);

  const videosEl = $('videos');
  function makeDeck(i) {
    const el = document.createElement('video');
    el.playsInline = true; el.setAttribute('playsinline', ''); el.preload = 'auto';
    el.preservesPitch = true; el.webkitPreservesPitch = true;
    videosEl.appendChild(el);
    const src = ctx.createMediaElementSource(el);
    const shelf = ctx.createBiquadFilter(); shelf.type = 'lowshelf'; shelf.frequency.value = 220; shelf.gain.value = 0;
    const gain = ctx.createGain(); gain.gain.value = i === 0 ? 1 : 0;
    src.connect(shelf); shelf.connect(gain); gain.connect(bus);
    return { i, el, shelf, gain, yt: null, kind: 'file', m: el, track: null, loadedId: null, loadingId: null, loadP: null, glide: null, ramp: null, resumeRate: 1, lastYtVol: 0 };
  }
  const D = [makeDeck(0), makeDeck(1)];
  const setParam = (p, v) => { p.cancelScheduledValues(0); p.setValueAtTime(v, ctx.currentTime); };

  /* ---------- estado ---------- */
  let queue = [];
  let seq = 0;
  let active = 0;          // deck principal
  let curId = null;        // id de la pista principal
  let paused = true;
  let mix = null;          // {phase:'plan'|'armed'|'running', ...}
  let playTok = 0;

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
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 3000); }
  const fmt = (s) => { if (!isFinite(s) || s < 0) s = 0; const m = Math.floor(s / 60), r = Math.floor(s % 60); return m + ':' + String(r).padStart(2, '0'); };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const artOf = (t) => { if (!t) return ''; if (t.art) return t.art; if (!t._gen) t._gen = Tags.makeArt((t.artist ? t.artist + ' ' : '') + t.name, 192); return t._gen; };
  const subOf = (t) => [t.artist, t.album && t.album !== t.artist ? t.album : ''].filter(Boolean).join(' · ') || t.sub || '';

  /* ---------- biblioteca ---------- */
  let tagChain = Promise.resolve();
  function addFiles(fileList) {
    const all = Array.from(fileList || []);
    const dirImages = {};
    all.forEach((f) => {
      if (IMG_EXT.test(f.name) && f.webkitRelativePath) {
        const dir = f.webkitRelativePath.split('/').slice(0, -1).join('/');
        if (!dirImages[dir] || COVER_NAME.test(f.name)) dirImages[dir] = f;
      }
    });
    const files = all.filter((f) => /^(audio|video)\//.test(f.type) || AUDIO_EXT.test(f.name) || VIDEO_EXT.test(f.name));
    if (!files.length) { toast('No encontré audio ni video en esa selección'); return; }
    files.sort((a, b) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: 'base' }));
    let added = 0;
    for (const f of files) {
      if (queue.some((t) => t.file && t.file.name === f.name && t.file.size === f.size)) continue;
      const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/') : null;
      const dir = rel ? rel.slice(0, -1).join('/') : null;
      const isVideo = /^video\//.test(f.type) || VIDEO_EXT.test(f.name);
      const t = {
        id: ++seq, order: seq, file: f, url: URL.createObjectURL(f), kind: isVideo ? 'video' : 'audio', src: 'local',
        name: f.name.replace(/\.[^.]+$/, '').replace(/_+/g, ' ').trim(), artist: '', album: '',
        sub: rel && rel.length > 1 ? rel[rel.length - 2] : (f.name.split('.').pop() || '').toUpperCase(),
        art: null, bpm: null, firstBeat: null, status: 'new'
      };
      const c = store.get('automix:bpm:' + f.name + ':' + f.size, null);
      if (c) { t.bpm = c.bpm; t.firstBeat = c.fb; t.status = 'ready'; }
      queue.push(t); added++;
      tagChain = tagChain.then(() => readTags(t, dir && dirImages[dir])).catch(() => { });
    }
    if (added) { toast(added + (added === 1 ? ' pista agregada' : ' pistas agregadas')); scheduleAnalysis(); }
    else toast('Esas pistas ya estaban en la lista');
    render();
  }
  async function readTags(t, folderImg) {
    const md = await Tags.read(t.file);
    if (md.title) t.name = md.title;
    if (md.artist) t.artist = md.artist;
    if (md.album) t.album = md.album;
    if (md.cover) t.art = URL.createObjectURL(md.cover);
    else if (folderImg) t.art = URL.createObjectURL(folderImg);
    t._md = true; render();
    if (t.id === curId) pushMedia(t, true);
  }

  /* ---------- análisis de BPM ---------- */
  const analyzing = new Map();
  let chain = Promise.resolve();
  function analyze(t) {
    if (t.kind === 'yt' || t.status === 'ready' || t.status === 'error') return Promise.resolve();
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
      } catch (e) { /* sin BPM: igual se mezcla con crossfade simple */ }
      t.status = 'ready'; render();
      if (!queue.some((q) => q.status === 'new' || q.status === 'analyzing') && /^bpm/.test($('sortMode').value)) sortQueue();
    })().finally(() => analyzing.delete(t.id));
    analyzing.set(t.id, p);
    return p;
  }
  function scheduleAnalysis() { for (const t of queue) if (t.status === 'new') chain = chain.then(() => analyze(t)).catch(() => { }); }

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

  /* ---------- listas en línea ---------- */
  function addOnlineTracks(arr) {
    let added = 0;
    for (const x of arr) {
      if (x.ytId && queue.some((q) => q.ytId === x.ytId)) continue;
      const t = {
        id: ++seq, order: seq, kind: 'yt', src: x.src, ytId: x.ytId || null, query: x.query || null,
        name: x.name || 'Pista', artist: x.artist || '', album: x.album || '', dur: x.dur || null, needsTitle: !!x.needsTitle,
        sub: x.src === 'spotify' ? 'Spotify' : x.src === 'search' ? 'Búsqueda' : 'YouTube',
        art: x.art || (x.ytId ? 'https://i.ytimg.com/vi/' + x.ytId + '/mqdefault.jpg' : null), bpm: null, firstBeat: null, status: 'ready'
      };
      queue.push(t); added++;
      if (t.needsTitle && t.ytId) Online.oembed(t.ytId).then((o) => { if (o) { t.name = o.title; t.artist = o.author || ''; t.needsTitle = false; render(); } });
    }
    render(); return added;
  }
  async function resolveYTFor(t) {
    if (t.ytId) return;
    const key = 'automix:yt:' + (t.query || t.name), cached = store.get(key, null);
    if (cached) { t.ytId = cached; return; }
    t.status = 'resolving'; render();
    try {
      const id = await Online.resolve(t.query || t.name, t.dur, t.artist, t.name);
      if (!id) throw new Error('Sin resultados en YouTube');
      t.ytId = id; store.set(key, id);
    } finally { if (t.status === 'resolving') t.status = 'ready'; render(); }
  }
  const importBtn = $('btnImport'), importStatus = $('importStatus');
  async function runImport() {
    const raw = $('onlineText').value.trim();
    if (!raw) { importStatus.className = 'import-status err'; importStatus.textContent = 'Pega al menos un enlace o nombre de canción.'; return; }
    const lines = [];
    raw.split(/\n/).forEach((ln) => { const urls = ln.match(/https?:\/\/\S+|spotify:\S+/g); if (urls && urls.length > 1) lines.push(...urls); else if (ln.trim()) lines.push(ln.trim()); });
    importBtn.disabled = true; importStatus.className = 'import-status';
    let total = 0; const fails = [];
    for (const ln of lines) {
      try {
        const r = await Online.importLine(ln, (m) => { importStatus.textContent = m; });
        total += addOnlineTracks(r.tracks);
        importStatus.textContent = 'Agregadas ' + total + ' pistas…';
      } catch (e) {
        const hint = !Online.isNative && /Failed to fetch|NetworkError|Load failed/i.test(e.message) ? ' (en el navegador no se pueden leer listas: usa la app instalada o pega enlaces de video / nombres)' : '';
        fails.push('• ' + (ln.length > 46 ? ln.slice(0, 46) + '…' : ln) + ' → ' + e.message + hint);
      }
    }
    importBtn.disabled = false;
    importStatus.className = 'import-status' + (fails.length ? ' err' : '');
    importStatus.textContent = (total ? 'Listo: ' + total + ' pistas agregadas.' : 'No se agregó nada.') + (fails.length ? '\n' + fails.join('\n') : '');
    if (total) { scheduleAnalysis(); toast(total + ' pistas en línea agregadas'); if (!fails.length) setTimeout(() => closeSheets(), 900); }
  }

  /* ---------- decks: carga ---------- */
  function ytHooks(d) {
    return {
      onEnded() { if (d.i !== active || mix) return; const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll(); },
      onError(code) {
        const t = d.track; if (t) { markError(t); toast('YouTube no permitió reproducir: ' + t.name + ' (' + code + ')'); }
        if (d.i === active && !mix) { const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll(); }
      }
    };
  }
  function loadFile(d, t) {
    return new Promise((res, rej) => {
      const el = d.el; let to;
      if (d.yt) d.yt.pause();
      const done = (ok, err) => {
        el.removeEventListener('loadedmetadata', onOk); el.removeEventListener('error', onErr); clearTimeout(to);
        if (ok) { d.kind = 'file'; d.m = el; res(); } else rej(err || new Error('no se pudo cargar'));
      };
      const onOk = () => done(true), onErr = () => done(false, el.error);
      el.addEventListener('loadedmetadata', onOk); el.addEventListener('error', onErr);
      to = setTimeout(() => done(false, new Error('tiempo agotado')), 15000);
      el.src = t.url; el.load();
    });
  }
  async function loadYT(d, t) {
    if (!t.ytId) await resolveYTFor(t);
    if (!d.yt) d.yt = new Online.YTDeck(videosEl, ytHooks(d));
    d.el.pause();
    await d.yt.load(t.ytId, t.dur);
    d.kind = 'yt'; d.m = d.yt.media; d.yt.setVolume(0); d.lastYtVol = 0;
  }
  function loadDeck(d, t) {
    if (d.loadedId === t.id) return Promise.resolve();
    if (d.loadingId === t.id) return d.loadP;
    d.loadedId = null; d.loadingId = t.id;
    d.loadP = (t.kind === 'yt' ? loadYT(d, t) : loadFile(d, t)).then(
      () => { d.loadedId = t.id; d.loadingId = null; d.track = t; },
      (err) => { d.loadingId = null; throw err; });
    return d.loadP;
  }
  function markError(t) { t.status = 'error'; render(); }
  function preload(ni) {
    const t = queue[ni], nxt = D[1 - active];
    if (!t || nxt.loadedId === t.id || nxt.loadingId === t.id) return;
    loadDeck(nxt, t).catch(() => markError(t));
  }
  function levelSet(d, v) {
    if (d.kind === 'yt') { d.lastYtVol = v; if (d.yt) d.yt.setVolume(v); } else setParam(d.gain.gain, v);
  }
  function setVisual(d, show, secs) {
    const t = d.track, useEl = show && d.kind === 'file' && t && t.kind === 'video', useYt = show && d.kind === 'yt';
    const tr = secs > 0 ? 'opacity ' + secs + 's linear' : 'none';
    d.el.style.transition = tr; d.el.style.opacity = useEl ? 1 : 0;
    if (d.yt) { d.yt.wrap.style.transition = tr; d.yt.wrap.style.opacity = useYt ? 1 : 0; }
  }
  function stopGlide(d) { if (d.glide) { clearInterval(d.glide); d.glide = null; } }
  function startGlide(d) {
    stopGlide(d);
    if (Math.abs(d.m.playbackRate - 1) < 0.003) { d.m.playbackRate = 1; return; }
    d.glide = setInterval(() => {
      const r = d.m.playbackRate, nr = r + (1 - r) * 0.07;
      if (Math.abs(nr - 1) < 0.002) { d.m.playbackRate = 1; stopGlide(d); } else d.m.playbackRate = nr;
    }, 250);
  }
  function stopRamp(d) { if (d.ramp) { clearInterval(d.ramp.id); const f = d.ramp.done; d.ramp = null; f(false); } }
  function stopDeck(d) {
    stopRamp(d); stopGlide(d);
    try { d.el.pause(); } catch (e) { /* ignorado */ }
    if (d.yt) { d.yt.pause(); d.yt.setVolume(0); }
    setVisual(d, false, 0); setParam(d.gain.gain, 0); setParam(d.shelf.gain, 0);
  }
  function cancelMix() {
    mix = null;
    D.forEach((d) => { stopGlide(d); d.gain.gain.cancelScheduledValues(0); d.shelf.gain.cancelScheduledValues(0); });
  }

  /* ---------- frenado y arranque de disco ---------- */
  function rampRate(d, to, secs, done) {
    stopRamp(d);
    const m = d.m, from = m.playbackRate || 1, t0 = performance.now();
    if (d.kind === 'file') { d.el.preservesPitch = false; d.el.webkitPreservesPitch = false; }
    const id = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / (secs * 1000));
      m.playbackRate = from + (to - from) * p;
      if (p >= 1) { clearInterval(id); d.ramp = null; done(true); }
    }, 30);
    d.ramp = { id, done };
  }
  const rateFloor = (d) => (d.kind === 'yt' ? 0.25 : 0.07);
  function brake(d, secs) {
    return new Promise((res) => {
      if (!d.m || d.loadedId == null || d.m.paused) { res(); return; }
      d.resumeRate = Math.max(0.5, d.m.playbackRate || 1); stopGlide(d);
      rampRate(d, rateFloor(d), secs || 0.9, (ok) => { if (ok) d.m.pause(); res(); });
    });
  }
  function spinUp(d, secs) {
    if (!d.m || d.loadedId == null) return Promise.resolve();
    const target = d.resumeRate || 1;
    d.m.playbackRate = rateFloor(d);
    const p = d.m.play();
    rampRate(d, target, secs || 0.55, (ok) => {
      if (!ok) return;
      if (d.kind === 'file') { d.el.preservesPitch = true; d.el.webkitPreservesPitch = true; }
      if (Math.abs(target - 1) > 0.003) startGlide(d);
    });
    return p;
  }

  /* ---------- reproducción directa ---------- */
  async function hardPlay(index) {
    const t = queue[index]; if (!t) return;
    const tok = ++playTok;
    cancelMix(); endScratchNow();
    try { await ctx.resume(); } catch (e) { /* ignorado */ }
    const d = D[active], o = D[1 - active];
    stopDeck(o); stopDeck(d);
    curId = t.id; paused = false; render(); updatePlayIcon();
    try { await loadDeck(d, t); }
    catch (e) {
      if (tok !== playTok) return;
      markError(t); toast('No se pudo reproducir: ' + t.name);
      const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll();
      return;
    }
    if (tok !== playTok) return;
    d.resumeRate = 1; d.m.playbackRate = 1;
    if (d.kind === 'file') { d.el.preservesPitch = true; setParam(d.gain.gain, 1); setParam(d.shelf.gain, 0); }
    levelSet(d, 1);
    d.el.style.zIndex = 1; if (d.yt) d.yt.wrap.style.zIndex = 1; setVisual(d, true, 0);
    if (d.kind === 'file') d.m.currentTime = 0;
    try { await d.m.play(); } catch (e) { toast('Toca Play para iniciar'); paused = true; }
    setMediaSession(t); wake(); updatePlayIcon(); analyze(t); prepScratch(t); pushMedia(t, true);
    if (d.kind === 'yt') autoTitle(d, t);
  }
  function autoTitle(d, t) {
    if (!t.needsTitle) return;
    setTimeout(() => { const s = d.yt && d.yt.title(); if (s) { t.name = s; t.needsTitle = false; render(); } }, 1800);
  }
  function stopAll() {
    cancelMix(); D.forEach((d) => { try { d.m.pause(); } catch (e) { /* ignorado */ } setVisual(d, false, 0); });
    paused = true; updatePlayIcon(); pushMedia(null);
  }
  async function togglePlay() {
    if (!queue.length) { toast('Primero agrega música'); return; }
    if (curId == null || curIndex() < 0) { hardPlay(0); return; }
    if (!paused) {
      paused = true; updatePlayIcon(); endScratchNow();
      const ds = [D[active]]; if (mix && mix.phase === 'running') ds.push(D[1 - active]);
      pushMedia(queue[curIndex()]);
      await Promise.all(ds.map((d) => brake(d)));
    } else {
      paused = false; updatePlayIcon(); ctx.resume(); wake();
      spinUp(D[active]); if (mix && mix.phase === 'running') spinUp(D[1 - active]);
      pushMedia(queue[curIndex()]);
    }
  }
  async function stopPlayback() {
    if (curId == null) return;
    cancelMix(); endScratchNow();
    if (!paused) { paused = true; updatePlayIcon(); await Promise.all(D.map((d) => (d.loadedId != null ? brake(d) : Promise.resolve()))); }
    D.forEach((d) => { if (d.loadedId != null && d.kind === 'file') d.m.currentTime = 0; setVisual(d, false, 0); });
    const d = D[active]; if (d.loadedId != null) { setVisual(d, true, 0); levelSet(d, 1); }
    pushMedia(null);
  }

  /* ---------- el automix ---------- */
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
    const tc = cur.m.currentTime, rateC = cur.m.playbackRate || 1;
    let r = 1, synced = false;
    if (settings.sync && cur.kind === 'file' && nxt.kind === 'file' && ct && ct.bpm && nt.bpm) {
      r = (ct.bpm * rateC) / nt.bpm;
      while (r > 1.34) r /= 2;
      while (r < 0.67) r *= 2;
      if (Math.abs(r - 1) <= 0.12) synced = true; else r = 1;
    }
    const cutAt = cutPoint(cur.m.duration);
    const minDelay = !force && cutAt != null ? Math.max(0, (cutAt - tc) / rateC) : 0;
    let delay = minDelay;
    if (synced && ct.firstBeat != null) {
      const bl = 60 / ct.bpm;
      const ph = (((tc - ct.firstBeat) % bl) + bl) % bl;
      delay = (bl - ph) / rateC;
      if (delay < 0.12) delay += bl / rateC;
      while (delay < minDelay) delay += bl / rateC;
    }
    const remReal = (cur.m.duration - tc) / rateC;
    let len = force ? Math.min(settings.mix, 6) : settings.mix;
    len = Math.max(2, Math.min(len, (isFinite(remReal) ? remReal : 30) - delay - 0.25));
    nxt.m.playbackRate = r;
    if (nxt.kind === 'file') {
      nxt.el.preservesPitch = true;
      nxt.m.currentTime = synced && nt.firstBeat != null ? nt.firstBeat : 0;
      setParam(nxt.shelf.gain, synced && settings.bass ? -30 : 0);
    }
    levelSet(nxt, 0);
    nxt.el.style.zIndex = 2; if (nxt.yt) nxt.yt.wrap.style.zIndex = 2; cur.el.style.zIndex = 1; if (cur.yt) cur.yt.wrap.style.zIndex = 1;
    mix = { phase: 'armed', ni, nt, r, synced, len, t0: ctx.currentTime + delay, bpmFrom: ct ? ct.bpm * rateC : null, bpmTo: nt.bpm ? nt.bpm * r : null };
  }
  function fireMix() {
    const m = mix; if (!m || m.phase !== 'armed') return;
    m.phase = 'running';
    const cur = D[active], nxt = D[1 - active];
    nxt.m.play();
    const now = ctx.currentTime, len = m.len;
    m.end = now + len; m.startedAt = now; m.lastYt = 0;
    const N = 64, up = new Float32Array(N), dn = new Float32Array(N);
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * Math.PI / 2; up[i] = Math.sin(x); dn[i] = Math.cos(x); }
    if (cur.kind === 'file') { cur.gain.gain.cancelScheduledValues(now); cur.gain.gain.setValueCurveAtTime(dn, now, len); }
    if (nxt.kind === 'file') { nxt.gain.gain.cancelScheduledValues(now); nxt.gain.gain.setValueCurveAtTime(up, now, len); }
    if (m.synced && settings.bass) {
      const so = cur.shelf.gain, si = nxt.shelf.gain;
      so.cancelScheduledValues(now); so.setValueAtTime(0, now); so.setValueAtTime(0, now + len * 0.42); so.linearRampToValueAtTime(-30, now + len * 0.58);
      si.cancelScheduledValues(now); si.setValueAtTime(-30, now); si.setValueAtTime(-30, now + len * 0.42); si.linearRampToValueAtTime(0, now + len * 0.58);
    }
    setVisual(nxt, false, 0); void nxt.el.offsetWidth;
    setVisual(nxt, true, len); setVisual(cur, false, len);
    setMediaSession(m.nt); pushMedia(m.nt, true);
  }
  function ytMixStep() {      // el volumen de YouTube se mueve por pasos (no hay WebAudio)
    const m = mix, cur = D[active], nxt = D[1 - active];
    if (!m || m.phase !== 'running') return;
    const nowMs = performance.now(); if (nowMs - m.lastYt < 90) return; m.lastYt = nowMs;
    const p = clamp((ctx.currentTime - m.startedAt) / m.len, 0, 1), x = p * Math.PI / 2;
    if (cur.kind === 'yt') cur.yt.setVolume(Math.cos(x));
    if (nxt.kind === 'yt') nxt.yt.setVolume(Math.sin(x));
  }
  function finishMix() {
    const m = mix; if (!m) return;
    const cur = D[active], nxt = D[1 - active];
    try { cur.m.pause(); } catch (e) { /* ignorado */ }
    if (cur.kind === 'yt') cur.yt.setVolume(0); else { setParam(cur.gain.gain, 0); setParam(cur.shelf.gain, 0); }
    setVisual(cur, false, 0);
    if (nxt.kind === 'yt') nxt.yt.setVolume(1); else { setParam(nxt.gain.gain, 1); setParam(nxt.shelf.gain, 0); }
    active = 1 - active; curId = m.nt.id; mix = null;
    startGlide(D[active]);
    render(); prepScratch(m.nt); if (m.nt.kind === 'yt') autoTitle(D[active], m.nt);
  }
  function tick() {
    if (paused || curId == null || sc.on || sc.handing) return;
    const d = D[active];
    if (!mix) {
      const dur = d.m.duration, t = d.m.currentTime;
      if (!isFinite(dur) || dur <= 0 || d.m.readyState < 2 || d.m.paused) return;
      const ni = nextIndex(); if (ni < 0) return;
      const rate = d.m.playbackRate || 1, cutAt = cutPoint(dur);
      if (cutAt != null) {
        const toCut = (cutAt - t) / rate;
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
      ytMixStep();
      if (ctx.currentTime >= mix.end) finishMix();
    }
  }
  setInterval(tick, 20);
  D.forEach((d) => d.el.addEventListener('ended', () => {
    if (d.i !== active || mix || d.kind !== 'file') return;
    const ni = nextIndex(); if (ni >= 0) hardPlay(ni); else stopAll();
  }));

  /* ---------- tocadiscos / scratch ---------- */
  const sc = { on: false, handing: false, mode: null, d: null, pid: null, cx: 0, cy: 0, prevA: 0, moveT: 0, lastT: 0, rate: 1, pos: 0, wasMix: false };
  const vis = { ang: 0, rate: 0 };
  let scratchNode = null, scratchReady = false, scratchTrack = null, scratchSeq = 0;
  async function initScratch() {
    try {
      await ctx.audioWorklet.addModule('scratch-worklet.js');
      scratchNode = new AudioWorkletNode(ctx, 'scratch-proc', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      scratchNode.connect(bus);
      scratchNode.port.onmessage = (e) => { if (e.data.type === 'pos') { sc.pos = e.data.pos; sc.posT = e.data.t; sc.posRate = e.data.rate; } };
      scratchReady = true;
    } catch (e) { scratchReady = false; }
  }
  const scratchInit = initScratch();
  async function prepScratch(t) {
    await scratchInit;
    if (!scratchReady || !t || t.kind === 'yt' || scratchTrack === t.id) return;
    scratchTrack = null; scratchNode.port.postMessage({ type: 'free' });
    if (!t.file || t.file.size > 60 * 1024 * 1024) return;
    const my = ++scratchSeq;
    try {
      const ab = await new OfflineAudioContext(2, 1, ctx.sampleRate).decodeAudioData(await t.file.arrayBuffer());
      if (my !== scratchSeq || ab.duration > 12 * 60) return;
      const chs = []; for (let c = 0; c < Math.min(2, ab.numberOfChannels); c++) chs.push(ab.getChannelData(c).slice());
      scratchNode.port.postMessage({ type: 'load', ch: chs, sr: ab.sampleRate }, chs.map((c) => c.buffer));
      scratchTrack = t.id;
    } catch (e) { /* sin buffer: se usará el modo por velocidad */ }
  }
  const platterEl = $('platter'), wrapEl = $('platterWrap');
  wrapEl.addEventListener('pointerdown', (e) => {
    if (curId == null || paused || sc.on || (mix && mix.phase === 'running')) return;
    if (mix) cancelMix();
    const d = D[active]; if (d.loadedId == null) return;
    try { wrapEl.setPointerCapture(e.pointerId); } catch (er) { /* ignorado */ }
    const r = wrapEl.getBoundingClientRect();
    sc.on = true; sc.handing = false; sc.pid = e.pointerId; sc.d = d; sc.cx = r.left + r.width / 2; sc.cy = r.top + r.height / 2;
    sc.prevA = Math.atan2(e.clientY - sc.cy, e.clientX - sc.cx); sc.moveT = sc.lastT = performance.now();
    sc.rate = d.m.playbackRate || 1; stopRamp(d); stopGlide(d);
    if (d.kind === 'file' && scratchReady && scratchTrack === d.track.id) {
      sc.mode = 'worklet'; sc.pos = d.m.currentTime; d.el.pause();
      scratchNode.port.postMessage({ type: 'start', pos: sc.pos, rate: sc.rate });
    } else if (d.kind === 'file') {
      sc.mode = 'rate'; d.el.preservesPitch = false; d.el.webkitPreservesPitch = false;
    } else { sc.mode = 'yt'; brake(d, 0.5); }
    e.preventDefault();
  });
  wrapEl.addEventListener('pointermove', (e) => {
    if (!sc.on || e.pointerId !== sc.pid) return;
    const a = Math.atan2(e.clientY - sc.cy, e.clientX - sc.cx);
    let da = a - sc.prevA; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
    sc.prevA = a;
    const now = performance.now(), dt = Math.max(4, now - sc.lastT) / 1000; sc.lastT = now; sc.moveT = now;
    sc.rate += ((da / dt) / BASE_W - sc.rate) * 0.45; sc.rate = clamp(sc.rate, -8, 8);
    vis.ang += da; vis.rate = sc.rate;
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => wrapEl.addEventListener(ev, (e) => { if (sc.on && e.pointerId === sc.pid) releaseScratch(); }));
  function applyScratchRate() {
    if (sc.mode === 'worklet') scratchNode.port.postMessage({ type: 'rate', rate: sc.rate });
    else if (sc.mode === 'rate') {
      const d = sc.d, r = sc.rate;
      d.m.playbackRate = clamp(Math.abs(r), 0.07, 4);
      setParam(d.gain.gain, r > 0.1 ? 1 : 0);
    }
  }
  setInterval(() => {
    if (!sc.on) return;
    const now = performance.now();
    if (now - sc.moveT > 50) sc.rate *= 0.6;          // dedo quieto = disco sujeto
    if (Math.abs(sc.rate) < 0.01) sc.rate = 0;
    vis.rate = sc.rate; applyScratchRate();
  }, 16);
  function releaseScratch() {
    if (!sc.on) return;
    sc.on = false; const d = sc.d;
    if (sc.mode === 'worklet') {
      sc.handing = true;
      scratchNode.port.postMessage({ type: 'rate', rate: 1, motor: true });
      setTimeout(() => handoff(d), 220);
    } else if (sc.mode === 'rate') {
      setParam(d.gain.gain, 1);
      d.resumeRate = 1; rampRate(d, 1, 0.35, (ok) => { if (ok) { d.el.preservesPitch = true; d.el.webkitPreservesPitch = true; } });
    } else { spinUp(d, 0.5); }
  }
  async function handoff(d) {       // pasa del motor de scratch al elemento de audio sin salto
    if (sc.on || !sc.handing) return;
    const el = d.el, wpos = () => sc.pos + (sc.posRate || 1) * (ctx.currentTime - (sc.posT || ctx.currentTime));   // posición real del scratch ahora
    el.playbackRate = 1; el.preservesPitch = true; setParam(d.gain.gain, 0);
    try { el.currentTime = Math.min((el.duration || 1e9) - 0.2, wpos() + 0.25); await el.play(); } catch (e) { /* ignorado */ }
    let tries = 0;
    const settle = () => {
      if (sc.on || !sc.handing) return;
      const diff = el.currentTime - wpos();            // >0: el elemento va adelantado
      if (Math.abs(diff) < 0.02 || ++tries > 5) {
        d.gain.gain.setTargetAtTime(1, ctx.currentTime, 0.012);
        scratchNode.port.postMessage({ type: 'stop' });
        sc.lastHandDiff = diff; setTimeout(() => { sc.handing = false; }, 80);
      } else { try { el.currentTime = Math.max(0, el.currentTime - diff); } catch (e) { /* ignorado */ } setTimeout(settle, 110); }
    };
    setTimeout(settle, 60);
  }
  function endScratchNow() {
    if (!sc.on && !sc.handing) return;
    const d = sc.d; sc.on = false; sc.handing = false;
    if (scratchReady) scratchNode.port.postMessage({ type: 'stop' });
    if (d) { d.el.preservesPitch = true; setParam(d.gain.gain, 1); }
  }

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
    if (D[active].m.currentTime > 3 || i === 0) { if (!mix && D[active].kind === 'file') D[active].m.currentTime = 0; else if (!mix) D[active].m.currentTime = 0; return; }
    hardPlay(i - 1);
  };
  $('progress').addEventListener('pointerdown', (e) => {
    if (mix || curId == null) return;
    const m = D[active].m, r = e.currentTarget.getBoundingClientRect();
    if (isFinite(m.duration)) m.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * m.duration;
  });
  $('btnFiles').onclick = () => $('inFiles').click();
  $('btnFolder').onclick = () => $('inFolder').click();
  $('inFiles').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('inFolder').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
  $('btnClear').onclick = () => {
    if (!queue.length) return;
    stopAll(); D.forEach((d) => { d.el.removeAttribute('src'); d.el.load(); if (d.yt) d.yt.pause(); d.loadedId = null; d.track = null; });
    queue.forEach((t) => { if (t.url) URL.revokeObjectURL(t.url); }); queue = []; curId = null; scratchTrack = null; render();
  };
  $('sortMode').onchange = sortQueue;
  $('btnSettings').onclick = () => { const s = $('settings'); s.hidden = !s.hidden; };
  $('list').addEventListener('click', (e) => {
    const li = e.target.closest('.item'); if (!li) return;
    const id = +li.dataset.id, i = queue.findIndex((t) => t.id === id);
    if (i < 0) return;
    if (e.target.closest('.rm')) {
      if (id === curId || (mix && mix.nt && mix.nt.id === id)) return toast('No puedes quitar la pista que está sonando');
      if (queue[i].url) URL.revokeObjectURL(queue[i].url);
      D.forEach((d) => { if (d.loadedId === id) d.loadedId = null; });
      queue.splice(i, 1); render(); return;
    }
    if (queue[i].status === 'error') queue[i].status = 'ready';
    hardPlay(i);
  });
  const mixLen = $('mixLen');
  mixLen.value = settings.mix; $('mixVal').textContent = settings.mix + ' s';
  mixLen.oninput = () => { settings.mix = +mixLen.value; $('mixVal').textContent = settings.mix + ' s'; saveSettings(); };
  [['optSync', 'sync'], ['optBass', 'bass'], ['optLoop', 'loop']].forEach(([id, key]) => {
    const el = $(id); el.checked = !!settings[key];
    el.onchange = () => { settings[key] = el.checked; saveSettings(); };
  });
  const fmtMin = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const cutLen = $('cutLen'), optCut = $('optCut');
  cutLen.value = settings.cut; optCut.checked = !!settings.cutOn;
  const applyCut = () => { $('cutVal').textContent = fmtMin(settings.cut); $('cutRow').hidden = !settings.cutOn; };
  cutLen.oninput = () => { settings.cut = +cutLen.value; applyCut(); saveSettings(); };
  optCut.onchange = () => { settings.cutOn = optCut.checked; applyCut(); saveSettings(); };
  applyCut();

  /* vista disco / video */
  function applyView() {
    $('stage').dataset.view = settings.view;
    document.querySelectorAll('.view-toggle button').forEach((b) => b.classList.toggle('on', b.dataset.view === settings.view));
  }
  document.querySelectorAll('.view-toggle button').forEach((b) => { b.onclick = () => { settings.view = b.dataset.view; saveSettings(); applyView(); }; });
  applyView();

  /* ecualizador */
  const presetsEl = $('eqPresets'), bandsEl = $('eqBands');
  const fmtHz = (f) => (f >= 1000 ? f / 1000 + ' kHz' : f + ' Hz');
  presetsEl.innerHTML = EQ_PRESETS.map((p) => '<button class="chip" data-p="' + p[0] + '">' + p[1] + '</button>').join('');
  bandsEl.innerHTML = EQ_FREQS.map((f, i) => '<div class="band"><span class="db" id="db' + i + '"></span><input type="range" min="-12" max="12" step="0.5" data-b="' + i + '" aria-label="' + fmtHz(f) + '"><span class="hz">' + fmtHz(f) + '</span></div>').join('');
  function syncEqUI() {
    bandsEl.querySelectorAll('input').forEach((inp) => { const i = +inp.dataset.b; inp.value = settings.eq[i]; $('db' + i).textContent = (settings.eq[i] > 0 ? '+' : '') + settings.eq[i]; });
    presetsEl.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.p === settings.eqPreset));
  }
  presetsEl.addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    const p = EQ_PRESETS.find((x) => x[0] === c.dataset.p); settings.eq = p[2].slice(); settings.eqPreset = p[0];
    saveSettings(); applyEQ(); syncEqUI();
  });
  bandsEl.addEventListener('input', (e) => {
    const inp = e.target.closest('input'); if (!inp) return;
    settings.eq[+inp.dataset.b] = +inp.value; settings.eqPreset = 'custom';
    saveSettings(); applyEQ(); syncEqUI();
  });
  syncEqUI();

  /* hojas */
  function openSheet(id) { closeSheets(); $(id).hidden = false; }
  function closeSheets() { document.querySelectorAll('.sheet').forEach((s) => { s.hidden = true; }); }
  document.querySelectorAll('.sheet').forEach((s) => s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) closeSheets(); }));
  $('btnEq').onclick = () => openSheet('eqSheet');
  $('btnOnline').onclick = () => { openSheet('onlineSheet'); importStatus.textContent = ''; importStatus.className = 'import-status'; };
  $('btnImport').onclick = runImport;
  $('btnPasteClip').onclick = async () => { try { $('onlineText').value = (await navigator.clipboard.readText()) || $('onlineText').value; } catch (e) { toast('Pega con mantener pulsado en el cuadro de texto'); } };

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
        : t.status === 'resolving' ? '<span class="bpm ana">buscando</span>'
        : t.status === 'analyzing' ? '<span class="bpm ana">analizando</span>'
        : t.status === 'new' ? '<span class="bpm ana">en cola</span>'
        : '<span class="bpm">' + (t.bpm ? t.bpm.toFixed(1) + ' BPM' : '— BPM') + '</span>';
      const v = t.kind === 'video' ? '<span class="vtag"><svg><use href="#i-video"/></svg>video</span>' : t.kind === 'yt' ? '<span class="vtag"><svg><use href="#i-video"/></svg>' + esc(t.sub) + '</span>' : '';
      const sub = t.kind === 'yt' ? esc(t.artist || '') : esc(subOf(t));
      return '<li class="' + cls + '" data-id="' + t.id + '"><div class="art" style="background-image:url(\'' + esc(artOf(t)) + '\')"><em>' + (t.id === curId ? '▶' : i + 1) + '</em></div>' +
        '<div class="t"><b>' + esc(t.name) + '</b><small>' + sub + v + '</small></div>' + chip +
        '<button class="rm" aria-label="Quitar"><svg><use href="#i-x"/></svg></button></li>';
    }).join('');
    $('empty').hidden = queue.length > 0;
    $('qCount').textContent = queue.length;
  }

  const cache = {};
  const setText = (id, v) => { if (cache[id] !== v) { cache[id] = v; $(id).textContent = v; } };
  const setBg = (id, url) => { if (cache['bg' + id] !== url) { cache['bg' + id] = url; $(id).style.backgroundImage = url ? 'url("' + url + '")' : 'none'; } };
  const vizC = $('viz'), vctx = vizC.getContext('2d'), fq = new Uint8Array(analyser.frequencyBinCount);
  function sizeViz() { const r = vizC.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; vizC.width = r.width * dpr; vizC.height = r.height * dpr; }
  window.addEventListener('resize', sizeViz); sizeViz();
  const CA = [77, 155, 255], CB = [52, 217, 133];     // azul · verde
  let lastTs = 0;

  function frame(ts) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0.016); lastTs = ts;
    if (document.hidden) return;
    const d = D[active], o = D[1 - active];
    const running = mix && mix.phase === 'running';
    let pos = active === 0 ? 0 : 1;
    if (running) { const prog = clamp((ctx.currentTime - mix.startedAt) / mix.len, 0, 1); pos = active === 0 ? prog : 1 - prog; }
    const col = CA.map((v, k) => Math.round(v + (CB[k] - v) * pos));

    // plato
    if (!sc.on) {
      let target = 0;
      if (sc.handing) target = 1;
      else if (curId != null && d.loadedId != null && !d.m.paused) target = d.m.playbackRate || 1;
      vis.rate += (target - vis.rate) * Math.min(1, dt * 10);
      vis.ang += vis.rate * BASE_W * dt;
    }
    platterEl.style.transform = 'rotate(' + vis.ang + 'rad)';
    wrapEl.style.setProperty('--c', 'rgb(' + col.join(',') + ')');
    const tA = D[0].loadedId != null ? D[0].track : null, tB = D[1].loadedId != null ? D[1].track : null;
    setBg('artA', tA ? artOf(tA) : ''); setBg('artB', tB ? artOf(tB) : '');
    $('artA').style.opacity = tA ? (1 - pos) : 0; $('artB').style.opacity = tB ? pos : 0;
    setBg('dartA', tA ? artOf(tA) : ''); setBg('dartB', tB ? artOf(tB) : '');
    const cur = queue[curIndex()];
    setBg('backdrop', cur ? artOf(cur) : '');

    for (const x of D) {
      const live = x === d || (running && x === o);
      $(x.i ? 'deckB' : 'deckA').classList.toggle('live', !!live && !paused);
      const t = x.loadedId != null ? x.track : null;
      const rate = x.m.playbackRate || 1;
      setText(x.i ? 'nameB' : 'nameA', t ? t.name : '—');
      setText(x.i ? 'bpmB' : 'bpmA', t && t.bpm ? (t.bpm * (x === d || running ? rate : 1)).toFixed(1) + ' BPM' : t && t.kind === 'yt' ? 'en línea' : '— BPM');
    }
    $('xfKnob').style.left = (pos * 100) + '%';
    setText('xfLabel', mix ? (mix.synced ? 'SYNC' : 'FADE') : '');

    if (running) {
      setText('npLabel', 'Mezclando' + (mix.synced && mix.bpmFrom && mix.bpmTo ? ' · ' + mix.bpmFrom.toFixed(0) + ' → ' + mix.bpmTo.toFixed(0) + ' BPM' : ''));
      setText('npTitle', (d.track ? d.track.name : '') + '  →  ' + mix.nt.name);
      setText('npSub', '');
    } else {
      setText('npLabel', cur ? (sc.on ? 'Scratch' : paused ? 'En pausa' : 'Reproduciendo') : 'Sin reproducción');
      setText('npTitle', cur ? cur.name : 'Agrega música para empezar');
      setText('npSub', cur ? subOf(cur) : '');
    }
    const dur = d.m.duration;
    let t = d.m.currentTime;
    if ((sc.on || sc.handing) && sc.mode === 'worklet') t = sc.pos;
    if (curId != null && isFinite(dur) && dur > 0) {
      $('progressFill').style.width = clamp(t / dur * 100, 0, 100) + '%';
      setText('tCur', fmt(t)); setText('tTot', fmt(dur));
    } else { $('progressFill').style.width = '0%'; setText('tCur', '0:00'); setText('tTot', '0:00'); }
    const cm = $('cutMark'), cp = curId != null ? cutPoint(dur) : null;
    if (cp != null) { cm.hidden = false; cm.style.left = (cp / dur * 100) + '%'; } else cm.hidden = true;
    setText('hint', mix ? (mix.phase === 'plan' ? 'Preparando mezcla…' : mix.phase === 'armed' ? 'Esperando el golpe…' : 'Mezcla en curso')
      : queue.length ? 'Gira el disco para scratch · ▸▸ mezcla ahora' : 'Agrega una carpeta, archivos o una lista en línea');

    if (settings.view === 'disc') {
      const w = vizC.width, h = vizC.height;
      vctx.clearRect(0, 0, w, h);
      if (!paused) analyser.getByteFrequencyData(fq); else fq.fill(0);
      const bars = 32, bw = w / bars;
      vctx.fillStyle = 'rgba(' + col.join(',') + ',0.5)';
      for (let i = 0; i < bars; i++) {
        const v = fq[Math.min(fq.length - 1, Math.floor(i * 1.6))] / 255, bh = Math.max(2, v * v * h * 0.55);
        vctx.fillRect(i * bw + bw * 0.18, h - bh, bw * 0.64, bh);
      }
    }
  }
  requestAnimationFrame(frame);

  /* ---------- sistema: notificación, teclas multimedia, segundo plano ---------- */
  const Cap = window.Capacitor, isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());
  const MC = isNative ? Cap.registerPlugin('MediaControls') : null;
  const desktop = window.MixDesktop || null;
  const artSent = new Map(); let lastMediaId = null;
  async function mediaArt(t) {
    if (artSent.has(t.id)) return artSent.get(t.id);
    let url = artOf(t), data = null;
    if (/^(blob:|https?:)/.test(url)) data = await Tags.thumb(url, 256);
    if (!data) data = Tags.makeArt((t.artist ? t.artist + ' ' : '') + t.name, 256);
    artSent.set(t.id, data); return data;
  }
  async function pushMedia(t, trackChanged) {
    if (!MC && !desktop) return;
    if (!t) { if (MC) MC.hide().catch(() => { }); lastMediaId = null; return; }
    const i = queue.findIndex((q) => q.id === t.id);
    const info = { title: t.name, artist: t.artist || t.sub || '', album: t.album || '', playing: !paused, position: 0, duration: 0, canPrev: i > 0, canNext: nextIndex() >= 0, art: '' };
    const dk = D.find((x) => x.loadedId === t.id);
    if (dk) { info.position = Math.round((dk.m.currentTime || 0) * 1000); const du = dk.m.duration; info.duration = isFinite(du) ? Math.round(du * 1000) : 0; }
    if (MC) {
      if (trackChanged || lastMediaId !== t.id) { info.art = ((await mediaArt(t)) || '').split(',')[1] || ''; }
      lastMediaId = t.id;
      MC.update(info).catch(() => { });
    }
    if (desktop && desktop.setPlaying) desktop.setPlaying(info.playing);
  }
  function handleAction(a) {
    switch (a) {
      case 'play': if (paused) togglePlay(); break;
      case 'pause': if (!paused) togglePlay(); break;
      case 'toggle': togglePlay(); break;
      case 'next': $('btnNext').click(); break;
      case 'prev': $('btnPrev').click(); break;
      case 'stop': stopPlayback(); break;
    }
  }
  if (MC) MC.addListener('action', (e) => handleAction(e.action));
  if (desktop && desktop.onMedia) desktop.onMedia(handleAction);

  let lock = null;
  async function wake() { try { if (navigator.wakeLock && !lock) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch (e) { /* no disponible */ } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !paused && !isNative) wake(); });
  function setMediaSession(t) {
    if (!('mediaSession' in navigator)) return;
    try {
      const art = t.art && !/^blob:/.test(t.art) ? [{ src: t.art }] : [];
      navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artist || 'Mix up-ear', album: t.album || t.sub, artwork: art });
      const set = (k, f) => { try { navigator.mediaSession.setActionHandler(k, f); } catch (e) { /* no soportado */ } };
      set('play', () => handleAction('play')); set('pause', () => handleAction('pause'));
      set('nexttrack', () => handleAction('next')); set('previoustrack', () => handleAction('prev')); set('stop', () => handleAction('stop'));
    } catch (e) { /* ignorado */ }
  }
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol) && !desktop && !isNative) navigator.serviceWorker.register('sw.js').catch(() => { });

  // utilidades para pruebas automáticas
  window.__automix = {
    get state() { return { active, curId, paused, scratch: { on: sc.on, handing: sc.handing, mode: sc.mode, pos: sc.pos, rate: sc.rate, handDiff: sc.lastHandDiff }, scratchReady, scratchTrack, vis: { ang: vis.ang, rate: vis.rate }, eq: settings.eq.slice(), eqPreset: settings.eqPreset, mix: mix && { phase: mix.phase, synced: mix.synced, len: mix.len, r: mix.r }, queue: queue.map((t) => ({ id: t.id, name: t.name, artist: t.artist, album: t.album, art: !!t.art, kind: t.kind, ytId: t.ytId, bpm: t.bpm, fb: t.firstBeat, status: t.status })) }; },
    D, ctx, eq, handleAction, addOnlineTracks, settings, pre, bus
  };

  render(); updatePlayIcon();
})();
