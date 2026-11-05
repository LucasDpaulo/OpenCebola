//! Backend mpv do Windows (motor de reserva do GStreamer), por libmpv + opção `wid`.
//!
//! O mpv desenha sozinho (`vo=gpu`, D3D11) numa janela que ele mesmo cria como FILHA de uma janela
//! HWND nossa, passada em `wid`. Essa janela é irmã do WebView2 na janela principal e fica no fundo
//! da ordem Z (`HWND_BOTTOM`), recortada pelo layout da interface: o WebView transparente passa por
//! cima e o vídeo aparece na abertura, exatamente como no backend GStreamer do Windows
//! (`windows.rs`). Nenhum quadro passa por JavaScript.
//!
//! Diferenças para o `linux_mpv` (que usa a API de render com um `GtkGLArea`):
//! - sem render context nem GL: quem apresenta os quadros é o próprio mpv, na thread dele;
//! - eventos: sem laço GTK e sem thread extra. A interface consulta `stats` o tempo todo, então
//!   a fila de eventos do libmpv é esvaziada no `snapshot` (`wait_event(0.0)`), como no Linux. Um
//!   erro de reprodução fica gravado em `error` até a próxima abertura;
//! - o mpv acompanha sozinho o redimensionamento da janela pai (ele instala um hook
//!   `WH_CALLWNDPROC` na thread dona dela), então o `layout` só precisa do `SetWindowPos`.
//!
//! Teclado e mouse continuam no WebView: o mpv sobe sem atalhos, sem OSC e sem entrada de ponteiro.
//!
//! O app liga contra `libmpv-2.dll` por um `mpv.lib` de importação, mas com carga sob demanda
//! (delay-load, ver `apps/pc/src-tauri/build.rs`). Como a DLL puxa `vulkan-1.dll`, que um Windows
//! sem driver gráfico completo não tem, a primeira abertura confere o carregamento e devolve um
//! erro claro em vez de derrubar o app.

use std::{cell::RefCell, ffi::c_char, time::Instant};

