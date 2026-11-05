import Capacitor
import Foundation
import Libmpv
import UIKit
import AVFoundation
import WebKit

private final class VideoSurface: UIView {
    override class var layerClass: AnyClass { CAMetalLayer.self }
    override func layoutSubviews() {
        super.layoutSubviews()
        let metal = layer as! CAMetalLayer
        metal.contentsScale = window?.screen.nativeScale ?? UIScreen.main.nativeScale
        metal.drawableSize = CGSize(width: bounds.width * metal.contentsScale, height: bounds.height * metal.contentsScale)
    }
}

/// Adapta o exemplo Metal do MPVKit ao contrato Player já consumido pela interface Capacitor.
@objc(CebolaPlayerPlugin)
public final class CebolaPlayerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CebolaPlayerPlugin"
    public let jsName = "Player"
    public let pluginMethods = ["load", "resume", "pause", "seek", "stop", "status", "tracks", "chapters", "selectTrack", "setSubtitleDelay", "setBrightness", "toggleFullscreen", "exitFullscreen"].compactMap {
        CAPPluginMethod(name: $0, returnType: CAPPluginReturnPromise)
    }
    private var mpv: OpaquePointer?
    private var surface: VideoSurface?
    private var event = "abrindo"
    private var observers: [NSObjectProtocol] = []
    private var foreground = true
    private var originalBrightness: CGFloat?

    public override func load() {
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
                     UIScene.willDeactivateNotification, UIScene.didEnterBackgroundNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self, self.foreground else { return }
                self.foreground = false
                self.close()
            })
        }
        for name in [UIApplication.didBecomeActiveNotification, UIScene.didActivateNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.foreground = true })
        }
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    public override func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        if replacesPlaybackDocument(navigationAction, currentURL: bridge?.webView?.url) { close() }
        return nil
    }

    private func perform(_ call: CAPPluginCall, _ work: @escaping () throws -> [String: Any]) {
        DispatchQueue.main.async {
            do { call.resolve(try work()) }
            catch { call.reject(error.localizedDescription, "PLAYER_FAILED") }
        }
    }
    private func check(_ code: Int32) throws {
        if code < 0 { throw NSError(domain: "CebolaPlayer", code: Int(code), userInfo: [NSLocalizedDescriptionKey: String(cString: mpv_error_string(code))]) }
    }
    private func command(_ args: [String]) throws {
        guard let mpv else { throw NSError(domain: "CebolaPlayer", code: -1) }
        let values = args.map { strdup($0) }
        defer { values.forEach { free($0) } }
        var pointers = values.map { $0.map { UnsafePointer<CChar>($0) } } + [nil]
        try check(mpv_command(mpv, &pointers))
    }
    private func string(_ key: String) -> String? {
        guard let mpv, let value = mpv_get_property_string(mpv, key) else { return nil }
        defer { mpv_free(value) }
        return String(cString: value)
    }
    private func number(_ key: String) -> Double { Double(string(key) ?? "") ?? 0 }
    private func close() {
        if let mpv { mpv_terminate_destroy(mpv) }
        mpv = nil
        event = "parado"
        surface?.removeFromSuperview(); surface = nil
        bridge?.webView?.isOpaque = true
        bridge?.webView?.backgroundColor = .systemBackground
        UIApplication.shared.isIdleTimerDisabled = false
        if let originalBrightness { UIScreen.main.brightness = originalBrightness; self.originalBrightness = nil }
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    @objc public func load(_ call: CAPPluginCall) { perform(call) {
        guard self.foreground, let raw = call.getString("url"), let url = URL(string: raw),
              url.scheme == "https" || (url.scheme == "http" && url.host == "127.0.0.1"),
              let web = self.bridge?.webView, let parent = web.superview else {
            throw NSError(domain: "CebolaPlayer", code: -1, userInfo: [NSLocalizedDescriptionKey: "Fonte ou superfície inválida."])
        }
        self.close()
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
            let surface = VideoSurface(frame: parent.bounds)
            surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            parent.insertSubview(surface, belowSubview: web)
            self.surface = surface
            web.isOpaque = false; web.backgroundColor = .clear; web.scrollView.backgroundColor = .clear
            guard let mpv = mpv_create() else { throw NSError(domain: "CebolaPlayer", code: -1) }
            self.mpv = mpv
            var windowID = Int64(Int(bitPattern: Unmanaged.passUnretained(surface.layer).toOpaque()))
            try self.check(mpv_set_option(mpv, "wid", MPV_FORMAT_INT64, &windowID))
            for (key, value) in ["vo": "gpu-next", "gpu-api": "vulkan", "gpu-context": "moltenvk", "hwdec": "videotoolbox", "terminal": "no", "idle": "yes"] {
                try self.check(mpv_set_option_string(mpv, key, value))
            }
            let start = max(0, call.getDouble("startAtSeconds") ?? 0)
            try self.check(mpv_set_option_string(mpv, "start", String(start)))
            try self.check(mpv_initialize(mpv))
            try self.command(["loadfile", url.absoluteString, "replace"])
            self.event = "abrindo"
            UIApplication.shared.isIdleTimerDisabled = true
            return [:]
        } catch { self.close(); throw error }
    } }
    @objc public func stop(_ call: CAPPluginCall) { perform(call) { self.close(); return [:] } }
    @objc public func resume(_ call: CAPPluginCall) { perform(call) { try self.command(["set", "pause", "no"]); return [:] } }
    @objc public func pause(_ call: CAPPluginCall) { perform(call) { try self.command(["set", "pause", "yes"]); return [:] } }
    @objc public func seek(_ call: CAPPluginCall) { perform(call) { try self.command(["seek", String(max(0, call.getDouble("seconds") ?? 0)), "absolute+exact"]); return [:] } }
    @objc public func selectTrack(_ call: CAPPluginCall) { perform(call) {
        let id = call.getInt("id") ?? -1
        guard let type = call.getString("type"), ["audio", "subtitle"].contains(type) else { throw NSError(domain: "CebolaPlayer", code: -1) }
        try self.command(["set", type == "audio" ? "aid" : "sid", id < 0 ? "no" : String(id)]); return [:]
    } }
    @objc public func setSubtitleDelay(_ call: CAPPluginCall) { perform(call) { try self.command(["set", "sub-delay", String(call.getDouble("seconds") ?? 0)]); return [:] } }
    @objc public func setBrightness(_ call: CAPPluginCall) { perform(call) {
        if self.originalBrightness == nil { self.originalBrightness = UIScreen.main.brightness }
        UIScreen.main.brightness = CGFloat(max(0.05, min(1, call.getDouble("level") ?? 1)))
        return [:]
    } }
    @objc public func toggleFullscreen(_ call: CAPPluginCall) { call.resolve() }
    @objc public func exitFullscreen(_ call: CAPPluginCall) { call.resolve() }
    private func trackSnapshot() -> [String: Any] {
        var audio: [[String: Any]] = [], subtitles: [[String: Any]] = []
        for index in 0..<min(256, max(0, Int(number("track-list/count")))) {
            let prefix = "track-list/\(index)/"
            let type = string(prefix + "type") ?? ""
            guard type == "audio" || type == "sub" else { continue }
            let position = type == "audio" ? audio.count + 1 : subtitles.count + 1
            let track: [String: Any] = ["id": Int(number(prefix + "id")), "nome": string(prefix + "title") ?? "Faixa \(position)", "idioma": string(prefix + "lang") ?? ""]
            if type == "audio" { audio.append(track) } else { subtitles.append(track) }
        }
        return ["audio": audio, "subtitle": subtitles, "audioSelecionada": Int(string("aid") ?? "") ?? -1, "subtitleSelecionada": Int(string("sid") ?? "") ?? -1]
    }
    @objc public func tracks(_ call: CAPPluginCall) { perform(call) { self.trackSnapshot() } }
    @objc public func chapters(_ call: CAPPluginCall) { perform(call) {
        var chapters: [[String: Any]] = []
        let count = min(1000, max(0, Int(self.number("chapter-list/count"))))
        for index in 0..<count {
            chapters.append(["name": self.string("chapter-list/\(index)/title") ?? "", "startSeconds": self.number("chapter-list/\(index)/time"),
                             "endSeconds": index + 1 < count ? self.number("chapter-list/\(index + 1)/time") : self.number("duration")])
        }
        return ["chapters": chapters]
    } }
    @objc public func status(_ call: CAPPluginCall) { perform(call) {
        if let mpv = self.mpv {
            while let pointer = mpv_wait_event(mpv, 0), pointer.pointee.event_id != MPV_EVENT_NONE {
                let value = pointer.pointee
                if value.event_id == MPV_EVENT_FILE_LOADED { self.event = "tocando" }
                if value.event_id == MPV_EVENT_END_FILE, let data = value.data {
                    let end = data.assumingMemoryBound(to: mpv_event_end_file.self).pointee
                    self.event = end.error < 0 ? "erro" : "fim"
                }
            }
        }
        var result: [String: Any] = ["evento": self.event, "vout": self.number("video-params/w") > 0 ? 1 : 0,
                                    "tocando": self.mpv != nil && self.event == "tocando" && self.string("pause") == "no",
                                    "duracaoMs": self.number("duration") * 1000, "posicaoMs": self.number("time-pos") * 1000,
                                    "faixaAudioAtual": Int(self.string("aid") ?? "") ?? -1]
        if call.getBool("includeTracks") != false { result["tracks"] = self.trackSnapshot() }
        return result
    } }
}

@objc(CebolaBridgeViewController)
public final class CebolaBridgeViewController: CAPBridgeViewController {
    public override func router() -> Router { StaticExportRouter() }

    public override func capacitorDidLoad() {
        bridge?.registerPluginInstance(CebolaPlayerPlugin())
        bridge?.registerPluginInstance(CebolaStreamingPlugin())
    }
}
