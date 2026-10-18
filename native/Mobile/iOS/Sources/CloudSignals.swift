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
        if message==nil || message?.isEmpty==true || message==lockCode {message="Cloud request failed (HTTP \(status))."}
        return Route(destination:.genericError,toast:message,lock:nil,method:method)
    }
    static func workspaceLock(status:Int,body:String)->WorkspaceLock? {
        guard status==423,jsonString(body,"error")==lockCode else {return nil}
        return WorkspaceLock(workspaces:workspaces(body),raw:body)
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
    var id:String { raw.isEmpty ? "workspace-lock" : raw }
    var issueSummary:String {
        let cap=workspaces.contains{$0.issue=="over_cap"}
        let unpaid=workspaces.contains{$0.issue=="unpaid"}
        if cap && unpaid {return "Some workspaces are over the plan cap or unpaid."}
        if cap {return "Some workspaces are over the plan cap."}
        if unpaid {return "Some workspaces are unpaid."}
        return ""
    }
    static func decode(_ raw:String)->WorkspaceLock { WorkspaceLock(workspaces:CloudSignals.workspaces(raw),raw:raw) }
}
