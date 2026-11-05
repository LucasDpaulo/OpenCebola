package br.cebola.app;

import android.content.pm.ActivityInfo;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewListener;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;

/**
 * A ponte entre o contrato `NativePlayer` (em apps/web/app/player) e o libVLC.
 *
 * Tudo que toca o player roda na thread da interface: o libVLC do Android não é seguro para
 * chamadas concorrentes, e o Capacitor entrega as chamadas numa thread de trabalho.
 */
@CapacitorPlugin(name = "Player")
public class PlayerPlugin extends Plugin {

    private LibVLC libVlc;
    private MediaPlayer player;
    private VLCVideoLayout surface;

    /**
     * A mídia corrente. O `setMedia` retém a dela; esta referência é a NOSSA, e existe para ler
     * as faixas depois que o libVLC as descobre. Só ela é liberada aqui — a do player é problema
     * do player.
     */
    private Media media;

    /** Último evento relevante, em texto. É o que diz se o arquivo abriu ou quebrou. */
    private String ultimoEvento = "nenhum";
    /** Quantas saídas de vídeo o libVLC criou. Zero depois de tocar = não decodificou a imagem. */
    private int voutCount = 0;
    private boolean hardware = true;
    private boolean telaCheia = false;
    private boolean background = false;
    private final PlayerOrientationSession orientacao = new PlayerOrientationSession();
    private final WebViewListener navigationListener = new WebViewListener() {
        @Override
        public void onPageStarted(android.webkit.WebView webView) {
            // Uma navegação completa destrói o JS sem garantir o cleanup do React.
            pararInterno(true);
        }
    };

    @Override
    public void load() {
        getBridge().addWebViewListener(navigationListener);
    }

    @PluginMethod
    public void load(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isBlank()) {
            call.reject("url ausente");
            return;
        }
        final int inicio = call.getInt("startAtSeconds", 0);
        final JSArray legendas = call.getArray("subtitles", new JSArray());
        final boolean comHardware = Boolean.TRUE.equals(call.getBoolean("hardware", true));

