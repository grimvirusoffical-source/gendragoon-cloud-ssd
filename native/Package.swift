// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "GenDragoonContract",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "GenDragoonContract",
            path: "Sources",
            exclude: ["GenDragoonMain.swift"]
        ),
        .testTarget(
            name: "GenDragoonContractTests",
            dependencies: ["GenDragoonContract"],
            path: "ContractTests/Tests"
        ),
    ]
)
