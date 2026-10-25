import AppKit
import SwiftUI

private enum GDPage: String, CaseIterable {
    case home = "Home"
    case cloud = "Files"
    case applications = "Applications"
    case plans = "Workspace plans"
    case storage = "Storage"
    case performance = "Performance"
    case account = "Account"
    var symbol: String {
        switch self {
        case .home: return "house.fill"
        case .cloud: return "externaldrive.fill.badge.wifi"
        case .applications: return "app.badge.fill"
        case .plans: return "square.stack.3d.up.fill"
        case .storage: return "externaldrive.fill"
        case .performance: return "bolt.fill"
        case .account: return "person.crop.circle"
        }
    }
}
private struct GDTier: Identifiable {
    let id: String
    let capacity: String
    let gigabytes: Int
    let monthly: Double
    let workers: Int
    let category: String
    var yearly: Double { (monthly * 10 * 100).rounded() / 100 }
    var monthlyEffectiveAnnual: Double { yearly / 12 }
}
private let gdTiers: [GDTier] = [
    .init(id:"100GB",capacity:"100 GB",gigabytes:100,monthly:7.99,workers:2,category:"Starter"),
    .init(id:"200GB",capacity:"200 GB",gigabytes:200,monthly:11.99,workers:2,category:"Essential"),
    .init(id:"300GB",capacity:"300 GB",gigabytes:300,monthly:15.99,workers:2,category:"Plus"),
    .init(id:"500GB",capacity:"500 GB",gigabytes:500,monthly:24.99,workers:2,category:"Creator"),
    .init(id:"1TB",capacity:"1 TB",gigabytes:1000,monthly:44.99,workers:4,category:"Popular"),
    .init(id:"2TB",capacity:"2 TB",gigabytes:2000,monthly:89.99,workers:8,category:"Power"),
    .init(id:"3TB",capacity:"3 TB",gigabytes:3000,monthly:129.99,workers:12,category:"Pro"),
    .init(id:"4TB",capacity:"4 TB",gigabytes:4000,monthly:169.99,workers:16,category:"Ultra"),
    .init(id:"5TB",capacity:"5 TB",gigabytes:5000,monthly:209.99,workers:20,category:"Studio"),
    .init(id:"6TB",capacity:"6 TB",gigabytes:6000,monthly:249.99,workers:24,category:"Ultimate")
]
private func gdMoney(_ value: Double) -> String { String(format:"$%.2f", value) }
private let gdPurple = Color(red:0.61,green:0.42,blue:0.98)
private let gdSecondary = Color.white.opacity(0.62)
private let gdSurface = Color.white.opacity(0.055)

private struct GDHeading: View {
    let kicker: String
    let title: String
    let subtitle: String
    var body: some View {
        VStack(alignment:.leading,spacing:7) {
            Text(kicker.uppercased()).font(.system(size:10,weight:.bold,design:.monospaced))
                .tracking(2.5).foregroundStyle(gdPurple)
            Text(title).font(.system(size:31,weight:.heavy,design:.rounded))
                .foregroundStyle(.white)
            Text(subtitle).font(.system(size:13)).foregroundStyle(gdSecondary)
                .fixedSize(horizontal:false,vertical:true)
        }.frame(maxWidth:.infinity,alignment:.leading)
    }
}
private struct GDPanel<Content:View>: View {
    let content:Content
    init(@ViewBuilder content:()->Content) {self.content=content()}
    var body:some View {
        VStack(alignment:.leading,spacing:15) {content}
            .padding(22).frame(maxWidth:.infinity,alignment:.leading)
            .background(gdSurface,in:RoundedRectangle(cornerRadius:19))
            .overlay(RoundedRectangle(cornerRadius:19).stroke(.white.opacity(0.10)))
    }
}
private struct GDPrimary: View {
    let title:String
    let icon:String
    let action:()->Void
    var body:some View {
        Button(action:action) {
            Label(title,systemImage:icon)
                .font(.system(size:13,weight:.bold))
                .frame(maxWidth:.infinity).padding(.vertical,12)
        }.buttonStyle(.plain)
         .foregroundStyle(.white)
         .background(LinearGradient(colors:[gdPurple,Color(red:0.34,green:0.22,blue:0.74)],startPoint:.topLeading,endPoint:.bottomTrailing),in:RoundedRectangle(cornerRadius:11))
    }
}

