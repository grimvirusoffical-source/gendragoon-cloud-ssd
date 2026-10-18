import AppKit
import SwiftUI

private enum GDPage: String, CaseIterable {
    case home = "Home"
    case cloud = "Files"
    case applications = "Applications"
    case plans = "Bundles"
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
private struct GDDraftWorkspace: Identifiable, Codable {
    let id: String
    let name: String
    let planID: String
    let planMode: String
    let yearly: Bool
    let totalCents: Int
}

@MainActor struct MainView:View {
    @EnvironmentObject private var loginSession: GDLoginSession
    @StateObject private var ads = GenDragoonAdsModel()
    @StateObject private var native = GDNativeWorkspace.shared
    @StateObject private var customer = GDFreeCustomerModel()
    @ObservedObject private var activity = GDUpdateActivity.shared
    @ObservedObject private var workspaceLock = GDWorkspaceLock.shared
    @State private var page:GDPage = .cloud
    @AppStorage("gd.commercial.preview.welcomeSeen") private var welcomeSeen = false
    @AppStorage("gd.commercial.preview.selectedTier") private var selectedTier = "1TB"
    @AppStorage("gd.commercial.preview.annual") private var annual = false
    @AppStorage("gd.commercial.preview.storageMode") private var storageMode = "managed"
    @State private var workspaceDraftsRevision = 0
    private var workspaceDraftsKey: String { "gd.workspace.drafts.v2."+loginSession.userID }
    private var workspaceDraftsJSON: String { UserDefaults.standard.string(forKey:workspaceDraftsKey) ?? "[]" }
    @State private var newWorkspaceName = ""
    @State private var newWorkspacePlan = "100GB"
    @State private var newWorkspaceMode = "bundle"
    @State private var workspaceStatus = ""

