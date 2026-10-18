import Foundation

/// Classifies cloud HTTP results so every call site, including chunk uploads, treats a workspace lock the same way.
enum CloudSignals {
    static let routeLock="workspace_lock"
    static let lockCode="workspace_lock"
    static let freshSignInSeconds:TimeInterval=300

    enum Destination:Equatable { case cont, lockScreen, genericError }
    struct Route:Equatable {
        var destination:Destination
        var toast:String?
        var lock:WorkspaceLock?
        var method:String
    }
    struct FailureNotice:Equatable {
        var route:String?
        var message:String?
        var lockJSON:String?
    }
    struct Presentation:Equatable {
        var lockScreen:Bool
        var toast:String?
    }

    static func route(status:Int,body:Data,method:String="")->Route {
        let text=String(data:body,encoding:.utf8) ?? ""
        if let lock=workspaceLock(status:status,body:text){return Route(destination:.lockScreen,toast:nil,lock:lock,method:method)}
        if (200..<300).contains(status){return Route(destination:.cont,toast:nil,lock:nil,method:method)}
        var message=jsonString(text,"error")
        if let friendly=ByoMessages.friendly(status:status,error:message) {message=friendly}
        else if message==nil || message?.isEmpty==true || message==lockCode {message="Cloud request failed (HTTP \(status))."}
        return Route(destination:.genericError,toast:message,lock:nil,method:method)
    }
    static func workspaceLock(status:Int,body:String)->WorkspaceLock? {
        guard status==423,jsonString(body,"error")==lockCode else {return nil}
        return WorkspaceLock.fromLockBody(body)
    }
    static func present(route:String?,message:String?)->Presentation {
        if route==routeLock {return Presentation(lockScreen:true,toast:nil)}
        return Presentation(lockScreen:false,toast:message)
    }
    /// Reads and downloads stay available while uploads are paused.
    static func allowsTransfer(method:String,locked:Bool)->Bool {
        if !locked {return true}
        return method=="GET" || method=="HEAD"
    }
    static func authTime(_ jwt:String)->Date? {
        let parts=jwt.split(separator:".")
        guard parts.count>=2,let data=base64URL(String(parts[1])),
              let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {return nil}
        let seconds:Double?
        if let number=json["auth_time"] as? NSNumber {seconds=number.doubleValue} else {seconds=nil}
        guard let seconds else {return nil}
        return Date(timeIntervalSince1970:seconds)
    }
    static func freshSignIn(_ jwt:String,now:Date)->Bool {
        guard let auth=authTime(jwt) else {return false}
        let age=now.timeIntervalSince(auth)
        return age>=0 && age<=freshSignInSeconds
    }
    static func workspaces(_ raw:String)->[WorkspaceLock.Item] {
        guard let data=raw.data(using:.utf8),
              let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any],
              let rows=json["workspaces"] as? [[String:Any]] else {return []}
        return rows.map { row in
            let issue=(row["issue"] as? String) ?? (row["reason"] as? String) ?? (row["status"] as? String)
            return WorkspaceLock.Item(workspaceID:row["id"] as? String,name:row["name"] as? String,issue:issue)
        }
    }
    static func jsonString(_ raw:String,_ key:String)->String? {
        guard let data=raw.data(using:.utf8),let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {return nil}
        return json[key] as? String
    }
    private static func base64URL(_ value:String)->Data? {
        var text=value.replacingOccurrences(of:"-",with:"+").replacingOccurrences(of:"_",with:"/")
        let remainder=text.count % 4
        if remainder != 0 {text+=String(repeating:"=",count:4-remainder)}
        return Data(base64Encoded:text)
    }
}

struct WorkspaceLocked:Error,Sendable { let lock:WorkspaceLock }

