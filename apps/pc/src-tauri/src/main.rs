// No Windows, o build de release é um app gráfico: sem isto abriria também uma janela de console.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
mod windows_native;
mod streaming;
use tauri::Manager;

#[cfg(target_os = "linux")]
fn configure_host_gstreamer_plugins() {
    // O AppImage isola as próprias bibliotecas. O player, porém, usa appsink, que no Ubuntu
    // vive no pacote base do GStreamer do sistema. Sem indicar esse diretório, a aplicação
    // abre mas o player termina imediatamente dizendo que appsink não existe.
    let plugin_dir = match std::env::consts::ARCH {
        "x86_64" => "/usr/lib/x86_64-linux-gnu/gstreamer-1.0",
        "aarch64" => "/usr/lib/aarch64-linux-gnu/gstreamer-1.0",
        _ => return,
    };
    if std::path::Path::new(plugin_dir).is_dir() {
        std::env::set_var("GST_PLUGIN_PATH", plugin_dir);
        std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", plugin_dir);
    }
}

#[cfg(target_os = "linux")]
fn linux_package_kind() -> &'static str {
    if std::env::var_os("APPIMAGE").is_some() {
        return "appimage";
    }
    if std::env::current_exe().is_ok_and(|path| path == std::path::Path::new("/usr/bin/cebola-pc")) {
        return "deb";
    }
    "unknown"
}

#[tauri::command]
fn installation_kind() -> &'static str {
    #[cfg(target_os = "linux")]
    return linux_package_kind();

    // O instalador do Windows é sempre o NSIS (com o GStreamer empacotado).
    #[cfg(windows)]
    return "nsis";

    #[cfg(not(any(target_os = "linux", windows)))]
    "unknown"
}

#[tauri::command]
fn current_app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

// No Linux guarda o `systemd-inhibit` em execução; no Windows, a requisição de energia ativa.
#[cfg(not(windows))]
#[derive(Default)]
struct PlaybackInhibitor(std::sync::Mutex<Option<std::process::Child>>);

#[cfg(windows)]
#[derive(Default)]
struct PlaybackInhibitor(std::sync::Mutex<Option<windows_native::PowerRequest>>);

#[tauri::command]
fn set_playback_inhibit(active: bool, state: tauri::State<'_, PlaybackInhibitor>) -> Result<(), String> {
    let mut child = state.0.lock().map_err(|_| "o inibidor de suspensão ficou indisponível")?;

    #[cfg(target_os = "linux")]
    {
        if active {
            if let Some(current) = child.as_mut() {
                if current.try_wait().map_err(|error| error.to_string())?.is_none() {
                    return Ok(());
                }
            }
            *child = Some(
                std::process::Command::new("systemd-inhibit")
                    .args([
                        "--what=idle:sleep",
                        "--mode=block",
                        "--who=Cebola",
                        "--why=Reprodução de vídeo em andamento",
                        "/bin/cat",
                    ])
                    .stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .spawn()
                    .map_err(|error| format!("não foi possível impedir a suspensão: {error}"))?,
            );
        } else if let Some(mut current) = child.take() {
            if current.try_wait().map_err(|error| error.to_string())?.is_none() {
                current.kill().map_err(|error| error.to_string())?;
                current.wait().map_err(|error| error.to_string())?;
            }
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        // Aqui `child` guarda a requisição de energia; soltá-la desfaz o bloqueio.
        if active {
            if child.is_none() {
                *child = Some(windows_native::PowerRequest::new(
                    "Reprodução de vídeo em andamento",
                )?);
            }
        } else {
            drop(child.take());
        }
        Ok(())
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = &mut child;
        if active {
            return Err("o inibidor nativo ainda não está disponível nesta plataforma".into());
        }
        Ok(())
    }
}

#[tauri::command]
fn open_linux_update_terminal() -> Result<(), String> {
    Err("Atualize a partir do código-fonte da sua instalação OpenCebola.".into())
}

fn main() {
    #[cfg(target_os = "linux")]
    configure_host_gstreamer_plugins();
    #[cfg(windows)]
    windows_native::configure_bundled_gstreamer();

    tauri::Builder::default()
        .manage(PlaybackInhibitor::default())
        .manage(std::sync::Arc::new(streaming::Streaming::default()))
        .setup(|app| { streaming::recover(app.handle()).map_err(std::io::Error::other)?; Ok(()) })
        .on_page_load(|window, _| {
            if streaming::available() { let _ = window.eval("window.__CEBOLA_LOCAL_STREAMING__ = true;"); }
        })
        .invoke_handler(tauri::generate_handler![
            streaming::streaming,
            installation_kind,
            current_app_version,
            open_linux_update_terminal,
            set_playback_inhibit
        ])
        .plugin(tauri_plugin_video::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(tauri::generate_context!())
        .expect("falha ao executar o aplicativo Cebola PC")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<std::sync::Arc<streaming::Streaming>>().shutdown();
            }
        });
}
