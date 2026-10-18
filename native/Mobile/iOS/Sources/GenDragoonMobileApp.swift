import SwiftUI
import UIKit
import UniformTypeIdentifiers
import GoogleSignIn
import GoogleSignInSwift

/// Dark purple tokens shared with the Expo app (gendragoon-apps `apps/mobile/src/theme.ts` at `f1d3487`)
/// and Android `Theme.java`. Text pairs are AA; `testThemeContrastIsAA` checks them.
enum GDTheme {
    static func hex(_ value:UInt32)->Color { Color(red:Double(value>>16&0xFF)/255,green:Double(value>>8&0xFF)/255,blue:Double(value&0xFF)/255) }
    static let bgHex:UInt32=0x100E17,surfaceHex:UInt32=0x1C1828,raisedHex:UInt32=0x241F34,textHex:UInt32=0xF6F3FB,mutedHex:UInt32=0xB3ADC4
    static let kickerHex:UInt32=0xC8B7FF,primaryHex:UInt32=0x6D4AFF,secondaryBgHex:UInt32=0x2A2142,secondaryTextHex:UInt32=0xDDD4FF
    static let dangerBgHex:UInt32=0x2C1A2B,dangerTextHex:UInt32=0xFFC2D1,warnBgHex:UInt32=0x2E2622,warnTextHex:UInt32=0xFFE3A3
    static let bg=hex(bgHex),surface=hex(surfaceHex),raised=hex(raisedHex),text=hex(textHex),muted=hex(mutedHex),kicker=hex(kickerHex)
    static let primary=hex(primaryHex),secondaryBg=hex(secondaryBgHex),secondaryBorder=hex(0x5B4A99),secondaryText=hex(secondaryTextHex)
    static let dangerBg=hex(dangerBgHex),dangerBorder=hex(0x7A3A52),dangerText=hex(dangerTextHex)
    static let warnBg=hex(warnBgHex),warnBorder=hex(0x6B5622),warnText=hex(warnTextHex),border=hex(0x3A3352)
    /// Minimum touch target in points.
    static let touch:CGFloat=44
    static func contrast(_ fg:UInt32,_ bg:UInt32)->Double {
        func lum(_ v:UInt32)->Double {
            let c=[Double(v>>16&0xFF),Double(v>>8&0xFF),Double(v&0xFF)].map{$0/255}.map{$0<=0.03928 ? $0/12.92 : pow(($0+0.055)/1.055,2.4)}
            return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2]
        }
        let a=lum(fg),b=lum(bg)
        return (max(a,b)+0.05)/(min(a,b)+0.05)
    }
}

/// Primary, secondary and a soft destructive style. Disabled is a muted surface with muted text, not faded.
struct GDButtonStyle:ButtonStyle {
    enum Tone { case primary, secondary, danger }
    var tone:Tone = .primary
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration:Configuration)->some View {
        let fill:Color = !enabled ? GDTheme.raised : tone == .primary ? GDTheme.primary : tone == .danger ? GDTheme.dangerBg : GDTheme.secondaryBg
        let ink:Color = !enabled ? GDTheme.muted : tone == .primary ? .white : tone == .danger ? GDTheme.dangerText : GDTheme.secondaryText
        let edge:Color = !enabled ? GDTheme.border : tone == .primary ? GDTheme.primary : tone == .danger ? GDTheme.dangerBorder : GDTheme.secondaryBorder
        configuration.label.font(.body.weight(.semibold)).foregroundStyle(ink)
            .padding(.horizontal,16).frame(minWidth:GDTheme.touch,minHeight:GDTheme.touch)
            .background(fill,in:RoundedRectangle(cornerRadius:12))
            .overlay(RoundedRectangle(cornerRadius:12).stroke(edge,lineWidth:1))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .contentShape(Rectangle())
    }
}

/// Non-blocking "Payment due" banner. Shows the server `graceEndsAt` date; no grace length is assumed.
struct PaymentDueBanner:View {
    let text:String
    let pay:()->Void
    var body:some View {
        VStack(alignment:.leading,spacing:10){
            Text(text).font(.subheadline).foregroundStyle(GDTheme.warnText)
            Button("Pay",action:pay).buttonStyle(GDButtonStyle(tone:.primary)).accessibilityIdentifier("payment-due").accessibilityLabel("Pay for this workspace")
        }.padding(14).frame(maxWidth:.infinity,alignment:.leading)
        .background(GDTheme.warnBg,in:RoundedRectangle(cornerRadius:12))
        .overlay(RoundedRectangle(cornerRadius:12).stroke(GDTheme.warnBorder,lineWidth:1))
        .accessibilityElement(children:.contain)
    }
}

