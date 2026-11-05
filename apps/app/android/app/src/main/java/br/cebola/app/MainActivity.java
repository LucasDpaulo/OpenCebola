package br.cebola.app;

import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.ProcessedRoute;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(PlayerPlugin.class);
        if (BuildConfig.LOCAL_STREAMING) {
            try {
                registerPlugin(Class.forName("br.cebola.app.StreamingPlugin")
                    .asSubclass(com.getcapacitor.Plugin.class));
            } catch (ClassNotFoundException error) {
                throw new IllegalStateException("Pacote de streaming incompleto", error);
            }
        }
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(BookDownloadsPlugin.class);

        // `next build` com output estático e trailingSlash cria uma pasta para cada rota.
        // Sem este processador o Capacitor aplica o fallback SPA e `/titulo/` recebe o HTML
        // de `/`, embora a barra de endereço continue mostrando `/titulo/`.
        bridgeBuilder.setRouteProcessor((basePath, path) -> {
            ProcessedRoute route = new ProcessedRoute();
            String lastSegment = path.substring(path.lastIndexOf('/') + 1);
            boolean isRoute = lastSegment.isEmpty() || !lastSegment.contains(".");
            String resolvedPath = isRoute
                ? path + (path.endsWith("/") ? "" : "/") + "index.html"
                : path;

            // Na carga inicial o servidor passa a raiz dos assets separadamente; nas demais
            // requisições ele próprio a acrescenta depois que o processador retorna.
            route.setPath(basePath.isEmpty() ? resolvedPath : basePath + resolvedPath);
            route.setAsset(true);
            return route;
        });
        super.onCreate(savedInstanceState);

        // O botão físico Voltar pertence à navegação da interface enquanto houver uma página
        // anterior na WebView. Sem este callback, o Android encerrava a Activity mesmo quando a
        // pessoa tinha acabado de abrir os detalhes de um título.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            private boolean awaitingBack = false;
            @Override
            public void handleOnBackPressed() {
                if (awaitingBack) return;
                WebView webView = getBridge().getWebView();
                awaitingBack = true;
                // O gesto/botão Voltar fecha primeiro a reprodução; não deve abandonar o
                // documento e deixar decoder/torrent e orientação ativos atrás da Home.
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('cebola:playback-back', {cancelable:true}))",
                    result -> {
                        awaitingBack = false;
                        if ("false".equals(result)) return;
                        if (webView.canGoBack()) { webView.goBack(); return; }
                        setEnabled(false);
                        getOnBackPressedDispatcher().onBackPressed();
                        setEnabled(true);
                    }
                );
            }
        });
    }
}
