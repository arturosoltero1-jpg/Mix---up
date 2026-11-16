package com.mixupear.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Recibe los toques de los botones de la notificación y los pasa a la app. */
public class ActionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;
        String a = intent.getAction();
        if (a.equals(MediaService.A_PREV)) MediaControlsPlugin.emit("prev");
        else if (a.equals(MediaService.A_PLAY)) MediaControlsPlugin.emit("play");
        else if (a.equals(MediaService.A_PAUSE)) MediaControlsPlugin.emit("pause");
        else if (a.equals(MediaService.A_NEXT)) MediaControlsPlugin.emit("next");
        else if (a.equals(MediaService.A_STOP)) MediaControlsPlugin.emit("stop");
    }
}
