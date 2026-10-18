import SwiftUI
import UIKit

struct AccountDeletedScreen:View {
    @EnvironmentObject private var session:MobileSession
    var body:some View {
        VStack(alignment:.leading,spacing:18){
            Text("Your account has been deleted.").font(.title.bold())
            Text("Hosted workspaces and this device's copy of your data have been erased. Bring-your-own storage was not changed.").foregroundStyle(.secondary)
            Button("Return to sign-in"){session.returnToSignIn()}.buttonStyle(.borderedProminent).controlSize(.large)
        }.padding(28).frame(maxWidth:.infinity,maxHeight:.infinity,alignment:.topLeading).background(Color(red:0.064,green:0.055,blue:0.10))
    }
}

struct CloudDeletionTransport:DeletionTransport {
    let cloud:MobileCloudModel
    func execute(method:String,path:String,body:Data?,authorization:String) async throws -> AccountHttp {
        let token=authorization.hasPrefix("Bearer ") ? String(authorization.dropFirst("Bearer ".count)) : authorization
        if method=="DELETE" { return try await cloud.deleteAccount(freshToken:token) }
        return try await cloud.pollDeletion(path,statusToken:token)
    }
}

@MainActor final class AccountDeletionModel:ObservableObject {
    @Published private(set) var flow=AccountDeletion()
    func continueFromExplain(){flow.continueFromExplain()}
    func confirm(_ phrase:String)->Bool { flow.confirmPhrase(phrase) }
    func acceptFreshSignIn(authTime:Date,now:Date)->Bool { flow.acceptFreshSignIn(authTime:authTime,now:now) }
    func noteDeleteSent(){flow.noteDeleteSent()}
    func onDeleteHttp(_ http:AccountHttp){flow.onDeleteHttp(status:http.status,jobId:http.jobId,errorCode:http.error,statusToken:http.statusToken);syncReceipt()}
    func onPollHttp(_ http:AccountHttp){flow.onPollHttp(status:http.status,jobStatus:http.jobStatus,errorCode:http.error,retryable:http.retryable,reportedJobId:http.jobId);syncReceipt()}
    func exhausted()->Bool { flow.exhausted() }
    func nextPollDelayMillis()->Int { flow.nextPollDelayMillis() }
    func fail(_ text:String){flow.fail(text)}
    func retry(){flow.retry();syncReceipt()}
    func noteWiped(){flow.noteWiped()}
    func noteWipeFailed(_ text:String){flow.noteWipeFailed(text)}
    func resume(_ receipt:DeletionReceipt){flow=AccountDeletion.resume(receipt);syncReceipt()}
    func preview(_ step:AccountDeletion.Step){var next=AccountDeletion();next.step=step;flow=next}
    func previewSupportFailure(){
        var next=AccountDeletion()
        next.step = .failed
        next.showSupport=true
        next.dismissible=true
        next.jobId="00000000-0000-4000-8000-0000000000aa"
        next.message="Account deletion failed and cannot be resumed. Nothing on this device was erased."
        flow=next
    }
    func askForSignIn(_ text:String){flow.askForSignIn(text)}
    func dismissError(){flow.dismissError();syncReceipt()}
    func deleteThrough(_ transport:any DeletionTransport,authorization:String) async {
        var next=flow
        await next.deleteThrough(transport,authorization:authorization)
        flow=next
        syncReceipt()
    }
    func pollThrough(_ transport:any DeletionTransport) async {
        var next=flow
        await next.pollThrough(transport)
        flow=next
        syncReceipt()
    }
    func acknowledgeClearedSession(){flow.clearSession=false}
    @discardableResult func rejectDifferentAccount(expectedUid:String,actualUid:String,expectedEmail:String,actualEmail:String?)->Bool {
        let rejected=flow.rejectDifferentAccount(expectedUid:expectedUid,actualUid:actualUid,expectedEmail:expectedEmail,actualEmail:actualEmail)
        return rejected
    }
    func syncReceipt(){
        if flow.dropReceipt && !flow.requestsWipe() {DeletionReceiptVault.clear();return}
        if flow.step == .polling,let receipt=flow.receipt() {DeletionReceiptVault.save(jobId:receipt.jobId,token:receipt.statusToken)}
    }
}

