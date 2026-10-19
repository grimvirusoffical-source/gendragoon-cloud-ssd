import SwiftUI
import Foundation
import AppKit

struct GenDragoonAdvertisement: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    let description: String
    let link: String?
    var destination: URL? {
        guard let link,let url=URL(string:link),
              ["https","http"].contains(url.scheme?.lowercased() ?? ""),
              url.host != nil else { return nil }
        return url
    }
}
private struct GenDragoonAdFeed: Decodable {
    let schemaVersion: Int
    let revision: Int
    let ads: [GenDragoonAdvertisement]
}
@MainActor final class GenDragoonAdsModel:ObservableObject {
    @Published private(set) var top:GenDragoonAdvertisement?
    @Published private(set) var side:GenDragoonAdvertisement?
    private var pool:[GenDragoonAdvertisement]=[]
    private var isRefreshing=false
    private static let manifest="https://raw.githubusercontent.com/grimvirusoffical-source/gendragoon-cloud-ssd/main/ads/ads.json"
    func refresh(isAdFree:Bool,allowFetch:Bool=true) {
        guard !isAdFree else {pool=[];top=nil;side=nil;return}
        rotate()
        guard allowFetch,!isRefreshing,let url=URL(string:Self.manifest) else{return}
        isRefreshing=true
        var request=URLRequest(url:url,cachePolicy:.reloadIgnoringLocalCacheData,timeoutInterval:12)
        request.setValue("application/json",forHTTPHeaderField:"Accept")
        URLSession.shared.dataTask(with:request){[weak self] data,response,error in
            DispatchQueue.main.async {
                guard let self else {return}
                self.isRefreshing=false
                guard error == nil,(response as? HTTPURLResponse)?.statusCode == 200,
                    let data,data.count <= 65_536,
                    let feed=try? JSONDecoder().decode(GenDragoonAdFeed.self,from:data),
                    feed.schemaVersion == 1 else {
                    // Keep the last valid ad list if GitHub is temporarily unavailable.
                    return
                }
                var unique=Set<String>()
                self.pool=Array(feed.ads.prefix(200)).filter {
                    $0.id.count >= 2 && $0.id.count <= 80 &&
                    $0.title.count >= 3 && $0.title.count <= 120 &&
                    !$0.description.isEmpty && $0.description.count <= 350 &&
                    ($0.link == nil || $0.destination != nil) &&
                    unique.insert($0.id).inserted
                }
                self.rotate()
            }
        }.resume()
    }
    private func rotate() {
        if pool.isEmpty {top=nil;side=nil;return}
        let shuffled=pool.shuffled()
        top=shuffled[0]
        side=shuffled.count > 1 ? shuffled[1] : shuffled[0]
    }
}
struct GenDragoonAdView:View {
    let item:GenDragoonAdvertisement
    var compact=false
    var body:some View {
        Group {
            if let url=item.destination {
                Button {
                    NSWorkspace.shared.open(url)
                } label:{adBody}
                    .buttonStyle(.plain)
                    .accessibilityLabel("Advertisement: "+item.title+". Open website.")
            } else {adBody}
        }
    }
    private var adBody:some View {
        HStack(alignment:.top,spacing:9) {
            Image(systemName:"megaphone.fill")
                .foregroundStyle(Color(red:0.73,green:0.58,blue:0.98))
                .font(.system(size:compact ? 13 : 18))
            VStack(alignment:.leading,spacing:5) {
                Text("SPONSORED").font(.system(size:9,weight:.bold,design:.monospaced))
                    .tracking(1.4).foregroundStyle(.white.opacity(0.45))
                Text(item.title).font(.system(size:compact ? 11:15,weight:.bold))
                    .foregroundStyle(.white).lineLimit(compact ? 3:2)
                Text(item.description).font(.system(size:compact ? 10:11))
                    .foregroundStyle(.white.opacity(0.68)).lineLimit(compact ? 4:2)
                if item.destination != nil {
                    Label("Visit website",systemImage:"arrow.up.right").font(.system(size:10,weight:.semibold))
                        .foregroundStyle(.purple.opacity(0.9))
                }
            }
            Spacer(minLength:0)
        }
        .padding(compact ? 12:15)
        .frame(maxWidth:.infinity,alignment:.leading)
        .background(Color.white.opacity(0.045),in:RoundedRectangle(cornerRadius:12))
        .overlay(RoundedRectangle(cornerRadius:12).stroke(Color.white.opacity(0.08)))
    }
}
