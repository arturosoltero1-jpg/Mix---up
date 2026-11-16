const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('MixDesktop', {
  platform: process.platform,
  http: (opts) => ipcRenderer.invoke('http', opts),                     // peticiones sin CORS (YouTube/Spotify)
  onMedia: (cb) => ipcRenderer.on('media', (_e, action) => cb(action)),  // teclas multimedia y bandeja
  setPlaying: (p) => ipcRenderer.send('playing', !!p)
});
