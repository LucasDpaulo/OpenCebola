use serde_json::{json, Value};
use std::{io::{BufRead, BufReader}, path::PathBuf, process::{Child, Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}}, time::{Duration, Instant}};
use tauri::{Emitter, Manager};

struct Active { id: String, child: Child, root: PathBuf, stats: Value }
#[derive(Default)]
pub struct Streaming {
    active: Mutex<Option<Active>>,
    pending: Mutex<Option<String>>,
    operation: Mutex<()>,
    generation: AtomicU64,
}
fn executable() -> Result<PathBuf, String> {
    let path=std::env::current_exe().map_err(|e|e.to_string())?;
    Ok(path.with_file_name(if cfg!(windows) { "cebola-streaming-service.exe" } else { "cebola-streaming-service" }))
}
pub fn available() -> bool { cfg!(any(target_os="linux", windows)) && executable().is_ok_and(|p|p.is_file()) }

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows::Win32::{Foundation::{CloseHandle, ERROR_INVALID_PARAMETER, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE}};
    // Acesso negado é tratado conservadoramente: não apagar cache de outro processo.
    unsafe {
        match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
            Ok(handle) => {
                let exited = WaitForSingleObject(handle, 0) == WAIT_OBJECT_0;
                let _ = CloseHandle(handle);
                !exited
            },
            Err(error) => error.code() != windows::core::HRESULT::from_win32(ERROR_INVALID_PARAMETER.0),
        }
    }
}
#[cfg(target_os="linux")]
fn process_alive(pid: u32) -> bool { PathBuf::from(format!("/proc/{pid}")).exists() }
#[cfg(not(any(target_os="linux", windows)))]
fn process_alive(_pid: u32) -> bool { true }
impl Streaming {
    fn stop(&self, id: Option<&str>) -> Result<(), String> {
        let old = {
            let mut slot=self.active.lock().map_err(|_|"Sessão indisponível")?;
            if id.is_some_and(|id|slot.as_ref().is_none_or(|a|a.id!=id)) { return Ok(()); }
            slot.take()
        };
        if let Some(mut active)=old {
            drop(active.child.stdin.take()); // EOF pede shutdown ordenado do Nuvio.
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                if active.child.try_wait().map_err(|e|e.to_string())?.is_some() { break; }
                if Instant::now()>deadline { active.child.kill().map_err(|e|e.to_string())?; active.child.wait().map_err(|e|e.to_string())?; break; }
                std::thread::sleep(Duration::from_millis(50));
            }
            if active.root.exists() { std::fs::remove_dir_all(active.root).map_err(|e|e.to_string())?; }
        }
        Ok(())
    }
    pub fn shutdown(&self) { self.generation.fetch_add(1,Ordering::SeqCst); let _=self.stop(None); }
}
fn field<'a>(payload: &'a Value, name: &str)->Result<&'a str,String> { payload[name].as_str().ok_or_else(||format!("Campo inválido: {name}")) }
fn session_root(app:&tauri::AppHandle, id:&str)->Result<PathBuf,String> {
    let root=app.path().app_cache_dir().map_err(|e|e.to_string())?.join("local-streaming");
    if root.is_symlink() { return Err("Diretório temporário inválido".into()); }
    std::fs::create_dir_all(&root).map_err(|e|e.to_string())?;
    // Só remover resíduos de processos encerrados; outra janela pode estar reproduzindo.
    for entry in std::fs::read_dir(&root).map_err(|e|e.to_string())?.flatten() {
        let name=entry.file_name().to_string_lossy().into_owned();
        if let Some((pid,_))=name.split_once('-') {
            if pid.parse::<u32>().is_ok_and(|pid| !process_alive(pid)) {
                let _=std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(root.join(format!("{}-{id}",std::process::id())))
}
pub fn recover(app: &tauri::AppHandle) -> Result<(), String> { session_root(app,"startup").map(|_|()) }
#[tauri::command]
pub async fn streaming(action:String, payload:Option<Value>, app:tauri::AppHandle, state:tauri::State<'_,Arc<Streaming>>)->Result<Value,String> {
    let state=state.inner().clone(); let payload=payload.unwrap_or(json!({}));
    if action=="capabilities" { return Ok(json!({"available":available(),"backend":if cfg!(windows) {"nuvio-windows"} else {"nuvio-linux"}})); }
    if action=="cancel" {
        let id=field(&payload,"requestId")?;
        if state.pending.lock().map_err(|_|"Sessão indisponível")?.as_deref()==Some(id) { state.generation.fetch_add(1,Ordering::SeqCst); }
        let id=id.to_string();
        return tauri::async_runtime::spawn_blocking(move || {state.stop(Some(&id))?; Ok(json!(null))}).await.map_err(|e|e.to_string())?;
    }
    let generation=if action=="prepare" {
        let id=field(&payload,"requestId")?;
        if id.is_empty() || id.len()>128 || !id.bytes().all(|b|b.is_ascii_alphanumeric() || b==b'-') {return Err("Identificador inválido".into());}
        *state.pending.lock().map_err(|_|"Sessão indisponível")?=Some(id.to_string());
        state.generation.fetch_add(1,Ordering::SeqCst)+1
    } else {state.generation.load(Ordering::SeqCst)};
    tauri::async_runtime::spawn_blocking(move || {
        match action.as_str() {
            "prepare"=>prepare(payload,app,state,generation),
            "stop"=>{state.stop(Some(field(&payload,"id")?))?;Ok(json!(null))},
            "shutdown"=>{state.shutdown();Ok(json!(null))},
            "stats"|"cacheInfo"=>{
                let slot=state.active.lock().map_err(|_|"Sessão indisponível")?;
                if let Some(active)=slot.as_ref() {
                    if action=="stats" && payload["id"].as_str()!=Some(&active.id) {return Err("Sessão encerrada".into());}
                    Ok(active.stats.clone())
                } else if action=="cacheInfo" {Ok(json!({"usedBytes":0,"capacityBytes":10u64*1024*1024*1024,"protectedBytes":0}))}
                else {Err("Sessão encerrada".into())}
            },
            "clearCache"=>{
                if state.active.lock().map_err(|_|"Sessão indisponível")?.is_some(){return Err("Encerre o vídeo antes de limpar".into());}
                let _=session_root(&app,"cleanup")?; Ok(json!(null))
            },
            _=>Err("Operação desconhecida".into())
        }
    }).await.map_err(|e|e.to_string())?
}
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(ip) => {
            let b=ip.octets();
            !ip.is_private() && !ip.is_loopback() && !ip.is_link_local() && !ip.is_documentation() &&
            !ip.is_broadcast() && b[0]>0 && b[0]<224 && !(b[0]==100 && (64..=127).contains(&b[1])) &&
            !(b[0]==198 && (18..=19).contains(&b[1])) && !(b[0]==192 && b[1]==0)
        },
        std::net::IpAddr::V6(ip) => { let b=ip.segments(); b[0]&0xe000==0x2000 && !(b[0]==0x2001 && b[1]==0xdb8) }
    }
}
fn trackers(payload:&Value)->Vec<String> {
    use std::net::ToSocketAddrs;
    payload["trackers"].as_array().into_iter().flatten().take(32).filter_map(|value| {
        let raw=value.as_str()?; if raw.len()>2048{return None;}
        let mut url=url::Url::parse(raw).ok()?;
        if url.scheme()!="udp" || !url.username().is_empty() || url.password().is_some() || url.fragment().is_some(){return None;}
        let port=url.port()?; if port==0{return None;}
        let addresses:Vec<_>=(url.host_str()?,port).to_socket_addrs().ok()?.take(32).collect();
        if addresses.is_empty() || addresses.iter().any(|a|!public_ip(a.ip())){return None;}
        url.set_ip_host(addresses[0].ip()).ok()?;
        Some(url.to_string())
    }).collect()
}
fn prepare(payload:Value, app:tauri::AppHandle, state:Arc<Streaming>, generation:u64)->Result<Value,String> {
    let _operation=state.operation.lock().map_err(|_|"Sessão indisponível")?;
    let id=field(&payload,"requestId")?.to_string();
    let hash=field(&payload,"infoHash")?;
    if hash.len()!=40 || !hash.bytes().all(|b|b.is_ascii_hexdigit()) {return Err("Torrent inválido".into());}
    let index=if payload["fileIdx"].is_null(){-1}else{payload["fileIdx"].as_i64().filter(|i|(0..=100000).contains(i)).ok_or("Índice inválido")?};
    let filename=payload["filename"].as_str().unwrap_or("");
    if filename.len()>1024 || filename.contains('\0') {return Err("Nome inválido".into());}
    if generation!=state.generation.load(Ordering::SeqCst){return Err("Preparação cancelada".into());}
    state.stop(None)?;
    let root=session_root(&app,&id)?;
    let safe_trackers=trackers(&payload);
    if generation!=state.generation.load(Ordering::SeqCst){return Err("Preparação cancelada".into());}
    let mut command=Command::new(executable()?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: motor auxiliar sem console.
    }
    let mut child=command.arg(&root).arg(hash).arg(index.to_string()).arg(filename).args(safe_trackers)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e|format!("Motor local indisponível: {e}"))?;
    let stdout=child.stdout.take().ok_or("Motor sem resposta")?;
    let stderr=child.stderr.take().ok_or("Motor sem diagnóstico")?;
    let error=Arc::new(Mutex::new(String::new()));
    let errors=error.clone();
    std::thread::spawn(move || { for line in BufReader::new(stderr).lines().map_while(Result::ok) { if let Ok(mut value)=errors.lock(){ if value.len()<2048 {value.push_str(&line);} } } });
    *state.active.lock().map_err(|_|"Sessão indisponível")?=Some(Active{id:id.clone(),child,root,stats:json!({"phase":"metadata","downloadBytesPerSecond":0,"uploadBytesPerSecond":0,"peers":0,"downloadedBytes":0,"usedBytes":0,"capacityBytes":10u64*1024*1024*1024,"protectedBytes":0})});
    let (send,receive)=std::sync::mpsc::channel();
    let reader_state=state.clone(); let reader_id=id.clone();
    std::thread::spawn(move || {
        let mut reason="ENGINE_STOPPED".to_string();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let Ok(mut value)=serde_json::from_str::<Value>(&line) else {continue;};
            match value["event"].as_str().unwrap_or("") {
                "ready"=>{value["id"]=json!(reader_id);let _=send.send(value);},
                "stats"=>{if let Ok(mut slot)=reader_state.active.lock(){if let Some(active)=slot.as_mut().filter(|a|a.id==reader_id){active.stats=value;}}},
                "stopped"=>{reason=value["reason"].as_str().unwrap_or("ENGINE_STOPPED").to_string();},
                _=>{}
            }
        }
        let was_active=reader_state.active.lock().is_ok_and(|slot|slot.as_ref().is_some_and(|a|a.id==reader_id));
        let _=reader_state.stop(Some(&reader_id));
        if was_active {let _=app.emit("streaming-stopped",json!({"id":reader_id,"reason":reason}));}
    });
    let deadline=Instant::now()+Duration::from_secs(95);
    loop {
        if generation!=state.generation.load(Ordering::SeqCst) {state.stop(Some(&id))?;return Err("Preparação cancelada".into());}
        match receive.recv_timeout(Duration::from_millis(100)) {
            Ok(value)=>return Ok(value),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>{let _=state.stop(Some(&id));let message=error.lock().map(|s|s.clone()).unwrap_or_default();return Err(if message.is_empty(){"O torrent não respondeu; tente outra fonte".into()}else{message});},
            _=>{}
        }
        if Instant::now()>deadline {state.stop(Some(&id))?;return Err("Tempo de preparação excedido; tente outra fonte".into());}
    }
}
