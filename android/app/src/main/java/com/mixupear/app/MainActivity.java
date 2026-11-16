package com.mixupear.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaControlsPlugin.class);
        super.onCreate(savedInstanceState);
        // Android 13+: permiso para mostrar la notificación con los controles
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 7);
        }
    }

    @Override
    public void onStart() {
        super.onStart();
        if (getBridge() != null && getBridge().getWebView() != null) {
            // El segundo deck arranca solo en mitad de la mezcla (sin toque del usuario)
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // Mantener el WebView "vivo" en segundo plano para que la mezcla y los temporizadores sigan
        if (MediaService.isActive() && getBridge() != null) {
            WebView wv = getBridge().getWebView();
            if (wv != null) {
                wv.resumeTimers();
                wv.onResume();
            }
        }
    }
}
