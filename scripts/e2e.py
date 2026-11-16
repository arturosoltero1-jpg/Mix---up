# Prueba de extremo a extremo en Chrome headless: python3 scripts/e2e.py <carpeta_con_wavs>
import sys, time, json, threading, http.server, socketserver, os, glob
from playwright.sync_api import sync_playwright
www = os.path.join(os.path.dirname(__file__), '..', 'www')
class H(http.server.SimpleHTTPRequestHandler):
    def __init__(s,*a,**k): super().__init__(*a,directory=www,**k)
    def log_message(s,*a): pass
srv = socketserver.TCPServer(('127.0.0.1',0),H); port = srv.server_address[1]
threading.Thread(target=srv.serve_forever,daemon=True).start()
files = sorted(glob.glob(os.path.join(sys.argv[1],'*.wav')))
errs=[]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    pg = b.new_page(viewport={'width':390,'height':844})
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('console', lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.goto(f'http://127.0.0.1:{port}/index.html')
    pg.set_input_files('#inFiles', files)
    for _ in range(60):
        st = pg.evaluate('window.__automix.state')
        if all(t['status']=='ready' for t in st['queue']): break
        time.sleep(0.5)
    print('BPM detectado:', [(t['name'], t['bpm'], round(t['fb'] or 0,3)) for t in st['queue']])
    # ajustes: mezcla 5 s, cambio fijo en el segundo 14
    pg.click('#btnSettings')
    pg.evaluate("""() => { const m=document.getElementById('mixLen'); m.value=5; m.dispatchEvent(new Event('input'));
      const c=document.getElementById('optCut'); c.checked=true; c.dispatchEvent(new Event('change'));
      const l=document.getElementById('cutLen'); l.value=35; l.dispatchEvent(new Event('input')); }""")
    pg.screenshot(path=os.path.join(sys.argv[1],'shot_settings.png'))
    pg.click('#btnPlay')
    log=[]; last=None; t0=time.time()
    while time.time()-t0 < 62:
        s = pg.evaluate("""() => { const a=window.__automix, d=a.D[a.state.active]; return {st:a.state, t:d.el.currentTime, name:(d.track||{}).name, ctx:a.ctx.state, o:a.D[1-a.state.active].el.currentTime, r:[a.D[0].el.playbackRate,a.D[1].el.playbackRate]} }""")
        key=(s['st']['active'], (s['st']['mix'] or {}).get('phase'))
        if key!=last:
            log.append((round(time.time()-t0,1), key, round(s['t'],2), s['name'], s['st']['mix'], [round(x,3) for x in s['r']]))
            last=key
        if time.time()-t0 in (0,) : pass
        time.sleep(0.1)
        if 30 < time.time()-t0 < 31: pg.screenshot(path=os.path.join(sys.argv[1],'shot_play.png'))
    for l in log: print(l)
    print('ctx', s['ctx'], '| errores:', errs[:5])
    b.close()