/// Workspace price copy. Off until pricing labels ship. `isFree:true` shows "Free".
/// `grandfathered:true` or `feeWaived:true` shows "Included". The server sends
/// `monthlyPriceCents:0` when `isFree`, `grandfathered`, or `feeWaived` is set.
/// Every other row shows `monthlyPriceCents`. Zero is not a price, so the label is never `$0.00/mo`.
/// A BYO register with `grandfatheringEnded:true` keeps `grandfathered:false` and a non-zero
/// cent amount, so it shows that price. The client does not count workspaces.
enum WorkspacePrice {
    static let enabled=false
    static let free="Free"
    static let included="Included"
    /// Dollars from server cents. `nil` for a missing or zero amount.
    static func formatCents(_ cents:Int?)->String? {
        guard let cents,cents>0 else {return nil}
        let dollars=cents/100,remainder=cents%100
        if remainder==0 {return "$\(dollars)/mo"}
        return String(format:"$%d.%02d/mo",dollars,remainder)
    }
    static func priceLabel(isFree:Bool?,grandfathered:Bool,feeWaived:Bool=false,cents:Int?)->String? {
        if isFree==true {return free}
        if grandfathered || feeWaived {return included}
        return formatCents(cents)
    }
    static func pickerText(name:String,isFree:Bool?,grandfathered:Bool,feeWaived:Bool=false,cents:Int?,enabled:Bool=WorkspacePrice.enabled)->String {
        let title=name.isEmpty ? "Workspace" : name
        guard enabled else {return title}
        guard let price=priceLabel(isFree:isFree,grandfathered:grandfathered,feeWaived:feeWaived,cents:cents) else {return title}
        return title+" · "+price
    }
}

/// A 409 `workspace_busy` keeps the workspace. A `deleting` row shows "Deleting..." and
/// disables its actions. An unpaid BYO workspace locks only itself. The 3-day grace period
/// is a non-blocking "Payment due" banner with a Pay button.
enum WorkspacePolicy {
    static let busy="busy, try again"
    static let deleting="Deleting..."
    static let paymentDue="Payment due"
    static let graceMs:Int64=3*24*60*60*1000
    static func keepsWorkspace(status:Int,error:String?)->Bool { status==409 && error=="workspace_busy" }
    static func deleteNotice(status:Int,error:String?)->String? { keepsWorkspace(status:status,error:error) ? busy : nil }
    static func isDeleting(_ projectStatus:String?)->Bool { projectStatus=="deleting" }
    static func rowTitle(_ pricedLabel:String?,projectStatus:String?)->String {
        if isDeleting(projectStatus) {return deleting}
        guard let pricedLabel,!pricedLabel.isEmpty else {return "Workspace"}
        return pricedLabel
    }
    static func actionsEnabled(_ projectStatus:String?)->Bool { !isDeleting(projectStatus) }
    /// Free and current paid workspaces stay open. Only an id in `unpaidIds` is locked.
    static func locksThisWorkspace(id:String?,kind:String?,isFree:Bool?,unpaidIds:[String])->Bool {
        guard let id,!id.isEmpty else {return false}
        if id=="free" || kind=="free" || isFree==true {return false}
        return unpaidIds.contains(id)
    }
    /// A lapsed 423 takes over the library only when the open workspace is the unpaid one.
    static func blocksLibrary(selectedId:String?,kind:String?,isFree:Bool?,lock:WorkspaceLock?)->Bool {
        guard let lock else {return false}
        if lock.reasonText != "lapsed" {return true}
        return locksThisWorkspace(id:selectedId,kind:kind,isFree:isFree,unpaidIds:lock.unpaidIds)
    }
    /// `paidThroughMs <= now < paidThroughMs + 3 days`, and the workspace is not already lapsed.
    static func isPaymentDue(paidThroughMs:Int64?,nowMs:Int64,lapsed:Bool)->Bool {
        guard !lapsed,let paidThroughMs else {return false}
        let end=paidThroughMs+graceMs
        return nowMs>=paidThroughMs && nowMs<end
    }
}