use ::windows::{
    core::w,
    Win32::{
        Foundation::HWND,
        System::LibraryLoader::LoadLibraryW,
        UI::{
            HiDpi::GetDpiForWindow,
            WindowsAndMessaging::{
                CreateWindowExW, SetWindowPos, ShowWindow, HWND_BOTTOM, SWP_NOACTIVATE,
                SWP_NOOWNERZORDER, SWP_SHOWWINDOW, SW_HIDE, WINDOW_EX_STYLE, WS_CHILD,
                WS_CLIPCHILDREN,
            },
        },
    },
};
use libmpv2::{
    events::{mpv_event_id, Event},
    Mpv,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::{
    models::{
        NativeControlRequest, NativeLayoutRequest, NativeOpenRequest, NativePlaybackSnapshot,
        NativeSessionRequest, NativeTrackInfo, TrackKind,
    },
    Error, Result,
};

// `setlocale` da UCRT (a mesma que o libmpv e o GStreamer usam): ver `create_player`.
unsafe extern "C" {
    fn setlocale(category: i32, locale: *const c_char) -> *mut c_char;
}
const LC_NUMERIC: i32 = 4;

thread_local! {
    static PLAYER: RefCell<Option<MpvPlayer>> = const { RefCell::new(None) };
    static SURFACE: RefCell<Option<NativeSurface>> = const { RefCell::new(None) };
}

#[derive(Clone, Copy)]
struct NativeSurface {
    parent: HWND,
    child: HWND,
}

#[derive(Clone)]
struct TrackTarget {
    public_index: i32,
    mpv_id: i64,
    kind: TrackKind,
}

#[derive(Clone, Copy)]
struct MpvBufferDefaults {
    cache_seconds: f64,
    readahead_seconds: f64,
    forward_bytes: i64,
    backward_bytes: i64,
    donate_buffer: bool,
    hysteresis_seconds: f64,
}

impl MpvBufferDefaults {
    fn read(mpv: &Mpv) -> Self {
        Self {
            cache_seconds: property(mpv, "cache-secs").unwrap_or(3_600_000.0),
            readahead_seconds: property(mpv, "demuxer-readahead-secs").unwrap_or(1.0),
            forward_bytes: property(mpv, "demuxer-max-bytes").unwrap_or(150 * 1024 * 1024),
            backward_bytes: property(mpv, "demuxer-max-back-bytes").unwrap_or(50 * 1024 * 1024),
            donate_buffer: property(mpv, "demuxer-donate-buffer").unwrap_or(true),
            hysteresis_seconds: property(mpv, "demuxer-hysteresis-secs").unwrap_or(0.0),
        }
    }
}

struct MpvPlayer {
    session_key: String,
    mpv: Mpv,
    last_presented_frames: u64,
    last_sample_at: Instant,
    measured_fps: f64,
    tracks: Vec<NativeTrackInfo>,
    track_targets: Vec<TrackTarget>,
    tracks_dirty: bool,
    default_buffer: MpvBufferDefaults,
    error: Option<String>,
}

impl Drop for MpvPlayer {
    fn drop(&mut self) {
        // Para a reprodução antes de destruir o handle: o `stop` fecha a janela de vídeo do mpv de
        // forma síncrona, e o `mpv_destroy` que vem a seguir não precisa mais esperar por ela.
        let _ = self.mpv.command("stop", &[]);
    }
}

pub fn open<R: Runtime>(
    app: &AppHandle<R>,
    payload: NativeOpenRequest,
) -> Result<NativePlaybackSnapshot> {
    ensure_surface(app)?;
    let opened = open_player(&payload);
    if opened.is_err() {
        // Sem vídeo para mostrar: não deixa a janela vazia à mostra atrás do WebView.
        hide_surface();
    }
    opened
}

fn open_player(payload: &NativeOpenRequest) -> Result<NativePlaybackSnapshot> {
    PLAYER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if let Some(player) = slot.as_mut() {
            load_source(player, payload)?;
            return snapshot(player);
        }
        let mut player = create_player(payload)?;
        let result = snapshot(&mut player)?;
        *slot = Some(player);
        Ok(result)
    })
}

/// Cria (uma vez) a janela filha onde o mpv vai desenhar. Mesmo padrão do backend GStreamer.
fn ensure_surface<R: Runtime>(app: &AppHandle<R>) -> Result<()> {
    SURFACE.with(|slot| {
        if slot.borrow().is_some() {
            return Ok(());
        }
        let window = app
            .webview_windows()
            .into_values()
            .next()
            .ok_or_else(|| Error::Pipeline("no Tauri webview window is available".into()))?;
        // Keep the native parent black while making the WebView above the video transparent.
        window
            .set_background_color(Some(tauri::webview::Color(0, 0, 0, 0)))
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let parent = window
            .hwnd()
            .map_err(|error| Error::Pipeline(error.to_string()))?;
        let child = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                w!("STATIC"),
                w!(""),
                // Do not clip against the transparent WebView sibling covering the video.
                WS_CHILD | WS_CLIPCHILDREN,
                0,
                0,
                1,
                1,
                Some(parent),
                None,
                None,
                None,
            )
        }
        .map_err(|error| Error::Pipeline(format!("failed to create mpv video HWND: {error}")))?;
        *slot.borrow_mut() = Some(NativeSurface { parent, child });
        Ok(())
    })
}

fn surface() -> Result<NativeSurface> {
    SURFACE.with(|slot| {
        slot.borrow()
            .as_ref()
            .copied()
            .ok_or_else(|| Error::Pipeline("native Windows mpv surface is unavailable".into()))
    })
}

fn place_surface(x: f64, y: f64, width: f64, height: f64) -> Result<()> {
    let surface = surface()?;
    let scale = f64::from(unsafe { GetDpiForWindow(surface.parent) }) / 96.0;
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    let x = (x * scale).round() as i32;
    let y = (y * scale).round() as i32;
    let width = (width.max(1.0) * scale).round() as i32;
    let height = (height.max(1.0) * scale).round() as i32;
    unsafe {
        SetWindowPos(
            surface.child,
            Some(HWND_BOTTOM),
            x,
            y,
            width,
            height,
            SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_SHOWWINDOW,
        )
    }
    .map_err(|error| Error::Pipeline(format!("failed to place mpv video HWND: {error}")))
}

