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
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' and 'youtube' not in m.text.lower() and 'ERR_' not in m.text else None)
    pg.route('https://www.youtube.com/**', lambda r: r.abort())
    pg.route('https://i.ytimg.com/**', lambda r: r.abort())
    pg.route('https://i.scdn.co/**', lambda r: r.abort())
    pg.add_init_script(FAKE_YT)
    pg.goto(f'http://127.0.0.1:{port}/index.html')
    pg.set_input_files('#inFiles', files)
    for _ in range(80):
        st = pg.evaluate('window.__automix.state')
        if all(t['status']=='ready' for t in st['queue']) and all(t['art'] for t in st['queue']): break
        time.sleep(0.5)
    res['tags'] = [(t['name'],t['artist'],t['album'],t['art'],t['bpm']) for t in st['queue']]
    pg.screenshot(path=out+'/s1_lista.png')

    # --- EQ ---
    pg.click('#btnEq'); pg.click('.chip[data-p=bass]')
    res['eq_bass'] = pg.evaluate('window.__automix.eq.map(b=>b.gain.value)')
    time.sleep(0.4); res['eq_bass_settled'] = pg.evaluate('window.__automix.eq.map(b=>+b.gain.value.toFixed(2))')
    pg.screenshot(path=out+'/s2_eq.png')
    pg.click('.chip[data-p=flat]'); pg.mouse.click(200,20)  # cerrar hoja

    # --- reproducir y frenar ---
    pg.click('#btnPlay'); time.sleep(3.0)
    res['scratch_ready'] = pg.evaluate('[window.__automix.state.scratchReady, window.__automix.state.scratchTrack]')
    pg.screenshot(path=out+'/s3_disco.png')
    pg.click('#btnPlay')   # pausar -> frena
    samples=[]
    for _ in range(14):
        samples.append(pg.evaluate("(()=>{const d=window.__automix.D[window.__automix.state.active].el;return [+d.playbackRate.toFixed(2), d.paused]})()")); time.sleep(0.1)
    res['brake'] = samples
    pg.click('#btnPlay')   # reanudar -> arranca
    sp=[]
    for _ in range(10):
        sp.append(pg.evaluate("(()=>{const d=window.__automix.D[window.__automix.state.active].el;return [+d.playbackRate.toFixed(2), d.paused]})()")); time.sleep(0.09)
    res['spinup'] = sp
    time.sleep(1.0)

    # --- scratch con el mouse ---
    box = pg.eval_on_selector('#platterWrap','e=>{const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2,r.width/2]}')
    cx,cy,R = box; rad=R*0.8
    pg.evaluate("""()=>{const a=window.__automix; const an=a.ctx.createAnalyser(); an.fftSize=1024; a.bus.connect(an); window.__an=an;}""")
    def rms(): return pg.evaluate("(()=>{const an=window.__an,b=new Float32Array(an.fftSize);an.getFloatTimeDomainData(b);let s=0;for(const x of b)s+=x*x;return +Math.sqrt(s/b.length).toFixed(4)})()")
    ang=0.0
    def pt(a): return (cx+rad*math.cos(a), cy+rad*math.sin(a))
    pg.mouse.move(*pt(ang)); pg.mouse.down()
    time.sleep(0.15)
    st0 = pg.evaluate('window.__automix.state.scratch'); res['scratch_start']=st0
    # adelante rápido (~3x)
    p0 = st0['pos']; t0=time.time(); rms_f=[]
    for i in range(30):
        ang += 3*3.49*0.016; pg.mouse.move(*pt(ang)); time.sleep(0.016)
        if i%10==9: rms_f.append(rms())
    st1 = pg.evaluate('window.__automix.state.scratch'); dt=time.time()-t0
    res['fwd'] = dict(dpos=round(st1['pos']-p0,3), dt=round(dt,3), rate=round(st1['rate'],2), rms=rms_f)
    # sostener (disco detenido)
    time.sleep(0.5); st2=pg.evaluate('window.__automix.state.scratch'); time.sleep(0.3); st3=pg.evaluate('window.__automix.state.scratch')
    res['hold'] = dict(rate=round(st3['rate'],3), moved=round(st3['pos']-st2['pos'],4), rms=rms())
    # reversa
    p1=st3['pos']; rms_r=[]
    for i in range(30):
        ang -= 2*3.49*0.016; pg.mouse.move(*pt(ang)); time.sleep(0.016)
        if i%10==9: rms_r.append(rms())
    st4=pg.evaluate('window.__automix.state.scratch')
    res['rev'] = dict(dpos=round(st4['pos']-p1,3), rate=round(st4['rate'],2), rms=rms_r)
    pg.screenshot(path=out+'/s4_scratch.png')
    pg.mouse.up(); time.sleep(0.15)
    res['release_handing'] = pg.evaluate('window.__automix.state.scratch.handing')
    time.sleep(1.6)
    s5 = pg.evaluate("(()=>{const a=window.__automix,d=a.D[a.state.active].el;return {handing:a.state.scratch.handing,paused:d.paused,rate:d.playbackRate,t:d.currentTime,wpos:a.state.scratch.pos,gain:+a.D[a.state.active].gain.gain.value.toFixed(2),handDiff:a.state.scratch.handDiff}})()")
    res['after_release']=s5

    # --- listas en línea (HTTP simulado) + deck YouTube falso ---
    pg.evaluate("""([yt,sp,se])=>{ window.Online.setHttp(async (m,url)=>{ if(url.includes('/playlist?list=')) return yt; if(url.includes('open.spotify.com/embed')) return sp; if(url.includes('/results?')) return se; if(url.includes('oembed')) return JSON.stringify({title:'Video suelto',author_name:'Canal'}); throw new Error('url inesperada '+url); }); }""", [YT_HTML,SP_HTML,SEARCH_HTML])
    pg.click('#btnOnline')
    pg.fill('#onlineText','https://www.youtube.com/playlist?list=PLabc123\nhttps://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M\nhttps://youtu.be/dQw4w9WgXcQ\nBad Bunny - Dakiti')
    pg.click('#btnImport'); time.sleep(1.5)
    res['import_status']=pg.inner_text('#importStatus')
    pg.screenshot(path=out+'/s5_importar.png')
    st=pg.evaluate('window.__automix.state'); res['queue_after_import']=[(t['name'],t['kind'],t['ytId']) for t in st['queue'] if t['kind']=='yt']
    pg.mouse.click(200,20)
    print(json.dumps(res, ensure_ascii=False, indent=1))
    print('ERRORES:', errs[:6])
    b.close()
