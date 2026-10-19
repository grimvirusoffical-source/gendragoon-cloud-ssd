import SwiftUI
import AppKit
import Foundation

private struct GDIntegrationConfig:Decodable { let endpoint:String }
struct GDKeySummary:Decodable,Identifiable {
    let id:String
    let name:String
    let scopes:[String]
    let expiresAt:String?
    let active:Bool
}
private struct GDKeyList:Decodable {let keys:[GDKeySummary]; let maxActive:Int}
private struct GDNewKey:Decodable {let id:String;let apiKey:String;let expiresAt:String;let scopes:[String]}
@MainActor final class GDIntegrationModel:ObservableObject {
    @Published var keys:[GDKeySummary]=[]
    @Published var busy=false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    @Published var status="API keys are tied to your Google account and free cloud workspace."
    @Published var newSecret:String?
    private var api:URL? {
        guard let file=Bundle.main.url(forResource:"gendragoon_free_api",withExtension:"json"),
              let data=try? Data(contentsOf:file),
              let cfg=try? JSONDecoder().decode(GDIntegrationConfig.self,from:data),
              let url=URL(string:cfg.endpoint),url.scheme=="https",
              url.host?.hasSuffix(".run.app")==true else{return nil}
        return url
    }
    private func request(path:String,method:String="GET",token:String,payload:Data?=nil) async throws -> Data {
        guard let api,!token.isEmpty else {throw NSError(domain:"GenDragoon",code:1,
            userInfo:[NSLocalizedDescriptionKey:"Sign in with Google and retry."])}
        var r=URLRequest(url:api.appendingPathComponent(path))
        r.httpMethod=method;r.timeoutInterval=30
        r.setValue("Bearer "+token,forHTTPHeaderField:"Authorization")
        if payload != nil {r.setValue("application/json",forHTTPHeaderField:"Content-Type")}
        r.httpBody=payload
        let (data,response)=try await URLSession.shared.data(for:r)
        guard let code=(response as? HTTPURLResponse)?.statusCode,(200...299).contains(code) else{
            let e=((try? JSONSerialization.jsonObject(with:data)) as? [String:Any])?["error"] as? String
            throw NSError(domain:"GenDragoon",code:(response as? HTTPURLResponse)?.statusCode ?? 0,
                userInfo:[NSLocalizedDescriptionKey:e ?? "Server rejected the request."])
        }
        return data
    }
    func refresh(token:String){
        guard !busy, GDUpdateActivity.shared.canStart(excluding:self) else{return}
        busy=true
        Task{
            defer{busy=false}
            do{
                let result=try JSONDecoder().decode(GDKeyList.self,from:try await request(path:"v1/keys",token:token))
                keys=result.keys.sorted{$0.name<$1.name}
                status="API keys: \(keys.filter{$0.active}.count) active. Five active keys maximum."
            }catch{status=error.localizedDescription}
        }
    }
    func create(token:String,name:String,allowWrite:Bool){
        guard !busy, GDUpdateActivity.shared.canStart(excluding:self) else{return}
        busy=true
        Task{
            defer{busy=false}
            do{
                let scopes=allowWrite ? ["files:read","files:write"]:["files:read"]
                let payload=try JSONSerialization.data(withJSONObject:["name":name,"scopes":scopes])
                let item=try JSONDecoder().decode(GDNewKey.self,from:try await request(path:"v1/keys",method:"POST",token:token,payload:payload))
                newSecret=item.apiKey
                do {
                    let result=try await request(path:"v1/files",token:item.apiKey)
                    guard (try? JSONSerialization.jsonObject(with:result)) is [String:Any] else {
                        throw NSError(domain:"GenDragoon",code:1,
                            userInfo:[NSLocalizedDescriptionKey:"API returned an invalid file list"])
                    }
                    status="API key VERIFIED against your private cloud. Copy it now; the secret will not be shown again."
                } catch {
                    status="Key created, but access test failed: \(error.localizedDescription). Copy or revoke it; do not deploy it yet."
                }
                let refreshed=try JSONDecoder().decode(GDKeyList.self,from:try await request(path:"v1/keys",token:token))
                keys=refreshed.keys.sorted{$0.name<$1.name}
            }catch{status=error.localizedDescription}
        }
    }
    func revoke(token:String,id:String){
        guard !busy, GDUpdateActivity.shared.canStart(excluding:self) else{return}
        busy=true
        Task{
            defer{busy=false}
            do{
                _=try await request(path:"v1/keys/\(id)",method:"DELETE",token:token)
                status="API key revoked immediately."
                let refreshed=try JSONDecoder().decode(GDKeyList.self,from:try await request(path:"v1/keys",token:token))
                keys=refreshed.keys.sorted{$0.name<$1.name}
            }catch{status=error.localizedDescription}
        }
    }
    func clearDisplayedSecret(){newSecret=nil}
}
@MainActor struct GenDragoonAPIKeysPanel:View {
    @EnvironmentObject private var login:GDLoginSession
    @StateObject private var model=GDIntegrationModel()
    @ObservedObject private var activity=GDUpdateActivity.shared
    @State private var keyName="My application"
    @State private var allowWrite=false
    var body:some View {
        VStack(alignment:.leading,spacing:12) {
            Label("Developer API access",systemImage:"curlybraces.square")
                .font(.system(size:17,weight:.bold))
            Text("Connect Python, JavaScript, Java, C, C#, C++, Swift and other programs to your private free cloud using standard HTTPS requests. These keys cannot access the owner's storage bucket.")
                .font(.system(size:12)).foregroundStyle(.gray)
            TextField("Key name",text:$keyName).textFieldStyle(.roundedBorder)
            Toggle("Allow file uploads and deletions (read/write)",isOn:$allowWrite)
                .font(.system(size:12))
            HStack {
                Button("Create API Key"){model.create(token:login.firebaseIDToken,name:keyName,allowWrite:allowWrite)}
                    .disabled(model.busy || !activity.canStart(excluding:model)).buttonStyle(.borderedProminent).tint(.purple)
                Button("Refresh Keys"){model.refresh(token:login.firebaseIDToken)}.disabled(model.busy || !activity.canStart(excluding:model))
            }
            if let secret=model.newSecret {
                VStack(alignment:.leading,spacing:8){
                    Label("COPY THIS SECRET ONCE",systemImage:"exclamationmark.shield.fill")
                        .font(.system(size:12,weight:.bold)).foregroundStyle(.orange)
                    Text("Never put an API key inside a public website or mobile app, public GitHub repo, or client-side source code. Use a private backend or secrets manager.")
                        .font(.system(size:11)).foregroundStyle(.orange)
                    HStack {
                        Text(String(secret.prefix(14))+"…").font(.system(size:11,design:.monospaced))
                        Spacer()
                        Button("Copy Secret"){NSPasteboard.general.clearContents();NSPasteboard.general.setString(secret,forType:.string)}
                        Button("Dismiss"){model.clearDisplayedSecret()}
                    }
                }.padding(12).background(Color.orange.opacity(0.09),in:RoundedRectangle(cornerRadius:11))
            }
            ForEach(model.keys){key in
                HStack(spacing:9){
                    Image(systemName:key.active ? "key.fill":"key.slash")
                        .foregroundStyle(key.active ? .purple:.gray)
                    VStack(alignment:.leading,spacing:2){
                        Text(key.name).font(.system(size:12,weight:.semibold))
                        Text(key.scopes.joined(separator:", ")+" · "+(key.active ? "Active":"Expired or revoked"))
                            .font(.system(size:10)).foregroundStyle(.gray)
                    }
                    Spacer()
                    if key.active {
                        Button("Revoke",role:.destructive){
                            model.revoke(token:login.firebaseIDToken,id:key.id)
                        }.disabled(model.busy || !activity.canStart(excluding:model))
                    }
                }
                Divider().opacity(0.15)
            }
            Text(model.status).font(.system(size:11)).foregroundStyle(.orange)
        }
        .padding(16)
        .background(Color.white.opacity(0.045),in:RoundedRectangle(cornerRadius:15))
        .onAppear{model.refresh(token:login.firebaseIDToken)}
    }
}
// The old download-only updater delegates to the same verified update path.
struct GenDragoonUpdatePanel: View {
    var body: some View { GenDragoonAutomaticUpdateStatus() }
}
