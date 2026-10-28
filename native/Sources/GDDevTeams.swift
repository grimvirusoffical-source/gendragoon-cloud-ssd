import AppKit
import Foundation
import SwiftUI
import WebKit

@MainActor struct GDDevTeamsView: View {
    @ObservedObject private var native = GDNativeWorkspace.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            GroupBox("Enable and set up Teams") {
                VStack(alignment: .leading, spacing: 9) {
                    Text("Teams uses your Red-XAI account, not a separate device enable switch. Choose and mount a MachineNote on Home first, then create a team or accept an invitation below.")
                    Text("To start a team: create a team, choose its member plan and complete checkout. The server must confirm any required subscription before paid features unlock.")
                    Text("Team members can collaborate in chat and share selected workspaces. A personal MachineNote does not become shared merely by joining a team. Each shared workspace has its own storage and performance plan.")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
            }
            if let url = Bundle.main.resourceURL?.appendingPathComponent("GenDragoonTeams/index.html"), FileManager.default.fileExists(atPath: url.path) {
                GDTeamsWebView(url: url, workspaceID: native.selectedDestination?.bucket, workspaceName: native.destinationLabel, accountID: auth.subject)
                    .frame(minHeight: 1000).clipShape(RoundedRectangle(cornerRadius: 16))
            } else {
                Text("The Teams interface is missing from this build. Reinstall the complete verified package.")
                    .padding().foregroundStyle(.orange)
            }
        }
    }
}

@MainActor private struct GDTeamsWebView: NSViewRepresentable {
    let url: URL
    let workspaceID: String?
    let workspaceName: String
    let accountID: String
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeNSView(context: Context) -> WKWebView {
        let controller = WKUserContentController()
        controller.add(context.coordinator, name: "gendragoonTeams")
        let bridge = """
        (()=>{const pending=new Map();window.gdNative={request:(path,method='GET',body)=>new Promise((resolve,reject)=>{const requestId=crypto.randomUUID().replaceAll('-','');const timer=setTimeout(()=>{pending.delete(requestId);reject(new Error('The team request timed out. Refresh before retrying.'));},30000);pending.set(requestId,{resolve,reject,timer});window.webkit.messageHandlers.gendragoonTeams.postMessage({requestId,path,method,...(body===undefined?{}:{body})});}),receive:r=>{const p=pending.get(r.requestId);if(!p)return;pending.delete(r.requestId);clearTimeout(p.timer);if(r.error)p.reject(new Error(r.error));else p.resolve(r.value);}};})();
        """
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = controller
        let web = WKWebView(frame: .zero, configuration: configuration)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        context.coordinator.allowedURL = url.standardizedFileURL
        context.coordinator.web = web
        context.coordinator.config = config
        web.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        return web
    }
    private var config: [String: Any] {
        ["workspaceId": workspaceID ?? "", "workspaceName": workspaceName, "accountId": accountID]
    }
    func updateNSView(_ view: WKWebView, context: Context) {
        if context.coordinator.config["accountId"] as? String != accountID {
            view.evaluateJavaScript("window.GenDragoonTeams?.shutdown()", completionHandler: nil)
        }
        context.coordinator.config = config
        context.coordinator.configure()
    }
    static func dismantleNSView(_ view: WKWebView, coordinator: Coordinator) {
        view.evaluateJavaScript("window.GenDragoonTeams?.shutdown()", completionHandler: nil)
        view.configuration.userContentController.removeScriptMessageHandler(forName: "gendragoonTeams")
        view.stopLoading()
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
        weak var web: WKWebView?
        var config: [String: Any] = [:]
        var allowedURL: URL?
        private var configured = ""
        private var pending = Set<String>()
        func configure() {
            guard let data = try? JSONSerialization.data(withJSONObject: config, options: [.sortedKeys]), let value = String(data: data, encoding: .utf8), configured != value else { return }
            web?.evaluateJavaScript("window.GenDragoonTeams?.configure(" + value + ")") { [weak self] _, error in
                if error == nil { self?.configured = value }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { configured = ""; configure() }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            let allowed = navigationAction.request.url?.isFileURL == true && navigationAction.request.url?.standardizedFileURL == allowedURL
            decisionHandler(allowed ? .allow : .cancel)
        }
        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            guard frame.isMainFrame, message.count <= 1000 else { completionHandler(false); return }
            let alert = NSAlert(); alert.messageText = "GenDragoon Teams"; alert.informativeText = message
            alert.addButton(withTitle: "Confirm"); alert.addButton(withTitle: "Cancel")
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }
        private func respond(_ id: String, value: [String: Any]? = nil, error: String? = nil) {
            pending.remove(id)
            var response: [String: Any] = ["requestId": id]
            if let value { response["value"] = value }
            if let error { response["error"] = GDNativeMessage.safe(error) }
            guard let data = try? JSONSerialization.data(withJSONObject: response), data.count <= 2 * 1024 * 1024 else { return }
            // Base64 transports JSON as data rather than executable peer content.
            web?.evaluateJavaScript("window.gdNative.receive(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('" + data.base64EncodedString() + "'),c=>c.charCodeAt(0)))))", completionHandler: nil)
        }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.frameInfo.isMainFrame, let body = message.body as? [String: Any], let id = body["requestId"] as? String,
                  id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil, !pending.contains(id), pending.count < 32,
                  let path = body["path"] as? String, path.utf8.count <= 4096,
                  !path.contains(".."), !path.contains("#"), !path.contains("\\"),
                  !(path.split(separator: "?", maxSplits: 1).first?.contains("%") ?? true),
                  path.range(of: #"^/v1/receivers/(?:me/dev-(?:profile|teams)(?:\?|$)|me/workspaces/[a-f0-9]{32}/team$|teams(?:/|\?|$))"#, options: .regularExpression) != nil,
                  let method = body["method"] as? String, ["GET", "POST", "PUT", "DELETE"].contains(method),
                  JSONSerialization.isValidJSONObject(body), let encoded = try? JSONSerialization.data(withJSONObject: body), encoded.count <= 128 * 1024 else { return }
            pending.insert(id)
            let account = GDRedXAIAuthSession.shared.subject
            Task { @MainActor [weak self] in
                do {
                    let result = try await GDRedXAIAuthSession.shared.serviceRequest(path: path, method: method, json: body["body"] as? [String: Any])
                    guard GDRedXAIAuthSession.shared.subject == account else { self?.respond(id, error: "Your account changed. Reopen Teams."); return }
                    self?.respond(id, value: result)
                } catch { self?.respond(id, error: error.localizedDescription) }
            }
        }
    }
}
