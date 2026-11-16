# Prueba extremo a extremo (Chrome headless): python3 scripts/e2e2.py <carpeta_media> <carpeta_salida>
import sys, time, math, json, threading, http.server, socketserver, os, glob
from playwright.sync_api import sync_playwright
www = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'www')
media, out = sys.argv[1], sys.argv[2]
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=www,**k)
    def log_message(s,*a): pass
srv = socketserver.TCPServer(('127.0.0.1',0),H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()
files = sorted(glob.glob(os.path.join(media,'0*')))
errs=[]; res={}
FAKE_YT = """
window.YT = { Player: class {
  constructor(el, o){ this.o=o.events||{}; this.t=0; this.s=-1; this.vol=100; this.rate=1; this.vid=null; this.log=window.__ytlog=(window.__ytlog||[]);
    const m=/embed\\/([\\w-]*)/.exec(el.src||''); this.vid=m?m[1]:null; window.__ytp=(window.__ytp||[]); window.__ytp.push(this);
    setTimeout(()=>this.o.onReady&&this.o.onReady({}),30); }
  _set(s){ this.s=s; this.o.onStateChange&&this.o.onStateChange({data:s}); }
  cueVideoById(a){ this.vid=a.videoId; this.t=0; setTimeout(()=>this._set(5),20); }
  playVideo(){ this._set(1); clearInterval(this.iv); this.last=performance.now(); this.iv=setInterval(()=>{const n=performance.now(); this.t+=(n-this.last)/1000*this.rate; this.last=n; if(this.t>=this.dur()){clearInterval(this.iv); this._set(0);} },50); }
  pauseVideo(){ clearInterval(this.iv); this._set(2); }
  seekTo(v){ this.t=v; } getCurrentTime(){ return this.t; } dur(){ return 20; } getDuration(){ return 20; }
  setVolume(v){ this.vol=v; this.log.push([performance.now()|0,this.vid,v]); } getVolume(){return this.vol;}
  setPlaybackRate(r){ this.rate=r; } getPlaybackRate(){ return this.rate; } getAvailablePlaybackRates(){ return [0.25,0.5,0.75,1,1.25,1.5,1.75,2]; }
  getVideoData(){ return {title:'Titulo real '+this.vid}; } getPlaylist(){ return ['AAAAAAAAAAA','BBBBBBBBBBB']; } destroy(){ clearInterval(this.iv); }
}};
"""
YT_HTML = '<html><script>var ytInitialData = ' + json.dumps({"metadata":{"playlistMetadataRenderer":{"title":"Mi lista YT"}},"contents":[
  {"playlistVideoRenderer":{"videoId":"vid00000001","title":{"runs":[{"text":"Cancion Uno"}]},"shortBylineText":{"runs":[{"text":"Artista A - Topic"}]},"lengthSeconds":"20"}},
  {"playlistVideoRenderer":{"videoId":"vid00000002","title":{"runs":[{"text":"Cancion Dos"}]},"shortBylineText":{"runs":[{"text":"Artista B"}]},"lengthSeconds":"20"}}]}) + ';</script></html>'
SP_HTML = '<html><script id="__NEXT_DATA__" type="application/json">' + json.dumps({"props":{"pageProps":{"state":{"data":{"entity":{"name":"Playlist Spotify","coverArt":{"sources":[{"url":"https://i.scdn.co/x"},{"url":"https://i.scdn.co/y"}]},"trackList":[
  {"uri":"spotify:track:aaaaaaaaaaaaaaaaaaaaaa","title":"Tití Me Preguntó","subtitle":"Bad Bunny","duration":243000},
  {"uri":"spotify:track:bbbbbbbbbbbbbbbbbbbbbb","title":"Ojitos Lindos","subtitle":"Bad Bunny, Bomba Estéreo","duration":258000}]}}}}}}) + '</script></html>'
SEARCH_HTML = '<html><script>var ytInitialData = ' + json.dumps({"contents":[
  {"videoRenderer":{"videoId":"live0000001","title":{"runs":[{"text":"Titi Me Pregunto (LIVE en vivo)"}]},"ownerText":{"runs":[{"text":"Fan"}]},"lengthText":{"simpleText":"5:10"}}},
  {"videoRenderer":{"videoId":"good0000001","title":{"runs":[{"text":"Bad Bunny - Tití Me Preguntó (Official Audio)"}]},"ownerText":{"runs":[{"text":"Bad Bunny - Topic"}]},"lengthText":{"simpleText":"4:03"}}}]}) + ';</script></html>'

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox','--autoplay-policy=no-user-gesture-required'])
    pg = b.new_page(viewport={'width':390,'height':900})
    pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
    pg.route('https://www.youtube.com/**', lambda r: r.abort()); pg.route('https://i.ytimg.com/**', lambda r: r.abort()); pg.route('https://i.scdn.co/**', lambda r: r.abort())
    pg.add_init_script(FAKE_YT)
    pg.goto(f'http://127.0.0.1:{port}/index.html')
    pg.evaluate("""([yt,sp,se])=>{ window.Online.setHttp(async (m,url)=>{ if(url.includes('/playlist?list=')) return yt; if(url.includes('open.spotify.com/embed')) return sp; if(url.includes('/results?')) return se; throw new Error('x'); }); }""", [YT_HTML,SP_HTML,SEARCH_HTML])
    pg.set_input_files('#inFiles', files[:1])
    time.sleep(1.5)
    pg.click('#btnOnline'); pg.fill('#onlineText','https://www.youtube.com/playlist?list=PLabc123\nhttps://open.spotify.com/track/aaaaaaaaaaaaaaaaaaaaaa')
    pg.click('#btnImport'); time.sleep(1.2)
    pg.mouse.click(200,20)
    pg.click('#btnSettings')
    pg.evaluate("""()=>{ const m=document.getElementById('mixLen'); m.value=4; m.dispatchEvent(new Event('input')); const c=document.getElementById('optCut'); c.checked=true; c.dispatchEvent(new Event('change')); const l=document.getElementById('cutLen'); l.value=12; l.dispatchEvent(new Event('input')); }""")
    pg.click('#btnPlay')
    log=[]; last=None; t0=time.time()
    while time.time()-t0 < 78:
        s=pg.evaluate("(()=>{const a=window.__automix;const d=a.D[a.state.active];return {act:a.state.active,cur:a.state.curId,mix:a.state.mix&&a.state.mix.phase,kind:d.kind,t:+d.m.currentTime.toFixed(1),nm:d.track&&d.track.name}})()")
        key=(s['act'],s['mix'],s['kind'],s['nm'])
        if key!=last: log.append((round(time.time()-t0,1),s)); last=key
        time.sleep(0.1)
    for l in log: print(l)
    vol=pg.evaluate('window.__ytlog||[]')
    byv={}
    for ts,v,x in vol: byv.setdefault(v,[]).append(x)
    print('volumenes YT por video:', {k:(v[:3],'...',v[-3:],len(v)) for k,v in byv.items()})
    print('cola:', [(t['name'],t['ytId'],t['status']) for t in pg.evaluate('window.__automix.state.queue')])
    print('ERRORES:', errs[:5]); b.close()