struct WorkspaceLock:Identifiable,Equatable,Sendable {
    struct Item:Identifiable,Equatable,Sendable {
        var workspaceID:String?
        var name:String?
        var issue:String?
        var id:String { (workspaceID ?? name ?? "workspace")+"|"+(issue ?? "") }
        var label:String {
            let title=(name?.isEmpty==false ? name! : (workspaceID ?? "Workspace"))
            if issue=="over_cap" {return title+" · over the plan cap"}
            if issue=="unpaid" {return title+" · unpaid"}
            return title
        }
    }
    var workspaces:[Item]
    var raw:String
    var overBy:Int=0
    var unpaidIds:[String]=[]
    var id:String { raw.isEmpty ? "workspace-lock" : raw }
    static let actionDelete="Delete"
    static let actionMerge="Merge"
    static let actionDownload="Download files"
    static let detailMerge="A merge is already running. Wait until it finishes. Your files stay available to download."
    static let detailScope="This action is not available for the current workspace scope. Your files stay available to download."
    static let detailPay="Pay to restore this plan. Your files stay available to download."
    var reasonText:String { CloudSignals.jsonString(raw,"reason") ?? "" }
    /// `lapsed` and `over_cap_and_lapsed` ask the user to pay. Delete and Merge stay hidden.
    var requiresPayment:Bool { reasonText=="lapsed" || reasonText=="over_cap_and_lapsed" }
    /// Clear copy for reasons that do not include a workspace list.
    var detailText:String {
        switch reasonText {
        case "merge_in_progress": return WorkspaceLock.detailMerge
        case "scope_unavailable": return WorkspaceLock.detailScope
        case "lapsed","over_cap_and_lapsed": return WorkspaceLock.detailPay
        default: return ""
        }
    }
    var overByText:String { "Over by \(overBy)" }
    var chooseMessage:String { overBy>0 ? "Choose \(overBy) workspaces to remove." : "" }
    var issueSummary:String {
        let cap=workspaces.contains{$0.issue=="over_cap"}
        let unpaid=workspaces.contains{$0.issue=="unpaid"}
        if cap && unpaid {return "Some workspaces are over the plan cap or unpaid."}
        if cap {return "Some workspaces are over the plan cap."}
        if unpaid {return "Some workspaces are unpaid."}
        return ""
    }
    static func decode(_ raw:String)->WorkspaceLock { fromLockBody(raw) }
    /// The 423 body has `unpaidWorkspaceIds` and `overBy`. Names come from the workspace list.
    /// A legacy `workspaces` array is still read when the new field is absent.
    static func fromLockBody(_ raw:String)->WorkspaceLock {
        guard let data=raw.data(using:.utf8),let json=try? JSONSerialization.jsonObject(with:data) as? [String:Any] else {
            return WorkspaceLock(workspaces:[],raw:raw)
        }
        if json["unpaidWorkspaceIds"] != nil {
            let parsedOverBy=(json["overBy"] as? Int) ?? (json["overBy"] as? NSNumber)?.intValue ?? 0
            let overBy=max(0,parsedOverBy)
            let ids=(json["unpaidWorkspaceIds"] as? [String]) ?? []
            let items=ids.map{Item(workspaceID:$0,name:nil,issue:"unpaid")}
            return WorkspaceLock(workspaces:items,raw:raw,overBy:overBy,unpaidIds:ids)
        }
        return WorkspaceLock(workspaces:CloudSignals.workspaces(raw),raw:raw)
    }
    func named(_ known:[Item])->WorkspaceLock {
        if overBy<=0 && unpaidIds.isEmpty {return self}
        var items:[Item]=[]
        var seen=Set<String>()
        if overBy>0 {
            for item in known {
                guard let id=item.workspaceID else {continue}
                seen.insert(id)
                items.append(Item(workspaceID:id,name:item.name,issue:unpaidIds.contains(id) ? "unpaid" : nil))
            }
        }
        for id in unpaidIds where seen.insert(id).inserted {
            let name=known.first{$0.workspaceID==id}?.name
            items.append(Item(workspaceID:id,name:name,issue:"unpaid"))
        }
        return WorkspaceLock(workspaces:items,raw:raw,overBy:overBy,unpaidIds:unpaidIds)
    }
}
