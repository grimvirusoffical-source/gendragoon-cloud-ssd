import SwiftUI
import AppKit
import Foundation

@MainActor final class GDLoginSession: ObservableObject {
    enum Stage: Equatable {case login, waiting, verifying, terms, ready, error}
    static let termsVersion = "terms-2026-10-14-v1"
    @Published var stage:Stage = .login
    @Published var status = "Google login is required to use GenDragoon."
    @Published var email = ""
    @Published private(set) var isAdFree = false
    @Published private(set) var adStatusKnown = false
    var isOwner: Bool {email.lowercased() == "grimvirusoffical@gmail.com"}
    @Published var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    private var idToken = ""
    private var refreshToken = ""
    private var transferRenewal:Task<String,Error>?
    private var transferRenewalID:UUID?
    private var lastVerified = Date.distantPast
    private var authTime: TimeInterval?
    var authTimeSeconds: TimeInterval? { authTime }
    private var renewTimer:Timer?
    private var activationObserver:NSObjectProtocol?
    @Published private(set) var userID = ""
    /// Captured before logout so a new sign-in can be compared with the account already on this Mac.
    private var accountUIDBeforeSignIn = ""
    var firebaseIDToken: String { idToken }
    private var bridge:Process?
    private var pipe:Pipe?
    private var lineBuffer = ""
    private struct WebConfig: Decodable {let apiKey:String;let projectId:String;let authDomain:String;let appId:String}
    private var config:WebConfig? {
        guard let u=Bundle.main.url(forResource:"gendragoon_firebase_public",withExtension:"json"),
        let d=try? Data(contentsOf:u) else {return nil}
        return try? JSONDecoder().decode(WebConfig.self,from:d)
    }
    func login() {
        guard stage == .login || stage == .error else {return}
        guard let cfg=config, cfg.projectId=="gendragoonssd",!cfg.apiKey.isEmpty else {
            status="Firebase login configuration is missing. Ask the administrator to repair the installation.";stage = .error;return
        }
        guard let url=Bundle.main.url(forResource:"gendragoon_login_bridge",withExtension:"js") else {
            status="The verified Google sign-in helper was not packaged.";stage = .error;return
        }
        let executable=([Bundle.main.resourceURL?.appendingPathComponent("gendragoon_node").path].compactMap{$0}+["/usr/local/bin/node","/opt/homebrew/bin/node"]).first(where:{FileManager.default.isExecutableFile(atPath:$0)})
        guard let node=executable else {
            status="The Google sign-in helper requires Node.js on this Mac. Sign-in remains locked until it is available."
            stage = .error;return
        }
        accountUIDBeforeSignIn = userID
        logout(preserveStatus:true)
        stage = .waiting
        status="Opening your browser for secure Google sign-in…"
        let task=Process(),out=Pipe()
        task.executableURL=URL(fileURLWithPath:node)
        task.arguments=[url.path,Bundle.main.url(forResource:"gendragoon_firebase_public",withExtension:"json")!.path,UUID().uuidString+"-"+UUID().uuidString]
        task.standardOutput=out
        task.standardError=Pipe()
        lineBuffer=""
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data=handle.availableData
            guard !data.isEmpty else {handle.readabilityHandler=nil;return}
            guard let part=String(data:data,encoding:.utf8) else {return}
            DispatchQueue.main.async {self?.ingest(part)}
        }
        task.terminationHandler={ [weak self] _ in
            DispatchQueue.main.async {
                guard let self=self,self.stage == .waiting else{return}
                self.stage = .login
                self.status="The login window closed or timed out. Select Google Sign In to try again."
            }
        }
        do { try task.run();bridge=task;pipe=out }
        catch {stage = .error;status="Unable to start the Google sign-in helper."}
    }
    private func ingest(_ text:String) {
        lineBuffer += text
        while let range=lineBuffer.range(of:"\n") {
            let line=String(lineBuffer[..<range.lowerBound])
            lineBuffer.removeSubrange(..<range.upperBound)
            if line.hasPrefix("READY "),let url=URL(string:String(line.dropFirst(6))) {
                if url.host=="localhost" {NSWorkspace.shared.open(url)}
            } else if line.hasPrefix("RESULT ") {
                guard let data=Data(base64Encoded:String(line.dropFirst(7))),
                let payload=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                let jwt=payload["idToken"] as? String else {
                    stage = .error;status="Google sign-in response could not be verified.";continue
                }
                refreshToken=(payload["refreshToken"] as? String) ?? ""
                stage = .verifying
                status = "Verifying your Google account with Firebase…"
                validateGoogle(token:jwt)
            }
        }
    }
    private func doRequest(_ request:URLRequest,complete:@escaping (Int,Data?)->Void) {
        URLSession.shared.dataTask(with:request) {data,response,_ in
            DispatchQueue.main.async {complete((response as? HTTPURLResponse)?.statusCode ?? 0,data)}
        }.resume()
    }
    private func validateGoogle(token:String) {
        guard let cfg=config,let url=URL(string:"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key="+cfg.apiKey) else {
            stage = .error;status="Google verification configuration is invalid.";return
        }
        var req=URLRequest(url:url)
        req.httpMethod="POST"
        req.setValue("application/json",forHTTPHeaderField:"Content-Type")
        req.httpBody=try? JSONSerialization.data(withJSONObject:["idToken":token])
        doRequest(req) { [weak self] code,data in
            guard let self=self else{return}
            guard code==200,let data=data,
                let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                let user=(result["users"] as? [[String:Any]])?.first,
                let uid=user["localId"] as? String,!uid.isEmpty,
                let providers=user["providerUserInfo"] as? [[String:Any]],
                providers.contains(where:{$0["providerId"] as? String=="google.com"}) else {
                self.stage = .login;self.status="Firebase rejected the account. Sign in using Google, not email/password.";return
            }
            switch GDAccountContract.adoptSignIn(incomingUID: uid, savedOwnerUID: GDAccountDeletionMonitor.loadJob()?.ownerUID, currentUID: accountUIDBeforeSignIn) {
            case .reject(let message):
                self.stage = .login
                self.status = message
                return
            case .adopt:
                break
            }
            self.userID=uid
            self.email=(user["email"] as? String) ?? "Google user"
            self.adoptIDToken(token)
            self.lastVerified=Date()
            self.configureTokenRenewal()
            self.status="Google account verified. Checking Terms acceptance…"
            self.checkConsent()
        }
    }
    private func configureTokenRenewal() {
        renewTimer?.invalidate()
        renewTimer=Timer.scheduledTimer(withTimeInterval:40*60,repeats:true) {[weak self] _ in
            Task {@MainActor in self?.refreshSession()}
        }
        if activationObserver == nil {
            activationObserver=NotificationCenter.default.addObserver(
                forName:NSApplication.didBecomeActiveNotification,object:nil,queue:.main) {[weak self] _ in
                    Task {@MainActor in
                        guard let self else{return}
                        if Date().timeIntervalSince(self.lastVerified)>20*60 {self.refreshSession()}
                    }
                }
        }
    }
    func refreshSession() {
        Task { _ = try? await tokenForTransfer(forceRefresh:true) }
    }
    func tokenForTransfer(forceRefresh:Bool=false) async throws -> String {
        guard stage == .ready,!userID.isEmpty,!idToken.isEmpty else {
            throw GDTransferError(message:"Sign in and accept the current Terms first.",status:401)
        }
        if !forceRefresh && Date().timeIntervalSince(lastVerified)<40*60 {return idToken}
        if let task=transferRenewal {return try await task.value}
        guard !refreshToken.isEmpty,let cfg=config,
            let url=URL(string:"https://securetoken.googleapis.com/v1/token?key="+cfg.apiKey) else {
            throw GDTransferError(message:"Google session cannot be renewed. Sign in again.",status:401)
        }
        let owner=userID,credential=refreshToken,identifier=UUID()
        let task=Task<String,Error> {
            var request=URLRequest(url:url);request.httpMethod="POST";request.timeoutInterval=30
            request.setValue("application/x-www-form-urlencoded",forHTTPHeaderField:"Content-Type")
            var body=URLComponents();body.queryItems=[URLQueryItem(name:"grant_type",value:"refresh_token"),URLQueryItem(name:"refresh_token",value:credential)]
            request.httpBody=body.percentEncodedQuery?.data(using:.utf8)
            let(data,response)=try await URLSession.shared.data(for:request)
            try Task.checkCancellation()
            guard self.userID==owner,(response as? HTTPURLResponse)?.statusCode==200,
                let payload=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                payload["user_id"] as? String==owner,
                let fresh=payload["id_token"] as? String,!fresh.isEmpty,
                let renewal=payload["refresh_token"] as? String,!renewal.isEmpty else {
                throw GDTransferError(message:"Google session expired or changed. Sign in again; transfer progress is retained.",status:401)
            }
            self.adoptIDToken(fresh);self.refreshToken=renewal;self.lastVerified=Date()
            return fresh
        }
        transferRenewal=task;transferRenewalID=identifier
        defer{if transferRenewalID==identifier{transferRenewal=nil;transferRenewalID=nil}}
        return try await task.value
    }
    func signedInWithin(seconds: TimeInterval) -> Bool {
        guard stage == .ready, !idToken.isEmpty, let authTime else { return false }
        return Date().timeIntervalSince1970 - authTime < seconds
    }
    private func adoptIDToken(_ token: String) {
        idToken = token
        authTime = GDAccountContract.authTime(jwt: token)
    }
    func requireFreshSignIn(message: String) {
        logout(preserveStatus: true)
        status = message
        stage = .login
    }
    func verifiedBearerToken() -> String? {
        guard stage == .ready, !idToken.isEmpty, !userID.isEmpty else { return nil }
        return idToken
    }
    func checkConsent() {
        guard !userID.isEmpty,!idToken.isEmpty else {stage = .login;return}
        stage = .verifying
        var req=URLRequest(url:consentURL())
        req.setValue("Bearer "+idToken,forHTTPHeaderField:"Authorization")
        doRequest(req) { [weak self] code,data in
            guard let self=self else{return}
            if code==404 {self.stage = .terms;self.status="Review and agree to continue.";return}
            guard code==200,let d=data,
                let root=(try? JSONSerialization.jsonObject(with:d)) as? [String:Any],
                let fields=root["fields"] as? [String:[String:Any]] else {
                self.stage = .error
                self.status="Couldn't verify your Terms record (HTTP \(code)). Access is locked; try again."
                return
            }
            let accepted=(fields["termsVersion"]?["stringValue"] as? String)==Self.termsVersion
            let read=(fields["readConfirmed"]?["booleanValue"] as? Bool)==true
            let agreed=(fields["agreed"]?["booleanValue"] as? Bool)==true
            self.stage=(accepted && read && agreed) ? .ready : .terms
            self.status=self.stage == .ready ? "Ready" : "Please review the updated Terms."
            if self.stage == .ready {self.checkAdEntitlement()}
        }
    }
    func checkAdEntitlement() {
        guard !userID.isEmpty else {adStatusKnown=false;return}
        let owner=userID
        Task {
            do {
                let token=try await tokenForTransfer()
                guard let file=Bundle.main.url(forResource:"gendragoon_free_api",withExtension:"json"),
                    let cfg=(try JSONSerialization.jsonObject(with:Data(contentsOf:file))) as? [String:Any],
                    let endpoint=cfg["endpoint"] as? String,let base=URL(string:endpoint),base.scheme=="https" else {
                    self.adStatusKnown=false;return
                }
                var request=URLRequest(url:base.appendingPathComponent("v2/account/entitlements"))
                request.setValue("Bearer "+token,forHTTPHeaderField:"Authorization");request.timeoutInterval=30
                let(data,response)=try await URLSession.shared.data(for:request)
                let http = response as? HTTPURLResponse
                if http?.statusCode == 423,
                   let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                   GDServerCode.read(object) == "workspace_lock" {
                    GDWorkspaceLock.shared.present(json: object)
                    return
                }
                guard self.userID==owner,http?.statusCode==200,
                    let result=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],
                    let adFree=result["adFree"] as? Bool else {self.adStatusKnown=false;return}
                self.isAdFree=adFree;self.adStatusKnown=true
            }catch{self.adStatusKnown=false}
        }
    }
    private func consentURL()->URL {
        let safe=userID.addingPercentEncoding(withAllowedCharacters:.urlPathAllowed) ?? userID
        return URL(string:"https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+safe)!
    }
    func acceptTerms() {
        guard stage == .terms,!busy,!userID.isEmpty,!idToken.isEmpty else{return}
        busy=true;status="Saving your agreement to your private Firebase account…"
        var req=URLRequest(url:URL(string:"https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents:commit")!)
        req.httpMethod="POST"
        req.setValue("application/json",forHTTPHeaderField:"Content-Type")
        req.setValue("Bearer "+idToken,forHTTPHeaderField:"Authorization")
        let fields:[String:Any]=[
            "termsVersion":["stringValue":Self.termsVersion],
            "readConfirmed":["booleanValue":true],
            "agreed":["booleanValue":true]
        ]
        let payload:[String:Any]=["writes":[[
            "update":["name":"projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+userID,"fields":fields],
            "updateTransforms":[["fieldPath":"acceptedAt","setToServerValue":"REQUEST_TIME"]],
            "currentDocument":["exists":false]
        ]]]
        req.httpBody=try? JSONSerialization.data(withJSONObject:payload)
        doRequest(req) { [weak self] code,_ in
            guard let self=self else{return}
            self.busy=false
            if code==200 {self.checkConsent()}
            else {
                self.stage = .terms
                self.status="The server could not save acceptance (HTTP \(code)). You must complete it before app access."
            }
        }
    }
    func retry() { if !idToken.isEmpty {checkConsent()} else {stage = .login;login()} }
    func logout(preserveStatus:Bool=false) {
        pipe?.fileHandleForReading.readabilityHandler=nil
        if bridge?.isRunning==true {bridge?.terminate()}
        bridge=nil;pipe=nil;lineBuffer=""
        renewTimer?.invalidate();renewTimer=nil
        if let observer=activationObserver {NotificationCenter.default.removeObserver(observer);activationObserver=nil}
        transferRenewal?.cancel();transferRenewal=nil;transferRenewalID=nil
        idToken="";refreshToken="";lastVerified = .distantPast;authTime=nil
        userID="";email="";busy=false;isAdFree=false;adStatusKnown=false;stage = .login
        if !preserveStatus {status="Signed out. Google login is required to use GenDragoon."}
    }
}

struct GenDragoonStartupRoot:View {
    @StateObject private var session=GDLoginSession()
    var body:some View {
        Group {
            switch session.stage {
            case .ready:
                MainView().environmentObject(session)
            case .terms:
                GenDragoonTermsGate(authenticatedEmail:session.email,
                    termsVersion:GDLoginSession.termsVersion,
                    status:session.status,isBusy:session.busy,
                    completion:{session.acceptTerms()},logout:{session.logout()})
            case .login,.waiting,.verifying,.error:
                ZStack {
                    Color(red:0.055,green:0.048,blue:0.092).ignoresSafeArea()
                    VStack(spacing:19) {
                        Image(systemName:"lock.shield.fill").font(.system(size:53))
                            .foregroundStyle(.purple)
                        Text("GenDragoonSSD").font(.system(size:34,weight:.heavy,design:.rounded))
                        Text("Google sign-in required").font(.system(size:20,weight:.semibold))
                        Text("Sign in with Google to open your cloud drive, app library, plans and project workspaces.")
                            .font(.system(size:13)).foregroundStyle(.gray).multilineTextAlignment(.center)
                        if session.stage == .waiting || session.stage == .verifying {ProgressView().controlSize(.large)}
                        Text(session.status).font(.system(size:12)).foregroundStyle(.orange)
                            .multilineTextAlignment(.center)
                        Button("Continue with Google") {session.login()}
                            .disabled(session.stage == .waiting || session.stage == .verifying)
                            .buttonStyle(.borderedProminent).tint(.purple).controlSize(.large)
                        Text("A secure Google login window opens in your browser. No password is requested by GenDragoon.")
                            .font(.system(size:10)).foregroundStyle(.gray).multilineTextAlignment(.center)
                    }.frame(maxWidth:440).padding(40)
                }
            }
        }
        .frame(minWidth:780,minHeight:660)
        .preferredColorScheme(.dark)
        .onAppear {
            GDUpdateCoordinator.shared.start()
            GDAccountDeletionMonitor.shared.resumeOnLaunch(login: session)
        }
        .onChange(of: session.stage) { _, stage in
            if stage == .ready { GDAccountDeletionMonitor.shared.sessionBecameReady(session) }
        }
    }
}