private let violet=GDTheme.kicker
private let canvas=GDTheme.bg
private let panel=GDTheme.surface
@main struct GenDragoonMobileApp:App {
    @StateObject private var session=MobileSession()
    var body:some Scene{WindowGroup{MobileRoot().environmentObject(session).preferredColorScheme(.dark).tint(violet).onOpenURL{_ = GIDSignIn.sharedInstance.handle($0)}}}
}
struct MobileRoot:View {
    @EnvironmentObject private var session:MobileSession
    var body:some View{
        ZStack{canvas.ignoresSafeArea();if let screen=UIPreview.screen{UIPreviewHost(screen:screen)}else if session.accountDeleted{AccountDeletedScreen()}else if let receipt=session.resumedDeletion{ResumedDeletionScreen(receipt:receipt)}else{switch session.stage{
        case .loading:VStack(spacing:20){Image(systemName:"cloud.fill").font(.system(size:65)).foregroundStyle(violet);ProgressView();Text("Opening your cloud…").font(.subheadline).foregroundStyle(.secondary)}
        case .login:MobileLogin()
        case .terms:MobileTerms()
        case .ready:MobileLibrary().id(session.uid)
        }}}.task{if UIPreview.screen==nil{await session.start()}}
    }
}
private struct ResumedDeletionScreen:View {
    @EnvironmentObject private var session:MobileSession
    let receipt:DeletionReceipt
    @StateObject private var cloud=MobileCloudModel()
    var body:some View { DeleteAccountView(resume:receipt).environmentObject(session).environmentObject(cloud) }
}
private struct UIPreviewHost:View {
    let screen:String
    @StateObject private var session=MobileSession()
    @StateObject private var cloud=MobileCloudModel()
    var body:some View {
        switch screen {
        case "account":
            NavigationStack{AccountSettingsForm(confirmReset:.constant(false),close:{},delete:{})}.environmentObject(session).environmentObject(cloud)
        case "confirm-delete":
            DeleteAccountView(previewStep:.confirm).environmentObject(session).environmentObject(cloud)
        case "deletion-support":
            DeleteAccountView(previewSupport:true).environmentObject(session).environmentObject(cloud)
        case "locked":
            WorkspaceLockView(lock:UIPreview.lock).environmentObject(session).environmentObject(cloud)
        case "lapsed":
            WorkspaceLockView(lock:UIPreview.byoLapsed).environmentObject(session).environmentObject(cloud)
        case "grace":
            GraceBannerPreview()
        default:
            MobileLogin()
        }
    }
}
private struct GraceBannerPreview:View {
    var body:some View {
        ScrollView{VStack(alignment:.leading,spacing:20){
            Text("My cloud").font(.largeTitle.weight(.bold)).accessibilityIdentifier("payment-grace")
            PaymentDueBanner(text:WorkspacePolicy.paymentDueText(graceEndsAtMs:1700518400000)){}
            Text("Uploads stay available during the grace period.").foregroundStyle(.secondary)
        }.padding(20)}.background(canvas)
    }
}
private struct MobileLogin:View {
    @EnvironmentObject private var session:MobileSession
    var body:some View{
        ScrollView{VStack(alignment:.leading,spacing:24){
            Text("GENDRAGOON  /  CLOUD SSD").font(.system(size:11,weight:.bold,design:.monospaced)).tracking(2).foregroundStyle(violet)
            Spacer(minLength:40)
            Image(systemName:"cloud.fill").font(.system(size:72,weight:.light)).foregroundStyle(violet).padding(30).background(violet.opacity(0.08),in:RoundedRectangle(cornerRadius:30))
            Text("Your cloud.\nWithin reach.").font(.largeTitle.weight(.bold)).tracking(-1.5).fixedSize(horizontal:false,vertical:true).accessibilityIdentifier("sign-in-title")
            Text("Private files, less clutter. Upload, restore and share across your devices.").font(.body).foregroundStyle(.secondary)
            VStack(alignment:.leading,spacing:17){
                Label("Start with 2 GB for free",systemImage:"gift")
                Label("Resumable, verified transfers",systemImage:"checkmark.shield")
                Label("Works with the Files app",systemImage:"folder")
            }.font(.subheadline).padding(.vertical,10)
            GoogleSignInButton(action:session.signIn).frame(height:50).disabled(session.busy)
            if session.busy{ProgressView()}
            Text(session.status).font(.footnote).foregroundStyle(.secondary)
            Text("Your Google password is entered only on Google's secure sign-in page.").font(.caption).foregroundStyle(.secondary)
        }.frame(maxWidth:520,alignment:.leading).padding(28).frame(maxWidth:.infinity)}
    }
}
private struct MobileTerms:View {
    @EnvironmentObject private var session:MobileSession
    @State private var read=false
    @State private var agreed=false
    private var terms:String{guard let u=Bundle.main.url(forResource:"gendragoon_terms",withExtension:"txt") else{return "Terms document unavailable."};return (try? String(contentsOf:u,encoding:.utf8)) ?? "Terms document unavailable."}
    var body:some View{NavigationStack{
        ScrollView{VStack(alignment:.leading,spacing:22){
            Text("Before you begin").font(.largeTitle.bold())
            Text("Your agreement is saved to your private Google account. Please read the Terms.").foregroundStyle(.secondary)
            Text(terms).font(.system(size:13)).textSelection(.enabled).padding(20).background(panel,in:RoundedRectangle(cornerRadius:18))
            Toggle("I confirm I have read the Terms",isOn:$read)
            Toggle("I agree to the Terms and Privacy Notice",isOn:$agreed)
            Link("Read the Privacy Notice",destination:URL(string:"https://gendragoon-free-10068843866.us-central1.run.app/mobile/privacy.txt")!)
            Button("Accept and continue"){session.acceptTerms(read:read,agreed:agreed)}.buttonStyle(.borderedProminent).controlSize(.large).disabled(!read || !agreed||session.busy)
            Text(session.status).font(.footnote).foregroundStyle(.secondary)
        }.padding(24)}.background(canvas).toolbar{ToolbarItem(placement:.topBarTrailing){Button("Sign out"){session.signOut()}.disabled(session.busy)}}
    }}
}
private struct MobileLibrary:View {
    @EnvironmentObject private var session:MobileSession
    @Environment(\.scenePhase) private var phase
    @StateObject private var cloud=MobileCloudModel()
    @State private var search=""
    @State private var importing=false
    @State private var importFolders=false
    @State private var applicationsOnly=false
    @State private var pendingUpload:[URL]=[]
    @State private var confirmOriginalRemoval=false
    @State private var confirmReset=false
    @State private var settings=false
    @State private var grid=false
    @State private var removing:GDCloudItem?
    @State private var deleteAccount=false
    private func size(_ n:Int64)->String{ByteCountFormatter.string(fromByteCount:n,countStyle:.file)}
    private func icon(_ name:String)->String{
        switch (name as NSString).pathExtension.lowercased(){
        case "wav","mp3","m4a","flac","aiff","ogg":return "waveform"
        case "jpg","jpeg","png","gif","heic","webp":return "photo"
        case "zip","7z","dmg","ipa","apk","aab","gz":return "archivebox"
        default:return "doc.text"
        }
    }
    private var shown:[GDCloudItem]{cloud.files.filter{(!applicationsOnly || MobileArchive.isApplication($0.name)) && (search.isEmpty||$0.name.localizedCaseInsensitiveContains(search))}.sorted{$0.name.localizedStandardCompare($1.name) == .orderedAscending}}
    private func metric(_ title:String,_ value:String)->some View{
        VStack(alignment:.leading,spacing:9){Text(value).font(.system(size:21,weight:.bold,design:.rounded)).lineLimit(1).minimumScaleFactor(0.65);Text(title.uppercased()).font(.system(size:8,weight:.bold,design:.monospaced)).tracking(1).foregroundStyle(.secondary)}
            .frame(maxWidth:.infinity,alignment:.leading).padding(18).background(violet.opacity(0.075),in:RoundedRectangle(cornerRadius:15)).overlay(RoundedRectangle(cornerRadius:15).stroke(violet.opacity(0.15)))
    }
    private func fileRow(_ file:GDCloudItem)->some View{
        HStack(spacing:13){Image(systemName:icon(file.name)).font(.system(size:22,weight:.medium)).foregroundStyle(violet).frame(width:44,height:51).background(violet.opacity(0.10),in:RoundedRectangle(cornerRadius:12))
            VStack(alignment:.leading,spacing:7){Text(file.name).font(.subheadline.weight(.semibold)).lineLimit(2);Text(size(file.sizeBytes)).font(.caption2).foregroundStyle(.secondary)}
            Spacer(minLength:4)
            Menu{Button{cloud.restore(file)}label:{Label("Restore and share",systemImage:"arrow.down.to.line")};Button(role:.destructive){removing=file}label:{Label("Delete cloud copy",systemImage:"trash")}}label:{Image(systemName:"ellipsis").frame(width:42,height:44)}.disabled(cloud.busy || !cloud.actionsEnabled).accessibilityLabel("Actions for "+file.name)
        }.padding(14).background(panel,in:RoundedRectangle(cornerRadius:15))
    }
    var body:some View{NavigationStack{
        ScrollView{VStack(alignment:.leading,spacing:20){
            HStack{VStack(alignment:.leading,spacing:7){Text("YOUR DIGITAL SPACE").font(.system(size:9,weight:.bold,design:.monospaced)).tracking(2).foregroundStyle(violet);Text("My cloud").font(.largeTitle.weight(.bold)).tracking(-1);Text("Everything you need. Nothing in your way.").font(.caption).foregroundStyle(.secondary)};Spacer();Image(systemName:"cloud.fill").font(.system(size:37)).foregroundStyle(violet).padding(15).background(violet.opacity(0.12),in:RoundedRectangle(cornerRadius:21))}
            Picker("Workspace",selection:$cloud.selected){Text(cloud.freePickerLabel).tag("free");ForEach(cloud.choices){Text($0.pickerLabel).tag($0.id)}}.pickerStyle(.menu).frame(maxWidth:.infinity,alignment:.leading).padding(8).background(panel,in:RoundedRectangle(cornerRadius:11)).disabled(cloud.busy)
            if cloud.paymentDueBanner {
                PaymentDueBanner(text:cloud.paymentDueText){
                    if let url=cloud.paymentCheckout {UIApplication.shared.open(url)} else {cloud.status=WorkspacePolicy.paymentDue}
                }
            }
            if let c=cloud.config{
                HStack(spacing:12){metric("Used / total",size(c.usedBytes)+" / "+size(c.quotaBytes));metric("Parallel transfers",String((cloud.dataSaver||cloud.constrainedNetwork) ? 1:min(4,c.transfer.workers)))}
                ProgressView(value:min(1,Double(c.usedBytes+c.reservedBytes)/Double(max(1,c.quotaBytes)))).tint(violet)
                VStack(alignment:.leading,spacing:12){
                    Text("Applications, files & folders").font(.headline)
                    Text("Store app packages for their compatible devices. iPhone and iPad restore and share files; desktop and Android apps cannot run here.").font(.caption).foregroundStyle(.secondary)
                    HStack{Button{importFolders=false;importing=true}label:{Label("Files / apps",systemImage:"square.stack.3d.up")};Button{importFolders=true;importing=true}label:{Label("Complete folder",systemImage:"folder.badge.plus")}}.buttonStyle(.borderedProminent).controlSize(.large).disabled(cloud.busy || !cloud.actionsEnabled || cloud.selectedLocked)
                    Toggle("Remove selected originals after verified upload and restore check",isOn:$cloud.removeOriginals).font(.caption).disabled(cloud.busy)
                    if cloud.removeOriginals{Text("Applies only to the files or folder you select. Provider deletion may be permanent. A full cloud read-back is required.").font(.caption2).foregroundStyle(.secondary)}
                }.padding(16).background(panel,in:RoundedRectangle(cornerRadius:15))
                Picker("Library category",selection:$applicationsOnly){Text("All files").tag(false);Text("Applications").tag(true)}.pickerStyle(.segmented)
                if cloud.constrainedNetwork{Label("Mobile-data protection · one transfer at a time",systemImage:"antenna.radiowaves.left.and.right").font(.caption).foregroundStyle(.secondary)}
                if cloud.transferring{VStack(alignment:.leading,spacing:11){HStack{Text("Transfer in progress").font(.subheadline.weight(.semibold));Spacer();Button("Pause"){cloud.pause()}};ProgressView(value:cloud.fraction);Text(cloud.detail).font(.caption).foregroundStyle(.secondary)}.padding(17).background(violet.opacity(0.11),in:RoundedRectangle(cornerRadius:16))}
                HStack{Text("Your files").font(.headline);Spacer();Text("\(shown.count) files").font(.caption).foregroundStyle(.secondary);Button{grid.toggle()}label:{Image(systemName:grid ? "list.bullet":"square.grid.2x2")}.accessibilityLabel(grid ? "List view":"Grid view")}
                if shown.isEmpty{VStack(spacing:13){Image(systemName:cloud.files.isEmpty ? "tray.and.arrow.up":"magnifyingglass").font(.system(size:40,weight:.light)).foregroundStyle(violet);Text(cloud.files.isEmpty ? "Make room for what matters.":"No matching files.").font(.headline);Text(cloud.files.isEmpty ? "Upload your first file. Your original stays on your device.":"Try a different search.").font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)}.frame(maxWidth:.infinity).padding(.vertical,34)}
                else if grid{LazyVGrid(columns:[GridItem(.adaptive(minimum:280),spacing:12)],spacing:12){ForEach(shown){fileRow($0)}}}
                else{LazyVStack(spacing:10){ForEach(shown){fileRow($0)}}}
            }else{
                VStack(spacing:18){Image(systemName:"cloud.badge.plus").font(.system(size:45)).foregroundStyle(violet);Text("Start with 2 GB, on us.").font(.title2.bold());Text("Verified transfers, private files and no payment required.").font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center);Button("Create free workspace"){cloud.create()}.buttonStyle(.borderedProminent).controlSize(.large).disabled(cloud.busy)}.frame(maxWidth:.infinity).padding(.vertical,35)
            }
            Label(cloud.status,systemImage:"info.circle").font(.caption).foregroundStyle(.secondary).frame(maxWidth:.infinity,alignment:.leading).padding(14).background(panel,in:RoundedRectangle(cornerRadius:12))
            Text("Keep the app open during transfers. Completed chunks remain available when an upload is paused. Exported files also appear in Files → On My iPhone/iPad → GenDragoon → Exports.").font(.caption2).foregroundStyle(.secondary)
        }.frame(maxWidth:960).padding(20).frame(maxWidth:.infinity)}
        .background(canvas).navigationBarTitleDisplayMode(.inline).searchable(text:$search,prompt:"Find a file…")
        .toolbar{ToolbarItem(placement:.topBarLeading){Text("GENDRAGOON").font(.system(size:10,weight:.bold,design:.monospaced)).tracking(1.4)};ToolbarItem(placement:.topBarTrailing){Button{settings=true}label:{Image(systemName:"person.crop.circle")}.accessibilityLabel("Account and settings")}}
        .refreshable{await cloud.refreshAndWait()}.task{await cloud.connect(session)}
        .onChange(of:cloud.selected){_ in cloud.refresh()}
        .onChange(of:phase){value in if value == .background{cloud.pause()}}
        .fileImporter(isPresented:$importing,allowedContentTypes:importFolders ? [.folder] : [.item],allowsMultipleSelection:true){result in switch result{case .success(let urls):if cloud.removeOriginals{pendingUpload=urls;confirmOriginalRemoval=true}else{cloud.upload(urls)};case .failure(let error):cloud.status=error.localizedDescription}}
        .confirmationDialog("Upload and remove originals?",isPresented:$confirmOriginalRemoval,titleVisibility:.visible){Button("Verify then remove \(pendingUpload.count) selected items",role:.destructive){cloud.upload(pendingUpload);pendingUpload=[]};Button("Keep originals and upload"){cloud.removeOriginals=false;cloud.upload(pendingUpload);pendingUpload=[]};Button("Cancel",role:.cancel){pendingUpload=[]}}message:{Text("Originals are removed only after a complete cloud read-back and archive restore check. Some providers delete permanently.")}
        .sheet(item:$cloud.export){value in NativeShare(url:value.url).presentationDetents([.medium,.large])}
        .sheet(isPresented:$settings){NavigationStack{AccountSettingsForm(confirmReset:$confirmReset,close:{settings=false},delete:{settings=false;DispatchQueue.main.async{deleteAccount=true}}).alert("Reset App?",isPresented:$confirmReset){Button("Reset",role:.destructive){cloud.resetLocalState();settings=false};Button("Cancel",role:.cancel){}}message:{Text("Clear local transfer cache and selected workspace. Cloud files and exported documents stay in place.")}.toolbar{ToolbarItem(placement:.confirmationAction){Button("Done"){settings=false}}}}}
        .fullScreenCover(isPresented:$deleteAccount){DeleteAccountView().environmentObject(session).environmentObject(cloud)}
        .fullScreenCover(item:$cloud.workspaceLock){lock in WorkspaceLockView(lock:lock).environmentObject(session).environmentObject(cloud)}
        .alert("Delete cloud copy?",isPresented:Binding(get:{removing != nil},set:{if !$0{removing=nil}})){Button("Delete",role:.destructive){if let removing{cloud.delete(removing)};removing=nil};Button("Cancel",role:.cancel){removing=nil}}message:{Text("This removes \(removing?.name ?? "this file") from cloud storage. Local copies are not changed.")}
    }}
}
struct NativeShare:UIViewControllerRepresentable {
    let url:URL
    func makeUIViewController(context:Context)->UIActivityViewController{UIActivityViewController(activityItems:[url],applicationActivities:nil)}
    func updateUIViewController(_ uiViewController:UIActivityViewController,context:Context){}
}
