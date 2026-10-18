// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "GenDragoonContract",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "GenDragoonContract",
            path: "../Sources",
            sources: [
                "GDAccountContract.swift",
                "GDStorageContract.swift",
                "GDArgon2.swift",
                "GDChunkCrypto.swift",
                "GDSealedManifest.swift",
            ]
        ),
        .testTarget(
            name: "GenDragoonContractTests",
            dependencies: ["GenDragoonContract"],
            path: "Tests"
        ),
    ]
)