        getActivity().runOnUiThread(() -> {
            try {
                if (background) {
                    call.reject("Aplicativo em segundo plano");
                    return;
                }
                garantirPlayer();
                // Trocar de episódio/fonte não encerra a sessão de orientação. A tela ainda pode
                // estar deitada nesse instante; capturá-la de novo faria o app ficar deitado ao sair.
                pararInterno(false);
                orientacao.captureIfNeeded(
                    getActivity().getRequestedOrientation(),
                    ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED,
                    getActivity().getResources().getConfiguration().orientation == Configuration.ORIENTATION_PORTRAIT,
                    ActivityInfo.SCREEN_ORIENTATION_USER_PORTRAIT
                );
                getActivity().setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                manterTelaLigada(true);

                hardware = comHardware;
                ultimoEvento = "abrindo";
                voutCount = 0;

                media = new Media(libVlc, Uri.parse(url));
                media.setHWDecoderEnabled(comHardware, false);

                // Começar no segundo pedido é opção da MÍDIA, e não um seek depois do play:
                // buscar depois de tocar faz o começo do arquivo ser baixado à toa, e num
                // arquivo de 42 GB servido por HTTP isso custa segundos de espera.
                if (inicio > 0) media.addOption(":start-time=" + inicio);
                // Nunca deixe o libVLC adivinhar entre várias legendas. Uma externa só é
                // ligada depois por addSubtitle, quando o Cebola conhece a escolha segura.
                media.addOption(":sub-track=-1");

                for (int i = 0; i < legendas.length(); i += 1) {
                    JSONObject legenda = legendas.optJSONObject(i);
                    if (legenda == null) continue;
                    String enderecoLegenda = legenda.optString("url", "");
                    if (!enderecoLegenda.isBlank()) {
                        media.addSlave(new IMedia.Slave(IMedia.Slave.Type.Subtitle, 4, enderecoLegenda));
                    }
                }

                player.setMedia(media);
                player.play();
                call.resolve();
            } catch (Exception erro) {
                pararInterno(true);
                call.reject("falha ao iniciar: " + erro.getMessage());
            }
        });
    }

    @PluginMethod
    public void resume(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) {
                player.play();
                manterTelaLigada(true);
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void pause(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (player != null) player.pause();
            manterTelaLigada(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void toggleFullscreen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            aplicarTelaCheia(!telaCheia);
            call.resolve();
        });
    }

    @PluginMethod
    public void exitFullscreen(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            aplicarTelaCheia(false);
            call.resolve();
        });
    }

    @PluginMethod
    public void seek(PluginCall call) {
        final Integer segundos = call.getInt("seconds");
        if (segundos == null) {
            call.reject("seconds ausente");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (player != null) player.setTime(segundos * 1000L);
            call.resolve();
        });
    }

    @PluginMethod
    public void setBrightness(PluginCall call) {
        final Double requested = call.getDouble("level");
        if (requested == null) {
            call.reject("level ausente");
            return;
        }
        final float level = (float) Math.max(0.05, Math.min(1.0, requested));
        getActivity().runOnUiThread(() -> {
            WindowManager.LayoutParams params = getActivity().getWindow().getAttributes();
            params.screenBrightness = level;
            getActivity().getWindow().setAttributes(params);
            call.resolve();
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            pararInterno(true);
            call.resolve();
        });
    }

    /**
     * As faixas do MediaPlayer, e não as da Media: só o player sabe quais foram realmente
     * abertas, e o `id` daqui é o mesmo que `selectTrack` aceita de volta.
     */
    @PluginMethod
    public void tracks(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            call.resolve(playbackTracks());
        });
    }

    private JSObject playbackTracks() {
        JSObject resposta = new JSObject();
        resposta.put("audio", descricoes(player == null ? null : player.getAudioTracks()));
        resposta.put("subtitle", descricoes(player == null ? null : player.getSpuTracks()));
        resposta.put("audioSelecionada", player == null ? -1 : player.getAudioTrack());
        resposta.put("subtitleSelecionada", player == null ? -1 : player.getSpuTrack());
        return resposta;
    }

    @PluginMethod
    public void selectTrack(PluginCall call) {
        final String tipo = call.getString("type", "audio");
        final Integer id = call.getInt("id");
        if (id == null) {
            call.reject("id ausente");
            return;
        }
        getActivity().runOnUiThread(() -> {
            boolean ok = false;
            if (player != null) {
                ok = "subtitle".equals(tipo) ? player.setSpuTrack(id) : player.setAudioTrack(id);
            }
            JSObject r = new JSObject();
            r.put("ok", ok);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void setSubtitleDelay(PluginCall call) {
        final Double seconds = call.getDouble("seconds", 0.0);
        if (seconds == null || !Double.isFinite(seconds)) {
            call.reject("atraso inválido");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (player == null || !player.setSpuDelay(Math.round(seconds * 1_000_000))) {
                call.reject("Não foi possível ajustar a legenda.");
                return;
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void addSubtitle(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isBlank()) {
            call.reject("url ausente");
            return;
        }
        getActivity().runOnUiThread(() -> {
            boolean ok = player != null && player.addSlave(IMedia.Slave.Type.Subtitle, Uri.parse(url), true);
            JSObject resposta = new JSObject();
            resposta.put("ok", ok);
            resposta.put("id", player == null ? -1 : player.getSpuTrack());
            call.resolve(resposta);
        });
    }

    /**
     * Capítulos do título atual (ex.: MKV com "OP"/"Ending" marcados). É o fallback de
     * "pular abertura/encerramento" quando a API de skip-times não tem dado para o episódio —
     * `segmentsFromChapters` (em skip-segments.ts) decide o que cada nome de capítulo significa;
     * aqui só convertemos milissegundos do libVLC em segundos.
     */
    @PluginMethod
    public void chapters(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject resposta = new JSObject();
            resposta.put("chapters", capitulos());
            call.resolve(resposta);
        });
    }

    private JSArray capitulos() {
        JSArray lista = new JSArray();
        if (player == null) return lista;
        MediaPlayer.Chapter[] capitulos = player.getChapters(player.getTitle());
        if (capitulos == null) return lista;
        for (MediaPlayer.Chapter capitulo : capitulos) {
            JSObject item = new JSObject();
            item.put("name", capitulo.name == null ? "" : capitulo.name);
            item.put("startSeconds", capitulo.timeOffset / 1000.0);
            item.put("endSeconds", (capitulo.timeOffset + capitulo.duration) / 1000.0);
            lista.put(item);
        }
        return lista;
    }

    /**
     * O relatório cru do motor. A tela de teste de codecs vive disto, e o adaptador em
     * TypeScript usa a posição e a duração daqui para alimentar a barra.
     */
    @PluginMethod
    public void status(PluginCall call) {
        final boolean lightweight = Boolean.TRUE.equals(call.getBoolean("lightweight", false));
        final boolean includeTracks = Boolean.TRUE.equals(call.getBoolean("includeTracks", true));
        getActivity().runOnUiThread(() -> {
            JSObject resposta = new JSObject();
            resposta.put("evento", ultimoEvento);
            resposta.put("hardware", hardware);
            resposta.put("hardwareRequested", hardware);
            resposta.put("decoderConfirmed", false);
            resposta.put("decoder", "unknown");
            resposta.put("vout", voutCount);
            resposta.put("tocando", player != null && player.isPlaying());
            resposta.put("duracaoMs", player == null ? 0 : player.getLength());
            resposta.put("posicaoMs", player == null ? 0 : player.getTime());
            resposta.put("faixaAudioAtual", player == null ? -1 : player.getAudioTrack());
            // Metadados completos ficam disponíveis para a tela de diagnóstico. A reprodução
            // recebe estado e seleção de faixas em uma única travessia da ponte nativa.
            if (lightweight && includeTracks) resposta.put("tracks", playbackTracks());
            else if (!lightweight) resposta.put("faixas", faixas());
            call.resolve(resposta);
        });
    }

    private JSArray descricoes(MediaPlayer.TrackDescription[] faixas) {
        JSArray lista = new JSArray();
        if (faixas == null) return lista;
        for (MediaPlayer.TrackDescription faixa : faixas) {
            // -1 é a entrada "Desativar" que o libVLC inclui nas legendas. Quem desliga legenda
            // no Cebola manda `null`, então essa entrada só confundiria a lista.
            if (faixa.id == -1) continue;
            JSObject item = new JSObject();
            item.put("id", faixa.id);
            item.put("nome", faixa.name);
            if (media != null) {
                for (int i = 0; i < media.getTrackCount(); i++) {
                    IMedia.Track metadata = media.getTrack(i);
                    if (metadata != null && metadata.id == faixa.id) {
                        item.put("idioma", metadata.language);
                        if (metadata.description != null && !metadata.description.isBlank()) {
                            item.put("nome", metadata.description);
                        }
                        break;
                    }
                }
            }
            lista.put(item);
        }
        return lista;
    }

    private JSArray faixas() {
        JSArray lista = new JSArray();
        if (media == null) return lista;
        int total = media.getTrackCount();
        for (int i = 0; i < total; i += 1) {
            IMedia.Track faixa = media.getTrack(i);
            if (faixa == null) continue;
            JSObject item = new JSObject();
            item.put("id", faixa.id);
            item.put("tipo", faixa.type == IMedia.Track.Type.Audio ? "audio"
                : faixa.type == IMedia.Track.Type.Video ? "video"
                : faixa.type == IMedia.Track.Type.Text ? "legenda" : "desconhecido");
            item.put("codec", faixa.codec);
            item.put("codecOriginal", faixa.originalCodec);
            item.put("idioma", faixa.language);
            item.put("descricao", faixa.description);
            if (faixa instanceof IMedia.AudioTrack audio) {
                item.put("canais", audio.channels);
                item.put("taxa", audio.rate);
            }
            if (faixa instanceof IMedia.VideoTrack video) {
                item.put("largura", video.width);
                item.put("altura", video.height);
            }
            lista.put(item);
        }
        return lista;
    }

    private void garantirPlayer() {
        if (libVlc != null) return;

        ArrayList<String> opcoes = new ArrayList<>();
        // Permite ao VLC descartar quadros atrasados quando o aparelho não acompanha.
        opcoes.add("--drop-late-frames");
        opcoes.add("--skip-frames");
        libVlc = new LibVLC(getContext(), opcoes);
        player = new MediaPlayer(libVlc);

        // VLCVideoLayout é um FrameLayout comum. Entra no índice 0, ou seja ATRÁS da WebView do
        // Capacitor; a WebView fica transparente para os controles em React aparecerem por cima.
        surface = new VLCVideoLayout(getContext());
        ViewGroup raiz = (ViewGroup) getBridge().getWebView().getParent();
        raiz.addView(surface, 0, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT));
        getBridge().getWebView().setBackgroundColor(0x00000000);
        player.attachViews(surface, null, true, false);

        player.setEventListener(evento -> {
            switch (evento.type) {
                case MediaPlayer.Event.Playing -> ultimoEvento = "tocando";
                case MediaPlayer.Event.Paused -> ultimoEvento = "pausado";
                case MediaPlayer.Event.Stopped -> ultimoEvento = "parado";
                case MediaPlayer.Event.EndReached -> ultimoEvento = "fim";
                case MediaPlayer.Event.EncounteredError -> ultimoEvento = "erro";
                case MediaPlayer.Event.Vout -> {
                    voutCount = evento.getVoutCount();
                    ultimoEvento = voutCount > 0 ? "vídeo na tela" : "sem saída de vídeo";
                }
                default -> { }
            }
            if (evento.type == MediaPlayer.Event.EndReached || evento.type == MediaPlayer.Event.EncounteredError) {
                getActivity().runOnUiThread(() -> {
                    manterTelaLigada(false);
                });
            }
            JSObject aviso = new JSObject();
            aviso.put("evento", ultimoEvento);
            aviso.put("vout", voutCount);
            aviso.put("posicaoMs", player == null ? 0 : player.getTime());
            aviso.put("duracaoMs", player == null ? 0 : player.getLength());
            notifyListeners("playerEvent", aviso);
        });
    }

    private void pararInterno(boolean encerrarSessao) {
        if (player != null) {
            if (encerrarSessao) player.setEventListener(null);
            player.stop();
        }
        if (media != null) {
            media.release();
            media = null;
        }
        if (encerrarSessao) {
            restaurarOrientacao();
            // Ao bloquear a tela o SurfaceView pode ser destruído. Não reutilizar a saída
            // antiga na próxima abertura; também libera decoder, buffers e threads ociosas.
            if (player != null) {
                player.detachViews();
                player.release();
                player = null;
            }
            if (surface != null && surface.getParent() instanceof ViewGroup parent) parent.removeView(surface);
            surface = null;
            if (libVlc != null) { libVlc.release(); libVlc = null; }
            ultimoEvento = "parado";
            voutCount = 0;
        }
        manterTelaLigada(false);
        aplicarTelaCheia(false);
        WindowManager.LayoutParams params = getActivity().getWindow().getAttributes();
        params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
        getActivity().getWindow().setAttributes(params);
    }

    private void manterTelaLigada(boolean manter) {
        if (manter) {
            getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } else {
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        }
    }

    private void restaurarOrientacao() {
        Integer anterior = orientacao.finish();
        if (anterior != null) getActivity().setRequestedOrientation(anterior);
    }

    @SuppressWarnings("deprecation")
    private void aplicarTelaCheia(boolean ativa) {
        telaCheia = ativa;
        View decor = getActivity().getWindow().getDecorView();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = decor.getWindowInsetsController();
            if (controller == null) return;
            if (ativa) {
                controller.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                controller.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            } else {
                controller.show(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
            }
            return;
        }
        decor.setSystemUiVisibility(ativa
            ? View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
            : View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
    }

    @Override
    protected void handleOnResume() {
        background = false;
        super.handleOnResume();
    }

    @Override
    protected void handleOnPause() {
        // O bloqueio pode entregar onPause sem onStop imediatamente.
        if (!getActivity().isChangingConfigurations()) {
            background = true;
            pararInterno(true);
        }
        super.handleOnPause();
    }

    @Override
    protected void handleOnStop() {
        // O React pode estar suspenso: não deixar áudio/buffer local tocando ao sair do app.
        if (!getActivity().isChangingConfigurations()) {
            background = true;
            pararInterno(true);
        }
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        getBridge().removeWebViewListener(navigationListener);
        pararInterno(true);
        super.handleOnDestroy();
    }
}