fn hide_surface() {
    if let Ok(surface) = surface() {
        unsafe {
            let _ = ShowWindow(surface.child, SW_HIDE);
        }
    }
}

/// `libmpv-2.dll` é carregada sob demanda (delay-load). Se ela, ou uma dependência dela (como a
/// `vulkan-1.dll`), não carregar, o erro vem aqui e não como uma exceção do carregador.
fn ensure_library() -> Result<()> {
    unsafe { LoadLibraryW(w!("libmpv-2.dll")) }
        .map(|_| ())
        .map_err(|error| {
            Error::RuntimeUnavailable(format!(
                "libmpv-2.dll could not be loaded (it must sit next to the app, and needs \
                 vulkan-1.dll from the graphics driver): {error}"
            ))
        })
}

fn create_player(payload: &NativeOpenRequest) -> Result<MpvPlayer> {
    ensure_library()?;
    // O libmpv só inicializa com LC_NUMERIC "C" (documentado como precondição de quem o embute),
    // e o `gst::init()` chama `setlocale(LC_ALL, "")`, que no Windows em português vira vírgula
    // decimal. A UCRT é uma só no processo, então basta fixar antes de criar o handle.
    let locale = unsafe { setlocale(LC_NUMERIC, c"C".as_ptr()) };
    if locale.is_null() {
        return Err(Error::Pipeline(
            "mpv backend could not select the required C numeric locale".into(),
        ));
    }
    let video_window = surface()?.child;

    let mpv = Mpv::with_initializer(|init| {
        // O mpv pede o HWND como `uint32_t` (todo handle do Windows cabe em 32 bits); um valor
        // negativo é rejeitado, então o cast passa por u32.
        init.set_option("wid", i64::from(video_window.0 as usize as u32))?;
        init.set_option("vo", "gpu")?;
        init.set_option("hwdec", "auto-safe")?;
        init.set_option("keep-open", "yes")?;
        init.set_option("osd-level", "0")?;
        init.set_option("cache", "yes")?;
        // Sem entrada própria: teclado e mouse seguem no WebView.
        init.set_option("osc", "no")?;
        init.set_option("input-default-bindings", "no")?;
        init.set_option("input-vo-keyboard", "no")?;
        init.set_option("input-cursor", "no")?;
        init.set_option("cursor-autohide", "no")?;
        // Isolamento do mpv.exe do usuário: nada de scripts da pasta de configuração nem do
        // yt-dlp. Só reduzem superfície; uma build sem a opção não deve impedir a abertura.
        let _ = init.set_option("load-scripts", "no");
        let _ = init.set_option("ytdl", "no");
        Ok(())
    })
    .map_err(mpv_error)?;
    mpv.disable_deprecated_events().map_err(mpv_error)?;
    mpv.disable_event(mpv_event_id::Tick).map_err(mpv_error)?;
    let default_buffer = MpvBufferDefaults::read(&mpv);

    let mut player = MpvPlayer {
        session_key: String::new(),
        mpv,
        last_presented_frames: 0,
        last_sample_at: Instant::now(),
        measured_fps: 0.0,
        tracks: Vec::new(),
        track_targets: Vec::new(),
        tracks_dirty: true,
        default_buffer,
        error: None,
    };
    load_source(&mut player, payload)?;
    Ok(player)
}

