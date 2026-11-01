"""Release boundary: compiled private codec, original notices, separate FLOSS host."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import tarfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch,MagicMock

DESKTOP=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DESKTOP))
import stage_runtime
import package_desktop
import build_mount_host

class DistributionTests(unittest.TestCase):
    def fixture(self,root):
        runtime=root/"runtime";runtime.mkdir()
        for name in ("LICENSE","NOTICE"):(runtime/name).write_text("Synthetic immutable legal notice\n")
        for package in ("redxai","redsecretsxai"):(runtime/package).mkdir()
        return runtime

    def test_original_notice_and_source_exclusion_are_mandatory(self):
        with tempfile.TemporaryDirectory() as temporary:
            runtime=self.fixture(Path(temporary));package_desktop.check_compiled_codec(runtime)
            source=runtime/"redxai/private.py";source.write_text("secret = 'synthetic'\n")
            with self.assertRaisesRegex(RuntimeError,"private codec source"):package_desktop.check_compiled_codec(runtime)
            source.unlink();(runtime/"NOTICE").unlink()
            with self.assertRaisesRegex(RuntimeError,"original license and notice"):package_desktop.check_compiled_codec(runtime)

    @unittest.skipUnless(sys.version_info[:2]==(3,13),"Compiled portable wrappers require Python3.13")
    def test_source_build_freezes_adjacent_bytecode_without_private_build_paths(self):
        with tempfile.TemporaryDirectory(prefix="gd-private-build-synthetic-") as temporary:
            runtime=self.fixture(Path(temporary));sources=[]
            for package,names in (("redxai",("__init__","_librsx")),("redsecretsxai",("__init__",*stage_runtime.MODULES))):
                for name in names:
                    path=runtime/package/(name+".py");path.write_text("VALUE = 17\n");sources.append(path)
            stage_runtime.freeze_codec_sources(runtime)
            self.assertFalse(any(runtime.rglob("*.py")))
            for source in sources:
                data=source.with_suffix(".pyc").read_bytes()
                self.assertEqual(data[:4],importlib.util.MAGIC_NUMBER);self.assertNotIn(temporary.encode(),data)
            package_desktop.check_compiled_codec(runtime)

    def test_host_dependency_json_stream_does_not_silently_drop_records(self):
        records=list(build_mount_host.json_stream(b'{"ImportPath":"one"}\n{"ImportPath":"two"}\n'))
        self.assertEqual([v["ImportPath"] for v in records],["one","two"])
        with self.assertRaises(ValueError):list(build_mount_host.json_stream(b'{"ImportPath":"one"}\ninvalid'))

    def test_windows_acl_split_entries_preserve_exact_owner_scope(self):
        sid="synthetic-current-user";descriptor=MagicMock();acl=descriptor.GetSecurityDescriptorDacl.return_value
        descriptor.GetSecurityDescriptorOwner.return_value=sid;descriptor.GetSecurityDescriptorControl.return_value=(0x1000,1)
        security=SimpleNamespace(OWNER_SECURITY_INFORMATION=1,DACL_SECURITY_INFORMATION=4,ACCESS_ALLOWED_ACE_TYPE=0,
            ConvertSidToStringSid=lambda value:value,GetFileSecurity=lambda *_:descriptor)
        fixture=SimpleNamespace(modules=lambda:(security,),user_sid=lambda:sid)
        entries=[((0,3),0x1f01ff,sid),((0,11),0x10000000,sid)]
        acl.GetAceCount.side_effect=lambda:len(entries);acl.GetAce.side_effect=lambda index:entries[index]
        with patch.dict(sys.modules,{"gendragoon_platform_ipc":fixture}):
            build_mount_host.verify_windows_output(Path("synthetic-output"))
            for principal in ("S-1-5-18","S-1-5-32-544","synthetic-other-user"):
                entries[1]=((0,11),0x10000000,principal)
                with self.subTest(principal=principal),self.assertRaisesRegex(RuntimeError,"another Windows principal"):
                    build_mount_host.verify_windows_output(Path("synthetic-output"))
            entries[1]=((0,11),0x10000000,sid);descriptor.GetSecurityDescriptorControl.return_value=(0,1)
            with self.assertRaisesRegex(RuntimeError,"protected current-user"):build_mount_host.verify_windows_output(Path("synthetic-output"))

    def test_standalone_host_artifact_contains_only_public_host_source_and_actual_notices(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);module=root/"module";module.mkdir();dependency=root/"rclone";dependency.mkdir();goroot=root/"go";goroot.mkdir()
            for name in ("LICENSE","README.md","THIRD_PARTY_NOTICES.md","go.mod","go.sum","main.go"):(module/name).write_text("Synthetic public host fixture\n")
            (module/"notices").mkdir();(module/"notices/WinFsp-LICENSE.txt").write_text("Synthetic original WinFsp copyright\n")
            (dependency/"COPYING").write_text("Synthetic immutable rclone copyright\n")
            (goroot/"LICENSE").write_text("Synthetic immutable Go copyright\n")
            seen=[]
            def command(args,environment):
                seen.append(args)
                self.assertEqual(environment["GOOS"],"windows");self.assertEqual(environment["CGO_ENABLED"],"0")
                if args[1]=="list":return (json.dumps({"Module":{"Path":"owned/public-host","Dir":str(module)}})+"\n"+json.dumps({"Module":{"Path":"github.com/rclone/rclone","Version":"v1.75.2","Dir":str(dependency),"Sum":"h1:fixture"}})).encode()
                if args[1]=="env":return str(goroot).encode()
                if args[1]=="version":return b"go version go1.26.0 windows/amd64\n"
                if args[1]=="build":Path(args[args.index("-o")+1]).write_bytes(b"MZsynthetic-public-host");return b""
                self.fail("Unexpected build command")
            output=root/"standalone"
            with patch.object(build_mount_host,"MODULE",module),patch.object(build_mount_host.shutil,"which",return_value="/fixture/go"),patch.object(build_mount_host,"command",side_effect=command):
                build_mount_host.build(output)
            manifest=json.loads((output/"STANDALONE_HOST_MANIFEST.json").read_text())
            self.assertFalse(manifest["containsGenDragoonApp"]);self.assertFalse(manifest["containsPrivateCodec"]);self.assertFalse(manifest["containsWinFsp"])
            self.assertEqual((output/"licenses/github.com_rclone_rclone--COPYING").read_bytes(),(dependency/"COPYING").read_bytes())
            with tarfile.open(output/"GenDragoonMountHost-source.tar.gz") as source:
                entries=source.getmembers();self.assertEqual(len(entries),7)
                self.assertTrue(all(i.uid==0 and i.gid==0 and not i.uname and not i.gname and i.mtime==0 for i in entries))
                self.assertFalse(any(i.name.endswith((".exe",".dll",".py")) for i in entries))
            self.assertTrue(any("-mod=readonly" in a for a in seen));self.assertTrue(any("-trimpath" in a for a in seen))
            if os.name=="nt":
                import private_fs
                from gendragoon_platform_ipc import modules,user_sid
                security=modules()[-1];sid=security.ConvertSidToStringSid(user_sid())
                for path in (output,*output.rglob("*")):
                    private_fs.verify(path)
                    descriptor=security.GetFileSecurity(str(path),security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
                    self.assertEqual(security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()),sid)
                    self.assertTrue(descriptor.GetSecurityDescriptorControl()[0]&0x1000)
                    acl=descriptor.GetSecurityDescriptorDacl();self.assertIsNotNone(acl);self.assertGreaterEqual(acl.GetAceCount(),1)
                    for index in range(acl.GetAceCount()):
                        self.assertEqual(acl.GetAce(index)[0][0],security.ACCESS_ALLOWED_ACE_TYPE)
                        self.assertEqual(security.ConvertSidToStringSid(acl.GetAce(index)[-1]),sid)

if __name__=="__main__":unittest.main()
