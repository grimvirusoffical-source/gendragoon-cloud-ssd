import AppKit
import SwiftUI

private enum GDPage: String, CaseIterable {
    case home = "Home"
    case cloud = "Files"
    case applications = "Applications"
    case teams = "Teams"
    case integrations = "Integrations"
    case plans = "MachineNotes"
    case storage = "Storage"
    case performance = "Performance"
    case account = "Account"
    var symbol: String {
        switch self {
        case .home: return "house.fill"
        case .cloud: return "externaldrive.fill.badge.wifi"
        case .applications: return "app.badge.fill"
        case .teams: return "person.3.fill"
        case .integrations: return "point.3.connected.trianglepath.dotted"
        case .plans: return "square.stack.3d.up.fill"
        case .storage: return "externaldrive.fill"
        case .performance: return "bolt.fill"
        case .account: return "person.crop.circle"
        }
    }
}
let gdPurple = Color(red:0.61,green:0.42,blue:0.98)
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
struct GDPanel<Content:View>: View {
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
    @EnvironmentObject private var redXSession: GDRedXAIAuthSession
    @StateObject private var ads = GenDragoonAdsModel()
    @StateObject private var native = GDNativeWorkspace.shared
    @StateObject private var subscriptions = GDRXSubscriptionModel()
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var page:GDPage = .cloud