fn load_source(player: &mut MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
    player.mpv.command("stop", &[]).map_err(mpv_error)?;
    // Eventos que sobraram do arquivo anterior (inclusive um fim com erro) não são deste.
    discard_pending_events(&mut player.mpv);
    configure_network(player, payload)?;
    configure_buffer(player, payload)?;
    player
        .mpv
        .set_property(
            "volume",
            if payload.muted {
                0.0
            } else {
                payload.volume.clamp(0.0, 1.0) * 100.0
            },
        )
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property("pause", !payload.autoplay)
        .map_err(mpv_error)?;
    // A janela de vídeo do mpv nasce com o tamanho da janela pai: posiciona antes de carregar.
    place_surface(payload.x, payload.y, payload.width, payload.height)?;
    player
        .mpv
        .command("loadfile", &[&payload.uri, "replace"])
        .map_err(mpv_error)?;
    player.session_key.clone_from(&payload.session_key);
    player.tracks.clear();
    player.track_targets.clear();
    player.tracks_dirty = true;
    player.error = None;
    player.last_presented_frames = 0;
    player.last_sample_at = Instant::now();
    player.measured_fps = 0.0;
    Ok(())
}

fn configure_network(player: &MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
    let mut headers = payload.headers.clone();
    if let Some(value) = payload.cookies.as_ref().filter(|value| !value.is_empty()) {
        headers.insert("Cookie".into(), value.clone());
    }
    if let Some(value) = payload.referrer.as_ref().filter(|value| !value.is_empty()) {
        headers.insert("Referer".into(), value.clone());
    }
    if !headers.is_empty() {
        let values = headers
            .iter()
            .map(|(name, value)| format!("{name}: {value}"))
            .collect::<Vec<_>>();
        player
            .mpv
            .set_property("http-header-fields", encode_mpv_list(&values))
            .map_err(mpv_error)?;
    } else {
        player
            .mpv
            .set_property("http-header-fields", String::new())
            .map_err(mpv_error)?;
    }
    player
        .mpv
        .set_property(
            "user-agent",
            payload
                .user_agent
                .clone()
                .unwrap_or_else(|| "tauri-plugin-video".into()),
        )
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property(
            "tls-ca-file",
            payload.tls_ca_file.clone().unwrap_or_default(),
        )
        .map_err(mpv_error)?;
    Ok(())
}

fn configure_buffer(player: &MpvPlayer, payload: &NativeOpenRequest) -> Result<()> {
    let (cache_seconds, readahead_seconds) = payload.max_buffer_ms.map_or(
        (
            player.default_buffer.cache_seconds,
            player.default_buffer.readahead_seconds,
        ),
        |milliseconds| {
            let seconds = (f64::from(milliseconds) / 1_000.0).clamp(3.0, 120.0);
            (seconds, seconds)
        },
    );
    let (forward_bytes, backward_bytes, donate_buffer) = payload.target_buffer_bytes.map_or(
        (
            player.default_buffer.forward_bytes,
            player.default_buffer.backward_bytes,
            player.default_buffer.donate_buffer,
        ),
        |requested| {
            let total = requested.clamp(8 * 1024 * 1024, i64::MAX as u64);
            let backward = (total / 4)
                .clamp(4 * 1024 * 1024, 16 * 1024 * 1024)
                .min(total / 2);
            ((total - backward) as i64, backward as i64, false)
        },
    );
    player
        .mpv
        .set_property("cache-secs", cache_seconds)
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property("demuxer-readahead-secs", readahead_seconds)
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property("demuxer-max-bytes", forward_bytes)
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property("demuxer-max-back-bytes", backward_bytes)
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property("demuxer-donate-buffer", donate_buffer)
        .map_err(mpv_error)?;
    player
        .mpv
        .set_property(
            "demuxer-hysteresis-secs",
            player.default_buffer.hysteresis_seconds,
        )
        .map_err(mpv_error)?;
    Ok(())
}

