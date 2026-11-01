"""Current Mac receipt policy and exact local-file/maintenance ownership boundaries.

Uses only disposable fixtures. No Keychain account, live endpoint or user file is read.
"""
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]
SUBJECT = "public-dummy-user"
RECEIVER = hashlib.sha256(json.dumps(["red-xai-receiver/v1", "https://red-xai.com", SUBJECT], separators=(",", ":")).encode()).hexdigest()
PENDING = {"schema": 1, "issuer": "https://red-xai.com", "subject": SUBJECT, "receiverID": RECEIVER,
           "idempotencyKey": "1" * 32, "receiptID": "2" * 32}
HARNESS = r'''
import Foundation
@main struct DeletionTest {
 static func main() {
  do {
   let value = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
   var out: [String: Any] = ["ok": true]
   switch value["operation"] as! String {
   case "receipt":
    var pending = try JSONDecoder().decode(GDAccountDeletionPending.self, from: JSONSerialization.data(withJSONObject: value["pending"]!))
    try pending.validate()
    let response = try GDAccountDeletionResponse.decode(JSONSerialization.data(withJSONObject: value["body"]!), pending: pending)
    if let row = response.deletion {
     if value["post"] as? Bool == true { pending = try pending.binding(row.id) }
     out["cleanup"] = row.authorizesCleanup(pending: pending, subject: value["subject"] as? String ?? pending.subject, receiver: value["receiver"] as? String ?? pending.receiverID)
    } else { out["cleanup"] = false }
   case "activity":
    try GDAccountDeletionActivityProbe.validate(apps: JSONSerialization.data(withJSONObject: value["apps"]!), mounts: JSONSerialization.data(withJSONObject: value["mounts"]!), uploads: JSONSerialization.data(withJSONObject: value["uploads"]!))
   case "lock":
    let lease = try GDAccountDeletionLocalLease(home: URL(fileURLWithPath: value["home"] as! String))
    defer { withExtendedLifetime(lease) {} }
    do { let second = try GDAccountDeletionLocalLease(home: URL(fileURLWithPath: value["home"] as! String)); withExtendedLifetime(second) {}; out["secondBlocked"] = false }
    catch { out["secondBlocked"] = true }
   case "cleanup":
    let urls = (value["paths"] as! [String]).map { URL(fileURLWithPath: $0) }
    let plan = try urls.compactMap { try GDAccountDeletionOwnedFiles.inspect($0) }
    if let replace = value["replace"] as? String {
     try FileManager.default.moveItem(atPath: replace, toPath: replace + ".old")
     FileManager.default.createFile(atPath: replace, contents: Data("replacement".utf8), attributes: [.posixPermissions: 0o600])
    }
    try GDAccountDeletionOwnedFiles.remove(plan)
   default: fatalError("Fixture operation")
   }
   print(String(data: try JSONSerialization.data(withJSONObject: out), encoding: .utf8)!)
  } catch { print("{\"ok\":false}") }
 }
}
'''


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Apple Swift/CryptoKit/Darwin required")
class AccountDeletionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gd-account-delete-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        source = root / "Harness.swift"
        source.write_text(HARNESS)
        cls.program = root / "DeletionTest"
        result = subprocess.run([shutil.which("swiftc"), "-parse-as-library", str(NATIVE / "Sources/GDAccountDeletionReceipt.swift"), str(source), "-o", str(cls.program)], capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise AssertionError(result.stderr)

    def call(self, operation, **value):
        result = subprocess.run([str(self.program)], input=json.dumps(dict(operation=operation, **value)), text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def proof(self, status="completed"):
        row = dict(id="2" * 32, status=status, phase="complete" if status == "completed" else "billing",
                   requestedAt="2026-10-26T10:00:00.000Z", updatedAt="2026-10-26T10:01:00.000Z",
                   retryable=status == "failed", cloudDataDeleted=status == "completed",
                   externalIdentityDeleted=False, externalBYODataDeleted=False, localOriginalsDeleted=False)
        if status == "completed": row["completedAt"] = row["updatedAt"]
        if status == "failed": row["error"] = "account_deletion_retry_required"
        return {"schema": 1, "deletion": row}

    def receipt(self, body=None, pending=None, **value):
        return self.call("receipt", body=body or self.proof(), pending=pending or PENDING, **value)

    def test_matching_completed_receipt_only(self):
        self.assertTrue(self.receipt()["cleanup"])
        for status in ("queued", "running", "failed"):
            self.assertFalse(self.receipt(self.proof(status))["cleanup"])
        self.assertFalse(self.receipt({"schema": 1, "deletion": None})["cleanup"])

    def test_initial_get_cannot_bind_but_same_key_post_can(self):
        pending = {k: v for k, v in PENDING.items() if k != "receiptID"}
        self.assertFalse(self.receipt(pending=pending)["cleanup"])
        self.assertTrue(self.receipt(pending=pending, post=True)["cleanup"])

    def test_receipt_and_account_binding(self):
        self.assertFalse(self.receipt(subject="another-account")["cleanup"])
        self.assertFalse(self.receipt(receiver="a" * 64)["cleanup"])
        changed = copy.deepcopy(self.proof()); changed["deletion"]["id"] = "3" * 32
        self.assertFalse(self.receipt(changed)["ok"])
        pending = {**PENDING, "receiverID": "a" * 64}
        self.assertFalse(self.receipt(pending=pending)["ok"])

    def test_missing_or_string_cloud_proof_never_cleans(self):
        for value in (None, "true", False):
            body = copy.deepcopy(self.proof())
            if value is None: del body["deletion"]["cloudDataDeleted"]
            else: body["deletion"]["cloudDataDeleted"] = value
            self.assertFalse(self.receipt(body)["ok"])

    def test_unknown_phase_status_and_invalid_times_fail(self):
        for field, value in (("phase", "storage"), ("status", "done"), ("completedAt", "2026-10-26T09:00:00Z")):
            body = copy.deepcopy(self.proof()); body["deletion"][field] = value
            self.assertFalse(self.receipt(body)["ok"])

    def test_unexpected_external_deletion_claims_fail(self):
        for field in ("externalIdentityDeleted", "externalBYODataDeleted", "localOriginalsDeleted"):
            body = copy.deepcopy(self.proof()); body["deletion"][field] = True
            self.assertFalse(self.receipt(body)["ok"])

    def test_exact_files_only_other_account_original_and_cache_retained(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            own = root / "account.keymap"; sidecar = root / "account.keymap.gen"
            retained = [root / "other.keymap", root / "original", root / "unattributed-cache"]
            for path in [own, sidecar, *retained]: path.write_bytes(b"fixture"); path.chmod(0o600)
            self.assertTrue(self.call("cleanup", paths=[str(own), str(sidecar)])["ok"])
            self.assertFalse(own.exists()); self.assertFalse(sidecar.exists())
            self.assertTrue(all(path.read_bytes() == b"fixture" for path in retained))

    def test_symlink_hardlink_and_shared_file_preflight_retains_all(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); own = root / "own"; outside = root / "outside"
            own.write_bytes(b"own"); own.chmod(0o600); outside.write_bytes(b"original"); outside.chmod(0o600)
            linked = root / "linked"; linked.symlink_to(outside)
            self.assertFalse(self.call("cleanup", paths=[str(own), str(linked)])["ok"])
            self.assertTrue(own.exists()); self.assertEqual(outside.read_bytes(), b"original")
            linked.unlink(); os.link(outside, linked)
            self.assertFalse(self.call("cleanup", paths=[str(linked)])["ok"])
            linked.unlink(); own.chmod(0o644)
            self.assertFalse(self.call("cleanup", paths=[str(own)])["ok"])

    def test_shared_cleanup_directory_and_shared_home_are_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); path = root/"keymap"
            path.write_bytes(b"private"); path.chmod(0o600); root.chmod(0o777)
            try:
                self.assertFalse(self.call("cleanup", paths=[str(path)])["ok"])
                self.assertFalse(self.call("lock", home=str(root))["ok"])
                self.assertTrue(path.exists())
            finally: root.chmod(0o700)

    def test_replaced_inode_not_unlinked(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary).resolve() / "keymap"; path.write_bytes(b"original"); path.chmod(0o600)
            self.assertFalse(self.call("cleanup", paths=[str(path)], replace=str(path))["ok"])
            self.assertEqual(path.read_bytes(), b"replacement")
            self.assertEqual(path.with_suffix(".old").read_bytes(), b"original")

    def test_cross_process_helper_lock_conflicts_and_releases(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = str(Path(temporary).resolve())
            first = self.call("lock", home=home)
            self.assertTrue(first["ok"]); self.assertTrue(first["secondBlocked"])
            self.assertTrue(self.call("lock", home=home)["ok"])
            # Python parent and Swift child contend on the actual shared OS lock.
            path = Path(home)/"Library/Application Support/GenDragoon Cloud SSD/AutoUpdates/update.lock"
            with path.open("r+b") as stream:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                self.assertFalse(self.call("lock", home=home)["ok"])
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)

    def test_fresh_activity_probe_rejects_active_unknown_or_malformed_state(self):
        base = {"apps": {"active": False, "busy": False, "sessions": []},
                "mounts": {"unknownMounts": False, "mounts": []},
                "uploads": {"state": {"schema": 1, "active_job_id": None, "jobs": [{"state": "queued"}]}}}
        self.assertTrue(self.call("activity", **base)["ok"])
        for section, key, value in [("apps", "active", True), ("apps", "busy", True),
                                    ("apps", "sessions", [{"active": True}]), ("apps", "active", "false"),
                                    ("mounts", "unknownMounts", True), ("mounts", "mounts", [{"state": "orphaned"}])]:
            changed = copy.deepcopy(base); changed[section][key] = value
            self.assertFalse(self.call("activity", **changed)["ok"])
        changed = copy.deepcopy(base); changed["uploads"]["state"]["jobs"] = [{"state": "running"}]
        self.assertFalse(self.call("activity", **changed)["ok"])
        changed = copy.deepcopy(base); del changed["uploads"]["state"]["active_job_id"]
        self.assertFalse(self.call("activity", **changed)["ok"])

    def test_linked_maintenance_ancestry_fails(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve(); home = root / "home"; outside = root / "outside"
            home.mkdir(); outside.mkdir(); (home / "Library").symlink_to(outside, target_is_directory=True)
            self.assertFalse(self.call("lock", home=str(home))["ok"])


if __name__ == "__main__": unittest.main()
