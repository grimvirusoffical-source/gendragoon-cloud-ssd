import Foundation

@main struct WorkspaceSetupPolicyTests {
    static func main() {
        let receiver = String(repeating: "a", count: 64)
        let a = String(repeating: "b", count: 32), b = String(repeating: "c", count: 32)
        let own: Set<String> = [a, b]
        var count = 0
        func expect(_ title: String, _ actual: GDWorkspaceSetupPolicy.Stage, _ expected: GDWorkspaceSetupPolicy.Stage) {
            precondition(actual == expected, "\(title): \(actual) != \(expected)"); count += 1
        }
        func state(_ linked: Bool = true, _ workspace: String? = a, _ mounts: Set<String> = [], _ signed: Set<String> = []) -> GDWorkspaceSetupPolicy.Stage {
            GDWorkspaceSetupPolicy.stage(linked: linked, receiver: receiver, workspace: workspace,
                                         owned: own, mounted: mounts, signed: signed)
        }
        expect("sign in first", state(false,a,[a],[a]), .signIn)
        expect("choose a workspace", state(true,nil), .chooseWorkspace)
        expect("no mount", state(), .mount)
        expect("local credential does not skip mount", state(true,a,[],[a]), .mount)
        expect("mount alone does not unlock", state(true,a,[a]), .sign)
        expect("same workspace mounted and server signed", state(true,a,[a],[a]), .ready)
        expect("different workspace signature does not unlock", state(true,a,[a],[b]), .sign)
        expect("different workspace mount does not unlock", state(true,a,[b],[a]), .mount)
        expect("unmount relocks", state(true,a,[],[a]), .mount)
        expect("unsign relocks", state(true,a,[a],[]), .sign)
        expect("switch to unsigned workspace relocks", state(true,b,[a,b],[a]), .sign)
        expect("unowned workspace rejected", state(true,String(repeating:"d",count:32)), .chooseWorkspace)
        expect("invalid identity rejected", GDWorkspaceSetupPolicy.stage(linked:true,receiver:"not-an-account",workspace:a,owned:own,mounted:[a],signed:[a]), .signIn)
        for stage in [GDWorkspaceSetupPolicy.Stage.signIn,.chooseWorkspace,.mount,.sign,.ready] {
            for page in ["Home","Account"] { precondition(GDWorkspaceSetupPolicy.mayOpen(page:page,stage:stage)); count += 1 }
            for page in ["Files","Applications","Teams","Integrations","MachineNotes","Storage","Performance"] {
                precondition(GDWorkspaceSetupPolicy.mayOpen(page:page,stage:stage) == (stage == .ready)); count += 1
            }
        }
        print("\(count) setup-order assertions passed")
    }
}
