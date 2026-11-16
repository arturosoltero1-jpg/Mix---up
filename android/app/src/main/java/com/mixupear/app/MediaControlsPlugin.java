package com.mixupear.app;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** Puente JS ↔ notificación multimedia (anterior, pausa/play, siguiente, detener). */
@CapacitorPlugin(name = "MediaControls")
public class MediaControlsPlugin extends Plugin {
    private static MediaControlsPlugin instance;

    @Override
    public void load() {
        instance = this;
    }

    @PluginMethod
    public void update(PluginCall call) {
        MediaService.State s = new MediaService.State();
        s.title = call.getString("title", "");
        s.artist = call.getString("artist", "");
        s.album = call.getString("album", "");
        s.playing = Boolean.TRUE.equals(call.getBoolean("playing", false));
        Integer pos = call.getInt("position", 0);
        Integer dur = call.getInt("duration", 0);
        s.position = pos == null ? 0 : pos;
        s.duration = dur == null ? 0 : dur;
        s.canPrev = Boolean.TRUE.equals(call.getBoolean("canPrev", false));
        s.canNext = Boolean.TRUE.equals(call.getBoolean("canNext", false));
        String art = call.getString("art", "");
        if (art != null && !art.isEmpty()) {
            try {
                byte[] b = Base64.decode(art, Base64.DEFAULT);
                s.art = BitmapFactory.decodeByteArray(b, 0, b.length);
                s.hasArt = true;
            } catch (Exception ignored) {
                s.hasArt = false;
            }
        }
        Context ctx = getContext();
        try {
            MediaService.post(ctx, s);
            call.resolve();
        } catch (Exception e) {
            call.reject(String.valueOf(e.getMessage()));
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        MediaService.hide(getContext());
        call.resolve();
    }

    /** Llamado desde el servicio / receptor cuando el usuario toca un botón de la notificación. */
    static void emit(String action) {
        MediaControlsPlugin p = instance;
        if (p == null) return;
        JSObject o = new JSObject();
        o.put("action", action);
        p.notifyListeners("action", o);
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
        MediaService.hide(getContext());
    }
}
