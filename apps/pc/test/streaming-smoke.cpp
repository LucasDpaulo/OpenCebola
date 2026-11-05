// Teste Linux real: seeder BitTorrent local -> Nuvio -> HTTP Range -> bytes conferidos.
#include <nuvio_engine/nuvio_engine.h>
#include <libtorrent/session.hpp>
#include <libtorrent/settings_pack.hpp>
#include <libtorrent/create_torrent.hpp>
#include <libtorrent/torrent_info.hpp>
#include <libtorrent/magnet_uri.hpp>
#include <libtorrent/add_torrent_params.hpp>
#include <libtorrent/bencode.hpp>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <thread>
#include <vector>
#include <cstring>
#include <sys/wait.h>
#include <unistd.h>
#include <mpv/client.h>
#include <csignal>
#include <memory>
namespace fs = std::filesystem;
namespace lt = libtorrent;
using namespace std::chrono_literals;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void check(nuvio_engine_status status) { require(status == 0, nuvio_engine_status_message(status)); }
nuvio_engine_event wait_event(nuvio_engine* engine, unsigned type) {
    auto deadline = std::chrono::steady_clock::now() + 40s;
    while (std::chrono::steady_clock::now() < deadline) {
        nuvio_engine_event event; nuvio_engine_event_init(&event);
        auto status = nuvio_engine_poll_event(engine, &event);
        if (status == NUVIO_ENGINE_STATUS_NO_EVENT) { std::this_thread::sleep_for(20ms); continue; }
        check(status);
        require(event.type != NUVIO_ENGINE_EVENT_TORRENT_ERROR, event.message);
        if (event.type == type) return event;
    }
    throw std::runtime_error("tempo de espera do evento excedido");
}
void read_range(const char* url, const fs::path& output, const char* range) {
    const auto file = output.string();
    auto pid = fork(); require(pid >= 0, "fork falhou");
    if (pid == 0) {
        execlp("curl", "curl", "--fail", "--silent", "--show-error", "--max-time", "40",
            "--range", range, "--output", file.c_str(), url, static_cast<char*>(nullptr));
        _exit(127);
    }
    int status = 0; require(waitpid(pid, &status, 0) == pid && WIFEXITED(status) && WEXITSTATUS(status) == 0, "HTTP Range falhou");
}
volatile std::sig_atomic_t interrupted = 0;
void play_video(const char* url, bool automatic) {
    std::unique_ptr<mpv_handle, decltype(&mpv_terminate_destroy)> player(mpv_create(), mpv_terminate_destroy);
    require(player != nullptr, "mpv_create falhou");
    mpv_set_option_string(player.get(), "terminal", "yes");
    mpv_set_option_string(player.get(), "input-default-bindings", "yes");
    mpv_set_option_string(player.get(), "input-vo-keyboard", "yes");
    mpv_set_option_string(player.get(), "osc", "yes");
    mpv_set_option_string(player.get(), "title", "Cebola — teste real do motor Nuvio");
    mpv_set_option_string(player.get(), "volume", "15");
    mpv_set_option_string(player.get(), "keep-open", "no");
    require(mpv_initialize(player.get()) >= 0, "mpv_initialize falhou");
    const char* load[] = {"loadfile", url, nullptr};
    require(mpv_command(player.get(), load) >= 0, "mpv loadfile falhou");
    bool loaded = false, decoded = false, advanced = false, returned = false;
    int stage = 0;
    auto start = std::chrono::steady_clock::now();
    auto deadline = start + 30s;
    while (!interrupted) {
        auto* event = mpv_wait_event(player.get(), 0.1);
        if (event->event_id == MPV_EVENT_SHUTDOWN) break;
        if (event->event_id == MPV_EVENT_FILE_LOADED) {
            loaded = true; start = std::chrono::steady_clock::now();
            std::cout << "PASS player abriu a URL HTTP do Nuvio" << std::endl;
        }
        if (event->event_id == MPV_EVENT_END_FILE) {
            auto* end = static_cast<mpv_event_end_file*>(event->data);
            require(end->reason != MPV_END_FILE_REASON_ERROR, mpv_error_string(end->error));
            break;
        }
        double position = 0; int64_t width = 0;
        mpv_get_property(player.get(), "time-pos", MPV_FORMAT_DOUBLE, &position);
        mpv_get_property(player.get(), "video-out-params/w", MPV_FORMAT_INT64, &width);
        if (loaded && width > 0 && position > 0.5 && !decoded) {
            decoded = true;
            std::cout << "PASS vídeo decodificado, largura=" << width << std::endl;
        }
        if (!automatic) continue;
        auto elapsed = std::chrono::steady_clock::now() - start;
        if (decoded && elapsed > 2s && stage == 0) {
            const char* seek[] = {"seek", "75", "absolute+exact", nullptr};
            require(mpv_command(player.get(), seek) >= 0, "seek para frente falhou"); stage = 1;
        }
        if (stage == 1 && position >= 74) { advanced = true; stage = 2; std::cout << "PASS avanço para 75 s" << std::endl; }
        if (stage == 2 && elapsed > 5s) {
            const char* seek[] = {"seek", "10", "absolute+exact", nullptr};
            require(mpv_command(player.get(), seek) >= 0, "seek para trás falhou"); stage = 3;
        }
        if (stage == 3 && position >= 9 && position < 20) { returned = true; stage = 4; std::cout << "PASS retorno para 10 s" << std::endl; }
        if (stage == 4 && elapsed > 8s) break;
        require(std::chrono::steady_clock::now() < deadline, "tempo de reprodução excedido");
    }
    if (automatic) require(decoded && advanced && returned, "teste de reprodução incompleto");
}
int main(int argc, char** argv) {
    const bool video = argc >= 3 && std::string(argv[1]) == "--video";
    const bool automatic = argc >= 4 && std::string(argv[3]) == "--auto-test";
    std::signal(SIGINT, [](int) { interrupted = 1; });
    std::signal(SIGTERM, [](int) { interrupted = 1; });

    char pattern[] = "/tmp/cebola-p2p-smoke-XXXXXX";
    char* created = mkdtemp(pattern);
    if (!created) return 1;
    const fs::path root(created);
    nuvio_engine* engine = nullptr;
    try {
        fs::create_directories(root / "seed");
        std::vector<char> content(8 * 1024 * 1024);
        for (size_t i = 0; i < content.size(); ++i) content[i] = char((i * 31 + i / 997) % 251);
        const auto filename = video ? "sample.mp4" : "sample.bin";
        if (video) {
            require(fs::file_size(argv[2]) <= 64 * 1024 * 1024, "vídeo do teste deve ter até 64 MiB");
            std::ifstream file(argv[2], std::ios::binary);
            content.assign(std::istreambuf_iterator<char>(file), {});
            require(content.size() >= 131072, "vídeo de teste ausente ou pequeno demais");
        }
        { std::ofstream file(root / "seed" / filename, std::ios::binary); file.write(content.data(), content.size()); }
        lt::file_storage files; files.add_file(filename, content.size());
        lt::create_torrent torrent(files, 16 * 1024, lt::create_torrent::v1_only);
        lt::set_piece_hashes(torrent, (root / "seed").string());
        std::vector<char> metadata; lt::bencode(std::back_inserter(metadata), torrent.generate());
        lt::settings_pack settings;
        settings.set_str(lt::settings_pack::listen_interfaces, "127.0.0.1:0");
        settings.set_bool(lt::settings_pack::enable_dht, false);
        settings.set_bool(lt::settings_pack::enable_lsd, false);
        settings.set_bool(lt::settings_pack::enable_upnp, false);
        settings.set_bool(lt::settings_pack::enable_natpmp, false);
        lt::session seeder(settings);
        lt::add_torrent_params source;
        source.ti = std::make_shared<lt::torrent_info>(metadata.data(), int(metadata.size()));
        source.save_path = (root / "seed").string();
        source.flags &= ~lt::torrent_flags::paused;
        source.flags &= ~lt::torrent_flags::auto_managed;
        auto seed = seeder.add_torrent(source);
        for (int i = 0; seeder.listen_port() == 0 && i < 100; ++i) std::this_thread::sleep_for(50ms);
        require(seeder.listen_port() != 0, "seeder sem porta");
        auto magnet = lt::make_magnet_uri(seed) + "&x.pe=127.0.0.1:" + std::to_string(seeder.listen_port());
        if (argc >= 5) {
            int input[2], output[2];
            require(pipe(input)==0 && pipe(output)==0, "pipe falhou");
            const auto hash=magnet.substr(magnet.find("btih:")+5,40);
            const auto session_root=(root/"service").string();
            const auto peer="--test-peer=127.0.0.1:"+std::to_string(seeder.listen_port());
            const auto pid=fork(); require(pid>=0,"fork falhou");
            if(pid==0) {
                dup2(input[0],STDIN_FILENO);dup2(output[1],STDOUT_FILENO);
                close(input[0]);close(input[1]);close(output[0]);close(output[1]);
                execl(argv[4],argv[4],session_root.c_str(),hash.c_str(),"0",filename,peer.c_str(),static_cast<char*>(nullptr)); _exit(127);
            }
            close(input[0]);close(output[1]);
            FILE* messages=fdopen(output[0],"r");
            char line[4096]{};
            require(fgets(line,sizeof(line),messages)!=nullptr,"serviço não preparou a fonte");
            const std::string ready(line), key="\"url\":\"";
            const auto begin=ready.find(key);require(begin!=std::string::npos,"resposta inválida");
            const auto end=ready.find('"',begin+key.size());
            const auto url=ready.substr(begin+key.size(),end-begin-key.size());
            require(url.starts_with("http://127.0.0.1:"),"URL inválida");
            for(size_t offset:{size_t(0),content.size()-65536}) {
                const auto range=std::to_string(offset)+"-"+std::to_string(offset+65535);
                read_range(url.c_str(),root/"received",range.c_str());
                std::ifstream file(root/"received",std::ios::binary);
                std::vector<char> actual((std::istreambuf_iterator<char>(file)),{});
                require(actual.size()==65536 && std::equal(actual.begin(),actual.end(),content.begin()+offset),"bytes do serviço divergentes");
            }
            if(video) play_video(url.c_str(),automatic);
            close(input[1]);
            while(fgets(line,sizeof(line),messages)) {}
            fclose(messages);
            int status=0;require(waitpid(pid,&status,0)==pid && WIFEXITED(status) && WEXITSTATUS(status)==0,"shutdown do serviço falhou");
            require(!fs::exists(session_root),"serviço deixou cache residual");
            std::cout << "PASS serviço Linux: magnet, seleção, HTTP, player e limpeza por EOF" << std::endl;
            fs::remove_all(root);
            return 0;
        }
        const auto state = (root / "client" / "state").string();
        const auto cache = (root / "client" / "cache").string();
        nuvio_engine_config config; nuvio_engine_config_init(&config);
        config.data_directory = state.c_str(); config.cache_directory = cache.c_str();
        config.disk_cache_capacity_bytes = 10ULL * 1024 * 1024 * 1024;
        config.memory_cache_capacity_bytes = 32 * 1024 * 1024;
        config.warm_torrent_timeout_milliseconds = 0;
        check(nuvio_engine_create(&config, &engine));
        std::cout << "Backend: " << nuvio_engine_protocol_backend_version() << std::endl;
        nuvio_engine_torrent_request request; nuvio_engine_torrent_request_init(&request);
        request.magnet_uri = magnet.c_str(); uint64_t id = 0;
        check(nuvio_engine_add_torrent(engine, &request, &id));
        auto ready = wait_event(engine, NUVIO_ENGINE_EVENT_TORRENT_METADATA_READY);
        nuvio_engine_stream_request stream; nuvio_engine_stream_request_init(&stream);
        stream.torrent_id = ready.torrent_id; stream.file_index = 0;
        check(nuvio_engine_prepare_stream(engine, &stream, &id));
        auto prepared = wait_event(engine, NUVIO_ENGINE_EVENT_STREAM_PREPARED);
        for (size_t offset : {size_t(0), content.size() - 65536, content.size() / 2}) {
            auto range = std::to_string(offset) + "-" + std::to_string(offset + 65535);
            read_range(prepared.stream_url, root / "received", range.c_str());
            std::ifstream file(root / "received", std::ios::binary);
            std::vector<char> actual((std::istreambuf_iterator<char>(file)), {});
            require(actual.size() == 65536 && std::equal(actual.begin(), actual.end(), content.begin() + offset), "bytes recebidos divergentes");
            std::cout << "PASS Range " << range << std::endl;
        }
        if (video) play_video(prepared.stream_url, automatic);
        nuvio_engine_stats stats; nuvio_engine_stats_init(&stats); check(nuvio_engine_get_stats(engine, &stats));
        for (int i = 0; stats.total_payload_download_bytes == 0 && i < 30; ++i) {
            std::this_thread::sleep_for(100ms);
            check(nuvio_engine_get_stats(engine, &stats));
        }
        require(stats.total_payload_download_bytes > 0, "nenhuma transferência P2P registrada");
        std::cout << "P2P recebido: " << stats.total_payload_download_bytes << " bytes" << std::endl;
        nuvio_engine_destroy(engine); engine = nullptr;
        fs::remove_all(root / "client");
        require(!fs::exists(root / "client"), "cache residual");
        std::cout << "PASS encerramento e remoção do diretório temporário do teste" << std::endl;
    } catch (const std::exception& error) {
        if (engine) nuvio_engine_destroy(engine);
        fs::remove_all(root);
        std::cerr << error.what() << std::endl;
        return 1;
    }
    fs::remove_all(root);
}
