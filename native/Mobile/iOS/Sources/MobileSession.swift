import Foundation
import SwiftUI
import UIKit
import Security
import GoogleSignIn

private struct StoredSession:Codable {let uid:String;let email:String;let refreshToken:String}
private enum ByoVault {
    static func clear(){
        let query:[String:Any]=[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:LocalWipePlan.byoService]
        SecItemDelete(query as CFDictionary)
    }
}
private enum SessionVault {
    static let service="app.gendragoon.cloudssd.mobile.auth"
    static var query:[String:Any]{[kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:service,kSecAttrAccount as String:"firebase-refresh"]}
    static func save(_ session:StoredSession)throws{
        let data=try JSONEncoder().encode(session)
        let change=[kSecValueData as String:data]
        let status=SecItemUpdate(query as CFDictionary,change as CFDictionary)
        if status==errSecItemNotFound {
            var q=query;q[kSecValueData as String]=data;q[kSecAttrAccessible as String]=kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(q as CFDictionary,nil)==errSecSuccess else{throw GDTransferError(message:"Secure sign-in storage is unavailable.",status:0)}
        }else if status != errSecSuccess {throw GDTransferError(message:"Could not save your session securely.",status:0)}
    }
    static func load()->StoredSession? {
        var q=query;q[kSecReturnData as String]=true;q[kSecMatchLimit as String]=kSecMatchLimitOne
        var result:CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary,&result)==errSecSuccess,let data=result as? Data else{return nil}
        return try? JSONDecoder().decode(StoredSession.self,from:data)
    }
    static func clear(){SecItemDelete(query as CFDictionary)}
}
@MainActor final class MobileSession:ObservableObject {
    enum Stage {case loading,login,terms,ready}
    @Published private(set) var stage:Stage = .loading
    @Published private(set) var uid=""
    @Published private(set) var email=""
    @Published var status="Opening your private cloud…"
    @Published var busy=false
    @Published var accountDeleted=false
    private var bearer="",refresh=""
    private var expires=Date.distantPast
    private var renewal:Task<String,Error>?
    private var generation=UUID()
    private let termsVersion="terms-2026-10-14-v1"
    var configuration:[String:Any]{
        guard let url=Bundle.main.url(forResource:"GoogleService-Info",withExtension:"plist"),
              let data=try? Data(contentsOf:url),let c=try? PropertyListSerialization.propertyList(from:data,format:nil) as? [String:Any] else{return [:]}
        return c
    }
    private var apiKey:String {configuration["API_KEY"] as? String ?? ""}
    func start() async {
        guard stage == .loading else{return}
        guard configuration["PROJECT_ID"] as? String=="gendragoonssd",
              configuration["BUNDLE_ID"] as? String==Bundle.main.bundleIdentifier else {
            stage = .login;status="Mobile sign-in configuration is missing or mismatched.";return
        }
        guard let saved=SessionVault.load() else {stage = .login;status="Sign in with Google to continue.";return}
        uid=saved.uid;email=saved.email;refresh=saved.refreshToken
        do{_=try await token(force:true);try await checkTerms()}
        catch{stage = .login;status=error.localizedDescription}
    }
    func signIn() {
        guard !busy else{return};busy=true
        Task {
            defer{busy=false}
            do { _=try await completeGoogleSignIn();try await checkTerms() }
            catch{status=error.localizedDescription;if uid.isEmpty{stage = .login}}
        }
    }
    /// New Google sign-in. Does not change the terms stage. The returned ID token is the one just issued.
    func reauthenticate() async throws -> String {
        let token=try await completeGoogleSignIn()
        guard CloudSignals.freshSignIn(token,now:Date()) else {
            throw GDTransferError(message:"Sign in again. The server only accepts a sign-in from the last 5 minutes.",status:401)
        }
        return token
    }
    private func completeGoogleSignIn() async throws -> String {
        guard let clientID=configuration["CLIENT_ID"] as? String,!clientID.isEmpty,
              let scene=UIApplication.shared.connectedScenes.compactMap({$0 as? UIWindowScene}).first(where:{$0.activationState == .foregroundActive}),
              var controller=scene.windows.first(where:{$0.isKeyWindow})?.rootViewController else {
            throw GDTransferError(message:"Google sign-in is not ready in this window.",status:0)
        }
        while let presented=controller.presentedViewController{controller=presented}
        GIDSignIn.sharedInstance.configuration=GIDConfiguration(clientID:clientID)
        let signed=try await GIDSignIn.sharedInstance.signIn(withPresenting:controller)
        guard let googleToken=signed.user.idToken?.tokenString else{throw GDTransferError(message:"Google did not return a valid sign-in.",status:401)}
        var body=URLComponents();body.queryItems=[URLQueryItem(name:"id_token",value:googleToken),URLQueryItem(name:"providerId",value:"google.com")]
        let data=try JSONSerialization.data(withJSONObject:["postBody":body.percentEncodedQuery ?? "","requestUri":"https://gendragoonssd.firebaseapp.com","returnSecureToken":true])
        let result=try await googleRequest("https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key="+apiKey,body:data)
        guard result["providerId"] as? String=="google.com",result["needConfirmation"] as? Bool != true,
              let id=result["localId"] as? String,!id.isEmpty,let access=result["idToken"] as? String,
              let refresh=result["refreshToken"] as? String else {throw GDTransferError(message:"Google account could not be verified.",status:401)}
        if !uid.isEmpty && id != uid {throw GDTransferError(message:"Use the same Google account.",status:401)}
        generation=UUID();uid=id;email=result["email"] as? String ?? "Google account"
        self.bearer=access;self.refresh=refresh;expires=Date().addingTimeInterval(3300)
        try SessionVault.save(StoredSession(uid:uid,email:email,refreshToken:refresh))
        return access
    }
    private func googleRequest(_ text:String,body:Data,form:Bool=false) async throws->[String:Any]{
        guard let url=URL(string:text),url.scheme=="https" else{throw GDTransferError(message:"Invalid authentication endpoint.",status:0)}
        var request=URLRequest(url:url);request.httpMethod="POST";request.httpBody=body;request.timeoutInterval=30
        request.setValue(form ? "application/x-www-form-urlencoded":"application/json",forHTTPHeaderField:"Content-Type")
        request.setValue(Bundle.main.bundleIdentifier,forHTTPHeaderField:"X-Ios-Bundle-Identifier")
        let(data,response)=try await URLSession.shared.data(for:request)
        guard let http=response as? HTTPURLResponse,http.statusCode==200,
              let result=try JSONSerialization.jsonObject(with:data) as? [String:Any] else{
            throw GDTransferError(message:"Secure Google sign-in could not be completed. Check your connection and try again.",status:(response as? HTTPURLResponse)?.statusCode ?? 0)
        }
        return result
    }
    func token(force:Bool=false) async throws->String{
        guard !uid.isEmpty,!refresh.isEmpty else{throw GDTransferError(message:"Sign in again to continue.",status:401)}
        if !force,!bearer.isEmpty,Date()<expires{return bearer}
        if let renewal{return try await renewal.value}
        let owner=uid,epoch=generation,credential=refresh
        let task=Task<String,Error>{
            var form=URLComponents();form.queryItems=[URLQueryItem(name:"grant_type",value:"refresh_token"),URLQueryItem(name:"refresh_token",value:credential)]
            let payload=try await self.googleRequest("https://securetoken.googleapis.com/v1/token?key="+self.apiKey,body:Data((form.percentEncodedQuery ?? "").utf8),form:true)
            try Task.checkCancellation()
            guard self.generation==epoch,self.uid==owner,payload["user_id"] as? String==owner,
                  let token=payload["id_token"] as? String,let next=payload["refresh_token"] as? String else {
                throw GDTransferError(message:"Google session changed. Sign in again; transfer progress is retained.",status:401)
            }
            self.bearer=token;self.refresh=next;self.expires=Date().addingTimeInterval(3300)
            try SessionVault.save(StoredSession(uid:owner,email:self.email,refreshToken:next))
            return token
        }
        renewal=task;defer{if generation==epoch{renewal=nil}}
        return try await task.value
    }
    private func termsURL()->URL {
        URL(string:"https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents/accepted_terms/")!.appendingPathComponent(uid)
    }
    func checkTerms() async throws {
        let owner=uid;var request=URLRequest(url:termsURL());request.timeoutInterval=30
        request.setValue("Bearer "+(try await token()),forHTTPHeaderField:"Authorization")
        let(data,response)=try await URLSession.shared.data(for:request)
        guard owner==uid else{throw CancellationError()}
        if (response as? HTTPURLResponse)?.statusCode==404{stage = .terms;status="Please review the Terms before continuing.";return}
        guard (response as? HTTPURLResponse)?.statusCode==200,
              let result=try JSONSerialization.jsonObject(with:data) as? [String:Any],let f=result["fields"] as? [String:[String:Any]] else {
            throw GDTransferError(message:"Your Terms record could not be verified. Please retry.",status:0)
        }
        let agreed=f["termsVersion"]?["stringValue"] as? String==termsVersion && f["readConfirmed"]?["booleanValue"] as? Bool==true && f["agreed"]?["booleanValue"] as? Bool==true
        stage=agreed ? .ready:.terms;status=agreed ? "Your private cloud is ready.":"Please review the current Terms."
    }
    func acceptTerms(read:Bool,agreed:Bool){
        guard stage == .terms,read,agreed,!busy else{return};busy=true
        Task{defer{busy=false};do{
            let name="projects/gendragoonssd/databases/(default)/documents/accepted_terms/"+uid
            let fields:[String:Any]=["termsVersion":["stringValue":termsVersion],"readConfirmed":["booleanValue":true],"agreed":["booleanValue":true]]
            let payload:[String:Any]=["writes":[["update":["name":name,"fields":fields],"updateTransforms":[["fieldPath":"acceptedAt","setToServerValue":"REQUEST_TIME"]],"currentDocument":["exists":false]]]]
            var request=URLRequest(url:URL(string:"https://firestore.googleapis.com/v1/projects/gendragoonssd/databases/(default)/documents:commit")!)
            request.httpMethod="POST";request.timeoutInterval=30;request.httpBody=try JSONSerialization.data(withJSONObject:payload)
            request.setValue("Bearer "+(try await token()),forHTTPHeaderField:"Authorization");request.setValue("application/json",forHTTPHeaderField:"Content-Type")
            let(_,response)=try await URLSession.shared.data(for:request)
            guard [200,409].contains((response as? HTTPURLResponse)?.statusCode ?? 0) else{throw GDTransferError(message:"Agreement was not saved. No acceptance was assumed.",status:0)}
            try await checkTerms()
        }catch{status=error.localizedDescription}}
    }
    func signOut(){renewal?.cancel();renewal=nil;generation=UUID();bearer="";refresh="";uid="";email="";expires = .distantPast;SessionVault.clear();GIDSignIn.sharedInstance.signOut();stage = .login;status="Signed out."}
    /// Clears the session, saved workspace selection, transfer checkpoints, exports and future bring-your-own secrets.
    /// The done screen stays up until `returnToSignIn`. Upload code recreates its cache directory on the next sign-in.
    func eraseLocalData() throws {
        renewal?.cancel();renewal=nil;generation=UUID();bearer="";refresh="";expires = .distantPast
        SessionVault.clear();ByoVault.clear();GIDSignIn.sharedInstance.signOut()
        let defaults=UserDefaults.standard
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix(LocalWipePlan.defaultsPrefix){defaults.removeObject(forKey:key)}
        let caches=FileManager.default.urls(for:.cachesDirectory,in:.userDomainMask)[0].appendingPathComponent(LocalWipePlan.cacheDirectory,isDirectory:true)
        if FileManager.default.fileExists(atPath:caches.path){try FileManager.default.removeItem(at:caches)}
        let exports=FileManager.default.urls(for:.documentDirectory,in:.userDomainMask)[0].appendingPathComponent(LocalWipePlan.exportsDirectory,isDirectory:true)
        if FileManager.default.fileExists(atPath:exports.path){try FileManager.default.removeItem(at:exports)}
        accountDeleted=true
    }
    func returnToSignIn(){accountDeleted=false;signOut()}
}
