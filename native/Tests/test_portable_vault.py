"""Real Apple crypto interoperability and private encrypted-keymap import safety."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((NATIVE / "Tests/fixtures/portable-vault-v1.json").read_text())

def decoded(value):
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))

HARNESS = r'''
import Foundation
@main struct VaultTest {
 static func main() {
  do {
   let value = try JSONSerialization.jsonObject(with:FileHandle.standardInput.readDataToEndOfFile()) as! [String:Any]
   let operation = value["operation"] as! String
   var result: [String:Any] = ["ok":true]
   if operation == "seal" {
    let keys = GDPortableVaultCodec.Keys(receiverId:value["receiverId"] as! String,
       storageSecret:value["storageSecret"] as! String,keymap:Data(base64Encoded:value["keymapBase64"] as! String)!)
    let fixed = value["fixed"] as? Bool == true
    let bytes = try GDPortableVaultCodec.seal(keys,password:value["password"] as! String,
       salt:fixed ? Data(0..<16):nil,nonce:fixed ? Data(16..<28):nil)
    result["envelope"] = try JSONSerialization.jsonObject(with:bytes)
   } else if operation == "open" {
    let envelope = try JSONSerialization.data(withJSONObject:value["envelope"]!)
    let keys = try GDPortableVaultCodec.open(envelope,password:value["password"] as! String,expectedReceiver:value["receiverId"] as! String)
    result["receiverId"]=keys.receiverId;result["storageSecret"]=keys.storageSecret
    result["keymapBase64"]=keys.keymap.base64EncodedString()
   } else if operation == "create" {
    try GDPortableVaultFiles.create(Data(base64Encoded:value["bytes"] as! String)!,at:URL(fileURLWithPath:value["path"] as! String))
   } else if operation == "read" {
    result["bytes"] = try GDPortableVaultFiles.read(URL(fileURLWithPath:value["path"] as! String)).base64EncodedString()
   }
   let out = try JSONSerialization.data(withJSONObject:result,options:[.sortedKeys])
   print(String(data:out,encoding:.utf8)!)
  } catch { print("{\"ok\":false}") }
 }
}
'''

@unittest.skipUnless(sys.platform == "darwin" and shutil.which("swiftc"), "Real Apple CryptoKit/CommonCrypto required")
class PortableVaultTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gd-vault-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        directory = Path(cls.temporary.name)
        source = directory / "Harness.swift"
        source.write_text(HARNESS)
        cls.program = directory / "VaultTest"
        built = subprocess.run([shutil.which("swiftc"), "-parse-as-library", str(NATIVE / "Sources/GDPortableVaultCodec.swift"),
            str(source), "-o", str(cls.program)], capture_output=True, text=True, timeout=60)
        if built.returncode:
            raise AssertionError(built.stderr)

    def call(self, operation, **value):
        result = subprocess.run([str(self.program)],input=json.dumps(dict(operation=operation,**value)),
            text=True,capture_output=True,timeout=30)
        self.assertEqual(result.returncode,0,result.stderr)
        return json.loads(result.stdout)

    def seal(self, **updates):
        value=dict(receiverId=FIXTURE["receiverId"],password=FIXTURE["password"],storageSecret=FIXTURE["storageSecret"],
            keymapBase64=base64.b64encode(decoded(FIXTURE["keymap"])).decode(),fixed=True)
        value.update(updates)
        return self.call("seal",**value)

    def open(self, envelope=None, **updates):
        value=dict(receiverId=FIXTURE["receiverId"],password=FIXTURE["password"],envelope=envelope or FIXTURE["envelope"])
        value.update(updates)
        return self.call("open",**value)

    def test_published_dummy_fixture_exact_ciphertext_and_open(self):
        self.assertEqual(self.seal()["envelope"],FIXTURE["envelope"])
        result=self.open()
        self.assertTrue(result["ok"])
        self.assertEqual(result["storageSecret"],FIXTURE["storageSecret"])
        self.assertEqual(base64.b64decode(result["keymapBase64"]),decoded(FIXTURE["keymap"]))

    def test_fresh_random_salt_and_nonce_and_no_plaintext_secrets(self):
        a,b=self.seal(fixed=False)["envelope"],self.seal(fixed=False)["envelope"]
        self.assertNotEqual(a["kdf"]["salt"],b["kdf"]["salt"])
        self.assertNotEqual(a["cipher"]["nonce"],b["cipher"]["nonce"])
        self.assertNotEqual(a["ciphertext"],b["ciphertext"])
        self.assertNotIn(FIXTURE["storageSecret"],json.dumps(a))
        self.assertNotIn(FIXTURE["keymap"],json.dumps(a))
        self.assertTrue(self.open(a)["ok"])

    def test_account_passphrase_and_authenticated_ciphertext_tamper_fail(self):
        self.assertFalse(self.open(receiverId="f"*64)["ok"])
        self.assertFalse(self.open(password="wrong-passphrase")["ok"])
        for field in ("ciphertext","nonce","salt"):
            envelope=copy.deepcopy(FIXTURE["envelope"])
            target=envelope if field=="ciphertext" else envelope["cipher" if field=="nonce" else "kdf"]
            data=bytearray(decoded(target[field]));data[0]^=1
            target[field]=base64.urlsafe_b64encode(data).decode().rstrip("=")
            self.assertFalse(self.open(envelope)["ok"],field)

    def test_untrusted_kdf_counts_extra_fields_and_noncanonical_base64_fail(self):
        for iterations in (True,False,600000.5,1,600001,1e30):
            envelope=copy.deepcopy(FIXTURE["envelope"]);envelope["kdf"]["iterations"]=iterations
            self.assertFalse(self.open(envelope)["ok"])
        for mutation in (lambda v:v.update(refreshToken="test-only-never-export"),
                lambda v:v["kdf"].update(salt=v["kdf"]["salt"]+"="),
                lambda v:v["cipher"].update(nonce="a"),
                lambda v:v["cipher"].update(name="AES-128-GCM")):
            envelope=copy.deepcopy(FIXTURE["envelope"]);mutation(envelope)
            self.assertFalse(self.open(envelope)["ok"])

    def test_password_unicode_codepoints_and_no_implicit_normalization(self):
        self.assertTrue(self.seal(password="🔐"*12)["ok"])
        self.assertFalse(self.seal(password="🔐"*11)["ok"])
        self.assertFalse(self.seal(password="x"*1025)["ok"])
        envelope=self.seal(password=" vault phrase with spaces ")["envelope"]
        self.assertFalse(self.open(envelope,password="vault phrase with spaces")["ok"])

    def test_keymap_shape_hardware_binding_and_cost_rejected_before_unlock(self):
        data=decoded(FIXTURE["keymap"])
        for changed in (data[:-1],data+b"x",b"nope"+data[4:],data[:4]+b"\4"+data[5:]+b"x",
                data[:7]+(1024*1024).to_bytes(4,"big")+data[11:]):
            self.assertFalse(self.seal(keymapBase64=base64.b64encode(changed).decode())["ok"])

    def test_keymap_files_never_replace_existing_and_reject_links_permissions(self):
        with tempfile.TemporaryDirectory(prefix="gd-vault-files-") as td:
            path=Path(td)/"private.keymap"
            encoded=base64.b64encode(b"original encrypted test keymap").decode()
            self.assertTrue(self.call("create",path=str(path),bytes=encoded)["ok"])
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertFalse(self.call("create",path=str(path),bytes=base64.b64encode(b"different").decode())["ok"])
            self.assertEqual(path.read_bytes(),base64.b64decode(encoded))
            link=Path(td)/"symlink";link.symlink_to(path)
            self.assertFalse(self.call("read",path=str(link))["ok"])
            self.assertFalse(self.call("create",path=str(link),bytes=encoded)["ok"])
            hard=Path(td)/"hardlink";os.link(path,hard)
            self.assertFalse(self.call("read",path=str(path))["ok"])
            hard.unlink();path.chmod(0o644)
            self.assertFalse(self.call("read",path=str(path))["ok"])

class KeymapValidatorTests(unittest.TestCase):
    def test_cli_help_has_no_side_effects(self):
        result=subprocess.run([sys.executable,"-B",str(NATIVE/"Resources/gendragoon_vault.py"),"--help"],capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,0)
        self.assertIn("check-keymap",result.stdout)

    def test_pinned_core_readonly_unlock_and_failure_preserves_encrypted_file(self):
        candidates=[Path(os.environ["RSX_LIB"])] if os.environ.get("RSX_LIB") else []
        if sys.platform=="darwin":
            candidates.append(Path("/Applications/GenDragoon Cloud SSD.app/Contents/Resources/redxai/_native/librsx.dylib"))
        core=next((p for p in candidates if p.is_file()),None)
        if core is None:self.skipTest("Pinned platform core unavailable")
        with tempfile.TemporaryDirectory(prefix="gd-vault-core-") as td:
            path=Path(td)/"dummy.keymap";data=decoded(FIXTURE["keymap"]);path.write_bytes(data);path.chmod(0o600)
            value=dict(storageSecret=FIXTURE["storageSecret"],keymapPath=str(path),keymapSha256=hashlib.sha256(data).hexdigest())
            env=os.environ.copy();env["RSX_LIB"]=str(core)
            command=[sys.executable,"-B",str(NATIVE/"Resources/gendragoon_vault.py"),"check-keymap"]
            good=subprocess.run(command,input=json.dumps(value),env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual(good.returncode,0,good.stdout+good.stderr)
            self.assertTrue(json.loads(good.stdout)["validated"])
            self.assertEqual(list(Path(td).iterdir()),[path])
            self.assertEqual(path.read_bytes(),data)
            value["storageSecret"]="X"*43
            bad=subprocess.run(command,input=json.dumps(value),env=env,capture_output=True,text=True,timeout=30)
            self.assertEqual(bad.returncode,1)
            self.assertNotIn(value["storageSecret"],bad.stdout+bad.stderr)
            self.assertEqual(path.read_bytes(),data)
            self.assertEqual(list(Path(td).iterdir()),[path])

if __name__ == "__main__":unittest.main()