pub fn control(payload: NativeControlRequest) -> Result<NativePlaybackSnapshot> {
    PLAYER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let player = slot
            .as_mut()
            .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
        ensure_session(&player.session_key, &payload.session_key)?;
        match payload.action.as_str() {
            "play" => player.mpv.set_property("pause", false).map_err(mpv_error)?,
            "pause" => player.mpv.set_property("pause", true).map_err(mpv_error)?,
            "seek" => player
                .mpv
                .command(
                    "seek",
                    &[&payload.value.max(0.0).to_string(), "absolute+exact"],
                )
                .map_err(mpv_error)?,
            "subtitleDelay" => player
                .mpv
                .set_property("sub-delay", payload.value.clamp(-60.0, 60.0))
                .map_err(mpv_error)?,
            "volume" => player
                .mpv
                .set_property("volume", payload.value.clamp(0.0, 1.0) * 100.0)
                .map_err(mpv_error)?,
            "fit" => {
                player
                    .mpv
                    .set_property("keepaspect", true)
                    .map_err(mpv_error)?;
                player
                    .mpv
                    .set_property("panscan", 0.0_f64)
                    .map_err(mpv_error)?;
            }
            "crop" => {
                player
                    .mpv
                    .set_property("keepaspect", true)
                    .map_err(mpv_error)?;
                player
                    .mpv
                    .set_property("panscan", 1.0_f64)
                    .map_err(mpv_error)?;
            }
            "stretch" => {
                player
                    .mpv
                    .set_property("keepaspect", false)
                    .map_err(mpv_error)?;
                player
                    .mpv
                    .set_property("panscan", 0.0_f64)
                    .map_err(mpv_error)?;
            }
            "zoom" => player
                .mpv
                .set_property("video-zoom", (payload.value.max(1.0)).log2())
                .map_err(mpv_error)?,
            "track" => select_track(player, payload.index, true)?,
            "deselectTrack" => select_track(player, payload.index, false)?,
            action => {
                return Err(Error::InvalidRequest(format!(
                    "unsupported native action: {action}"
                )))
            }
        }
        snapshot(player)
    })
}

pub fn layout(payload: NativeLayoutRequest) -> Result<()> {
    PLAYER.with(|slot| {
        let slot = slot.borrow();
        let player = slot
            .as_ref()
            .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
        ensure_session(&player.session_key, &payload.session_key)?;
        // O mpv redimensiona a própria janela pelo hook na janela pai e refaz o quadro, também
        // com o vídeo pausado.
        place_surface(payload.x, payload.y, payload.width, payload.height)
    })
}

pub fn stats(payload: NativeSessionRequest) -> Result<NativePlaybackSnapshot> {
    PLAYER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let player = slot
            .as_mut()
            .ok_or_else(|| Error::InvalidRequest("native player is not open".into()))?;
        ensure_session(&player.session_key, &payload.session_key)?;
        snapshot(player)
    })
}

pub fn close(payload: NativeSessionRequest) -> Result<()> {
    if owns_session(&payload.session_key) {
        park_player()?;
    }
    Ok(())
}

pub fn owns_session(session_key: &str) -> bool {
    PLAYER.with(|slot| {
        slot.borrow()
            .as_ref()
            .is_some_and(|player| player.session_key == session_key)
    })
}

/// Troca de backend: destrói o handle do mpv (o `Drop` para a reprodução antes) e esconde a
/// janela, que fica para o próximo uso.
pub fn force_close() -> Result<()> {
    PLAYER.with(|slot| {
        slot.borrow_mut().take();
    });
    hide_surface();
    Ok(())
}

fn park_player() -> Result<()> {
    PLAYER.with(|slot| {
        let mut slot = slot.borrow_mut();
        let Some(player) = slot.as_mut() else {
            return Ok(());
        };
        // Mantém o handle do mpv entre uma fonte e outra; só a janela de vídeo dele fecha com o `stop`.
        player.mpv.command("stop", &[]).map_err(mpv_error)?;
        hide_surface();
        player.session_key.clear();
        player.tracks.clear();
        player.track_targets.clear();
        player.tracks_dirty = true;
        player.error = None;
        Ok(())
    })
}

// Cebola: "chapter-list" do mpv, lido item a item (título e início em segundos).
fn mpv_chapters(mpv: &Mpv) -> Vec<crate::models::NativeChapter> {
    let count = property::<i64>(mpv, "chapter-list/count")
        .unwrap_or(0)
        .clamp(0, 200);
    (0..count)
        .filter_map(|index| {
            let start_seconds = property::<f64>(mpv, &format!("chapter-list/{index}/time"))?;
            let title =
                property::<String>(mpv, &format!("chapter-list/{index}/title")).unwrap_or_default();
            Some(crate::models::NativeChapter {
                title,
                start_seconds,
            })
        })
        .collect()
}

