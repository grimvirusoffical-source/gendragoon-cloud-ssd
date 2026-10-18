import XCTest

final class ScreenPreviewTests: XCTestCase {
    func testCapturePreviewScreens() throws {
        let primary="/tmp/ios-screenshots"
        try FileManager.default.createDirectory(atPath:primary,withIntermediateDirectories:true)
        if let extra=screenshotDirectory() {
            try FileManager.default.createDirectory(atPath:extra,withIntermediateDirectories:true)
        }
        try capture("sign-in",file:"sign-in.png",identifier:"sign-in-title")
        try capture("account",file:"account-delete.png",identifier:"delete-account")
        try capture("confirm-delete",file:"confirm-delete.png",identifier:"delete-confirm")
        try capture("locked",file:"workspaces-locked.png",identifier:"workspaces-locked")
    }

    private func capture(_ mode:String,file:String,identifier:String) throws {
        let app=XCUIApplication()
        app.launchArguments=["-GenDragoonUIPreview",mode]
        app.launch()
        let element=app.descendants(matching:.any)[identifier]
        XCTAssertTrue(element.waitForExistence(timeout:20),"missing \(identifier)")
        let screenshot=XCUIScreen.main.screenshot()
        let attachment=XCTAttachment(screenshot:screenshot)
        attachment.lifetime = .keepAlways
        attachment.name=file
        add(attachment)
        let png=screenshot.pngRepresentation
        try png.write(to:URL(fileURLWithPath:"/tmp/ios-screenshots/\(file)"))
        if let extra=screenshotDirectory() {
            try png.write(to:URL(fileURLWithPath:extra).appendingPathComponent(file))
        }
        app.terminate()
    }

    private func screenshotDirectory()->String? {
        let environment=ProcessInfo.processInfo.environment
        for key in ["IOS_SCREENSHOT_DIR","TEST_RUNNER_IOS_SCREENSHOT_DIR"] {
            if let value=environment[key],!value.isEmpty {return value}
        }
        return nil
    }
}
