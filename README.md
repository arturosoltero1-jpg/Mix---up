# Mix up-ear

Automix con tocadiscos para tu música y video. Elige una carpeta, archivos o una lista de YouTube/Spotify, toca Play y las pistas se mezclan solas.

## Qué incluye
- **Tocadiscos**: gira el disco para hacer scratch (adelante, reversa); sostenlo y se frena, con el sonido al mismo paso. Al **pausar** el disco frena bajando la velocidad y al reanudar arranca subiendo.
- **Automix** con detección de BPM, beatmatch (±12 %), alineación al golpe, crossfade y bass swap.
- **Tiempo fijo**: todas las pistas empiezan a mezclar en el mismo minuto (p. ej. 2:30).
- **Carátulas y datos** (título, artista, álbum) leídos de mp3, FLAC y M4A/MP4; si no hay, se genera una carátula; también usa `cover.jpg`/`folder.jpg` de la carpeta.
- **Ecualizador** de 5 bandas con 15 presets (Plano, Graves+, Agudos+, Voz, Rock, Pop, Electrónica, Hip-hop, Reggaetón, Latino, Jazz, Clásica, Acústico, Loudness, Menos graves).
- **Listas de YouTube y Spotify** (botón *YouTube / Spotify*): pega enlaces de lista, álbum, video o canción, o escribe "artista - título".
- **Segundo plano**: en Android corre como reproductor de medios (servicio en primer plano + notificación con Anterior, Pausa/Play, Siguiente y Detener, y carátula). En Windows/Linux se queda en la bandeja del sistema y responde a las teclas multimedia.
- Paleta azul y verde.

## Obtener las apps
### Android (APK)
1. Crea un repositorio en GitHub y sube el contenido de esta carpeta (incluye `.github`).
2. *Actions* → **Compilar APK** → espera ~5 min → descarga `mix-up-ear-apk` → instala `app-debug.apk` (permite orígenes desconocidos).
3. Al abrir la app por primera vez acepta el permiso de **notificaciones** (Android 13+) para ver los controles. Para que el sistema no la cierre, desactiva la optimización de batería para Mix up-ear.
   Alternativa: `npm install` → `npx cap sync android` → abre `android/` en Android Studio → *Build ▸ Build APK(s)*.

### Windows y Linux
- Ya compilados (si vienen en tu entrega): `Mix-up-ear-1.0.0-linux.AppImage`, `.deb`, y `Mix-up-ear-1.0.0-win.zip` (descomprime y ejecuta `Mix up-ear.exe`).
- Instalador de Windows (`.exe`) y paquetes Linux oficiales: en GitHub, *Actions* → **Compilar escritorio**.
- Desde el código: `cd desktop && npm install && npm run dist` (o `npm start` para probar).
- Linux AppImage: `chmod +x Mix-up-ear-*.AppImage && ./Mix-up-ear-*.AppImage`.

### PWA
Publica `www/` en un hosting HTTPS y en Chrome usa *Instalar app*.

## Límites conocidos
- **Spotify** se lee de la lista pública y cada canción suena con su equivalente de YouTube (sin cuenta ni Premium); la coincidencia puede fallar en canciones poco conocidas. No lee listas privadas ni "Canciones que te gustan".
- Las pistas de **YouTube/Spotify** se mezclan con crossfade por volumen; no tienen BPM, scratch ni ecualizador (el audio vive dentro del reproductor de YouTube). El freno al pausar se aproxima con la velocidad de YouTube (pasos de 0.25×).
- YouTube puede bloquear algunos videos fuera de su sitio; esos se marcan con error y se salta al siguiente. Si en Android todos fallan con el error 153, cambia `server.hostname` en `capacitor.config.json` a un dominio propio.
- La lectura de listas depende del formato de las páginas de YouTube/Spotify, que pueden cambiar; si falla, pega enlaces de video o nombres de canciones.
- La lista local no se conserva al cerrar la app (los archivos hay que volver a elegirlos); el BPM sí se guarda.
- El APK es de tipo *debug* (instalable, no para Play Store). El zip de Windows no está firmado: SmartScreen puede avisar la primera vez.

## Pruebas
`npm run test:bpm` · `python3 scripts/e2e2.py <medios> <salida>` (extremo a extremo en Chrome) · `python3 scripts/e2e3.py` (mezclas con YouTube simulado).