@MainActor struct DeleteAccountView:View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var session:MobileSession
    @EnvironmentObject private var cloud:MobileCloudModel
    @StateObject private var model:AccountDeletionModel
    @State private var phrase=""
    @State private var working=false
    init(resume:DeletionReceipt?=nil,previewStep:AccountDeletion.Step?=nil,previewSupport:Bool=false){
        let model=AccountDeletionModel()
        if previewSupport {model.previewSupportFailure()}
        else if let previewStep {model.preview(previewStep)}
        else if let resume {model.resume(resume)}
        else if let saved=DeletionReceiptVault.load() {model.resume(saved)}
        _model=StateObject(wrappedValue:model)
        _phrase=State(initialValue:"")
        _working=State(initialValue:false)
    }
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:18){
                    Text("Delete account").font(.largeTitle.bold())
                    switch model.flow.step {
                    case .explain:
                        Text("This deletes your account, all hosted workspaces and their files. Subscriptions are cancelled. Bring-your-own storage is not changed.")
                        Button("Continue"){model.continueFromExplain()}.buttonStyle(.borderedProminent)
                    case .confirm:
                        Text("Type DELETE to confirm. You will sign in with Google again immediately before the account is deleted.").accessibilityIdentifier("delete-confirm")
                        TextField("Type DELETE",text:$phrase).textInputAutocapitalization(.characters).autocorrectionDisabled().textFieldStyle(.roundedBorder)
                        Button("Delete account",role:.destructive){if model.confirm(phrase){Task{await authenticateAndDelete()}}}.buttonStyle(.borderedProminent).disabled(phrase != AccountDeletion.confirmPhrase || working)
                    case .reauth:
                        Text(model.flow.message ?? "Sign in again. The server only accepts a sign-in from the last 5 minutes.")
                        Button("Sign in again"){Task{await authenticateAndDelete()}}.buttonStyle(.borderedProminent).disabled(working)
                    case .deleting,.polling:
                        ProgressView()
                        Text(model.flow.step == .polling ? "Deleting your account…" : "Starting deletion…")
                    case .done:
                        if working { ProgressView(); Text("Removing this device's copy of your account…") }
                        else { Text(model.flow.message ?? "Local data could not be removed."); Button("Retry"){Task{await wipe()}} }
                    case .failed:
                        Text(model.flow.message ?? "Account deletion did not finish. You can retry.")
                        if model.flow.offersRetry() { Button("Retry"){model.retry()} }
                        if model.flow.showSupport {
                            Button("Contact support"){
                                if let url=SupportContact.mailto(jobId:model.flow.jobId){UIApplication.shared.open(url)}
                            }.accessibilityIdentifier("deletion-support")
                        }
                        if model.flow.canDismiss() { Button("Dismiss"){model.dismissError();dismiss()} }
                        else { Button("Cancel"){dismiss()} }
                    case .signedOut:
                        if model.flow.keepsPolling() {
                            ProgressView()
                            Text("Deleting your account…")
                        } else {
                            Text(model.flow.message ?? "Sign in again to continue.")
                            Button("Return to sign-in"){session.signOut();dismiss()}.buttonStyle(.borderedProminent)
                        }
                    case .wiped:
                        Text("Your account has been deleted.")
                    }
                }.padding(24)
            }.background(Color(red:0.064,green:0.055,blue:0.10))
        }.interactiveDismissDisabled(true)
        .task(id:model.flow.step){await onStep()}
    }
    private func onStep() async {
        if model.flow.keepsPolling() { await poll() }
        else if model.flow.step == .done && model.flow.requestsWipe() { await wipe() }
        else if model.flow.step == .signedOut { session.signOut();dismiss() }
    }
    private func authenticateAndDelete() async {
        guard !working else {return}
        working=true;defer{working=false}
        do {
            let token=try await session.reauthenticate()
            let auth=CloudSignals.authTime(token) ?? .distantPast
            guard model.acceptFreshSignIn(authTime:auth,now:Date()) else {return}
            if model.flow.step == .polling || !model.flow.allowsDelete() {return}
            await model.deleteThrough(CloudDeletionTransport(cloud:cloud),authorization:"Bearer "+token)
            if let http=model.flow.lastHttp,http.status==423 && http.error==CloudSignals.lockCode {
                cloud.noteLock(WorkspaceLock.decode(http.raw))
                if model.flow.step != .polling {dismiss()}
            }
        }catch let error as GDTransferError where error.message==AccountDeletion.differentAccount {
            model.rejectDifferentAccount(expectedUid:session.uid,actualUid:"",expectedEmail:session.email.contains("@") ? session.email : "",actualEmail:nil)
        }catch let error as GDTransferError where error.status==401 {
            model.askForSignIn(error.message)
        }catch{model.fail(error.localizedDescription)}
    }
    private func poll() async {
        let transport=CloudDeletionTransport(cloud:cloud)
        while model.flow.keepsPolling() {
            if model.exhausted(){model.fail("Account deletion is still running. You can retry.");return}
            let delay=model.nextPollDelayMillis()
            try? await Task.sleep(nanoseconds:UInt64(delay)*1_000_000)
            if Task.isCancelled || !model.flow.keepsPolling() {return}
            await model.pollThrough(transport)
            if model.flow.clearSession {
                session.clearSessionKeepingDeletion()
                model.acknowledgeClearedSession()
            }
            if model.flow.step == .polling,let http=model.flow.lastHttp,http.status==423 && http.error==CloudSignals.lockCode {
                cloud.noteLock(WorkspaceLock.decode(http.raw))
            }
        }
    }
    private func wipe() async {
        guard !working,model.flow.requestsWipe() else {return}
        working=true;defer{working=false}
        cloud.pause()
        cloud.workspaceLock=nil
        do { DeletionReceiptVault.clear();try session.eraseLocalData();model.noteWiped() }
        catch { model.noteWipeFailed(error.localizedDescription) }
    }
}

