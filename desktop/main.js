const { app, BrowserWindow, ipcMain, globalShortcut, Menu, Tray, nativeImage, net, powerSaveBlocker, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');

// Que el audio y los temporizadores de la mezcla no se detengan con la ventana oculta o minimizada
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService');   // las teclas multimedia las manejamos nosotros

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
let win = null, tray = null, server = null, quitting = false, blocker = null, port = 0;

if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => showWindow());

// Servidor local: la app corre en http://127.0.0.1 (YouTube exige un origen http real y el scratch usa AudioWorklet)
function startServer() {
  const root = path.join(__dirname, 'www');
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/index.html';
      const f = path.normalize(path.join(root, p));
      if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, data) => {
        if (err) { res.writeHead(404); return res.end('no encontrado'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
  });
}

function send(action) { if (win && !win.isDestroyed()) win.webContents.send('media', action); }
function showWindow() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  win = new BrowserWindow({
    width: 480, height: 940, minWidth: 380, minHeight: 640,
    backgroundColor: '#0a0d14', title: 'Mix up-ear', icon: path.join(__dirname, 'icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('http://127.0.0.1:' + port + '/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  // Cerrar la ventana la oculta: la música sigue sonando desde la bandeja del sistema
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });
}

function createTray() {
  let img = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  if (!img.isEmpty()) img = img.resize({ width: 22, height: 22 });
  tray = new Tray(img);
  tray.setToolTip('Mix up-ear');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mostrar Mix up-ear', click: showWindow },
    { type: 'separator' },
    { label: 'Reproducir / Pausar', click: () => send('toggle') },
    { label: 'Anterior', click: () => send('prev') },
    { label: 'Siguiente', click: () => send('next') },
    { label: 'Detener', click: () => send('stop') },
    { type: 'separator' },
    { label: 'Salir', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', showWindow);
}

ipcMain.handle('http', async (_e, o) => {
  const r = await net.fetch(o.url, { method: o.method || 'GET', headers: o.headers || {}, body: o.json ? JSON.stringify(o.json) : undefined });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.text();
});
ipcMain.on('playing', (_e, p) => {      // evita que el sistema suspenda la app mientras suena
  if (p && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!p && blocker !== null) { powerSaveBlocker.stop(blocker); blocker = null; }
});

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  createTray();
  [['MediaPlayPause', 'toggle'], ['MediaNextTrack', 'next'], ['MediaPreviousTrack', 'prev'], ['MediaStop', 'stop']].forEach(([k, a]) => {
    try { globalShortcut.register(k, () => send(a)); } catch (e) { /* tecla no disponible en este sistema */ }
  });
});
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (server) server.close(); });
app.on('window-all-closed', () => { /* se queda en la bandeja */ });
