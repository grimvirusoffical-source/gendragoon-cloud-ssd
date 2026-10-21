// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Gendragoon",
    platforms: [.macOS(.v12), .iOS(.v15), .tvOS(.v15), .watchOS(.v8)],
    products: [.library(name: "Gendragoon", targets: ["Gendragoon"])],
    dependencies: [
        // On Apple platforms swift-crypto re-exports CryptoKit; elsewhere it uses BoringSSL.
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"4.0.0"),
    ],
    targets: [
        .target(name: "Gendragoon", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
        .executableTarget(name: "gd-interop", dependencies: ["Gendragoon"]),
        .testTarget(name: "GendragoonTests", dependencies: ["Gendragoon"]),
    ]
)
