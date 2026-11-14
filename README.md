# Mix up-ear

Automix con beatmatch para tu música y video. Elige una carpeta o archivos, toca Play y las pistas se mezclan solas.

## Qué hace (v1: biblioteca local)
- Carpeta o archivos locales (audio y video).
- Detecta el BPM y el primer golpe de cada pista; iguala el tempo (±12 %) y alinea los golpes.
- Crossfade de potencia constante + intercambio de graves (bass swap).
- Mezcla de video con disolvencia cuando las pistas son video.
- **Tiempo fijo**: todas las pistas empiezan a mezclar en el mismo minuto (p. ej. 2:30).
- Duración de mezcla 3–32 s, repetir lista, orden por BPM o aleatorio, "Mezclar ahora".

## Obtener el APK
**Opción A — GitHub (sin instalar nada):**
1. Crea un repositorio en GitHub y sube el contenido de esta carpeta (incluye `.github`).
2. Pestaña *Actions* → *Compilar APK* → espera ~5 min.
3. Descarga el artefacto `mix-up-ear-apk` → `app-debug.apk` → cópialo al teléfono e instálalo (permite "orígenes desconocidos").

**Opción B — Android Studio:** `npm install` → `npx cap sync android` → abre la carpeta `android/` → *Build ▸ Build APK(s)*.

**Opción C — sin APK (PWA):** publica la carpeta `www/` en cualquier hosting HTTPS (GitHub Pages) y en Chrome usa *Instalar app*.

## Límites conocidos
- Spotify y YouTube (video) están previstos para la siguiente etapa. No dan acceso al audio crudo, así que ahí solo será posible crossfade por volumen (Spotify requiere Premium).
- En Android, el selector de carpeta del WebView puede comportarse como selector de archivos: elige todas las pistas de la carpeta.
- La lista no se conserva al cerrar la app (los archivos hay que volver a elegirlos); el BPM sí se guarda en caché.
- Con la pantalla apagada, Android puede pausar el temporizador de la mezcla; la app pide mantener la pantalla encendida mientras suena.
- El APK generado es *debug* (instalable, sin firmar para Play Store).

## Pruebas
`npm run test:bpm` (detector) · `python3 scripts/e2e.py <carpeta con wavs>` (extremo a extremo en Chrome; las pistas de prueba: `node scripts/gen-tracks.js <carpeta>`).
