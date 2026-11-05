package br.cebola.app

import android.os.SystemClock
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.WebViewListener
import com.getcapacitor.annotation.CapacitorPlugin
import com.nuvio.engine.*
import java.io.File
import java.net.InetAddress
import java.net.URI
import java.net.URLEncoder
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Uma instância por aparelho; nenhuma credencial do Cebola é enviada ao motor. */
@CapacitorPlugin(name = "Streaming")
class StreamingPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private val guard = Any()
    private var generation = 0L
    private var preparation: Job? = null
    private var requestId: String? = null
    private var monitor: Job? = null
    private var startup: Job? = null
    private var engine: NuvioEngine? = null
    private var session: NuvioStream? = null
    private var background = false
    private val diskBudget = 10L * 1024 * 1024 * 1024
    private val freeReserve = 128L * 1024 * 1024
    private class StorageLimit : Exception()
    private class PreparationFailure(message: String) : Exception(message)
    private fun storage() = TemporaryVideoStorage(context.cacheDir)
    private val navigationListener = object : WebViewListener() {
        override fun onPageStarted(webView: android.webkit.WebView) { stopAll(null) }
    }

    override fun load() {
        bridge.addWebViewListener(navigationListener)
        startup = scope.launch { lock.withLock { runCatching { cleanup() } } }
    }

    @PluginMethod
    fun capabilities(call: PluginCall) {
        val available = runCatching { NuvioEngine.protocolBackendVersion != "unavailable" }.getOrDefault(false)
        call.resolve(JSObject().put("available", available).put("backend", "nuvio-android"))
    }

    @PluginMethod
    fun prepare(call: PluginCall) {
        val id = call.getString("requestId")
        val hash = call.getString("infoHash")
        val index = call.getInt("fileIdx")
        val filename = call.getString("filename")
        val completed = AtomicBoolean(false)
        if (id.isNullOrBlank() || id.length > 128 || hash == null || !hash.matches(Regex("[a-fA-F0-9]{40}")) ||
            (index != null && index !in 0..100000) || (filename != null && filename.length > 255)) {
            call.reject("Fonte de torrent inválida", "INVALID_TORRENT"); return
        }
        synchronized(guard) {
            if (background) { call.reject("Aplicativo em segundo plano", "BACKGROUND"); return }
            val current = ++generation
            preparation?.cancel()
            requestId = id
            preparation = scope.launch {
                startup?.join()
                lock.withLock {
                    try {
                        cleanup()
                        ensureCurrent(current)
                        val capacity = minOf(diskBudget, (context.cacheDir.usableSpace - freeReserve) / 2)
                        if (capacity < 64L * 1024 * 1024) throw StorageLimit()
                        val directory = storage().begin()
                        val trackerUrls = safeTrackers(call)
                        ensureCurrent(current)
                        val magnet = "magnet:?xt=urn:btih:${hash.lowercase()}" + trackerUrls.joinToString("") {
                            "&tr=" + URLEncoder.encode(it, "UTF-8")
                        }
                        check(magnet.toByteArray().size <= 16 * 1024)
                        val active = NuvioEngine.create(NuvioEngineConfig(
                            dataDirectory = File(directory, "state"), cacheDirectory = File(directory, "payload"),
                            memoryCacheCapacityBytes = 32L * 1024 * 1024, diskCacheCapacityBytes = capacity,
                            uploadMode = NuvioUploadMode.Limited, uploadLimitBytesPerSecond = 128L * 1024,
                            torrentProfile = NuvioTorrentProfile.Soft, warmTorrentTimeoutMilliseconds = 0,
                            streamInactivityTimeoutMilliseconds = 0
                        ))
                        engine = active
                        var selectedName: String? = null
                        val stream = withTimeout(90_000) {
                            val torrent = withTimeoutOrNull(30_000) { active.addMagnet(magnet) }
                                ?: throw PreparationFailure("Torrent sem metadados após 30 segundos. Escolha outra fonte.")
                            val videos = active.files(torrent).filter {
                                !it.pathTruncated && it.path.substringAfterLast('.').lowercase() in
                                    setOf("mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "m2ts", "mpg", "mpeg")
                            }
                            if (videos.isEmpty()) throw PreparationFailure("Esta opção não contém vídeo; parece um arquivo falso")
                            val selected = if (index != null) { videos.singleOrNull { it.index == index } }
                                else { filename?.let { hint -> videos.singleOrNull {
                                    it.path.substringAfterLast('/').equals(hint.substringAfterLast('/'), ignoreCase = true)
                                } } ?: videos.singleOrNull() }
                            check(selected != null) { "Arquivo de vídeo ambíguo ou ausente" }
                            if (selected.size > capacity) throw StorageLimit()
                            selectedName = selected.path.substringAfterLast('/')
                            active.prepareStream(torrent, selected.index, selectedName)
                        }
                        ensureCurrent(current)
                        if (stream.fileSize > capacity) throw StorageLimit()
                        session = stream
                        val startedAt = SystemClock.elapsedRealtime()
                        while (true) {
                            ensureCurrent(current)
                            val stats = active.stats.value
                            if (context.cacheDir.usableSpace < freeReserve || stats.diskCacheOverBudget) throw StorageLimit()
                            val decision = StreamingReadiness.evaluate(stream.fileSize, stats.totalPayloadDownloadBytes,
                                stats.downloadRateBytesPerSecond, SystemClock.elapsedRealtime() - startedAt)
                            if (decision == StreamingReadiness.Decision.READY) break
                            if (decision == StreamingReadiness.Decision.TOO_SLOW) {
                                throw PreparationFailure("Torrent lento demais. Escolha outra fonte.")
                            }
                            delay(200)
                        }
                        monitor = scope.launch {
                            while (isActive) {
                                delay(1_000)
                                if (context.cacheDir.usableSpace < freeReserve || active.stats.value.diskCacheOverBudget) {
                                    notifyListeners("stopped", JSObject().put("id", stream.id).put("reason", "STORAGE_LIMIT"))
                                    stopAll(null)
                                    break
                                }
                            }
                        }
                        if (completed.compareAndSet(false, true)) {
                            call.resolve(JSObject().put("id", stream.id).put("url", stream.url)
                                .put("fileIdx", stream.fileIndex).put("size", stream.fileSize).put("filename", selectedName))
                        }
                    } catch (error: Throwable) {
                        withContext(NonCancellable) {
                            runCatching { cleanup() }
                            if (completed.compareAndSet(false, true)) {
                                call.reject(when (error) {
                                    is CancellationException -> "Preparação cancelada"
                                    is StorageLimit -> "Este arquivo excede o espaço temporário permitido. Escolha uma versão menor."
                                    is PreparationFailure -> error.message
                                    else -> "Não foi possível preparar o vídeo localmente"
                                }, if (error is StorageLimit) "STORAGE_LIMIT" else "LOCAL_STREAM_FAILED")
                            }
                        }
                    }
                }
            }
            preparation?.invokeOnCompletion { cause ->
                if (cause != null && completed.compareAndSet(false, true)) {
                    call.reject("Preparação cancelada", "LOCAL_STREAM_FAILED")
                }
            }
        }
    }

    private suspend fun ensureCurrent(current: Long) {
        currentCoroutineContext().ensureActive()
        synchronized(guard) { if (current != generation || background) throw CancellationException() }
    }

    /** Primeiro adaptador aceita UDP com DNS fixado em IP público. HTTP(S) aguarda transporte seguro. */
    private fun safeTrackers(call: PluginCall): List<String> {
        val values = call.getArray("trackers") ?: return emptyList()
        require(values.length() <= 32)
        val result = linkedSetOf<String>()
        for (i in 0 until values.length()) {
            val value = values.optString(i)
            if (value.length > 2048) continue
            runCatching {
                val uri = URI(value)
                if (uri.scheme != "udp" || uri.host == null || uri.port !in 1..65535 || uri.userInfo != null || uri.fragment != null) return@runCatching
                val addresses = InetAddress.getAllByName(uri.host)
                if (addresses.isEmpty() || addresses.any { !publicAddress(it) }) return@runCatching
                val ip = addresses.first().hostAddress ?: return@runCatching
                result += URI("udp", null, ip, uri.port, uri.path, uri.query, null).toASCIIString()
            }
        }
        return result.toList()
    }

    private fun publicAddress(address: InetAddress): Boolean {
        if (address.isAnyLocalAddress || address.isLoopbackAddress || address.isLinkLocalAddress ||
            address.isSiteLocalAddress || address.isMulticastAddress) return false
        val b = address.address.map { it.toInt() and 255 }
        if (b.size == 16) return b[0] in 0x20..0x3f // Unicast global, sem mapped/ULA/link-local.
        return b.size == 4 && b[0] != 0 && b[0] < 224 &&
            !(b[0] == 100 && b[1] in 64..127) && !(b[0] == 198 && b[1] in 18..19) &&
            !(b[0] == 192 && b[1] == 0) && !(b[0] == 198 && b[1] == 51 && b[2] == 100) &&
            !(b[0] == 203 && b[1] == 0 && b[2] == 113)
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        synchronized(guard) {
            if (call.getString("requestId") != requestId) { call.resolve(); return }
            stopAll(call)
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        scope.launch {
            lock.withLock {
                try {
                    if (call.getString("id") == session?.id) cleanup()
                    call.resolve()
                } catch (_: Throwable) { call.reject("Falha ao limpar vídeo temporário", "CLEANUP_FAILED") }
            }
        }
    }

    @PluginMethod
    fun stats(call: PluginCall) {
        scope.launch { lock.withLock {
            val active = engine
            if (active == null || call.getString("id") != session?.id) {
                call.reject("Sessão encerrada", "SESSION_CLOSED"); return@withLock
            }
            val stats = active.stats.value
            call.resolve(JSObject().put("phase", "streaming")
                .put("downloadBytesPerSecond", stats.downloadRateBytesPerSecond)
                .put("uploadBytesPerSecond", stats.uploadRateBytesPerSecond)
                .put("peers", stats.connectedPeers).put("downloadedBytes", stats.totalPayloadDownloadBytes))
        } }
    }

    @PluginMethod
    fun cacheInfo(call: PluginCall) {
        scope.launch { lock.withLock {
            val stats = engine?.stats?.value
            call.resolve(JSObject().put("usedBytes", stats?.diskCacheUsedBytes ?: 0)
                .put("capacityBytes", diskBudget).put("protectedBytes", stats?.diskCacheProtectedBytes ?: 0))
        } }
    }

    @PluginMethod
    fun clearCache(call: PluginCall) {
        scope.launch { lock.withLock {
            try {
                check(engine == null) { "Vídeo em reprodução" }
                storage().clear(); call.resolve()
            } catch (_: Throwable) { call.reject("Encerre o vídeo antes de limpar", "CACHE_IN_USE") }
        } }
    }

    @PluginMethod
    fun shutdown(call: PluginCall) = stopAll(call)

    private fun stopAll(call: PluginCall?) {
        val stoppedGeneration = synchronized(guard) {
            ++generation
            preparation?.cancel()
            preparation = null
            requestId = null
            generation
        }
        scope.launch {
            lock.withLock {
                try {
                    // Uma parada enfileirada antes de uma nova preparação não pode apagá-la.
                    if (synchronized(guard) { generation == stoppedGeneration }) cleanup()
                    call?.resolve()
                }
                catch (_: Throwable) { call?.reject("Não foi possível limpar o vídeo temporário", "CLEANUP_FAILED") }
            }
        }
    }

    private suspend fun cleanup() {
        monitor?.cancel(); monitor = null
        // Shutdown fecha leitores, sockets e threads antes de remover os arquivos.
        engine?.shutdown()
        engine = null
        session = null
        storage().clear()
    }

    override fun handleOnStart() { synchronized(guard) { background = false } }
    override fun handleOnResume() { synchronized(guard) { background = false } }
    private fun enterBackground() {
        if (activity?.isChangingConfigurations == true) return
        synchronized(guard) {
            if (background) return
            background = true
        }
        notifyListeners("stopped", JSObject().put("id", session?.id).put("reason", "BACKGROUND"))
        stopAll(null)
    }
    override fun handleOnPause() { enterBackground() }
    override fun handleOnStop() { enterBackground() }
    override fun handleOnDestroy() {
        bridge.removeWebViewListener(navigationListener)
        synchronized(guard) { background = true }
        stopAll(null)
        // Não cancelar o scope antes que a limpeza enfileirada termine.
        scope.launch { lock.withLock { cleanup() }; scope.cancel() }
    }
}
