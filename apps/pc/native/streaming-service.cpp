// Processo local exclusivo de uma sessão. stdin fechado encerra o motor e remove seus dados.
#include <nuvio_engine/nuvio_engine.h>
#include <filesystem>
#include <iostream>
#include <thread>
#include <vector>
#include <algorithm>
#include <csignal>
#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <poll.h>
#include <unistd.h>
#endif
namespace fs = std::filesystem;
using namespace std::chrono_literals;
volatile std::sig_atomic_t stopped = 0;
void check(nuvio_engine_status s) { if(s) throw std::runtime_error(nuvio_engine_status_message(s)); }
bool cancelled() {
#ifdef _WIN32
    DWORD bytes = 0;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    return stopped || input == INVALID_HANDLE_VALUE || input == nullptr ||
        !PeekNamedPipe(input, nullptr, 0, nullptr, &bytes, nullptr) || bytes > 0;
#else
    pollfd input{STDIN_FILENO, POLLIN | POLLHUP, 0};
    return stopped || (poll(&input, 1, 0) > 0 && input.revents != 0);
#endif
}
uint64_t available(const fs::path& path) {
    return fs::space(path).available;
}
// 30 s: torrent que não acha ninguém nesse tempo não vai tocar bem, e o automático precisa tentar
// a próxima opção em vez de prender a pessoa por minuto e meio.
nuvio_engine_event wait_event(nuvio_engine* engine, unsigned type) {
    const auto deadline = std::chrono::steady_clock::now() + 30s;
    while (!cancelled() && std::chrono::steady_clock::now() < deadline) {
        nuvio_engine_event e; nuvio_engine_event_init(&e);
        auto status = nuvio_engine_poll_event(engine, &e);
        if (status == NUVIO_ENGINE_STATUS_NO_EVENT) { std::this_thread::sleep_for(50ms); continue; }
        check(status);
        if(e.type == NUVIO_ENGINE_EVENT_TORRENT_ERROR) throw std::runtime_error("Torrent indisponível");
        if(e.type == type) return e;
    }
    throw std::runtime_error(cancelled() ? "Preparação cancelada" : "Torrent sem resposta: ninguém compartilhando agora");
}
std::string lower(std::string value) { std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c){return std::tolower(c);}); return value; }
int run_service(int argc, char** argv) {
    if (argc < 5 || argc > 37) return 2;
    std::signal(SIGTERM, [](int){stopped = 1;});
    std::signal(SIGINT, [](int){stopped = 1;});
    // Sem PR_SET_PDEATHSIG: ele dispara quando a THREAD que abriu o processo termina, e a ponte
    // abre o motor numa thread do pool que é reciclada segundos depois, no meio do vídeo. A morte
    // do app fecha o stdin, e isso já encerra o motor (`cancelled`).
#ifndef _WIN32
    if (getppid() == 1) return 2;
#endif
    fs::path root=fs::u8path(argv[1]);
    const std::string hash(argv[2]), hint(argv[4]);
    if(hash.size()!=40 || hash.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos) return 2;
    nuvio_engine* engine = nullptr;
    int result = 0;
    try {
        const int index = std::stoi(argv[3]);
        fs::create_directories(root);
        constexpr uint64_t reserve = 128ULL * 1024 * 1024;
        const auto free = available(root);
        if (free < reserve + 128ULL*1024*1024) throw std::runtime_error("Pouco espaço temporário no aparelho");
        const auto budget = std::min<uint64_t>(10ULL*1024*1024*1024, (free-reserve)/2);
        const auto state_utf8=(root/"state").u8string(), cache_utf8=(root/"payload").u8string();
        const std::string state(state_utf8.begin(),state_utf8.end()), cache(cache_utf8.begin(),cache_utf8.end());
        nuvio_engine_config config; nuvio_engine_config_init(&config);
        config.data_directory=state.c_str(); config.cache_directory=cache.c_str();
        config.memory_cache_capacity_bytes=32ULL*1024*1024;
        config.disk_cache_capacity_bytes=budget;
        config.upload_mode=NUVIO_ENGINE_UPLOAD_LIMITED; config.upload_limit_bytes_per_second=128*1024;
        config.warm_torrent_timeout_milliseconds=0;
        // 0 desliga a expiração por inatividade (30 s por padrão). A sessão é de uso único e morre
        // pelo stdin; com a expiração, a demora entre preparar e o player abrir (ou um player
        // parado) apagava a rota e a primeira leitura recebia 404.
        config.stream_inactivity_timeout_milliseconds=0;
        check(nuvio_engine_create(&config,&engine));
        // Trackers UDP chegam com DNS validado/fixado pela ponte Rust.
        auto magnet="magnet:?xt=urn:btih:"+hash;
        for(int i=5;i<argc;++i) {
            const std::string tracker(argv[i]);
            if(tracker.starts_with("--test-peer=127.0.0.1:")) {
                // Somente o harness nativo utiliza esta opção; a ponte não a expõe ao JavaScript.
                const auto port=std::stoi(tracker.substr(22));
                if(port<1 || port>65535) throw std::runtime_error("Porta inválida");
                magnet+="&x.pe=127.0.0.1:"+std::to_string(port); continue;
            }
            if(!tracker.starts_with("udp://") || tracker.size()>2048) continue;
            static constexpr char hex[]="0123456789ABCDEF";
            magnet+="&tr=";
            for(unsigned char c:tracker) { if(std::isalnum(c) || c=='-' || c=='_' || c=='.' || c=='~') magnet+=char(c); else {magnet+='%';magnet+=hex[c>>4];magnet+=hex[c&15];} }
        }
        if(magnet.size()>16384) throw std::runtime_error("Trackers excedem o limite do motor");
        nuvio_engine_torrent_request request; nuvio_engine_torrent_request_init(&request);
        request.magnet_uri=magnet.c_str(); uint64_t id=0;
        check(nuvio_engine_add_torrent(engine,&request,&id));
        const auto ready=wait_event(engine,NUVIO_ENGINE_EVENT_TORRENT_METADATA_READY);
        size_t count=0; check(nuvio_engine_get_file_count(engine,ready.torrent_id,&count));
        std::vector<nuvio_engine_file> videos;
        for(size_t i=0;i<count;++i) {
            nuvio_engine_file file; nuvio_engine_file_init(&file);
            check(nuvio_engine_get_file(engine,ready.torrent_id,i,&file));
            const auto ext=lower(fs::path(file.path).extension().string());
            const std::vector<std::string> supported={".mp4",".mkv",".avi",".m4v",".mov",".webm",".ts",".m2ts",".mpeg",".mpg"};
            if(!file.path_truncated && std::find(supported.begin(),supported.end(),ext)!=supported.end()) videos.push_back(file);
        }
        // Torrent sem nenhum vídeo é falso (ex.: "S01E01 1080p.exe" com seeders inflados).
        if(videos.empty()) throw std::runtime_error("Esta opção não contém vídeo; parece um arquivo falso");
        std::vector<nuvio_engine_file> selected;
        for(const auto& file:videos) {
            if(index>=0 ? file.index==unsigned(index) : (!hint.empty() && lower(fs::path(file.path).filename().string())==lower(fs::path(hint).filename().string()))) selected.push_back(file);
        }
        if(index<0 && selected.empty() && videos.size()==1) selected=videos;
        if(selected.size()!=1) throw std::runtime_error("Addon não identificou um arquivo de vídeo único");
        if(selected[0].size>budget) throw std::runtime_error("Vídeo excede o espaço temporário permitido; escolha uma versão menor");
        nuvio_engine_stream_request stream; nuvio_engine_stream_request_init(&stream);
        stream.torrent_id=ready.torrent_id; stream.file_index=selected[0].index;
        check(nuvio_engine_prepare_stream(engine,&stream,&id));
        const auto prepared=wait_event(engine,NUVIO_ENGINE_EVENT_STREAM_PREPARED);
        // Teste antes de liberar o player: o primeiro trecho precisa chegar. 8 MiB já dão alguns
        // segundos de 1080p; sem isso, em 20 s, exige ao menos 512 KiB/s. Com metadados mas sem
        // seeders de verdade, o player abria tela preta (Friends 4K CalicoSkies, 22/10).
        const auto check_until=std::chrono::steady_clock::now()+20s;
        for(;;) {
            nuvio_engine_stats stats; nuvio_engine_stats_init(&stats); check(nuvio_engine_get_stats(engine,&stats));
            if(stats.total_payload_download_bytes>=std::min<uint64_t>(8ULL*1024*1024,selected[0].size)) break;
            if(std::chrono::steady_clock::now()>=check_until) {
                if(stats.download_rate_bytes_per_second>=512ULL*1024) break;
                throw std::runtime_error("Torrent lento demais ("+std::to_string(stats.download_rate_bytes_per_second/1024)+" KB/s, "+
                    std::to_string(stats.connected_peers)+" peers)");
            }
            if(cancelled()) throw std::runtime_error("Preparação cancelada");
            std::this_thread::sleep_for(200ms);
        }
        std::cout << "{\"event\":\"ready\",\"url\":\"" << prepared.stream_url << "\",\"fileIdx\":" << prepared.file_index << ",\"size\":" << prepared.file_size << "}" << std::endl;
        while(!cancelled()) {
            nuvio_engine_stats stats; nuvio_engine_stats_init(&stats); check(nuvio_engine_get_stats(engine,&stats));
            if(available(root)<reserve || stats.disk_cache_over_budget) {
                std::cout << "{\"event\":\"stopped\",\"reason\":\"STORAGE_LIMIT\"}" << std::endl; break;
            }
            std::cout << "{\"event\":\"stats\",\"phase\":\"streaming\",\"downloadBytesPerSecond\":" << stats.download_rate_bytes_per_second
                << ",\"uploadBytesPerSecond\":" << stats.upload_rate_bytes_per_second << ",\"peers\":" << stats.connected_peers
                << ",\"downloadedBytes\":" << stats.total_payload_download_bytes << ",\"usedBytes\":" << stats.disk_cache_used_bytes
                << ",\"capacityBytes\":" << budget << ",\"protectedBytes\":" << stats.disk_cache_protected_bytes << "}" << std::endl;
            for(int i=0;i<10 && !cancelled();++i) std::this_thread::sleep_for(100ms);
        }
    } catch(const std::exception& error) { std::cerr << error.what() << std::endl; result=1; }
    if(engine) nuvio_engine_destroy(engine);
    std::error_code ec; fs::remove_all(root,ec);
    return ec ? 1 : result;
}

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    // Command do Rust usa UTF-16; a API do Nuvio usa UTF-8, inclusive nos diretórios.
    std::vector<std::string> values;
    std::vector<char*> pointers;
    values.reserve(argc);
    for(int i=0;i<argc;++i) {
        const int size=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,argv[i],-1,nullptr,0,nullptr,nullptr);
        if(size<=0) return 2;
        std::string value(size,'\0');
        if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,argv[i],-1,value.data(),size,nullptr,nullptr)) return 2;
        value.pop_back(); values.push_back(std::move(value));
    }
    for(auto& value:values) pointers.push_back(value.data());
    return run_service(argc,pointers.data());
}
#else
int main(int argc,char** argv) { return run_service(argc,argv); }
#endif