@MainActor struct MainView:View {
    @EnvironmentObject private var loginSession: GDLoginSession
    @EnvironmentObject private var redXSession: GDRedXAIAuthSession
    @StateObject private var ads = GenDragoonAdsModel()
    @StateObject private var native = GDNativeWorkspace.shared
    @StateObject private var customer = GDFreeCustomerModel()
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var page:GDPage = .cloud
    @State private var redXWorkspaceName = "My Cloud"
    @AppStorage("gd.commercial.preview.welcomeSeen") private var welcomeSeen = false
    private var googleReady: Bool { loginSession.stage == .ready && !loginSession.userID.isEmpty }
    private var nativeReady: Bool { redXSession.linked || loginSession.isOwner }

    var body:some View {
        HStack(spacing:0) {
            sidebar
            Divider().overlay(.white.opacity(0.08))
            ScrollView {
                VStack(alignment:.leading,spacing:20) {
                    GenDragoonCompactUpdateStatus()
                    if loginSession.adStatusKnown && !loginSession.isAdFree,let top=ads.top {
                        GenDragoonAdView(item:top)
                    }
                    switch page {
                    case .home: homePage
                    case .cloud: cloudPage
                    case .applications: applicationsPage
                    case .plans: plansPage
                    case .storage: storagePage
                    case .performance: performancePage
                    case .account: accountPage
                    }
                }.padding(28)
                 .frame(maxWidth:1080,alignment:.leading)
                 .frame(maxWidth:.infinity,alignment:.top)
            }
        }
        .background(Color(red:0.055,green:0.048,blue:0.092).ignoresSafeArea())
        .preferredColorScheme(.dark)
        .frame(minWidth:950,minHeight:720)
        .onAppear {
            if loginSession.stage == .ready {
                ads.refresh(isAdFree:loginSession.isAdFree,allowFetch:loginSession.adStatusKnown)
                customer.connect(loginSession)
            }
        }
        .task { if loginSession.isOwner || redXSession.linked { await native.start() } }
        .onChange(of:page) {_,_ in
            if loginSession.stage == .ready {
                loginSession.checkAdEntitlement()
                ads.refresh(isAdFree:loginSession.isAdFree,allowFetch:loginSession.adStatusKnown)
            }
        }
        .onChange(of:loginSession.isAdFree) {_,newValue in ads.refresh(isAdFree:newValue)}
        .onChange(of:loginSession.adStatusKnown) {_,known in
            if known {ads.refresh(isAdFree:loginSession.isAdFree)}
        }
        .onChange(of:loginSession.userID) {_,_ in if googleReady { customer.connect(loginSession) } }
        .onChange(of:redXSession.linked) {_,linked in
            if linked { Task { await native.start(); await native.refreshCloudChoices() } }
        }
        .onReceive(NotificationCenter.default.publisher(for:GDProjectPreferences.selectionChanged)) {
            if loginSession.stage == .ready { customer.selectionChanged($0) }
        }
        .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
            if loginSession.stage == .ready { customer.refresh(); loginSession.checkAdEntitlement() }
            if redXSession.linked { Task { await redXSession.refreshWorkspaces() } }
        }
    }
    private var sidebar:some View {
        VStack(alignment:.leading,spacing:10) {
            HStack(spacing:12) {
                Image(systemName:"externaldrive.fill.badge.wifi")
                    .font(.system(size:25)).foregroundStyle(gdPurple)
                    .frame(width:47,height:47)
                    .background(gdPurple.opacity(0.14),in:RoundedRectangle(cornerRadius:14))
                VStack(alignment:.leading,spacing:3) {
                    Text("GENDRAGOON").font(.system(size:16,weight:.heavy,design:.rounded)).tracking(1.3)
                    Text("CLOUD SSD").font(.system(size:10,weight:.bold,design:.monospaced))
                        .foregroundStyle(gdSecondary).tracking(2)
                }
            }.padding(.bottom,29)
            ForEach(GDPage.allCases,id:\.self) { dest in
                Button {withAnimation(.easeInOut(duration:0.18)) {page=dest}} label:{
                    HStack(spacing:12) {
                        Image(systemName:dest.symbol).frame(width:23)
                        Text(dest.rawValue).font(.system(size:13,weight:.semibold))
                        Spacer()
                        if page == dest {Image(systemName:"chevron.right").font(.system(size:10,weight:.bold))}
                    }
                    .foregroundStyle(page == dest ? Color.white : gdSecondary)
                    .padding(.horizontal,14).padding(.vertical,13)
                    .background(page == dest ? gdPurple.opacity(0.21) : .clear,in:RoundedRectangle(cornerRadius:11))
                    .overlay(RoundedRectangle(cornerRadius:11).stroke(page == dest ? gdPurple.opacity(0.55) : .clear))
                }.buttonStyle(.plain)
            }
            Spacer()
            if loginSession.adStatusKnown && !loginSession.isAdFree,let side=ads.side {
                GenDragoonAdView(item:side,compact:true)
            }
            Text("GenDragoon v\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "—") · macOS").font(.system(size:10,design:.monospaced))
                .foregroundStyle(gdSecondary)
        }
        .padding(20)
        .frame(width:258)
        .background(Color.white.opacity(0.025))
    }
    private var homePage:some View {
        VStack(alignment:.leading,spacing:20) {
            HStack(alignment:.center,spacing:16) {
                VStack(alignment:.leading,spacing:9) {
                    Text("YOUR CLOUD. YOUR RULES.").font(.system(size:11,weight:.heavy,design:.monospaced))
                        .tracking(3).foregroundStyle(Color(red:0.83,green:0.74,blue:1.0))
                    Text("A home for everything you create.")
                        .font(.system(size:38,weight:.heavy,design:.rounded))
                    Text("Keep files in your private cloud, restore them when needed, and use the managed library for compatible Mac app streaming.")
                        .font(.system(size:14)).foregroundStyle(.white.opacity(0.76))
                }
                Spacer()
                Image(systemName:"cloud.bolt.fill").font(.system(size:54))
                    .foregroundStyle(.white.opacity(0.9))
            }
            .padding(28).frame(maxWidth:.infinity,alignment:.leading)
            .background(LinearGradient(colors:[Color(red:0.34,green:0.20,blue:0.68),Color(red:0.13,green:0.10,blue:0.27)],startPoint:.topLeading,endPoint:.bottomTrailing),in:RoundedRectangle(cornerRadius:21))
            GDHeading(kicker:"GET STARTED",title:"Your setup, in three simple steps",subtitle:"Choose a storage option, connect your account, and open the cloud library.")
            GDPanel {
                onboardingStep(1,"Free private cloud","Create a free 2 GB workspace to upload, list and restore files.","My Cloud","cloud.fill") { page = .cloud }
                Divider()
                onboardingStep(2,"API integrations","Manage your private, scoped API keys for server applications.","API Keys","key.fill") { page = .account }
                Divider()
                onboardingStep(3,"Mac app library","For compatible Mac bundles, selectively preload into the local cache.","My Cloud","bolt.fill") {page = .cloud}
            }
            HStack(spacing:12) {
                GDPanel {
                    Label("Your cloud library",systemImage:"checkmark.seal.fill")
                        .foregroundStyle(gdPurple).font(.system(size:12,weight:.semibold))
                    Text("Applications, files and folders").font(.system(size:17,weight:.bold))
                    Text("Review current storage and performance offers, retain your selected tier, and activate it through secure checkout.")
                        .font(.system(size:11)).foregroundStyle(gdSecondary)
                    GDPrimary(title:"Choose a plan",icon:"arrow.up.right") {page = .plans}
                }
                GDPanel {
                    Label("Smart streaming",systemImage:"bolt.fill")
                        .foregroundStyle(gdPurple).font(.system(size:12,weight:.semibold))
                    Text("10 GiB free-space reserve").font(.system(size:17,weight:.bold))
                    Text("Compatible app bundles can stream from the mount; other apps need a local copy.")
                        .font(.system(size:11)).foregroundStyle(gdSecondary)
                    GDPrimary(title:"Go to My Cloud",icon:"externaldrive") {page = .cloud}
                }
            }
        }
    }
    private func onboardingStep(_ number:Int,_ title:String,_ description:String,_ button:String,_ icon:String,action:@escaping ()->Void)->some View {
        HStack(alignment:.center,spacing:13) {
            Text(String(number)).font(.system(size:16,weight:.bold,design:.monospaced))
                .foregroundStyle(gdPurple)
                .frame(width:37,height:37)
                .background(gdPurple.opacity(0.16),in:Circle())
            VStack(alignment:.leading,spacing:4) {
                Text(title).font(.system(size:14,weight:.bold))
                Text(description).font(.system(size:11)).foregroundStyle(gdSecondary)
                    .fixedSize(horizontal:false,vertical:true)
            }
            Spacer(minLength:12)
            Button {action()} label:{Label(button,systemImage:icon).font(.system(size:11,weight:.semibold))}
                .buttonStyle(.bordered)
        }
    }
    private var plansPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"WORKSPACE PLANS",title:"Storage that matches how you work.",subtitle:"Red-XAI managed storage and Google/custom-provider plans can coexist on the same Mac.")
            if redXSession.linked { redXStoragePanel }
            if loginSession.stage == .ready {
                GDPanel {
                    Label("Google / custom-provider plans",systemImage:"square.stack.3d.up.fill").font(.headline)
                    Text("Choose storage and performance plans for Google or your own provider. Provider storage/network billing remains separate where applicable.")
                        .font(.caption).foregroundStyle(gdSecondary)
                }
                GenDragoonStripePurchases(focus:"custom")
            }
        }
    }
    private var storagePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"STORAGE",title:"Your cloud space.",subtitle:"Manage encrypted Red-XAI Receiver workspaces or review Google/custom-provider storage plans.")
            if redXSession.linked { redXStoragePanel }
            if loginSession.stage == .ready { GenDragoonStripePurchases(focus:"standard") }
        }
    }
    private var performancePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"PERFORMANCE",title:"Tune your transfer workload.",subtitle:"GenDragoon keeps a 10 GiB local free-space reserve while staging verified cloud content.")
            if redXSession.linked {
                GDPanel {
                    Label("Red-XAI encrypted transfers",systemImage:"bolt.shield.fill").font(.headline)
                    Text("Large archives use resumable 4 MiB encrypted PNG chunks. Verified chunks are reused after an interruption instead of starting over.")
                        .font(.caption).foregroundStyle(gdSecondary)
                    Text(redXSession.usageSummary).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            if loginSession.stage == .ready { GenDragoonStripePurchases(focus:"performance") }
        }
    }
    private var cloudPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"FILES & FOLDERS",title:"Everything, in its place.",subtitle:"Choose your project, upload any files or complete folders, and download a verified copy when you need it.")
            if redXSession.linked || loginSession.isOwner {
                GDNativeWorkspaceView(native:native,content:.files)
            }
            if loginSession.stage == .ready {
                GenDragoonFreeCloudPanel(customer:customer,content:.files,onStorage:{page = .storage})
            }
        }
    }
    private var applicationsPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"APPLICATIONS",title:"Your applications. Room to create.",subtitle:"Keep complete applications in cloud storage, restore them when needed, and launch compatible Mac apps from a verified managed library.")
            if redXSession.linked || loginSession.isOwner {
                GDNativeWorkspaceView(native:native,content:.applications)
            }
            if loginSession.stage == .ready {
                GenDragoonFreeCloudPanel(customer:customer,content:.applications,showProjectControls:false,onStorage:{page = .storage})
            }
        }
    }
    private var redXStoragePanel: some View {
        GDPanel {
            Label("Red-XAI encrypted Receiver",systemImage:"lock.shield.fill")
                .font(.system(size:16,weight:.bold)).foregroundStyle(.green)
            Text(redXSession.usageSummary).font(.system(size:12,design:.monospaced)).foregroundStyle(gdSecondary)
            Text(redXSession.email.isEmpty ? redXSession.subject : redXSession.email)
                .font(.system(size:12,weight:.semibold)).textSelection(.enabled)
            HStack {
                TextField("New workspace name",text:$redXWorkspaceName).textFieldStyle(.roundedBorder)
                Button("Create Workspace") {
                    let name=redXWorkspaceName
                    Task { try? await redXSession.createWorkspace(name:name); await native.refreshCloudChoices() }
                }.disabled(redXSession.busy || redXWorkspaceName.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty)
                Button("Refresh") { Task { await redXSession.refreshWorkspaces(); await native.refreshCloudChoices() } }
            }
            Text("\(redXSession.uploadProjects.first?.buckets.count ?? 0) Red-XAI workspace(s) available in the Files / Applications destination picker.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
    private var accountPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"ACCOUNT & SECURITY",title:"Your GenDragoon connections",subtitle:"Red-XAI and Google can be connected independently on the same Mac.")
            if redXSession.linked {
                GDPanel {
                    Label("Red-XAI account connected",systemImage:"checkmark.shield.fill")
                        .font(.system(size:16,weight:.bold)).foregroundStyle(.green)
                    Text(redXSession.email.isEmpty ? redXSession.subject : redXSession.email)
                        .font(.system(size:14,weight:.semibold)).textSelection(.enabled)
                    Text("Approval is stored in macOS Keychain. GenDragoon stays signed in independently until app logout/revocation or the 30-day app-session expiry.")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Text(redXSession.usageSummary).font(.caption.monospaced()).foregroundStyle(gdSecondary)
                    Button("Disconnect GenDragoon from Red-XAI") { redXSession.logout() }
                        .buttonStyle(.bordered).tint(.orange)
                        .disabled(activity.hasActiveOperations || activity.isMaintenancePending)
                }
            }
            if !redXSession.linked {
                GDPanel {
                    Label("Red-XAI account",systemImage:"person.badge.key")
                        .font(.system(size:16,weight:.bold)).foregroundStyle(gdPurple)
                    Text(redXSession.status).font(.system(size:12)).foregroundStyle(gdSecondary)
                    Button("Connect Red-XAI") { redXSession.connect() }
                        .buttonStyle(.borderedProminent).tint(gdPurple).disabled(redXSession.busy)
                }
            }
            if loginSession.stage == .ready {
                GDPanel {
                    Label("Google account verified",systemImage:"checkmark.shield.fill")
                        .font(.system(size:16,weight:.bold)).foregroundStyle(.green)
                    Text(loginSession.email).font(.system(size:14,weight:.semibold))
                    Text("Authenticated by Firebase project gendragoonssd. Terms acceptance is verified from your private Firestore document.")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Button("Sign out of Google / GenDragoon") {loginSession.logout()}
                        .buttonStyle(.bordered).tint(.orange)
                        .disabled(activity.hasActiveOperations || activity.isMaintenancePending)
                }
                GDPanel {
                    Label("Remove Ads · one-time purchase",systemImage:"megaphone.slash.fill")
                        .font(.system(size:16,weight:.bold))
                    Text("$4.99 once · Remove top and sidebar sponsored placements from your Google account permanently.")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Text(loginSession.isAdFree ? "Ad-free entitlement active" : "Use the checkout panel to activate ad-free access.")
                        .font(.system(size:12)).foregroundStyle(loginSession.isAdFree ? .green : .orange)
                }
                GenDragoonStripePurchases(focus:"ads")
                GenDragoonAPIKeysPanel()
            } else {
                GDPanel {
                    Label("Google / Firebase",systemImage:"g.circle")
                        .font(.system(size:16,weight:.bold))
                    Text("Optional. Connect Google to keep using the existing Firebase project features, Google/custom-provider workspaces, ad entitlement, and provider-specific billing.")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Button("Connect Google") { loginSession.login() }.buttonStyle(.bordered)
                }
            }
            GenDragoonAutomaticUpdateStatus()
            GDPanel {
                AccountResetSection(isBusy: native.maintenanceBusy,
                    acquireExclusiveOperation: { native.acquireReset() },
                    releaseExclusiveOperation: { native.releaseReset() })
            }
        }
    }
}
