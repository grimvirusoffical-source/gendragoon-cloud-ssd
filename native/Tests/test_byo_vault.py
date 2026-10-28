"""Disposable BYO recovery fixtures; never open a user's profile or Keychain."""
import base64
import copy
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
sys.path.insert(0, str(NATIVE / "Resources"))
import gendragoon_byo_vault as recovery

FIXTURE = json.loads((NATIVE / "Tests/fixtures/portable-vault-v1.json").read_text())
KEYMAP = base64.urlsafe_b64decode(FIXTURE["keymap"] + "=" * (-len(FIXTURE["keymap"]) % 4))


class BYOFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-byo-recovery-")
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name).resolve()
        self.home.chmod(0o700)
        self.profile = {"schema": 1, "issuer": "https://red-xai.com", "clientId": "gendragoon",
            "authProvider": "redx-site-session", "cloudApi": "https://api.red-xai.com",
            "storageFormat": "redsecretsxai-png-v1", "subject": "dummy-byo-recovery-subject"}
        account = hashlib.sha256(json.dumps(["red-xai-receiver/v1", self.profile["issuer"], self.profile["subject"]], separators=(",", ":")).encode()).hexdigest()
        self.profile["receiverId"] = account
        self.profile_path = self.home.joinpath(*recovery.PROFILE, "cloud.json")
        self.write(self.profile_path, json.dumps(self.profile).encode())
        self.config = {"origin": "https://fixture.test", "database": "storage", "pack": "gendragoon", "accountId": account}
        self.config.update(recovery.pack.connection_context(self.config))
        self.path = self.home.joinpath(*recovery.KEYMAPS, self.config["receiverId"] + ".rsxkeymap")
        self.config["keymapPath"] = str(self.path)
        self.calls = []

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.write_bytes(data)
        path.chmod(0o600)

    def validator(self, value):
        self.calls.append(value.copy())
        self.assertEqual(value["storageSecret"], FIXTURE["storageSecret"])
        self.assertEqual(Path(value["keymapPath"]).read_bytes(), KEYMAP)
        self.assertEqual(value["keymapSha256"], hashlib.sha256(KEYMAP).hexdigest())
        return {"validated": True}

    def run_action(self, action, changes=None, validator=None, probe=None):
        value = self.config.copy()
        if action != "preflight":
            value["storageSecret"] = FIXTURE["storageSecret"]
            value["keymap" if action == "install-keymap" else "keymapSha256"] = FIXTURE["keymap"] if action == "install-keymap" else hashlib.sha256(KEYMAP).hexdigest()
        value.update(changes or {})
        return recovery.execute(action, value, home=self.home, validator=validator or self.validator, idle_probe=probe or (lambda: None))

    def test_atomic_install_matching_reimport_and_no_secrets_in_proof(self):
        result = self.run_action("install-keymap")
        self.assertTrue(result["created"])
        self.assertEqual(self.path.read_bytes(), KEYMAP)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.path.stat().st_nlink, 1)
        inode = self.path.stat().st_ino
        self.assertFalse(self.run_action("install-keymap")["created"])
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertTrue(self.run_action("check-keymap")["validated"])
        self.assertNotIn(FIXTURE["storageSecret"], json.dumps(result))
        self.assertNotIn(FIXTURE["keymap"], json.dumps(result))
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_cli_default_uses_physical_user_home_and_ignores_environment_home(self):
        from types import SimpleNamespace
        from unittest.mock import patch
        value = {**self.config, "storageSecret": FIXTURE["storageSecret"], "keymap": FIXTURE["keymap"]}
        fake_home = str(self.home / "untrusted-environment-home")
        with patch.object(recovery.pwd, "getpwuid", return_value=SimpleNamespace(pw_dir=str(self.home))) as user, patch.dict(os.environ, {"HOME": fake_home}):
            result = recovery.execute("install-keymap", value, validator=self.validator, idle_probe=lambda: None)
        user.assert_called_once_with(os.getuid())
        self.assertTrue(result["validated"])
        self.assertEqual(self.path.read_bytes(), KEYMAP)
        self.assertFalse(Path(fake_home).exists())

    def test_existing_conflicting_keys_never_replaced(self):
        self.write(self.path, b"retained encrypted keymap")
        with self.assertRaises(recovery.RecoveryError):
            self.run_action("install-keymap")
        self.assertEqual(self.path.read_bytes(), b"retained encrypted keymap")
        self.assertEqual(self.calls, [])

    def test_wrong_secret_or_core_failure_publishes_nothing(self):
        def rejected(value):
            raise ValueError("synthetic core rejection")
        with self.assertRaises(ValueError):
            self.run_action("install-keymap", validator=rejected)
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_exact_context_profile_and_api_key_exclusion(self):
        for changes in ({"origin": "https://other.test"}, {"database": "other"}, {"pack": "other"},
                {"accountId": "b" * 64}, {"receiverId": self.config["accountId"]},
                {"workspaceId": "f" * 32}, {"keymapPath": str(self.home / "wrong.keymap")},
                {"key": "rx_live_dummyTestOnly"}, {"development": "true"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.run_action("preflight", changes)
        self.assertEqual(self.calls, [])
        self.profile["subject"] = "different-account"
        self.write(self.profile_path, json.dumps(self.profile).encode())
        with self.assertRaises(ValueError): self.run_action("preflight")

    def test_changed_profile_during_core_unlock_does_not_publish(self):
        def changed(value):
            self.validator(value)
            self.profile["subject"] = "changed-during-validation"
            self.write(self.profile_path, json.dumps(self.profile).encode())
            return {"validated": True}
        with self.assertRaises(ValueError): self.run_action("install-keymap", validator=changed)
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_publication_race_preserves_new_conflicting_file(self):
        def racing(value):
            self.validator(value)
            self.write(self.path, b"other process retained encrypted keys")
            return {"validated": True}
        with self.assertRaises(ValueError): self.run_action("install-keymap", validator=racing)
        self.assertEqual(self.path.read_bytes(), b"other process retained encrypted keys")
        self.assertEqual(list(self.path.parent.iterdir()), [self.path])

    def test_failed_durable_publication_rolls_back_only_new_owned_candidate(self):
        from unittest.mock import patch
        original = recovery.os.fsync
        calls = 0
        def interrupted(fd):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("synthetic post-rename interruption")
            return original(fd)
        with patch.object(recovery.os, "fsync", side_effect=interrupted):
            with self.assertRaises(OSError): self.run_action("install-keymap")
        self.assertFalse(self.path.exists())
        self.assertEqual(list(self.path.parent.iterdir()), [])

    def test_existing_matching_keymap_survives_late_profile_failure(self):
        self.write(self.path, KEYMAP)
        inode = self.path.stat().st_ino
        def changed(value):
            self.validator(value)
            self.profile["subject"] = "changed-during-validation"
            self.write(self.profile_path, json.dumps(self.profile).encode())
            return {"validated": True}
        with self.assertRaises(ValueError): self.run_action("install-keymap", validator=changed)
        self.assertEqual(self.path.stat().st_ino, inode)
        self.assertEqual(self.path.read_bytes(), KEYMAP)

    def test_queued_running_or_unknown_upload_states_and_mount_probe_refuse(self):
        state = self.home / "Library/Application Support/GenDragoon Cloud SSD/UploadWorkspace/state.json"
        for value in ({"schema": 1, "jobs": [], "active_job_id": "a" * 32},
                {"schema": 1, "jobs": [{"state": "queued"}], "active_job_id": None},
                {"schema": 1, "jobs": [{"state": "running"}], "active_job_id": None},
                {"schema": 1, "jobs": [{"state": "unknown"}], "active_job_id": None}):
            self.write(state, json.dumps(value).encode())
            with self.assertRaises(ValueError): self.run_action("install-keymap")
            self.assertFalse(self.path.exists())
        self.write(state, json.dumps({"schema": 1, "jobs": [{"state": "failed"}, {"state": "succeeded"}], "active_job_id": None}).encode())
        def mounted(): raise ValueError("synthetic active mount")
        with self.assertRaises(ValueError): self.run_action("install-keymap", probe=mounted)
        self.assertFalse(self.path.exists())
        self.assertTrue(self.run_action("install-keymap")["validated"])

    def test_existing_maintenance_lease_refuses_without_keymap_write(self):
        with recovery.workspace.maintenance_lock(self.home):
            with self.assertRaises(recovery.workspace.WorkspaceError): self.run_action("install-keymap")
        self.assertFalse(self.path.exists())

    def test_symlink_parent_leaf_hardlink_and_shared_keymap_refused(self):
        self.run_action("preflight")
        other = self.home / "other.keymap"
        self.write(other, KEYMAP)
        self.path.symlink_to(other)
        with self.assertRaises((ValueError, OSError)): self.run_action("install-keymap")
        self.path.unlink()
        os.link(other, self.path)
        with self.assertRaises((ValueError, OSError)): self.run_action("install-keymap")
        self.path.unlink()
        self.write(self.path, KEYMAP)
        self.path.chmod(0o644)
        with self.assertRaises((ValueError, OSError)): self.run_action("check-keymap")
        self.path.unlink()
        moved = self.path.parent.with_name("retained-keys")
        self.path.parent.rename(moved)
        self.path.parent.symlink_to(moved)
        with self.assertRaises((ValueError, OSError)): self.run_action("install-keymap")
        self.assertEqual(list(moved.iterdir()), [])
        self.assertEqual(other.read_bytes(), KEYMAP)

    def test_profile_symlink_or_hardlink_or_shared_mode_refused(self):
        self.profile_path.chmod(0o644)
        with self.assertRaises(ValueError): self.run_action("preflight")
        self.profile_path.chmod(0o600)
        os.link(self.profile_path, self.home / "profile-hardlink")
        with self.assertRaises(ValueError): self.run_action("preflight")

    def test_noncanonical_or_hardware_bound_keymaps_refused(self):
        for encoded in (FIXTURE["keymap"] + "=", "a", "!", base64.urlsafe_b64encode(KEYMAP[:4] + b"\4" + KEYMAP[5:]).decode().rstrip("=")):
            with self.assertRaises((ValueError, IndexError)): self.run_action("install-keymap", {"keymap": encoded})
        self.assertFalse(self.path.exists())

    def test_real_pinned_readonly_core_import_and_wrong_secret_retention(self):
        core = Path(os.environ.get("RSX_LIB", "/Applications/GenDragoon Cloud SSD.app/Contents/Resources/redxai/_native/librsx.dylib"))
        if not core.is_file(): self.skipTest("Pinned platform core unavailable")
        from unittest.mock import patch
        with patch.dict(os.environ, {"RSX_LIB": str(core)}):
            result = self.run_action("install-keymap", validator=recovery.validate_pinned)
            self.assertTrue(result["validated"])
            inode = self.path.stat().st_ino
            with self.assertRaises(Exception): self.run_action("install-keymap", {"storageSecret": "X" * 43}, validator=recovery.validate_pinned)
            self.assertEqual(self.path.stat().st_ino, inode)
            self.assertEqual(self.path.read_bytes(), KEYMAP)

    def test_cli_help_without_stdin_or_side_effects(self):
        result = subprocess.run([sys.executable, "-B", str(NATIVE / "Resources/gendragoon_byo_vault.py"), "--help"], input="", capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage:", result.stdout)

    def test_cli_rejects_credentials_without_reflecting_private_input(self):
        secret = "rx_live_dummyMustNotAppearInOutput"
        result = subprocess.run([sys.executable, "-B", str(NATIVE / "Resources/gendragoon_byo_vault.py"), "preflight"],
            input=json.dumps({"key": secret}), capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(json.loads(result.stdout)["error"], "byo_vault_rejected")


HARNESS = r'''
import Foundation
@main struct BYOVaultTest {
 static func main() {
  do {
   let value = try JSONSerialization.jsonObject(with: FileHandle.standardInput.readDataToEndOfFile()) as! [String: Any]
   var result: [String: Any] = ["ok": true]
   if value["operation"] as? String == "policy" {
    let record = try GDBYOVaultPolicy.recovery(existing: value["existing"] as? [String: String], secret: value["secret"] as! String)
    result["record"] = record
    result["account"] = try GDBYOVaultPolicy.account(owner: value["owner"] as! String, receiver: value["receiver"] as! String)
   } else if value["operation"] as? String == "seal" {
    let keys = GDPortableVaultCodec.Keys(receiverId: value["receiver"] as! String, storageSecret: value["secret"] as! String, keymap: Data(base64Encoded: value["keymap"] as! String)!)
    let bytes = try GDPortableVaultCodec.seal(keys, password: value["password"] as! String)
    result["envelope"] = try JSONSerialization.jsonObject(with: bytes)
   } else {
    let envelope = try JSONSerialization.data(withJSONObject: value["envelope"]!)
    let keys = try GDPortableVaultCodec.open(envelope, password: value["password"] as! String, expectedReceiver: value["receiver"] as! String)
    result["secret"] = keys.storageSecret
    result["keymap"] = keys.keymap.base64EncodedString()
   }
   print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
  } catch { print("{\"ok\":false}") }
 }
}
'''


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Real Apple crypto required")
class BYOSwiftTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gd-byo-swift-")
        cls.addClassCleanup(cls.temporary.cleanup)
        root = Path(cls.temporary.name)
        source = root / "Harness.swift"
        source.write_text(HARNESS)
        cls.program = root / "BYOVaultTest"
        built = subprocess.run([shutil.which("swiftc"), "-parse-as-library", str(NATIVE / "Sources/GDPortableVaultCodec.swift"), str(NATIVE / "Sources/GDBYOVaultPolicy.swift"), str(source), "-o", str(cls.program)], capture_output=True, text=True, timeout=60)
        if built.returncode: raise AssertionError(built.stderr)
        cls.config = {"origin": "https://fixture.test", "database": "storage", "pack": "gendragoon", "accountId": "a" * 64}
        cls.receiver = recovery.pack.connection_context(cls.config)["receiverId"]

    def call(self, operation, **values):
        result = subprocess.run([str(self.program)], input=json.dumps({"operation": operation, **values}), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_recovery_only_record_and_matching_full_record_preserved(self):
        values = dict(secret=FIXTURE["storageSecret"], owner="a" * 64, receiver=self.receiver)
        recovered = self.call("policy", **values)
        self.assertEqual(recovered["record"], {"storageSecret": FIXTURE["storageSecret"]})
        full = {"key": "rx_live_dummyOnly", "storageSecret": FIXTURE["storageSecret"]}
        self.assertEqual(self.call("policy", existing=full, **values)["record"], full)
        self.assertFalse(self.call("policy", existing={"storageSecret": "X" * 43}, **values)["ok"])
        self.assertFalse(self.call("policy", **{**values, "receiver": "a" * 64})["ok"])
        self.assertFalse(self.call("policy", existing={**full, "refreshToken": "neverExport"}, **values)["ok"])

    def test_real_encrypted_vault_bound_to_account_origin_database_and_pack(self):
        sealed = self.call("seal", receiver=self.receiver, secret=FIXTURE["storageSecret"], keymap=base64.b64encode(KEYMAP).decode(), password=FIXTURE["password"])
        envelope = sealed["envelope"]
        text = json.dumps(envelope)
        self.assertNotIn(FIXTURE["storageSecret"], text)
        self.assertNotIn(FIXTURE["keymap"], text)
        values = dict(receiver=self.receiver, password=FIXTURE["password"], envelope=envelope)
        opened = self.call("open", **values)
        self.assertEqual(opened["secret"], FIXTURE["storageSecret"])
        self.assertEqual(base64.b64decode(opened["keymap"]), KEYMAP)
        for changed in ({"origin": "https://other.test"}, {"database": "other"}, {"pack": "other"}, {"accountId": "b" * 64}):
            receiver = recovery.pack.connection_context({**self.config, **changed})["receiverId"]
            self.assertFalse(self.call("open", **{**values, "receiver": receiver})["ok"])
            forged = copy.deepcopy(envelope); forged["receiverId"] = receiver
            self.assertFalse(self.call("open", **{**values, "receiver": receiver, "envelope": forged})["ok"])
        self.assertFalse(self.call("open", **{**values, "receiver": "a" * 64})["ok"])
        self.assertFalse(self.call("open", **{**values, "password": "incorrect passphrase"})["ok"])
        changed = copy.deepcopy(envelope)
        data = bytearray(base64.urlsafe_b64decode(changed["ciphertext"] + "=" * (-len(changed["ciphertext"]) % 4)))
        data[0] ^= 1
        changed["ciphertext"] = base64.urlsafe_b64encode(data).decode().rstrip("=")
        self.assertFalse(self.call("open", **{**values, "envelope": changed})["ok"])

    def test_real_export_open_import_to_second_home_restores_authenticated_bytes(self):
        core = Path(os.environ.get("RSX_LIB", "/Applications/GenDragoon Cloud SSD.app/Contents/Resources/redxai/_native/librsx.dylib"))
        if not core.is_file(): self.skipTest("Pinned platform core unavailable")
        from unittest.mock import patch
        import gendragoon_redx_storage as storage
        profile = {"schema": 1, "issuer": "https://red-xai.com", "clientId": "gendragoon", "subject": "dummy-two-mac-fixture",
            "authProvider": "redx-site-session", "cloudApi": "https://api.red-xai.com", "storageFormat": "redsecretsxai-png-v1"}
        account = hashlib.sha256(json.dumps(["red-xai-receiver/v1", profile["issuer"], profile["subject"]], separators=(",", ":")).encode()).hexdigest()
        profile["receiverId"] = account
        base = {**self.config, "accountId": account}
        context = recovery.pack.connection_context(base)
        first = Path(self.temporary.name).resolve() / "first-home"
        second = Path(self.temporary.name).resolve() / "second-home"
        def prepare(home):
            home.mkdir(mode=0o700)
            path = home.joinpath(*recovery.PROFILE, "cloud.json")
            path.parent.mkdir(parents=True, mode=0o700)
            path.write_text(json.dumps(profile)); path.chmod(0o600)
            return {**base, **context, "keymapPath": str(home.joinpath(*recovery.KEYMAPS, context["receiverId"] + ".rsxkeymap"))}
        a, b = prepare(first), prepare(second)
        with patch.dict(os.environ, {"RSX_LIB": str(core)}):
            installed = recovery.execute("install-keymap", {**a, "storageSecret": FIXTURE["storageSecret"], "keymap": FIXTURE["keymap"]}, home=first, idle_probe=lambda: None)
            self.assertTrue(installed["validated"])
            from redxai import _librsx as rsx
            payload = b"disposable BYO recovery authenticated fixture\0" * 150
            sealed_file = first / "dummy.rsx"
            aad = storage.aad(context["receiverId"], context["workspaceId"], "d" * 32)
            with rsx.session_open_readonly(FIXTURE["storageSecret"], a["keymapPath"])[0] as session:
                session.encrypt_to(str(sealed_file), payload, aad=aad)
            envelope = self.call("seal", receiver=context["receiverId"], secret=FIXTURE["storageSecret"], keymap=base64.b64encode(KEYMAP).decode(), password=FIXTURE["password"])["envelope"]
            opened = self.call("open", receiver=context["receiverId"], password=FIXTURE["password"], envelope=envelope)
            restored_keymap = base64.b64decode(opened["keymap"])
            result = recovery.execute("install-keymap", {**b, "storageSecret": opened["secret"], "keymap": base64.urlsafe_b64encode(restored_keymap).decode().rstrip("=")}, home=second, idle_probe=lambda: None)
            self.assertTrue(result["created"])
            with rsx.session_open_readonly(opened["secret"], b["keymapPath"])[0] as session:
                self.assertEqual(session.decrypt_from(str(sealed_file), aad=aad), payload)
            self.assertEqual(Path(a["keymapPath"]).read_bytes(), KEYMAP)
            self.assertEqual(Path(b["keymapPath"]).read_bytes(), KEYMAP)


if __name__ == "__main__": unittest.main()
