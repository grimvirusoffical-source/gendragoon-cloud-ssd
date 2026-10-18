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

/// Workspace price copy. Off until pricing labels ship. `isFree:true` on a hosted workspace shows
/// "Free". A BYO workspace, or `isFree:false`, shows `monthlyPriceCents` from the server.
/// The client never counts workspaces and never hardcodes an amount.
enum WorkspacePrice {
    static let enabled=false
    static let free="Free"
    static func byo(kind:String)->Bool { kind=="byo" }
    /// Dollars from server cents. `nil` when the server omitted the amount.
    static func formatCents(_ cents:Int?)->String? {
        guard let cents,cents>=0 else {return nil}
        let dollars=cents/100,remainder=cents%100
        if remainder==0 {return "$\(dollars)/mo"}
        return String(format:"$%d.%02d/mo",dollars,remainder)
    }
    static func pickerText(name:String,isFree:Bool?,byo:Bool,cents:Int?,enabled:Bool=WorkspacePrice.enabled)->String {
        let title=name.isEmpty ? "Workspace" : name
        guard enabled else {return title}
        if isFree==true && !byo {return title+" · "+free}
        if byo || isFree==false {
            guard let price=formatCents(cents) else {return title}
            return title+" · "+price
        }
        return title
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
