import Foundation
import SwiftUI

/// DEBUG-only launch argument `-GenDragoonUIPreview` with `sign-in`, `account`, `confirm-delete`, `deletion-support`, `locked`, `lapsed`, or `grace`.
/// Screenshot runs use mock data and never contact Google or the cloud.
enum UIPreview {
    static var screen:String? {
        #if DEBUG
        let args=ProcessInfo.processInfo.arguments
        guard let index=args.firstIndex(of:"-GenDragoonUIPreview"),index+1<args.count else {return nil}
        let value=args[index+1]
        switch value {
        case "sign-in","account","confirm-delete","deletion-support","locked","lapsed","grace": return value
        default: return nil
        }
        #else
        return nil
        #endif
    }
    static var lock:WorkspaceLock {
        let raw="{\"error\":\"workspace_lock\",\"reason\":\"over_cap\",\"overBy\":1,\"unpaidWorkspaceIds\":[\"11111111-1111-1111-1111-111111111111\"]}"
        let photos=WorkspaceLock.Item(workspaceID:"11111111-1111-1111-1111-111111111111",name:"Photos",issue:nil)
        return WorkspaceLock.fromLockBody(raw).named([photos])
    }
    /// `workspace-lock/byo-lapsed` at 0715b1a. One unpaid BYO workspace.
    static var byoLapsed:WorkspaceLock {
        let raw="{\"error\":\"workspace_lock\",\"reason\":\"lapsed\",\"overBy\":0,\"unpaidWorkspaceIds\":[\"11111111-1111-4111-8111-000000000022\"]}"
        let byo=WorkspaceLock.Item(workspaceID:"11111111-1111-4111-8111-000000000022",name:"BYO storage",issue:nil)
        return WorkspaceLock.fromLockBody(raw).named([byo])
    }
}

@MainActor struct AccountSettingsForm:View {
    @EnvironmentObject private var session:MobileSession
    @EnvironmentObject private var cloud:MobileCloudModel
    @Binding var confirmReset:Bool
    var close:()->Void
    var delete:()->Void
    @State private var endpoint=""
    @State private var bucket=""
    @State private var access=""
    @State private var secret=""
    @State private var notice=""
    var body:some View {
        Form{
            Section("Google account"){
                Text(session.email.isEmpty ? "preview@example.com" : session.email).textSelection(.enabled).accessibilityIdentifier("account-settings")
                Button("Reset App",role:.destructive){confirmReset=true}.disabled(cloud.busy)
                Button("Delete account",role:.destructive){delete()}.disabled(cloud.busy||cloud.transferring).accessibilityIdentifier("delete-account")
                Button("Sign out",role:.destructive){cloud.pause();close();session.signOut()}.disabled(cloud.busy)
            }
            if ByoFeature.showInSettings {
                Section("Bring-your-own storage"){
                    TextField("S3-compatible endpoint",text:$endpoint).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Bucket",text:$bucket).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Access key",text:$access).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Secret key",text:$secret)
                    Button("Save on this device"){
                        do { try session.saveByo(endpoint:endpoint,bucket:bucket,access:access,secret:secret);secret="";notice="S3-compatible keys are stored on this device." }
                        catch { notice=error.localizedDescription }
                    }
                    Text("SFTP — \(ByoMessages.comingSoon)").foregroundStyle(.secondary)
                    Text("Azure — \(ByoMessages.comingSoon)").foregroundStyle(.secondary)
                    Text("WebDAV — \(ByoMessages.comingSoon)").foregroundStyle(.secondary)
                    Text("Keys stay on this device. SFTP, Azure, and WebDAV are not available yet.").font(.footnote).foregroundStyle(.secondary)
                    if !notice.isEmpty { Text(notice).font(.footnote) }
                }
            }
            Section("Transfers"){
                Toggle("Data saver",isOn:$cloud.dataSaver)
                Text("Cellular, constrained networks and Low Power Mode reduce concurrency automatically. Higher paid worker limits do not change your carrier speed.").font(.footnote).foregroundStyle(.secondary)
            }
            Section("About"){
                Text("GenDragoon 1.0")
                Link("Privacy Notice",destination:URL(string:"https://gendragoon-free-10068843866.us-central1.run.app/mobile/privacy.txt")!)
                Text("Mobile releases update through the App Store/TestFlight. Desktop self-updating does not apply to this iOS app.").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Your account")
        .accessibilityIdentifier("account-settings")
    }
}