    var body:some View {
        HStack(spacing:0) {
            sidebar
            Divider().overlay(.white.opacity(0.08))
            ScrollView {
                VStack(alignment:.leading,spacing:20) {
                    GenDragoonCompactUpdateStatus()
                    GDDiskSpaceNotice()
                    if subscriptions.accountVerified && !subscriptions.adFree,let top=ads.top {
                        GenDragoonAdView(item:top)
                    }
                    switch page {
                    case .home: homePage
                    case .cloud: cloudPage
                    case .applications: applicationsPage
                    case .teams: GDDevTeamsView()
                    case .integrations: GDIntegrationsView()
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
        .task {
            GDCompanion.shared.start()
            if redXSession.linked {
                subscriptions.refresh(redXSession)
                await native.start()
            }
        }
        .onChange(of:page) { _,_ in
            if redXSession.linked { subscriptions.refresh(redXSession) }
        }
        .onReceive(NotificationCenter.default.publisher(for: .init("GDIntegrationURLReceived"))) { _ in page = .integrations }
        .onChange(of:subscriptions.adFree) { _,adFree in
            ads.refresh(isAdFree:adFree,allowFetch:subscriptions.accountVerified)
        }
        .onChange(of:subscriptions.accountVerified) { _,known in
            ads.refresh(isAdFree:subscriptions.adFree,allowFetch:known)
        }
        .onChange(of:redXSession.linked) { _,linked in
            if linked {
                subscriptions.refresh(redXSession)
                Task { await native.start(); await native.refreshCloudChoices() }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
            if redXSession.linked {
                subscriptions.refresh(redXSession)
                Task { await redXSession.refreshWorkspaces() }
            }
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
            if subscriptions.accountVerified && !subscriptions.adFree,let side=ads.side {
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
            GDHeading(kicker:"GET STARTED",title:"Your setup, in three simple steps",subtitle:"Create a MachineNote, choose its plans, and open your encrypted library.")
            GDPanel {
                onboardingStep(1,"Your private MachineNotes","Your first MachineNote has no MachineNote fee. Choose storage and Free or paid performance to start.","MachineNotes","cloud.fill") { page = .plans }
                Divider()
                onboardingStep(2,"Storage and performance","Choose storage capacity and transfer concurrency for each MachineNote.","Plans","slider.horizontal.3") { page = .plans }
                Divider()
                onboardingStep(3,"Mac app library","For compatible Mac bundles, selectively preload into the local cache.","Applications","bolt.fill") {page = .applications}
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
                    Text("10 GB free space recommended").font(.system(size:17,weight:.bold))
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
            GDHeading(kicker:"MACHINENOTES",title:"Storage that matches how you work.",subtitle:"Encrypted files, folders and applications on the Red-XAI server, organized in your MachineNotes.")
            if redXSession.linked {
                redXStoragePanel
                GDRXSubscriptionsPanel(focus:.plans)
                GDPanel { GDMachineNotesInventoryPanel() }
            }
        }
    }
    private var storagePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"STORAGE",title:"Your cloud space.",subtitle:"Choose the server storage capacity for each encrypted MachineNote.")
            if redXSession.linked {
                redXStoragePanel
                GDRXSubscriptionsPanel(focus:.storage)
            }
        }
    }
    private var performancePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"PERFORMANCE",title:"Tune your transfer workload.",subtitle:"Keep 10 GB free for comfortable operation. GenDragoon checks the actual staging space required for each transfer.")
            if redXSession.linked {
                GDPanel {
                    Label("Red-XAI encrypted transfers",systemImage:"bolt.shield.fill").font(.headline)
                    Text("Archives use resumable encrypted red-X barcode PNG chunks. Verified chunks are reused after an interruption instead of starting over. Storage usage includes the encoded images.")
                        .font(.caption).foregroundStyle(gdSecondary)
                    Text(redXSession.usageSummary).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }
            if redXSession.linked { GDRXSubscriptionsPanel(focus:.performance) }
        }
    }
    private var cloudPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"FILES & FOLDERS",title:"Everything, in its place.",subtitle:"Choose a MachineNote, upload files or complete folders, and restore a verified copy when you need it.")
            if redXSession.linked {
                GDNativeWorkspaceView(native:native,content:.files)
                GDWorkspaceMountsPanel()
            }
        }
    }
    private var applicationsPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"APPLICATIONS",title:"Your applications. Room to create.",subtitle:"Keep complete applications in cloud storage, restore them when needed, and launch compatible Mac apps from a verified managed library.")
            if redXSession.linked {
                GDNativeWorkspaceView(native:native,content:.applications)
            }
        }
    }
    private var redXStoragePanel: some View {
        GDPanel {
            Label("MachineNotes · Encrypted server storage",systemImage:"lock.shield.fill")
                .font(.system(size:16,weight:.bold)).foregroundStyle(.green)
            Text(redXSession.usageSummary).font(.system(size:12,design:.monospaced)).foregroundStyle(gdSecondary)
            Text(redXSession.email.isEmpty ? redXSession.subject : redXSession.email)
                .font(.system(size:12,weight:.semibold)).textSelection(.enabled)
            HStack {
                Button("Create MachineNote / Choose Plans") { page = .plans }
                    .buttonStyle(.borderedProminent).tint(gdPurple)
                Button("Refresh") { Task { await redXSession.refreshWorkspaces(); await native.refreshCloudChoices() } }
            }
            Text("MachineNote #1 has no MachineNote fee forever, but still needs storage and a performance choice. Each additional MachineNote adds $5/month. Free performance uses 1 worker; paid tiers increase transfer and preload concurrency.")
                .font(.caption).foregroundStyle(.secondary)
            Text("\(redXSession.uploadProjects.first?.buckets.count ?? 0) MachineNotes available in the Files / Applications destination picker.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
    private var accountPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"ACCOUNT & SECURITY",title:"Your Red-XAI account",subtitle:"One account for your encrypted server storage and MachineNote subscriptions.")
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
            if redXSession.linked {
                GDRXSubscriptionsPanel(focus:.ads)
            }
            GenDragoonAutomaticUpdateStatus()
            GDCompanionPanel()
            GDPortableVaultPanel()
            GDAccountDeletionSection()
            GDPanel {
                AccountResetSection(isBusy: native.maintenanceBusy,
                    acquireExclusiveOperation: { native.acquireReset() },
                    releaseExclusiveOperation: { native.releaseReset() })
            }
        }
    }
}
