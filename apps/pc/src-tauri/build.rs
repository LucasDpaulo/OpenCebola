fn main() {
    // Windows: o mpv de reserva usa libmpv-2.dll (empacotada ao lado do .exe). Ela puxa a
    // vulkan-1.dll do driver gráfico, que nem todo Windows tem. Carregada na inicialização, a falta
    // de qualquer uma das duas impediria o app inteiro de abrir, até quem só usa o GStreamer. Com
    // carga sob demanda o app abre sempre, e o plugin confere a DLL antes da primeira reprodução
    // com mpv (tauri-plugin-video, desktop/windows_mpv.rs) e devolve um erro claro se faltar.
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rustc-link-lib=delayimp");
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:libmpv-2.dll");
    }
    tauri_build::build()
}
