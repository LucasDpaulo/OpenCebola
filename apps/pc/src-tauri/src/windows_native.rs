//! Partes do `main.rs` que só existem no Windows: GStreamer empacotado e bloqueio de suspensão.

use std::path::{Path, PathBuf};

use windows::{
    core::PWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{
            Power::{
                PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
                PowerRequestSystemRequired, PowerSetRequest,
            },
            Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0},
        },
    },
};

// Valor de POWER_REQUEST_CONTEXT_VERSION (winbase.h); evita puxar a feature SystemServices só por isso.
const POWER_REQUEST_CONTEXT_VERSION: u32 = 0;

/// Aponta o GStreamer para o runtime empacotado no instalador (`<exe>\gstreamer\...`).
///
/// Precisa rodar antes de qualquer uso do GStreamer (o plugin de vídeo chama `gst::init()` só no
/// primeiro vídeo). As DLLs do núcleo ficam ao lado do executável e o Windows as encontra pelo
/// diretório da aplicação; aqui só configuramos plugins, scanner, módulos do GIO e o registro.
/// Sem a pasta `gstreamer\plugins` (build de desenvolvimento) nada muda e vale o GStreamer do sistema.
pub fn configure_bundled_gstreamer() {
    let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
    else {
        return;
    };
    let root = exe_dir.join("gstreamer");
    let plugins = root.join("plugins");
    if !plugins.is_dir() {
        return;
    }

    // Os três nomes, para que uma variável herdada do ambiente não acrescente plugins do sistema.
    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &plugins);
    std::env::set_var("GST_PLUGIN_PATH_1_0", &plugins);
    std::env::set_var("GST_PLUGIN_PATH", &plugins);

    let scanner = root.join("gst-plugin-scanner.exe");
    if scanner.is_file() {
        std::env::set_var("GST_PLUGIN_SCANNER_1_0", &scanner);
        std::env::set_var("GST_PLUGIN_SCANNER", &scanner);
        // O scanner mora em `gstreamer\`, mas suas DLLs ficam ao lado do executável: o Windows
        // procura primeiro na pasta do próprio scanner e depois no PATH. Sem isto ele não abre,
        // e os plugins deixariam de ser descobertos.
        prepend_to_path(&exe_dir);
    }

    let gio_modules = root.join("gio-modules");
    if gio_modules.is_dir() {
        // Backend TLS do GIO (souphttpsrc em https).
        std::env::set_var("GIO_MODULE_DIR", &gio_modules);
    }

    // Registro próprio, fora da pasta de instalação, para não misturar com o de um GStreamer
    // instalado no sistema.
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let dir = PathBuf::from(local_app_data).join("cebola");
        if std::fs::create_dir_all(&dir).is_ok() {
            std::env::set_var("GST_REGISTRY_1_0", dir.join("gstreamer-registry.bin"));
        }
    }
}

fn prepend_to_path(dir: &Path) {
    let mut paths = vec![dir.to_path_buf()];
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    if let Ok(joined) = std::env::join_paths(paths) {
        std::env::set_var("PATH", joined);
    }
}

/// Requisição de energia do Windows que mantém tela e sistema ativos enquanto existir.
///
/// Diferente de `SetThreadExecutionState`, não fica presa à thread que atendeu o comando do
/// Tauri: o HANDLE vale para o processo e a requisição some se o app fechar.
pub struct PowerRequest(HANDLE);

// O HANDLE de uma requisição de energia é um objeto do kernel, utilizável de qualquer thread.
unsafe impl Send for PowerRequest {}

impl PowerRequest {
    pub fn new(reason: &str) -> Result<Self, String> {
        let mut reason: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: POWER_REQUEST_CONTEXT_VERSION,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: PWSTR(reason.as_mut_ptr()),
            },
        };
        // `reason` vive até o fim da função, e o Windows copia a string durante a chamada.
        let handle = unsafe { PowerCreateRequest(&context) }
            .map_err(|error| format!("não foi possível criar a requisição de energia: {error}"))?;
        let request = Self(handle);
        for kind in [PowerRequestDisplayRequired, PowerRequestSystemRequired] {
            // Em caso de erro, `request` é descartado e desfaz o que já foi ativado.
            unsafe { PowerSetRequest(request.0, kind) }
                .map_err(|error| format!("não foi possível impedir a suspensão: {error}"))?;
        }
        Ok(request)
    }
}

impl Drop for PowerRequest {
    fn drop(&mut self) {
        unsafe {
            // Limpar um tipo que não foi ativado só devolve erro; ignorar é seguro.
            let _ = PowerClearRequest(self.0, PowerRequestDisplayRequired);
            let _ = PowerClearRequest(self.0, PowerRequestSystemRequired);
            let _ = CloseHandle(self.0);
        }
    }
}
