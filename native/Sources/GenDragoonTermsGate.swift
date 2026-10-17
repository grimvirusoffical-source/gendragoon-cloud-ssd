import SwiftUI
import AppKit

struct GenDragoonTermsGate: View {
    let authenticatedEmail: String
    let termsVersion: String
    let status: String
    let isBusy: Bool
    let completion: () -> Void
    let logout: () -> Void
    @State private var hasScrolledToEnd = false
    @State private var readChecked = false
    @State private var agreeChecked = false
    private let content: String = {
        guard let termsURL=Bundle.main.url(forResource:"gendragoon_terms",withExtension:"txt"),
              let privacyURL=Bundle.main.url(forResource:"gendragoon_privacy",withExtension:"txt"),
              let terms=try? String(contentsOf:termsURL,encoding:.utf8),
              let privacy=try? String(contentsOf:privacyURL,encoding:.utf8) else {
            return "Required legal documents are unavailable. Access is blocked."
        }
        return terms+"\n\n\n"+privacy
    }()
    var body: some View {
        VStack(alignment:.leading,spacing:18) {
            Label("Before using GenDragoon",systemImage:"checkmark.shield.fill")
                .font(.system(size:27,weight:.bold,design:.rounded))
                .foregroundStyle(.white)
            Text("Review our Terms of Service. Scroll all the way down, confirm you read them, and then separately agree. You can sign out instead.")
                .font(.system(size:13)).foregroundStyle(.white.opacity(0.75))
            ScrollView {
                LazyVStack(alignment:.leading,spacing:12) {
                    Text(content).font(.system(size:12,design:.rounded))
                        .foregroundStyle(.white.opacity(0.85))
                        .frame(maxWidth:.infinity,alignment:.leading)
                    Text("END OF TERMS").font(.system(size:11,weight:.bold)).foregroundStyle(.green)
                        .onAppear { hasScrolledToEnd = content.count > 1000 }
                }
                .padding(16).frame(maxWidth:.infinity,alignment:.leading)
            }
            .frame(minHeight:200,maxHeight:400)
            .background(.white.opacity(0.05),in:RoundedRectangle(cornerRadius:14))
            .overlay(RoundedRectangle(cornerRadius:14).stroke(.white.opacity(0.12)))
            CheckboxRow(label:"I have read the complete Terms of Service",checked:$readChecked,allowed:hasScrolledToEnd)
            CheckboxRow(label:"I agree to the Terms and acknowledge the Privacy Policy",checked:$agreeChecked,allowed:hasScrolledToEnd && readChecked)
            Text("Signed in as \(authenticatedEmail) · Terms version \(termsVersion)")
                .font(.system(size:11)).foregroundStyle(.white.opacity(0.55))
            Text(status).font(.system(size:12)).foregroundStyle(.orange)
            HStack {
                Button("Accept and continue",action:completion)
                    .disabled(!hasScrolledToEnd || !readChecked || !agreeChecked || isBusy)
                    .buttonStyle(.borderedProminent).tint(.purple)
                Button("Sign Out",action:logout).buttonStyle(.bordered)
            }
        }
        .padding(28)
        .frame(maxWidth:780)
        .background(Color(red:0.055,green:0.048,blue:0.092))
    }
}
private struct CheckboxRow:View {
    let label:String
    @Binding var checked:Bool
    let allowed:Bool
    var body:some View {
        Toggle(label,isOn:$checked).toggleStyle(.checkbox)
            .disabled(!allowed)
            .font(.system(size:13,weight:.semibold)).foregroundStyle(.white)
    }
}
