import XCTest

final class ScreenPreviewTests: XCTestCase {
    func testCapturePreviewScreens() throws {
        let directory="/tmp/ios-screenshots"
        try FileManager.default.createDirectory(atPath:directory,withIntermediateDirectories:true)
        capture("sign-in",file:"sign-in.png",identifier:"sign-in-title")
        capture("account",file:"account-delete.png",identifier:"delete-account")
        capture("confirm-delete",file:"confirm-delete.png",identifier:"delete-confirm")
        capture("locked",file:"workspaces-locked.png",identifier:"workspaces-locked")
    }

    private func capture(_ mode:String,file:String,identifier:String) {
        let app=XCUIApplication()
        app.launchArguments=["-GenDragoonUIPreview",mode]
        app.launch()
        let element=app.descendants(matching:.any)[identifier]
        XCTAssertTrue(element.waitForExistence(timeout:20),"missing \(identifier)")
        let url=URL(fileURLWithPath:"/tmp/ios-screenshots/\(file)")
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to:url)
        app.terminate()
    }
}