    private var savedDrafts: [GDDraftWorkspace] {
        _ = workspaceDraftsRevision
        guard let data = workspaceDraftsJSON.data(using:.utf8),
              let records = try? JSONDecoder().decode([GDDraftWorkspace].self,from:data) else { return [] }
        return records
    }
    private var quotedStorage: GDTier { gdTiers.first(where:{$0.id==newWorkspacePlan}) ?? gdTiers[0] }
    private var workspaceStorageCents: Int {
        newWorkspaceMode == "bundle" ? Int((quotedStorage.monthly*100).rounded()) : Int((storagePrice(quotedStorage)*100).rounded())
    }
    private var workspaceChargeCents: Int { workspaceStorageCents * (annual ? 10:1) + 500 }
    private func saveWorkspaceDraft() {
        let name = newWorkspaceName.trimmingCharacters(in:.whitespacesAndNewlines)
        guard name.count >= 3 && name.count <= 64 && !name.contains("/") && !name.contains("\\") else {
            workspaceStatus = "Enter a 3–64 character workspace name without slashes."
            return
        }
        var records=savedDrafts
        guard records.count < 100 else { workspaceStatus = "Limit of 100 local drafts reached."; return }
        records.append(.init(id:UUID().uuidString.lowercased(),name:name,planID:newWorkspacePlan,planMode:newWorkspaceMode,yearly:annual,totalCents:workspaceChargeCents))
        if let data=try? JSONEncoder().encode(records), let json=String(data:data,encoding:.utf8) {
            UserDefaults.standard.set(json,forKey:workspaceDraftsKey)
            workspaceDraftsRevision += 1
            workspaceStatus="Draft saved locally for this Google account. No bucket created and no payment charged."
            newWorkspaceName=""
        }
    }
    private var chosen:GDTier? { gdTiers.first(where:{$0.id == selectedTier}) }
    private var chosenLabel:String {
        if storageMode == "byo" { return "\(GDWorkspaceOffer.monthlyLabel) · Your S3-compatible bucket" }
        guard let t=chosen else {return "Choose a plan"}
        return "\(t.capacity) · \(gdMoney(annual ? t.yearly : t.monthly))/\(annual ? "year" : "month")"
    }
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
        .onAppear {ads.refresh(isAdFree:loginSession.isAdFree,allowFetch:loginSession.adStatusKnown); customer.connect(loginSession)}
        .task { if loginSession.isOwner { await native.start() } }
        .onChange(of:page) {_,_ in
            loginSession.checkAdEntitlement()
            ads.refresh(isAdFree:loginSession.isAdFree,allowFetch:loginSession.adStatusKnown)
        }
        .onChange(of:loginSession.isAdFree) {_,newValue in ads.refresh(isAdFree:newValue)}
        .onChange(of:loginSession.adStatusKnown) {_,known in
            if known {ads.refresh(isAdFree:loginSession.isAdFree)}
        }
        .onChange(of:loginSession.userID) {_,_ in customer.connect(loginSession)}
        .onReceive(NotificationCenter.default.publisher(for:GDProjectPreferences.selectionChanged)) { customer.selectionChanged($0) }
        .onReceive(NotificationCenter.default.publisher(for:NSApplication.didBecomeActiveNotification)) { _ in
            customer.refresh(); loginSession.checkAdEntitlement()
        }
        .sheet(isPresented: $workspaceLock.presented) {
            GDWorkspaceLockScreen()
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
                    Text("Keep files in your private cloud, restore them when needed, and use the owner library for compatible Mac app streaming.")
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
            GDHeading(kicker:"STORAGE + PERFORMANCE",title:"Choose your cloud plan.",subtitle:"Select a server-listed tier, retain your choice, and review the exact amount in secure checkout.")
            GenDragoonStripePurchases(focus:"bundle")
            GDPanel {
                Label("Bring your own S3-compatible bucket",systemImage:"server.rack").font(.headline)
                Text("Connect an S3-compatible bucket: Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, or Google Cloud with S3/HMAC keys. The workspace is \(GDWorkspaceOffer.monthlyLabel). SFTP, Azure, and WebDAV are coming soon. Performance features cost extra unless you stay on the free performance tier.")
                    .font(.caption).foregroundStyle(gdSecondary)
            }
            GenDragoonStripePurchases(focus:"byo")
        }
    }
    private var storagePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"STORAGE",title:"Choose the space you need.",subtitle:"Your selected capacity and billing period stay selected while you review available plans.")
            GenDragoonStripePurchases(focus:"standard")
        }
    }
    private func storagePrice(_ tier:GDTier)->Double {
        ((tier.monthly * 0.8 * 100).rounded(.up))/100
    }
    private var performancePage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"PERFORMANCE",title:"Tune your transfer workload.",subtitle:"The free performance tier is included with every hosted or bring-your-own workspace. Paid transfer-worker plans cost extra. Actual speed depends on the network, provider and workload.")
            GenDragoonStripePurchases(focus:"performance")
        }
    }
    private func performanceRow(name:String,price:Int,workers:Int,symbol:String)->some View {
        HStack(spacing:16) {
            Image(systemName:symbol).font(.system(size:23)).foregroundStyle(gdPurple)
                .frame(width:43,height:43).background(gdPurple.opacity(0.14),in:RoundedRectangle(cornerRadius:11))
            VStack(alignment:.leading,spacing:5) {
                Text(name).font(.system(size:15,weight:.bold))
                Text("\(workers) simultaneous transfer workers").font(.system(size:11)).foregroundStyle(gdSecondary)
            }
            Spacer()
            VStack(alignment:.trailing,spacing:4) {
                Text("$\(annual ? price*10 : price)" + (annual ? "/year" : "/month"))
                    .font(.system(size:17,weight:.bold))
                Text("Coming with billing").font(.system(size:10)).foregroundStyle(.orange)
            }
        }.padding(14).background(gdSurface,in:RoundedRectangle(cornerRadius:13))
    }
    private func planCard(_ tier:GDTier)->some View {
        let chosen=storageMode == "managed" && selectedTier == tier.id
        return VStack {
            VStack(alignment:.leading,spacing:9) {
                HStack {
                    Text(tier.category.uppercased())
                        .font(.system(size:10,weight:.heavy,design:.rounded)).tracking(1.4)
                        .foregroundStyle(gdPurple)
                    Spacer()
                    if chosen {Image(systemName:"checkmark.circle.fill").foregroundStyle(.green)}
                }
                Text(tier.capacity).font(.system(size:24,weight:.heavy,design:.rounded))
                HStack(alignment:.firstTextBaseline,spacing:2) {
                    Text(gdMoney(annual ? tier.yearly : tier.monthly))
                        .font(.system(size:21,weight:.bold))
                    Text(annual ? "/year" : "/month").font(.system(size:10))
                        .foregroundStyle(gdSecondary)
                }
                if annual {Text("≈ \(gdMoney(tier.monthlyEffectiveAnnual))/month").font(.system(size:11)).foregroundStyle(gdSecondary)}
                Divider().overlay(.white.opacity(0.1))
                Label("Private \(tier.capacity) storage",systemImage:"checkmark")
                Label("\(tier.workers) transfer workers¹",systemImage:"arrow.up.arrow.down")
                Label("App library & restores",systemImage:"checkmark")
                Text("Choose in checkout below")
                    .font(.system(size:10,weight:.heavy,design:.monospaced))
                    .foregroundStyle(chosen ? Color.green : gdPurple)
                    .padding(.top,5)
            }
            .font(.system(size:11)).foregroundStyle(Color.white)
            .frame(maxWidth:.infinity,minHeight:184,alignment:.leading)
            .padding(16)
            .background(chosen ? gdPurple.opacity(0.18) : gdSurface,in:RoundedRectangle(cornerRadius:16))
            .overlay(RoundedRectangle(cornerRadius:16).stroke(chosen ? gdPurple : Color.white.opacity(0.13),lineWidth:chosen ? 2:1))
        }.buttonStyle(.plain)
    }
    private var workspacesPage: some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"PROJECT WORKSPACES",title:"A separate cloud for every project.",subtitle:"The first hosted workspace is free. Each additional hosted workspace, and each S3-compatible bucket you connect, is $5/month. SFTP, Azure, and WebDAV are coming soon. Performance features cost extra unless you stay on the free performance tier.")
            if loginSession.isOwner { GDPanel {
                HStack {
                    Image(systemName:"externaldrive.fill.badge.checkmark")
                        .font(.system(size:28)).foregroundStyle(gdPurple)
                    VStack(alignment:.leading,spacing:5) {
                        Text("Your existing personal cloud").font(.system(size:17,weight:.bold))
                        Text("Google Cloud · storage project: \(GDProjects.storageProjectID)")
                            .font(.system(size:11)).foregroundStyle(gdSecondary)
                        Text("Existing bucket connection is preserved, not migrated or billed by this preview.")
                            .font(.system(size:11)).foregroundStyle(gdSecondary)
                    }
                    Spacer()
                    Button("Manage") {page = .cloud}.buttonStyle(.borderedProminent).tint(.purple)
                }
            }}
            GDPanel {
                Label("Free workspace · 2 GB · 1 transfer worker",systemImage:"gift.fill")
                    .font(.system(size:16,weight:.bold))
                Text("Free includes one parallel transfer, resumable uploads and integrity checks, with no artificial bandwidth cap. One free project per account, no payment required.")
                    .font(.system(size:12)).foregroundStyle(gdSecondary)
            }
            GDPanel {
                Label("Create a workspace draft",systemImage:"plus.square.on.square")
                    .font(.system(size:18,weight:.bold))
                Text("Choose a name and one required storage plan. This saves a local draft; actual provisioning will occur only after verified Google sign-in, Terms acceptance, and Stripe payment.")
                    .font(.system(size:12)).foregroundStyle(gdSecondary)
                TextField("Project name · e.g. Music Studio",text:$newWorkspaceName)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing:12) {
                    Picker("Storage",selection:$newWorkspacePlan) {
                        ForEach(gdTiers) { tier in Text(tier.capacity).tag(tier.id) }
                    }.frame(maxWidth:.infinity)
                    Picker("Type",selection:$newWorkspaceMode) {
                        Text("Storage + Performance").tag("bundle")
                        Text("Storage Only").tag("standard")
                    }.frame(maxWidth:.infinity)
                }
                Picker("Billing",selection:$annual) {
                    Text("Monthly").tag(false)
                    Text("Yearly · 2 months free").tag(true)
                }.pickerStyle(.segmented)
                Divider()
                HStack {
                    Text("Required \(quotedStorage.capacity) storage plan")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Spacer()
                    Text(gdMoney(Double(workspaceStorageCents)/100 * (annual ? 10:1)))
                        .font(.system(size:13,weight:.semibold))
                }
                HStack {
                    Text("Private workspace management fee")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                    Spacer()
                    Text("$5.00/month").font(.system(size:13,weight:.semibold))
                }
                HStack {
                    Text("Total for this workspace").font(.system(size:17,weight:.bold))
                    Spacer()
                    Text(annual ? gdMoney(Double(workspaceStorageCents*10)/100)+"/year storage + $5/month workspace" : gdMoney(Double(workspaceChargeCents)/100)+"/month")
                        .font(.system(size:21,weight:.heavy)).foregroundStyle(gdPurple)
                }
                GDPrimary(title:"Save workspace draft",icon:"plus.circle.fill") {saveWorkspaceDraft()}
                if !workspaceStatus.isEmpty {
                    Text(workspaceStatus).font(.system(size:11))
                        .foregroundStyle(.orange)
                }
            }
            GDPanel {
                Text("Your workspace drafts").font(.system(size:18,weight:.bold))
                if savedDrafts.isEmpty {
                    Text("No new workspace drafts yet. Your original personal cloud remains available above.")
                        .font(.system(size:12)).foregroundStyle(gdSecondary)
                } else {
                    ForEach(savedDrafts) { draft in
                        HStack(spacing:12) {
                            Image(systemName:"square.stack.3d.up").foregroundStyle(gdPurple)
                            VStack(alignment:.leading,spacing:4) {
                                Text(draft.name).font(.system(size:14,weight:.bold))
                                Text("\(draft.planID) · \(draft.planMode == "bundle" ? "Bundle" : "Storage only") · \(draft.id.prefix(8))")
                                    .font(.system(size:11)).foregroundStyle(gdSecondary)
                            }
                            Spacer()
                            Text(gdMoney(Double(draft.totalCents)/100)+(draft.yearly ? "/yr":"/mo"))
                                .font(.system(size:13,weight:.semibold))
                            Text("DRAFT").font(.system(size:10,weight:.bold)).foregroundStyle(.orange)
                        }
                        Divider().overlay(.white.opacity(0.06))
                    }
                }
            }
            GDPanel {
                Label("Private credentials for each project",systemImage:"lock.shield.fill")
                    .font(.system(size:14,weight:.bold)).foregroundStyle(gdPurple)
                Text("When customer storage is deployed, each paid workspace will receive independently scoped permissions and short-lived, server-issued credentials. The desktop app will never contain permanent bucket administration keys. Upload and download quotas will be enforced by the service.")
                    .font(.system(size:12)).foregroundStyle(gdSecondary)
                Label("New paid workspaces cannot be activated until test-mode Stripe prices, Firebase sessions and private cloud provisioning are validated.",systemImage:"exclamationmark.shield")
                    .font(.system(size:11)).foregroundStyle(.orange)
            }
        }
    }
    private var cloudPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"FILES & FOLDERS",title:"Everything, in its place.",subtitle:"Choose your project, upload any files or complete folders, and download a verified copy when you need it.")
            GenDragoonFreeCloudPanel(customer:customer,content:.files,onStorage:{page = .storage})
            if loginSession.isOwner {
                GDNativeWorkspaceView(native:native,content:.files)
            }
        }
    }
    private var applicationsPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"APPLICATIONS",title:"Your applications. Room to create.",subtitle:"Keep complete applications in cloud storage, restore them when needed, and launch compatible Mac apps from a verified managed library.")
            if loginSession.isOwner {
                GDNativeWorkspaceView(native:native,content:.applications)
            }
            GenDragoonFreeCloudPanel(customer:customer,content:.applications,showProjectControls:false,onStorage:{page = .storage})
        }
    }
    private var accountPage:some View {
        VStack(alignment:.leading,spacing:20) {
            GDHeading(kicker:"ACCOUNT & SECURITY",title:"Signed in to GenDragoonSSD",subtitle:"Your Google identity was verified by Firebase. Terms acceptance is checked against your account record.")
            GDPanel {
                Label("Google account verified",systemImage:"checkmark.shield.fill")
                    .font(.system(size:16,weight:.bold)).foregroundStyle(.green)
                Text(loginSession.email).font(.system(size:14,weight:.semibold))
                Text("Authenticated by Firebase project gendragoonssd. Terms acceptance is verified from your private Firestore document.")
                    .font(.system(size:12)).foregroundStyle(gdSecondary)
                Button("Sign out of GenDragoon") {loginSession.logout()}
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
            GenDragoonAutomaticUpdateStatus()
            GDPanel { GDSortMapEditor() }
            GDPanel { GDAccountDeletionSection() }
            GenDragoonAPIKeysPanel()
        }
    }
}
