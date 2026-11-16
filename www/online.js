/* Fuentes en línea: listas de YouTube y Spotify + reproductor de YouTube (IFrame API).
 * - Spotify se lee de la página pública "embed" y cada pista se reproduce con su equivalente de YouTube.
 * - Las peticiones salen por el motor nativo (Capacitor / Electron) para evitar CORS. */
(function (root) {
  'use strict';
  var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  var cap = root.Capacitor;
  var isCap = !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  var desk = root.MixDesktop || null;
  var httpImpl = null;

  async function defaultHttp(method, url, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'User-Agent': UA, 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.7', 'Cookie': 'CONSENT=YES+1' }, opts.headers || {});
    if (desk && desk.http) return desk.http({ method: method, url: url, headers: headers, json: opts.json || null });
    if (isCap) {
      var H = cap.registerPlugin('CapacitorHttp');
      var r = await H.request({ url: url, method: method, headers: opts.json ? Object.assign({ 'Content-Type': 'application/json' }, headers) : headers, data: opts.json || undefined, responseType: 'text' });
      if (r.status >= 400) throw new Error('HTTP ' + r.status);
      return typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    }
    var res = await fetch(url, { method: method, headers: opts.json ? { 'Content-Type': 'application/json' } : undefined, body: opts.json ? JSON.stringify(opts.json) : undefined });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.text();
  }
  function http(method, url, opts) { return (httpImpl || defaultHttp)(method, url, opts); }

  /* ---------- utilidades de parseo ---------- */
  function extractJSON(html, marker) {
    var i = html.indexOf(marker); if (i < 0) return null;
    i = html.indexOf('{', i); if (i < 0) return null;
    var depth = 0, inStr = false, esc = false;
    for (var j = i; j < html.length; j++) {
      var c = html[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { try { return JSON.parse(html.slice(i, j + 1)); } catch (e) { return null; } } }
    }
    return null;
  }
  function walk(o, fn) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) walk(o[i], fn); return; }
    fn(o);
    for (var k in o) walk(o[k], fn);
  }
  function txt(x) {
    if (!x) return '';
    if (typeof x === 'string') return x;
    if (x.simpleText) return x.simpleText;
    if (x.content) return x.content;
    if (x.runs) return x.runs.map(function (r) { return r.text; }).join('');
    return '';
  }
  function secs(s) {
    if (!s) return 0; var p = String(s).split(':').map(Number); if (p.some(isNaN)) return 0;
    return p.reduce(function (a, v) { return a * 60 + v; }, 0);
  }

  /* ---------- YouTube: páginas ---------- */
  function ytItems(data) {
    var items = [], seen = {}, token = null;
    walk(data, function (o) {
      var v = o.playlistVideoRenderer || o.videoRenderer;
      if (v && v.videoId && !seen[v.videoId]) {
        seen[v.videoId] = 1;
        items.push({ id: v.videoId, title: txt(v.title), channel: txt(v.shortBylineText || v.longBylineText || v.ownerText), dur: +v.lengthSeconds || secs(txt(v.lengthText)) });
      }
      var l = o.lockupViewModel;
      if (l && l.contentId && /VIDEO/.test(l.contentType || '') && !seen[l.contentId]) {
        seen[l.contentId] = 1;
        var md = (l.metadata && l.metadata.lockupMetadataViewModel) || {}, dur = 0;
        walk(l, function (x) { if (x.thumbnailBadgeViewModel && !dur) dur = secs(txt(x.thumbnailBadgeViewModel.text)); });
        items.push({ id: l.contentId, title: txt(md.title), channel: '', dur: dur });
      }
      var c = o.continuationItemRenderer;
      if (c && c.continuationEndpoint && c.continuationEndpoint.continuationCommand) token = c.continuationEndpoint.continuationCommand.token;
    });
    return { items: items, token: token };
  }
  async function ytPlaylist(listId, progress) {
    var html = await http('GET', 'https://www.youtube.com/playlist?list=' + listId + '&hl=es&gl=MX');
    var data = extractJSON(html, 'var ytInitialData') || extractJSON(html, 'ytInitialData');
    if (!data) throw new Error('YouTube no devolvió la lista');
    var title = '';
    walk(data, function (o) { if (!title && o.playlistMetadataRenderer) title = o.playlistMetadataRenderer.title; });
    var r = ytItems(data), all = r.items.slice(), token = r.token;
    var ver = (/"INNERTUBE_CLIENT_VERSION":"([\d.]+)"/.exec(html) || [])[1] || '2.20250101.00.00';
    var key = (/"INNERTUBE_API_KEY":"([^"]+)"/.exec(html) || [])[1];
    for (var n = 0; token && n < 8 && all.length < 800; n++) {
      if (progress) progress('Leyendo lista… ' + all.length);
      try {
        var raw = await http('POST', 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false' + (key ? '&key=' + key : ''),
          { json: { context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'es', gl: 'MX' } }, continuation: token } });
        var more = ytItems(JSON.parse(raw)); token = more.token;
        var have = {}; all.forEach(function (x) { have[x.id] = 1; });
        more.items.forEach(function (x) { if (!have[x.id]) all.push(x); });
        if (!more.items.length) break;
      } catch (e) { break; }
    }
    if (!all.length) throw new Error('La lista está vacía o es privada');
    return { title: title, items: all };
  }
  async function ytSearch(q) {
    var html = await http('GET', 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q) + '&sp=EgIQAQ%253D%253D&hl=es&gl=MX');
    var data = extractJSON(html, 'var ytInitialData') || extractJSON(html, 'ytInitialData');
    return data ? ytItems(data).items : [];
  }
  async function oembed(id) {
    try {
      var j = JSON.parse(await http('GET', 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id)));
      return { title: j.title, author: j.author_name };
    } catch (e) { return null; }
  }

  /* elegir el mejor resultado de YouTube para una canción */
  function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function score(c, want) {
    var ct = norm(c.title), cc = norm(c.channel), wt = norm(want.title), wa = norm(want.artist), s = 0;
    if (want.dur && c.dur) { var d = Math.abs(c.dur - want.dur); s += d <= 3 ? 40 : d <= 8 ? 25 : d <= 20 ? 8 : d <= 45 ? -10 : -35; }
    if (wt && ct.indexOf(wt) >= 0) s += 25;
    else if (wt) { var toks = wt.split(' ').filter(function (x) { return x.length > 2; }); if (toks.length) s += 20 * toks.filter(function (x) { return ct.indexOf(x) >= 0; }).length / toks.length; }
    if (wa && (ct.indexOf(wa) >= 0 || cc.indexOf(wa) >= 0)) s += 15;
    if (/topic$|vevo|official/.test(cc)) s += 10;
    if (/official audio|audio oficial|audio|letra|lyrics/.test(ct)) s += 5;
    var bad = /\b(live|en vivo|cover|karaoke|reaction|tutorial|slowed|sped up|nightcore|8d)\b/;
    if (bad.test(ct) && !bad.test(wt + ' ' + wa)) s -= 25;
    return s;
  }
  async function resolve(query, dur, artist, title) {
    var items = await ytSearch(query);
    if (!items.length) return null;
    var want = { title: title || query, artist: artist || '', dur: dur || 0 }, best = null, bs = -1e9;
    items.slice(0, 10).forEach(function (c) { var s = score(c, want); if (s > bs) { bs = s; best = c; } });
    return best ? best.id : null;
  }

  /* ---------- Spotify (página embed pública) ---------- */
  function parseSpotify(s) {
    var m = /open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track)\/([A-Za-z0-9]{22})/.exec(s) || /spotify:(playlist|album|track):([A-Za-z0-9]{22})/.exec(s);
    return m ? { type: m[1], id: m[2] } : null;
  }
  async function spotifyFetch(ref) {
    var html = await http('GET', 'https://open.spotify.com/embed/' + ref.type + '/' + ref.id);
    var m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
    if (!m) throw new Error('Spotify no devolvió datos (¿la lista es pública?)');
    var data = JSON.parse(m[1]), entity = null, tracks = [], art = '', name = '';
    walk(data, function (o) {
      if (!entity && o.entity && typeof o.entity === 'object') entity = o.entity;
    });
    if (entity) {
      name = entity.name || entity.title || '';
      var srcs = (entity.coverArt && entity.coverArt.sources) || (entity.visualIdentity && entity.visualIdentity.image) || [];
      if (srcs.length) art = (srcs[srcs.length > 1 ? 1 : 0] || srcs[0]).url || '';
    }
    var seen = {};
    walk(data, function (o) {
      if (typeof o.uri === 'string' && /^spotify:track:/.test(o.uri) && (o.title || o.name) && !seen[o.uri]) {
        seen[o.uri] = 1;
        var artists = o.subtitle || (o.artists ? o.artists.map(function (a) { return a.name; }).join(', ') : '');
        tracks.push({ name: o.title || o.name, artist: String(artists).replace(/ /g, ' '), dur: o.duration ? Math.round(o.duration / 1000) : 0, uri: o.uri });
      }
    });
    if (!tracks.length && entity && ref.type === 'track') {
      tracks.push({ name: entity.name || entity.title, artist: entity.artists ? entity.artists.map(function (a) { return a.name; }).join(', ') : (entity.subtitle || ''), dur: entity.duration ? Math.round(entity.duration / 1000) : 0 });
    }
    if (!tracks.length) throw new Error('No encontré canciones (¿la lista es pública?)');
    return { name: name, art: art, tracks: tracks };
  }

  /* ---------- entrada del usuario ---------- */
  function ytVideoId(s) {
    var m = /(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/.exec(s);
    return m ? m[1] : null;
  }
  async function importLine(line, progress) {
    line = line.trim(); progress = progress || function () { };
    var sp = parseSpotify(line);
    if (sp) {
      progress('Leyendo Spotify…');
      var r = await spotifyFetch(sp);
      return { label: r.name || 'Spotify', tracks: r.tracks.map(function (t) { return { src: 'spotify', name: t.name, artist: t.artist, album: r.name, dur: t.dur, art: r.art, query: (t.artist ? t.artist + ' - ' : '') + t.name }; }) };
    }
    var list = /[?&]list=([\w-]+)/.exec(line);
    if (list && /youtu/.test(line)) {
      progress('Leyendo lista de YouTube…');
      try {
        var p = await ytPlaylist(list[1], progress);
        return { label: p.title || 'YouTube', tracks: p.items.map(function (x) { return { src: 'youtube', ytId: x.id, name: x.title, artist: x.channel.replace(/ - Topic$/, ''), dur: x.dur, album: p.title }; }) };
      } catch (e) {
        // respaldo: pedirle los IDs al propio reproductor de YouTube
        progress('Probando por el reproductor de YouTube…');
        var ids = await playlistViaPlayer(list[1]);
        if (!ids.length) throw e;
        return { label: 'YouTube', tracks: ids.map(function (id, i) { return { src: 'youtube', ytId: id, name: 'Video ' + (i + 1), artist: '', needsTitle: true }; }) };
      }
    }
    var vid = /youtu/.test(line) ? ytVideoId(line) : null;
    if (vid) {
      var o = await oembed(vid);
      return { label: 'YouTube', tracks: [{ src: 'youtube', ytId: vid, name: (o && o.title) || 'Video de YouTube', artist: (o && o.author) || '' }] };
    }
    if (/^https?:\/\//i.test(line)) throw new Error('Enlace no reconocido');
    return { label: 'Búsqueda', tracks: [{ src: 'search', name: line, artist: '', query: line }] };
  }

  /* ---------- API del reproductor de YouTube ---------- */
  var apiP = null;
  function apiReady() {
    if (apiP) return apiP;
    apiP = new Promise(function (res, rej) {
      if (root.YT && root.YT.Player) return res();
      var s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = function () { apiP = null; rej(new Error('Sin conexión con YouTube')); };
      var prev = root.onYouTubeIframeAPIReady;
      root.onYouTubeIframeAPIReady = function () { if (prev) prev(); res(); };
      document.head.appendChild(s);
      setTimeout(function () { if (!(root.YT && root.YT.Player)) { apiP = null; rej(new Error('YouTube tardó demasiado')); } }, 15000);
    });
    return apiP;
  }
  function embedSrc(videoId, extra) {
    var o = encodeURIComponent(root.location.origin);
    return 'https://www.youtube.com/embed/' + (videoId || '') + '?enablejsapi=1&playsinline=1&controls=0&disablekb=1&fs=0&rel=0&modestbranding=1&iv_load_policy=3&origin=' + o + '&widget_referrer=' + o + (extra || '');
  }
  function makeFrame(src) {
    var f = document.createElement('iframe');
    f.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.src = src; return f;
  }
  async function playlistViaPlayer(listId) {
    await apiReady();
    return new Promise(function (res) {
      var holder = document.createElement('div'); holder.style.cssText = 'position:fixed;left:-9999px;width:320px;height:200px';
      document.body.appendChild(holder);
      var f = makeFrame(embedSrc('', '&listType=playlist&list=' + encodeURIComponent(listId))); holder.appendChild(f);
      var done = false, p;
      function finish(ids) { if (done) return; done = true; try { p.destroy(); } catch (e) { } holder.remove(); res(ids || []); }
      p = new root.YT.Player(f, { events: { onReady: function () {
        var tries = 0, iv = setInterval(function () {
          var ids = null; try { ids = p.getPlaylist(); } catch (e) { }
          if (ids && ids.length) { clearInterval(iv); finish(ids); } else if (++tries > 30) { clearInterval(iv); finish([]); }
        }, 400);
      }, onError: function () { finish([]); } } });
      setTimeout(function () { finish([]); }, 20000);
    });
  }

  /* Un "deck" de YouTube: iframe + adaptador con la misma forma que <video> */
  function YTDeck(container, hooks) {
    var self = this;
    this.hooks = hooks || {};
    this.wrap = document.createElement('div'); this.wrap.className = 'ytwrap'; container.appendChild(this.wrap);
    this.player = null; this.ready = false; this.state = -1; this.videoId = null; this._wait = null; this.fallbackDur = 0;
    var P = function () { return self.player; };
    this.media = {
      get currentTime() { try { return (P() && P().getCurrentTime()) || 0; } catch (e) { return 0; } },
      set currentTime(v) { try { P().seekTo(v, true); } catch (e) { } },
      get duration() { try { var d = P() && P().getDuration(); return d > 0 ? d : (self.fallbackDur || NaN); } catch (e) { return NaN; } },
      get playbackRate() { try { return P().getPlaybackRate() || 1; } catch (e) { return 1; } },
      set playbackRate(v) {
        try {
          var rates = P().getAvailablePlaybackRates() || [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], b = rates[0];
          rates.forEach(function (r) { if (Math.abs(r - v) < Math.abs(b - v)) b = r; });
          P().setPlaybackRate(b);
        } catch (e) { }
      },
      get readyState() { return self.ready ? 4 : 0; },
      get paused() { return self.state !== 1 && self.state !== 3; },
      play: function () { try { P().playVideo(); } catch (e) { } return Promise.resolve(); },
      pause: function () { try { P().pauseVideo(); } catch (e) { } }
    };
  }
  YTDeck.prototype.setVolume = function (v) { try { if (this.player && this.ready) this.player.setVolume(Math.round(Math.max(0, Math.min(1, v)) * 100)); } catch (e) { } };
  YTDeck.prototype.pause = function () { this.media.pause(); };
  YTDeck.prototype.title = function () { try { var d = this.player.getVideoData(); return d && d.title; } catch (e) { return ''; } };
  YTDeck.prototype._st = function (s) {
    this.state = s;
    if (s === 5 && this._wait) this._wait(true);
    if (s === 0 && this.hooks.onEnded) this.hooks.onEnded();
  };
  YTDeck.prototype._err = function (c) {
    if (this._wait) this._wait(false, new Error('YouTube ' + c));
    else if (this.hooks.onError) this.hooks.onError(c);
  };
  YTDeck.prototype.load = async function (videoId, dur) {
    var self = this;
    await apiReady();
    this.fallbackDur = dur || 0;
    return new Promise(function (resolve, reject) {
      var to = setTimeout(function () { done(false, new Error('tiempo agotado')); }, 20000);
      function done(ok, err) { clearTimeout(to); self._wait = null; ok ? resolve() : reject(err); }
      self._wait = done; self.ready = self.ready && !!self.player;
      if (!self.player) {
        var f = makeFrame(embedSrc(videoId)); self.wrap.appendChild(f);
        self.player = new root.YT.Player(f, { events: {
          onReady: function () { self.ready = true; self.videoId = videoId; self.setVolume(0); done(true); },
          onStateChange: function (e) { self._st(e.data); },
          onError: function (e) { self._err(e.data); }
        } });
      } else {
        self.videoId = videoId; self.state = -1;
        self.player.cueVideoById({ videoId: videoId, startSeconds: 0 });
      }
    });
  };

  root.Online = {
    isNative: isCap || !!desk, http: http, setHttp: function (f) { httpImpl = f; },
    importLine: importLine, resolve: resolve, ytSearch: ytSearch, oembed: oembed, parseSpotify: parseSpotify,
    _ytItems: ytItems, _extractJSON: extractJSON, _score: score, YTDeck: YTDeck, apiReady: apiReady, ytVideoId: ytVideoId
  };
})(typeof self !== 'undefined' ? self : this);
