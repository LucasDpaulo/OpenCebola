import Capacitor
import Foundation

/// O export Next tem um index.html por rota; o router padrão do Capacitor só abre a home.
struct StaticExportRouter: Router {
    var basePath = ""

    func route(for path: String) -> String {
        let root = URL(fileURLWithPath: basePath, isDirectory: true).standardizedFileURL
        let relative = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        var target = root.appendingPathComponent(relative).standardizedFileURL
        guard target.path == root.path || target.path.hasPrefix(root.path + "/") else {
            return root.appendingPathComponent("404/index.html").path
        }
        if target.pathExtension.isEmpty { target.appendPathComponent("index.html") }
        return target.path
    }
}
