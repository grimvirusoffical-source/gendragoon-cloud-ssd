import Foundation

var failed=0
func check(_ condition:Bool,_ message:String){
    if !condition {failed+=1;fputs("FAIL "+message+"\n",stderr)}
}

let body=Data("{\"error\":\"workspace_lock\",\"workspaces\":[{\"id\":\"11111111-1111-1111-1111-111111111111\",\"name\":\"Photos\",\"issue\":\"over_cap\"},{\"id\":\"22222222-2222-2222-2222-222222222222\",\"name\":\"Archive\",\"reason\":\"unpaid\"}]}".utf8)
let route=CloudSignals.route(status:423,body:body,method:"PUT")
check(route.destination == .lockScreen,"chunk 423 destination")
check(route.method == "PUT","chunk method")
check(route.toast == nil,"chunk 423 has no toast")
check(route.lock?.workspaces.first?.name == "Photos","workspace name")
check(route.lock?.workspaces.first?.issue == "over_cap","over cap")
check(route.lock?.workspaces.first?.label == "Photos · over the plan cap","over cap label")
check(route.lock?.workspaces.last?.issue == "unpaid","unpaid")
check(route.lock?.issueSummary == "Some workspaces are over the plan cap or unpaid.","issue summary")
let shown=CloudSignals.present(route:CloudSignals.routeLock,message:nil)
check(shown.lockScreen && shown.toast == nil,"lock presentation has no toast")
check(CloudSignals.allowsTransfer(method:"PUT",locked:true) == false,"uploads pause")
check(CloudSignals.allowsTransfer(method:"GET",locked:true),"downloads continue")
check(CloudSignals.allowsTransfer(method:"HEAD",locked:true),"reads continue")
let ok=CloudSignals.route(status:200,body:Data("{\"ok\":true}".utf8),method:"GET")
check(ok.destination == .cont && ok.toast == nil,"success has no toast")
let generic=CloudSignals.route(status:500,body:Data("{\"error\":\"unavailable\"}".utf8),method:"PUT")
check(generic.destination == .genericError && generic.toast == "unavailable","generic error still reports")
let genericShown=CloudSignals.present(route:nil,message:"unavailable")
check(!genericShown.lockScreen && genericShown.toast == "unavailable","generic toast")

let payload=Data("{\"auth_time\":1700000000}".utf8).base64EncodedString()
    .replacingOccurrences(of:"+",with:"-").replacingOccurrences(of:"/",with:"_").replacingOccurrences(of:"=",with:"")
let jwt="eyJhbGciOiJub25lIn0."+payload+"."
let auth=Date(timeIntervalSince1970:1_700_000_000)
check(CloudSignals.freshSignIn(jwt,now:auth.addingTimeInterval(300)),"five minutes is fresh")
check(!CloudSignals.freshSignIn(jwt,now:auth.addingTimeInterval(300.001)),"older than five minutes is stale")

func ready()->AccountDeletion {
    var flow=AccountDeletion()
    flow.continueFromExplain()
    check(flow.confirmPhrase("DELETE"),"confirm")
    check(flow.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:1),now:Date(timeIntervalSince1970:1)),"fresh")
    flow.noteDeleteSent()
    return flow
}
var gated=AccountDeletion()
check(!gated.confirmPhrase("DELETE"),"phrase before explain")
gated.continueFromExplain()
check(!gated.confirmPhrase("delete"),"phrase is exact")
check(gated.confirmPhrase("DELETE"),"phrase accepted")
let now=Date(timeIntervalSince1970:10_000)
check(!gated.acceptFreshSignIn(authTime:now.addingTimeInterval(-301),now:now),"old sign-in rejected")
check(gated.step == .reauth && (gated.message ?? "").contains("5 minutes"),"stale copy")

var progress=ready()
progress.onDeleteHttp(status:202,jobId:"job_1",statusUrl:nil,errorCode:nil)
check(progress.step == .polling && progress.statusPath == "v2/account/deletions/job_1","poll path")
progress.onPollHttp(status:200,state:"queued")
check(progress.step == .polling && !progress.wipe,"queued stays in progress")
progress.onPollHttp(status:200,state:"running")
check(progress.step == .polling,"running stays in progress")
progress.onPollHttp(status:200,state:"done")
check(progress.wipe && progress.step == .done,"done wipes")

var broken=ready()
broken.onDeleteHttp(status:202,jobId:"job_2",statusUrl:nil,errorCode:nil)
broken.onPollHttp(status:200,state:"failed")
check(broken.step == .failed && !broken.wipe,"failed can retry")

var stale=ready()
stale.onDeleteHttp(status:401,jobId:nil,statusUrl:nil,errorCode:"session_stale")
check(stale.step == .reauth && !stale.wipe,"first stale 401 does not wipe")
check(stale.acceptFreshSignIn(authTime:Date(timeIntervalSince1970:5),now:Date(timeIntervalSince1970:5)),"second sign-in")
stale.noteDeleteSent()
stale.onDeleteHttp(status:401,jobId:nil,statusUrl:nil,errorCode:nil)
check(stale.wipe && stale.step == .done,"second 401 wipes")

var missing=ready()
missing.onDeleteHttp(status:404,jobId:nil,statusUrl:nil,errorCode:nil)
check(missing.wipe,"404 wipes")
var gone=ready()
gone.onDeleteHttp(status:410,jobId:nil,statusUrl:nil,errorCode:nil)
check(gone.wipe,"410 wipes")

var delays=AccountDeletion()
check(delays.nextPollDelayMillis() == 1000,"1s")
check(delays.nextPollDelayMillis() == 2000,"2s")
check(delays.nextPollDelayMillis() == 4000,"4s")
check(delays.nextPollDelayMillis() == 8000,"8s")
check(delays.nextPollDelayMillis() == 8000,"8s cap")
var foreign=ready()
foreign.onDeleteHttp(status:202,jobId:"job_9",statusUrl:"https://evil.example/v2/account/deletions/job_9",errorCode:nil)
check(foreign.statusPath == "v2/account/deletions/job_9","foreign status url ignored")
check(AccountDeletion.mergeUnavailable("Photos").contains("name (from Photos)"),"merge duplicate note")
check(GDTransferClient.mergeWorkspaces(into:"target",sourceID:"source",sourceName:"Photos").contains("name (from Photos)"),"client merge stub")

check(LocalWipePlan.accountWipeIncludesCheckpoints(),"wipe includes checkpoints")
check(LocalWipePlan.lockPauseDeletes().isEmpty,"lock deletes nothing")
check(LocalWipePlan.wipedDefaults(["GenDragoon.workspace.abc","other"]) == ["GenDragoon.workspace.abc"],"defaults prefix")
check(LocalWipePlan.cacheDirectory == "GenDragoonTransfers","cache name")

if failed==0 {print("OK")} else {fputs("\(failed) failed\n",stderr);exit(1)}