@MainActor struct WorkspaceLockView:View {
    @EnvironmentObject private var cloud:MobileCloudModel
    let lock:WorkspaceLock
    @State private var files:[GDCloudItem]=[]
    @State private var listing:String?
    @State private var notice=""
    @State private var pendingDelete:WorkspaceLock.Item?
    var body:some View {
        NavigationStack {
            ScrollView {
                VStack(alignment:.leading,spacing:16){
                    Text("Workspaces locked").font(.largeTitle.bold()).accessibilityIdentifier("workspaces-locked")
                    Text("Your files are still readable and downloadable. Uploads are paused until you delete or merge workspaces down to your plan limit.")
                    if !resolved.reasonText.isEmpty { Text(resolved.reasonText).font(.headline) }
                    Text(resolved.overByText).font(.headline)
                    if !resolved.detailText.isEmpty { Text(resolved.detailText) }
                    if !resolved.chooseMessage.isEmpty { Text(resolved.chooseMessage).font(.headline) }
                    if !resolved.issueSummary.isEmpty { Text(resolved.issueSummary).font(.headline) }
                    Text("Duplicates are kept as name (from <source>).").font(.footnote).foregroundStyle(.secondary)
                    if resolved.workspaces.isEmpty && resolved.detailText.isEmpty { Text("The server did not include a workspace list.").foregroundStyle(.secondary) }
                    ForEach(resolved.workspaces){item in
                        VStack(alignment:.leading,spacing:10){
                            Text(item.label).font(.headline)
                            HStack{
                                if !resolved.requiresPayment {
                                    Button(WorkspaceLock.actionDelete,role:.destructive){pendingDelete=item}.disabled(item.workspaceID==nil || cloud.busy)
                                    mergeControl(item)
                                }
                                Button(WorkspaceLock.actionDownload){Task{await list(item)}}.disabled(item.workspaceID==nil || cloud.busy || !CloudSignals.allowsTransfer(method:"GET",locked:true))
                            }
                            if listing==item.workspaceID {
                                if files.isEmpty { Text("No files to download in this workspace.").font(.caption).foregroundStyle(.secondary) }
                                ForEach(files){file in Button(file.name){cloud.restore(file,from:item.workspaceID)}.disabled(cloud.busy)}
                            }
                        }.padding(16).frame(maxWidth:.infinity,alignment:.leading).background(Color(red:0.115,green:0.093,blue:0.16),in:RoundedRectangle(cornerRadius:16))
                    }
                    if !notice.isEmpty { Text(notice).font(.footnote) }
                    Button("Check again"){Task{await recheck()}}.buttonStyle(.borderedProminent)
                }.padding(24)
            }.background(Color(red:0.064,green:0.055,blue:0.10))
        }
        .interactiveDismissDisabled(true)
        .task{if lock.workspaces.contains(where:{$0.name==nil || $0.name?.isEmpty==true}){await cloud.refreshLockNames()}}
        .sheet(item:$cloud.export){value in NativeShare(url:value.url)}
        .confirmationDialog("Delete workspace?",isPresented:Binding(get:{pendingDelete != nil},set:{if !$0 {pendingDelete=nil}}),titleVisibility:.visible){
            Button("Delete workspace",role:.destructive){if let pendingDelete {Task{await remove(pendingDelete)}};pendingDelete=nil}
            Button("Cancel",role:.cancel){pendingDelete=nil}
        } message:{ Text("This permanently deletes the hosted workspace and its files. Bring-your-own storage is not changed.") }
    }
    private var resolved:WorkspaceLock { lock.named(cloud.knownWorkspaces()) }
    private func mergeControl(_ item:WorkspaceLock.Item)->some View {
        let others=resolved.workspaces.filter{$0.workspaceID != nil && $0.workspaceID != item.workspaceID}
        return Menu(WorkspaceLock.actionMerge){
            if others.isEmpty {Button("No other workspace"){notice=AccountDeletion.mergeNote(item.name ?? "workspace")}}
            else {ForEach(others){target in Button("Into "+target.label){Task{await merge(item,into:target)}}}}
        }.disabled(cloud.busy)
    }
    private func merge(_ item:WorkspaceLock.Item,into target:WorkspaceLock.Item) async {
        notice=AccountDeletion.mergeNote(item.name ?? "workspace")
        do {
            try await cloud.mergeWorkspace(source:item.workspaceID ?? "",target:target.workspaceID ?? "",confirmName:item.name ?? "")
            notice=AccountDeletion.mergeNote(item.name ?? "workspace")
        } catch let locked as WorkspaceLocked { cloud.workspaceLock=locked.lock }
        catch { notice=error.localizedDescription }
    }
    private func list(_ item:WorkspaceLock.Item) async {
        guard let id=item.workspaceID else {return}
        do { files=try await cloud.filesForDownload(workspace:id);listing=id;notice="" }
        catch let locked as WorkspaceLocked { cloud.workspaceLock=locked.lock }
        catch { notice=error.localizedDescription }
    }
    private func remove(_ item:WorkspaceLock.Item) async {
        guard let id=item.workspaceID else {return}
        do { try await cloud.deleteHostedWorkspace(id);try await cloud.reloadLibrary() }
        catch let locked as WorkspaceLocked { cloud.workspaceLock=locked.lock }
        catch { notice=error.localizedDescription }
    }
    private func recheck() async {
        do { try await cloud.reloadLibrary() }
        catch let locked as WorkspaceLocked { cloud.workspaceLock=locked.lock }
        catch { notice=error.localizedDescription }
    }
}
