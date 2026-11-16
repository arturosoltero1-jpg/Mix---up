package com.mixupear.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

/**
 * Servicio en primer plano: mantiene la app viva con la pantalla apagada y muestra la
 * notificación multimedia con anterior · pausa/play · siguiente · detener.
 */
public class MediaService extends Service {
    static final String CHANNEL = "mixupear_playback";
    static final int NOTIF_ID = 4711;
    static final String A_PREV = "com.mixupear.app.PREV";
    static final String A_PLAY = "com.mixupear.app.PLAY";
    static final String A_PAUSE = "com.mixupear.app.PAUSE";
    static final String A_NEXT = "com.mixupear.app.NEXT";
    static final String A_STOP = "com.mixupear.app.STOP";

    static class State {
        String title = "";
        String artist = "";
        String album = "";
        Bitmap art;
        boolean hasArt;
        boolean playing;
        long position;
        long duration;
        boolean canPrev;
        boolean canNext;
    }

    private static MediaService instance;
    private static State pending;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private State state = new State();
    private boolean foreground = false;

    static boolean isActive() {
        return instance != null;
    }

    /** Actualiza el estado; arranca el servicio si todavía no existe. */
    static void post(final Context ctx, final State s) {
        final Context app = ctx.getApplicationContext();
        MAIN.post(new Runnable() {
            @Override
            public void run() {
                if (instance != null) {
                    instance.apply(s);
                    return;
                }
                pending = s;
                Intent i = new Intent(app, MediaService.class);
                try {
                    if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(i);
                    else app.startService(i);
                } catch (Exception ignored) {
                    // sin permiso para iniciar en segundo plano: se reintentará con el próximo cambio
                }
            }
        });
    }

    static void hide(final Context ctx) {
        final Context app = ctx.getApplicationContext();
        MAIN.post(new Runnable() {
            @Override
            public void run() {
                pending = null;
                if (instance != null) instance.shutdown();
                else app.stopService(new Intent(app, MediaService.class));
            }
        });
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Reproducción", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            ch.setSound(null, null);
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.createNotificationChannel(ch);
        }
        session = new MediaSession(this, "MixUpEar");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MediaControlsPlugin.emit("play"); }
            @Override public void onPause() { MediaControlsPlugin.emit("pause"); }
            @Override public void onSkipToNext() { MediaControlsPlugin.emit("next"); }
            @Override public void onSkipToPrevious() { MediaControlsPlugin.emit("prev"); }
            @Override public void onStop() { MediaControlsPlugin.emit("stop"); }
        });
        session.setActive(true);
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mixupear:playback");
            wakeLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (pending != null) {
            state = pending;
            pending = null;
        }
        apply(state);   // siempre llama a startForeground (requisito de Android)
        return START_NOT_STICKY;
    }

    void apply(State s) {
        if (s.art == null && state.art != null && !s.hasArt) {
            s.art = state.art;   // conserva la carátula si no cambió la pista
        }
        state = s;
        MediaMetadata.Builder md = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, s.title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, s.artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, s.album)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, s.duration);
        if (s.art != null) md.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, s.art);
        session.setMetadata(md.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP;
        if (s.canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (s.canPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .setState(s.playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, s.position, s.playing ? 1f : 0f)
                .build());
        Notification n = build(s);
        try {
            if (!foreground) {
                if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
                else startForeground(NOTIF_ID, n);
                foreground = true;
            } else {
                NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.notify(NOTIF_ID, n);
            }
        } catch (Exception ignored) {
            // sin permiso de notificaciones o restricción del sistema: el audio sigue, sin tarjeta
        }
        if (wakeLock != null) {
            if (s.playing && !wakeLock.isHeld()) wakeLock.acquire();
            else if (!s.playing && wakeLock.isHeld()) wakeLock.release();
        }
    }

    @SuppressWarnings("deprecation")
    private Notification build(State s) {
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        PendingIntent content = PendingIntent.getActivity(this, 0, open, flags());
        b.setSmallIcon(R.drawable.ic_stat_disc)
                .setContentTitle(s.title)
                .setContentText(s.artist)
                .setSubText(s.album)
                .setContentIntent(content)
                .setOngoing(s.playing)
                .setShowWhen(false)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setCategory(Notification.CATEGORY_TRANSPORT);
        if (s.art != null) b.setLargeIcon(s.art);
        b.addAction(R.drawable.ic_prev, "Anterior", action(A_PREV, 1));
        b.addAction(s.playing ? R.drawable.ic_pause : R.drawable.ic_play, s.playing ? "Pausar" : "Reproducir", action(s.playing ? A_PAUSE : A_PLAY, 2));
        b.addAction(R.drawable.ic_next, "Siguiente", action(A_NEXT, 3));
        b.addAction(R.drawable.ic_stop, "Detener", action(A_STOP, 4));
        b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private PendingIntent action(String a, int code) {
        Intent i = new Intent(a);
        i.setComponent(new ComponentName(this, ActionReceiver.class));
        return PendingIntent.getBroadcast(this, code, i, flags());
    }

    private int flags() {
        return Build.VERSION.SDK_INT >= 23 ? (PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE) : PendingIntent.FLAG_UPDATE_CURRENT;
    }

    void shutdown() {
        try {
            if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE);
            else stopForeground(true);
        } catch (Exception ignored) { }
        foreground = false;
        stopSelf();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        shutdown();   // la app se cerró desde recientes
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (session != null) {
            session.setActive(false);
            session.release();
        }
        instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