fn snapshot(player: &mut MpvPlayer) -> Result<NativePlaybackSnapshot> {
    drain_events(player)?;
    if let Some(error) = player.error.clone() {
        return Err(Error::Pipeline(error));
    }
    if player.tracks_dirty {
        refresh_tracks(player);
        player.tracks_dirty = false;
    }
    let position = property::<f64>(&player.mpv, "time-pos")
        .unwrap_or(0.0)
        .max(0.0);
    let duration = property::<f64>(&player.mpv, "duration")
        .unwrap_or(0.0)
        .max(0.0);
    let buffered = property::<f64>(&player.mpv, "demuxer-cache-time")
        .unwrap_or(position)
        .max(position)
        .min(duration.max(position));
    // O mpv apresenta os quadros por conta própria, sem expor um contador de quadros mostrados:
    // `estimated-frame-number` (número do quadro atual, estimado) faz o papel, e a taxa medida
    // sai da diferença entre duas leituras.
    let rendered = property::<i64>(&player.mpv, "estimated-frame-number")
        .unwrap_or(0)
        .max(0) as u64;
    let dropped = property::<i64>(&player.mpv, "frame-drop-count")
        .unwrap_or(0)
        .max(0) as u64;
    let now = Instant::now();
    let elapsed = now.duration_since(player.last_sample_at).as_secs_f64();
    if elapsed >= 0.5 {
        player.measured_fps = rendered.saturating_sub(player.last_presented_frames) as f64 / elapsed;
        player.last_presented_frames = rendered;
        player.last_sample_at = now;
    }
    let video_width = property::<i64>(&player.mpv, "video-params/w")
        .unwrap_or(0)
        .max(0) as u32;
    let video_height = property::<i64>(&player.mpv, "video-params/h")
        .unwrap_or(0)
        .max(0) as u32;
    let paused = property::<bool>(&player.mpv, "pause").unwrap_or(true);
    // `video-codec` saiu das versões novas do mpv; a faixa de vídeo selecionada tem o mesmo dado.
    let decoder = property::<String>(&player.mpv, "current-tracks/video/codec")
        .or_else(|| property::<String>(&player.mpv, "video-codec"))
        .unwrap_or_default();
    let hwdec =
        property::<String>(&player.mpv, "hwdec-current").unwrap_or_else(|| "software".into());
    // Bytes de pacotes à frente da posição atual; `cache-used` (em KiB) só existe em mpv antigo.
    let encoded_bytes_buffered = property::<i64>(&player.mpv, "demuxer-cache-state/fw-bytes")
        .or_else(|| property::<i64>(&player.mpv, "cache-used").map(|kib| kib.saturating_mul(1024)))
        .unwrap_or(0)
        .max(0) as u64;
    Ok(NativePlaybackSnapshot {
        duration_seconds: duration,
        current_time_seconds: position,
        buffered_seconds: buffered,
        playing: !paused,
        video_width,
        video_height,
        tracks: player.tracks.clone(),
        presented_frames: rendered,
        dropped_frames: dropped,
        measured_fps: player.measured_fps,
        hardware_backend: format!("mpv:{hwdec}:{decoder}:win32-wid"),
        encoded_bytes_buffered,
        average_frame_processing_us: 0.0,
        chapters: mpv_chapters(&player.mpv),
    })
}

