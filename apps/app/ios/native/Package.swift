// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CebolaNative",
    platforms: [.iOS("16.1")],
    products: [.library(name: "CebolaNative", targets: ["CebolaNative"])],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(path: "../../../../third_party/nuvio-engine/platform/apple"),
        .package(path: "../../../../third_party/mpvkit")
    ],
    targets: [.target(name: "CebolaNative", dependencies: [
        .product(name: "Capacitor", package: "capacitor-swift-pm"),
        .product(name: "NuvioEngine", package: "apple"),
        .product(name: "MPVKit", package: "mpvkit")
    ])],
    swiftLanguageModes: [.v5]
)
