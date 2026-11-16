// Copia la app web (../www) dentro de desktop/www antes de ejecutar o empaquetar.
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, '..', 'www'), dst = path.join(__dirname, 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log('www copiado a', dst);