fn refresh_tracks(player: &mut MpvPlayer) {
    let count = property::<i64>(&player.mpv, "track-list/count")
        .unwrap_or(0)
        .max(0);
    let mut tracks = Vec::with_capacity(count as usize);
    let mut targets = Vec::with_capacity(count as usize);
    for source_index in 0..count {
        let prefix = format!("track-list/{source_index}");
        let track_type =
            property::<String>(&player.mpv, &format!("{prefix}/type")).unwrap_or_default();
        let kind = match track_type.as_str() {
            "video" => TrackKind::Video,
            "audio" => TrackKind::Audio,
            "sub" => TrackKind::Subtitle,
            _ => continue,
        };
        let mpv_id = property::<i64>(&player.mpv, &format!("{prefix}/id")).unwrap_or(source_index);
        let public_index = tracks.len() as i32;
        let language = property::<String>(&player.mpv, &format!("{prefix}/lang"))
            .unwrap_or_else(|| "und".into());
        let title = property::<String>(&player.mpv, &format!("{prefix}/title")).unwrap_or_default();
        let codec = property::<String>(&player.mpv, &format!("{prefix}/codec")).unwrap_or_default();
        let selected =
            property::<bool>(&player.mpv, &format!("{prefix}/selected")).unwrap_or(false);
        tracks.push(NativeTrackInfo {
            id: format!("mpv-{track_type}-{mpv_id}"),
            index: public_index,
            kind,
            language: language.clone(),
            label: if title.is_empty() {
                if language == "und" {
                    track_type.clone()
                } else {
                    language.to_uppercase()
                }
            } else {
                title
            },
            codec,
            selected,
        });
        targets.push(TrackTarget {
            public_index,
            mpv_id,
            kind,
        });
    }
    player.tracks = tracks;
    player.track_targets = targets;
}

fn select_track(player: &mut MpvPlayer, index: i32, enabled: bool) -> Result<()> {
    let target = player
        .track_targets
        .iter()
        .find(|target| target.public_index == index)
        .cloned()
        .ok_or_else(|| Error::InvalidRequest(format!("unknown native track index {index}")))?;
    let property = match target.kind {
        TrackKind::Video => "vid",
        TrackKind::Audio => "aid",
        TrackKind::Subtitle => "sid",
    };
    let result = if enabled {
        player
            .mpv
            .set_property(property, target.mpv_id)
            .map_err(mpv_error)
    } else {
        player
            .mpv
            .set_property(property, "no".to_owned())
            .map_err(mpv_error)
    };
    if result.is_ok() {
        player.tracks_dirty = true;
    }
    result
}

/// Esvazia a fila de eventos do libmpv (no máximo 64 por consulta, para um fluxo intenso não
/// prender a thread principal). `wait_event` já devolve `Err` quando o arquivo terminou por erro.
fn drain_events(player: &mut MpvPlayer) -> Result<()> {
    for _ in 0..64 {
        let Some(event) = player.mpv.wait_event(0.0) else {
            break;
        };
        match event {
            Ok(Event::Shutdown) => {
                let message = "mpv shut down".to_owned();
                player.error = Some(message.clone());
                return Err(Error::Pipeline(message));
            }
            Ok(
                Event::StartFile
                | Event::FileLoaded
                | Event::VideoReconfig
                | Event::AudioReconfig,
            ) => player.tracks_dirty = true,
            Ok(_) => {}
            Err(error) => {
                // Erro de reprodução: fica gravado até a próxima abertura, e não só nesta consulta.
                let error = mpv_error(error);
                player.error = Some(error.to_string());
                return Err(error);
            }
        }
    }
    Ok(())
}

fn discard_pending_events(mpv: &mut Mpv) {
    for _ in 0..256 {
        if mpv.wait_event(0.0).is_none() {
            break;
        }
    }
}

fn ensure_session(active: &str, requested: &str) -> Result<()> {
    if active == requested {
        Ok(())
    } else {
        Err(Error::InvalidRequest(
            "native player session is stale".into(),
        ))
    }
}

fn property<T: libmpv2::GetData>(mpv: &Mpv, name: &str) -> Option<T> {
    mpv.get_property(name).ok()
}

fn encode_mpv_list(values: &[String]) -> String {
    values
        .iter()
        .map(|value| format!("%{}%{}", value.len(), value))
        .collect::<Vec<_>>()
        .join(",")
}

fn mpv_error(error: libmpv2::Error) -> Error {
    Error::Pipeline(format!("mpv backend: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mpv_list_encoding_preserves_commas_in_headers() {
        assert_eq!(
            encode_mpv_list(&["Cookie: a=1,b=2".into()]),
            "%15%Cookie: a=1,b=2"
        );
    }
}
