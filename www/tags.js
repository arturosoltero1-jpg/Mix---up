/* Etiquetas y carátulas: ID3v2 (mp3), FLAC, MP4/M4A. Sin dependencias.
 * Tags.read(file) -> {title, artist, album, cover: Blob|null}
 * Tags.makeArt(texto) -> dataURL (carátula generada)   Tags.thumb(url, px) -> dataURL|null */
(function (root) {
  'use strict';
  var dec = function (enc, bytes) { try { return new TextDecoder(enc).decode(bytes); } catch (e) { return ''; } };
  var clean = function (s) { return (s || '').replace(/\u0000+$/g, '').replace(/^﻿/, '').trim(); };
  var ascii = function (b, p, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[p + i]); return s; };
  var u32 = function (b, p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; };
  var le32 = function (b, p) { return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; };
  var syncsafe = function (b, p) { return (b[p] << 21) | (b[p + 1] << 14) | (b[p + 2] << 7) | b[p + 3]; };
  function sniffMime(b) {
    if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg';
    if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
    if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif';
    if (b[0] === 0x52 && b[1] === 0x49) return 'image/webp';
    return 'image/jpeg';
  }
  function blobOf(bytes, mime) {
    if (!bytes || bytes.length < 64) return null;
    var m = /^image\/(jpe?g|png|gif|webp)$/i.test(mime || '') ? mime : sniffMime(bytes);
    return new Blob([bytes], { type: m });
  }
  function unsync(b) {
    var o = new Uint8Array(b.length), j = 0;
    for (var i = 0; i < b.length; i++) { o[j++] = b[i]; if (b[i] === 0xFF && b[i + 1] === 0x00) i++; }
    return o.subarray(0, j);
  }
  function id3Text(d) {
    if (!d.length) return '';
    var e = d[0], body = d.subarray(1);
    var s = e === 0 ? dec('windows-1252', body) : e === 3 ? dec('utf-8', body)
      : e === 2 ? dec('utf-16be', body)
      : (body[0] === 0xFE && body[1] === 0xFF ? dec('utf-16be', body.subarray(2)) : dec('utf-16le', body[0] === 0xFF && body[1] === 0xFE ? body.subarray(2) : body));
    return clean(s.split('\u0000').filter(Boolean).join(', '));
  }
  // saltar texto terminado en nulo (1 o 2 bytes según codificación)
  function skipZ(d, p, enc) {
    if (enc === 1 || enc === 2) { while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2; return p + 2; }
    while (p < d.length && d[p] !== 0) p++; return p + 1;
  }
  function id3Pic(d, v2) {
    var enc = d[0], p = 1, mime;
    if (v2) { mime = 'image/' + ascii(d, 1, 3).toLowerCase().replace('jpg', 'jpeg'); p = 4; }
    else { var e = p; while (e < d.length && d[e] !== 0) e++; mime = ascii(d, p, e - p).toLowerCase(); if (mime === 'image/jpg') mime = 'image/jpeg'; p = e + 1; }
    var type = d[p++]; p = skipZ(d, p, enc);
    return { type: type, bytes: d.subarray(p), mime: mime };
  }

  async function readID3(file) {
    var head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
    var out = {};
    if (ascii(head, 0, 3) === 'ID3') {
      var ver = head[3], flags = head[5], size = syncsafe(head, 6);
      var buf = new Uint8Array(await file.slice(10, 10 + Math.min(size, 16 * 1024 * 1024)).arrayBuffer());
      if ((flags & 0x80) && ver < 4) buf = unsync(buf);
      var p = 0;
      if (flags & 0x40) p = ver === 4 ? syncsafe(buf, 0) : u32(buf, 0) + 4;
      var idLen = ver === 2 ? 3 : 4, hdr = ver === 2 ? 6 : 10, best = null;
      while (p + hdr <= buf.length) {
        var id = ascii(buf, p, idLen);
        if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
        var sz = ver === 2 ? ((buf[p + 3] << 16) | (buf[p + 4] << 8) | buf[p + 5]) : ver === 4 ? syncsafe(buf, p + 4) : u32(buf, p + 4);
        var fl = ver >= 3 ? ((buf[p + 8] << 8) | buf[p + 9]) : 0;
        var d = buf.subarray(p + hdr, p + hdr + sz); p += hdr + sz;
        if (ver === 4 && (fl & 0x01)) d = d.subarray(4);
        if (ver === 4 && (fl & 0x02)) d = unsync(d);
        if (id === 'TIT2' || id === 'TT2') out.title = id3Text(d);
        else if (id === 'TPE1' || id === 'TP1') out.artist = id3Text(d);
        else if (id === 'TALB' || id === 'TAL') out.album = id3Text(d);
        else if (id === 'APIC' || id === 'PIC') {
          try { var pic = id3Pic(d, id === 'PIC'); if (!best || pic.type === 3 || (best.type !== 3 && pic.type < best.type)) best = pic; } catch (e) { /* imagen corrupta */ }
        }
      }
      if (best) out.cover = blobOf(best.bytes, best.mime);
    }
    if (!out.title && file.size > 128) { // ID3v1 al final
      var t = new Uint8Array(await file.slice(file.size - 128).arrayBuffer());
      if (ascii(t, 0, 3) === 'TAG') { out.title = clean(dec('windows-1252', t.subarray(3, 33))); out.artist = out.artist || clean(dec('windows-1252', t.subarray(33, 63))); out.album = out.album || clean(dec('windows-1252', t.subarray(63, 93))); }
    }
    return out;
  }

  async function readFLAC(file) {
    var out = {}, pos = 4, last = false;
    while (!last && pos < Math.min(file.size, 48 * 1024 * 1024)) {
      var h = new Uint8Array(await file.slice(pos, pos + 4).arrayBuffer());
      last = !!(h[0] & 0x80); var type = h[0] & 0x7F, len = (h[1] << 16) | (h[2] << 8) | h[3]; pos += 4;
      if (type === 4 || type === 6) {
        var b = new Uint8Array(await file.slice(pos, pos + len).arrayBuffer());
        if (type === 4) {
          var p = 4 + le32(b, 0), n = le32(b, p); p += 4;
          for (var i = 0; i < n && p + 4 <= b.length; i++) {
            var l = le32(b, p); p += 4; var kv = dec('utf-8', b.subarray(p, p + l)); p += l;
            var q = kv.indexOf('='); if (q < 0) continue;
            var k = kv.slice(0, q).toUpperCase(), v = kv.slice(q + 1);
            if (k === 'TITLE') out.title = v; else if (k === 'ARTIST') out.artist = v; else if (k === 'ALBUM') out.album = v;
          }
        } else if (!out.cover) {
          var ml = u32(b, 4), mime = ascii(b, 8, ml), q2 = 8 + ml, dl = u32(b, q2); q2 += 4 + dl + 16;
          var pl = u32(b, q2); q2 += 4; out.cover = blobOf(b.subarray(q2, q2 + pl), mime);
        }
      }
      pos += len;
    }
    return out;
  }

  function atoms(b, from, to, fn) {
    var p = from;
    while (p + 8 <= to) {
      var sz = u32(b, p), type = ascii(b, p + 4, 4), hs = 8;
      if (sz === 1) { sz = u32(b, p + 12); hs = 16; } else if (sz === 0) sz = to - p;
      if (sz < hs || p + sz > to) break;
      if (fn(type, p + hs, p + sz) === false) return;
      p += sz;
    }
  }
  async function readMP4(file) {
    var pos = 0, moov = null, hdr;
    while (pos + 8 <= file.size) {
      hdr = new Uint8Array(await file.slice(pos, pos + 16).arrayBuffer());
      var sz = u32(hdr, 0), type = ascii(hdr, 4, 4);
      if (sz === 1) sz = u32(hdr, 12); else if (sz === 0) sz = file.size - pos;
      if (sz < 8) break;
      if (type === 'moov') { if (sz > 64 * 1024 * 1024) return {}; moov = new Uint8Array(await file.slice(pos, pos + sz).arrayBuffer()); break; }
      pos += sz;
    }
    var out = {};
    if (!moov) return out;
    var ilst = null;
    atoms(moov, 8, moov.length, function (t, s, e) { if (t === 'udta') atoms(moov, s, e, function (t2, s2, e2) { if (t2 === 'meta') atoms(moov, s2 + 4, e2, function (t3, s3, e3) { if (t3 === 'ilst') ilst = [s3, e3]; }); }); });
    if (!ilst) return out;
    atoms(moov, ilst[0], ilst[1], function (t, s, e) {
      atoms(moov, s, e, function (t2, s2, e2) {
        if (t2 !== 'data') return;
        var flags = u32(moov, s2) & 0xFFFFFF, body = moov.subarray(s2 + 8, e2);
        if (t === '©nam') out.title = dec('utf-8', body);
        else if (t === '©ART' || (t === 'aART' && !out.artist)) out.artist = dec('utf-8', body);
        else if (t === '©alb') out.album = dec('utf-8', body);
        else if (t === 'covr') out.cover = blobOf(body, flags === 14 ? 'image/png' : 'image/jpeg');
      });
    });
    return out;
  }

  async function read(file) {
    var r = {};
    try {
      var h = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      if (ascii(h, 4, 4) === 'ftyp') r = await readMP4(file);
      else if (ascii(h, 0, 4) === 'fLaC') r = await readFLAC(file);
      else if (/\.(mp3|aac|wav)$/i.test(file.name) || ascii(h, 0, 3) === 'ID3') r = await readID3(file);
    } catch (e) { r = {}; }
    return { title: clean(r.title), artist: clean(r.artist), album: clean(r.album), cover: r.cover || null };
  }

  /* ---------- carátula generada ---------- */
  function hash(s) { var h = 2166136261; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function makeArt(seed, size) {
    size = size || 192; seed = seed || '?';
    var h = hash(seed), c = document.createElement('canvas'); c.width = c.height = size;
    var g = c.getContext('2d'), h1 = 190 + (h % 90), h2 = 120 + ((h >>> 8) % 60); // familia azul → verde
    var gr = g.createLinearGradient(0, 0, size, size);
    gr.addColorStop(0, 'hsl(' + h1 + ' 70% 48%)'); gr.addColorStop(1, 'hsl(' + h2 + ' 60% 24%)');
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    g.globalAlpha = 0.16; g.fillStyle = '#fff'; g.beginPath(); g.arc(size * (0.2 + ((h >>> 3) % 50) / 100), size * (0.15 + ((h >>> 5) % 60) / 100), size * 0.36, 0, 7); g.fill();
    g.globalAlpha = 0.14; g.fillStyle = '#000'; g.beginPath(); g.arc(size * 0.82, size * 0.88, size * 0.46, 0, 7); g.fill();
    var words = seed.replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
    var ini = ((words[0] || '?')[0] + (words[1] ? words[1][0] : '')).toUpperCase();
    g.globalAlpha = 0.92; g.fillStyle = '#fff'; g.font = '700 ' + Math.round(size * 0.38) + 'px system-ui,sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(ini, size / 2, size / 2 + size * 0.02);
    return c.toDataURL('image/jpeg', 0.82);
  }
  function thumb(url, size) {
    size = size || 256;
    return new Promise(function (res) {
      var im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = c.height = size; var g = c.getContext('2d');
          var s = Math.min(im.naturalWidth, im.naturalHeight);
          g.drawImage(im, (im.naturalWidth - s) / 2, (im.naturalHeight - s) / 2, s, s, 0, 0, size, size);
          res(c.toDataURL('image/jpeg', 0.85));
        } catch (e) { res(null); }
      };
      im.onerror = function () { res(null); };
      im.src = url;
    });
  }
  root.Tags = { read: read, makeArt: makeArt, thumb: thumb };
})(typeof self !== 'undefined' ? self : this);
