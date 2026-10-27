"""Release guardrails for native MachineNotes upload and app-key affordances.

Source-level checks complement (but do not replace) actual macOS Swift
compilation, UI activation and authenticated service tests.
"""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1] / "Sources"

def swift(name):
    return (ROOT / name).read_text(encoding="utf-8")

class NativeUploadPlayKeyUI(unittest.TestCase):
    def test_every_app_row_has_guarded_play_action(self):
        content = swift("GDLibraryBrowser.swift")
        self.assertIn('if node.item.kind == "app" {', content)
        self.assertIn('GDLibraryPlayButton(title: "Play"', content)
        self.assertIn('play.isEnabled = node.item.canRestoreOnMac && !parent.busy', content)
        self.assertIn('func playRow(_ sender: GDLibraryPlayButton)', content)
        self.assertIn('item.kind == "app", item.canRestoreOnMac', content)
        self.assertIn('parent.action(.open, [key], item.parentKey)', content)
        self.assertIn('if item.kind == "app" { library.smartLaunch(item) }', content)
        self.assertIn('This does not run on a remote macOS server', content)

    def test_upload_options_remain_visible_when_mutations_are_blocked(self):
        view = swift("GDNativeWorkspace.swift")
        self.assertIn('Label(showUpload ? "Hide Upload Options" : "Upload & Encryption Options"', view)
        self.assertIn('showUpload.toggle()', view)
        self.assertIn('Button("Check Upload State")', view)
        self.assertIn('await native.upload.refresh()', view)
        self.assertIn('if showUpload || native.upload.hasRunningJob || native.upload.hasQueuedJobs', view)
        options = swift("ProjectUploadSection.swift")
        self.assertIn('Toggle("Use Red-SecretsXAI encryption", isOn: $workspace.encryptionEnabled)', options)
        self.assertIn('.toggleStyle(.checkbox)', options)
        self.assertIn('"--encryption", encryptionEnabled ? "true" : "false"', options)
        self.assertIn('?? true', options)  # old queued jobs remain encrypted by default

    def test_key_creation_chooses_only_writable_machine_notes(self):
        view = swift("GDIntegrations.swift")
        self.assertIn('private var keyBuckets: [UploadCloudBucket] { auth.uploadProjects.flatMap(\\.buckets) }', view)
        self.assertIn('workspace = keyBuckets.first?.id ?? ""', view)
        self.assertIn('service = available.first?.id ?? ""', view)
        self.assertIn('ForEach(keyBuckets)', view)
        self.assertIn('!keyBuckets.contains(where: { $0.id == workspace })', view)
        self.assertIn('!model.availableServices.contains(where: { $0.id == service })', view)
        self.assertIn('Key created, but the key list could not refresh', view)
        self.assertIn('self.oneTimeKey = key', view)
        self.assertLess(view.index('self.oneTimeKey = key'), view.index('try await self.readMetadata(expected)', view.index('self.oneTimeKey = key')))

    def test_api_creation_errors_are_explained_without_leaking_service_body(self):
        auth = swift("GDRedXAIAuth.swift")
        self.assertIn('path == "/v1/integrations/keys" && method == "POST"', auth)
        self.assertIn('case "integration_entitlements_unavailable"', auth)
        self.assertIn('case "integration_key_limit"', auth)
        self.assertIn('Refresh the key list before trying again', auth)
        self.assertNotIn('message: code +', auth)

if __name__ == "__main__":
    unittest.main()
