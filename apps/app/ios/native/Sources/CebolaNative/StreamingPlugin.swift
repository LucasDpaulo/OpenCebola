import Capacitor
import Foundation
import NuvioEngine
import UIKit
import WebKit

private struct StreamingFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private func deadline<T: Sendable>(_ seconds: UInt64, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            throw StreamingFailure(message: "Torrent sem resposta. Escolha outra fonte.")
        }
        defer { group.cancelAll() }
        return try await group.next()!
    }
}

/// Uma fila por aparelho: shutdown termina antes da próxima preparação ou remoção do cache.
@objc(CebolaStreamingPlugin)
public final class CebolaStreamingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CebolaStreamingPlugin"
    public let jsName = "Streaming"
    public let pluginMethods = ["capabilities", "prepare", "cancel", "stop", "stats", "cacheInfo", "clearCache", "shutdown"].compactMap {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var tail: Task<Void, Never>?
    private var preparation: Task<Void, Never>?
    private var pendingID: String?
    private var engine: NuvioEngine?
    private var session: NuvioStream?
    private var monitor: Task<Void, Never>?
    private var foreground = true
    private let reserve: UInt64 = 128 * 1024 * 1024
    private let budget: UInt64 = 10 * 1024 * 1024 * 1024
    private var observers: [NSObjectProtocol] = []
    private var root: URL { FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("cebola-streaming", isDirectory: true) }

    public override func load() {
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
                     UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.foreground else { return }
                self.foreground = false
                self.preparation?.cancel()
                self.notifyListeners("stopped", data: ["id": self.session?.id ?? "", "reason": "BACKGROUND"])
                self.enqueue(nil) { try await self.cleanup() }
            })
        }
        for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.foreground = true })
        }
        DispatchQueue.main.async { self.enqueue(nil) { try await self.cleanup() } }
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if replacesPlaybackDocument(navigationAction, currentURL: bridge?.webView?.url) {
            preparation?.cancel()
            enqueue(nil) { try await self.cleanup() }
        }
        return nil
    }

    @discardableResult
    private func enqueue(_ call: CAPPluginCall?, _ work: @escaping @MainActor () async throws -> Void) -> Task<Void, Never> {
        let previous = tail
        let task = Task { @MainActor in
            await previous?.value
            do { try await work(); call?.resolve() }
            catch { call?.reject(error.localizedDescription, "LOCAL_STREAM_FAILED") }
        }
        tail = task
        return task
    }

    private func freeBytes() throws -> UInt64 {
        let values = try FileManager.default.attributesOfFileSystem(forPath: root.deletingLastPathComponent().path)
        return (values[.systemFreeSize] as? NSNumber)?.uint64Value ?? 0
    }

    private func cleanup() async throws {
        monitor?.cancel(); monitor = nil
        await engine?.shutdown()
        engine = nil; session = nil
        if FileManager.default.fileExists(atPath: root.path) { try FileManager.default.removeItem(at: root) }
    }

    @objc public func capabilities(_ call: CAPPluginCall) {
        call.resolve(["available": NuvioEngine.protocolBackendVersion != "unavailable", "backend": "nuvio-ios"])
    }

    @objc public func prepare(_ call: CAPPluginCall) {
        guard let id = call.getString("requestId"), !id.isEmpty, id.count <= 128,
              let hash = call.getString("infoHash"), hash.range(of: "^[a-fA-F0-9]{40}$", options: .regularExpression) != nil else {
            call.reject("Fonte de torrent inválida", "INVALID_TORRENT"); return
        }
        let index = call.getInt("fileIdx")
        let filename = call.getString("filename")
        guard index == nil || (0...100000).contains(index!), (filename?.utf8.count ?? 0) <= 255 else {
            call.reject("Arquivo inválido", "INVALID_TORRENT"); return
        }
        let trackers = call.getArray("trackers", String.self) ?? []
        guard trackers.count <= 32 else { call.reject("Trackers excedem o limite", "INVALID_TORRENT"); return }
        DispatchQueue.main.async {
            self.preparation?.cancel()
            self.pendingID = id
            self.preparation = self.enqueue(nil) {
                do {
                    try Task.checkCancellation()
                    try await self.cleanup()
                    guard self.foreground else { throw CancellationError() }
                    let free = try self.freeBytes()
                    guard free > self.reserve + 128 * 1024 * 1024 else { throw StreamingFailure(message: "Pouco espaço temporário no aparelho.") }
                    let capacity = min(self.budget, (free - self.reserve) / 2)
                    let directory = self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                    let active = try await NuvioEngine.create(configuration: NuvioEngineConfiguration(
                        dataDirectory: directory.appendingPathComponent("state"), cacheDirectory: directory.appendingPathComponent("payload"),
                        memoryCacheCapacityBytes: 32 * 1024 * 1024, diskCacheCapacityBytes: capacity, torrentProfile: .soft,
                        uploadMode: .limited(bytesPerSecond: 128 * 1024), streamInactivityTimeoutMilliseconds: 0, warmTorrentTimeoutMilliseconds: 0))
                    self.engine = active
                    let validated = await safeTrackers(trackers)
                    try Task.checkCancellation()
                    var magnet = URLComponents()
                    magnet.scheme = "magnet"
                    magnet.queryItems = [URLQueryItem(name: "xt", value: "urn:btih:\(hash.lowercased())")] + validated.map { URLQueryItem(name: "tr", value: $0) }
                    guard let magnetURI = magnet.string, magnetURI.utf8.count <= 16 * 1024 else { throw StreamingFailure(message: "Trackers excedem o limite do motor.") }
                    let torrent = try await deadline(30) { try await active.addMagnet(magnetURI) }
                    let extensions: Set<String> = ["mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "m2ts", "mpg", "mpeg"]
                    let videos = try await active.files(for: torrent).filter { !$0.pathWasTruncated && extensions.contains(($0.path as NSString).pathExtension.lowercased()) }
                    guard !videos.isEmpty else { throw StreamingFailure(message: "Esta opção não contém vídeo; parece um arquivo falso.") }
                    let matches = videos.filter { file in
                        if let index { return file.index == UInt32(index) }
                        if let filename { return (file.path as NSString).lastPathComponent.caseInsensitiveCompare((filename as NSString).lastPathComponent) == .orderedSame }
                        return true
                    }
                    let selected = matches.count == 1 ? matches[0] : (index == nil && videos.count == 1 ? videos[0] : nil)
                    guard let selected else { throw StreamingFailure(message: "Addon não identificou um vídeo único.") }
                    guard selected.size <= capacity else { throw StreamingFailure(message: "Escolha um arquivo menor para o espaço disponível.") }
                    let stream = try await deadline(30) { try await active.prepareStream(torrentID: torrent, fileIndex: selected.index) }
                    self.session = stream
                    let start = ProcessInfo.processInfo.systemUptime
                    while true {
                        try Task.checkCancellation()
                        let stats = try await active.currentStats()
                        guard try self.freeBytes() >= self.reserve, !stats.diskCacheIsOverBudget else { throw StreamingFailure(message: "Espaço temporário esgotado.") }
                        if stats.totalPayloadDownloadBytes >= min(8 * 1024 * 1024, stream.fileSize) { break }
                        if ProcessInfo.processInfo.systemUptime - start >= 20 {
                            guard stats.downloadRateBytesPerSecond >= 512 * 1024 else { throw StreamingFailure(message: "Torrent lento demais. Escolha outra fonte.") }
                            break
                        }
                        try await Task.sleep(nanoseconds: 200_000_000)
                    }
                    try Task.checkCancellation()
                    self.monitor = Task { @MainActor in
                        do {
                            while !Task.isCancelled {
                                try await Task.sleep(nanoseconds: 1_000_000_000)
                                let stats = try await active.currentStats()
                                if try self.freeBytes() < self.reserve || stats.diskCacheIsOverBudget {
                                    self.notifyListeners("stopped", data: ["id": stream.id, "reason": "STORAGE_LIMIT"])
                                    self.enqueue(nil) { try await self.cleanup() }
                                    return
                                }
                            }
                        } catch { /* encerramento da sessão cancela a sondagem */ }
                    }
                    call.resolve(["id": stream.id, "url": stream.url.absoluteString, "fileIdx": stream.fileIndex,
                                  "size": stream.fileSize, "filename": (selected.path as NSString).lastPathComponent])
                } catch {
                    try? await self.cleanup()
                    call.reject(error is CancellationError ? "Preparação cancelada" : error.localizedDescription, "LOCAL_STREAM_FAILED")
                }
            }
        }
    }

    @objc public func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard call.getString("requestId") == self.pendingID else { call.resolve(); return }
            self.preparation?.cancel()
            self.enqueue(call) { try await self.cleanup() }
        }
    }
    @objc public func stop(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.enqueue(call) {
            if call.getString("id") == self.session?.id { try await self.cleanup() }
        } }
    }
    @objc public func shutdown(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.preparation?.cancel(); self.enqueue(call) { try await self.cleanup() } }
    }
    @objc public func clearCache(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.enqueue(call) {
            guard self.engine == nil else { throw StreamingFailure(message: "Encerre o vídeo antes de limpar.") }
            try await self.cleanup()
        } }
    }
    @objc public func stats(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.enqueue(nil) {
            do {
                guard call.getString("id") == self.session?.id, let engine = self.engine else { throw StreamingFailure(message: "Sessão encerrada.") }
                let stats = try await engine.currentStats()
                call.resolve(["phase": "streaming", "downloadBytesPerSecond": stats.downloadRateBytesPerSecond,
                              "uploadBytesPerSecond": stats.uploadRateBytesPerSecond, "peers": stats.connectedPeers,
                              "downloadedBytes": stats.totalPayloadDownloadBytes])
            } catch { call.reject(error.localizedDescription, "SESSION_CLOSED") }
        } }
    }
    @objc public func cacheInfo(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.enqueue(nil) {
            do {
                let stats = try await self.engine?.currentStats()
                call.resolve(["usedBytes": stats?.diskCacheUsedBytes ?? 0, "capacityBytes": stats?.diskCacheCapacityBytes ?? self.budget,
                              "protectedBytes": stats?.diskCacheProtectedBytes ?? 0])
            } catch { call.reject(error.localizedDescription, "LOCAL_STREAM_FAILED") }
        } }
    }
}
