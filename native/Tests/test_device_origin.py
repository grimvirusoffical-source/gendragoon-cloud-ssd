"""Synthetic per-account origin privacy and application-backup compatibility."""
import concurrent.futures
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

RESOURCE=Path(__file__).resolve().parents[1]/"Resources"
sys.path.insert(0,str(RESOURCE))
import gendragoon_device_origin as origin

class OriginTests(unittest.TestCase):
    def test_random_device_id_is_stable_private_and_account_scoped_under_concurrency(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve()/"Origins"
            with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
                values=list(pool.map(lambda _:origin.current_origin("a"*64,state_dir=root),range(36)))
            self.assertEqual(len({v["deviceId"] for v in values}),1)
            other=origin.current_origin("b"*64,state_dir=root)
            self.assertNotEqual(other["deviceId"],values[0]["deviceId"])
            self.assertEqual(set(values[0]),{"schema","platform","architecture","deviceId"})
            record=json.loads((root/("a"*64+".json")).read_bytes())
            self.assertEqual(set(record),{"schema","deviceId"})
            if os.name!="nt":self.assertEqual((root/("a"*64+".json")).stat().st_mode&0o777,0o600)
    def test_origin_validation_rejects_extra_identifiers_invalid_types_and_platforms(self):
        good=dict(schema=1,platform="macos",architecture="arm64",deviceId="a"*32)
        self.assertEqual(origin.validate_origin(good),good);self.assertIsNone(origin.validate_origin(None))
        for change in ({"schema":True},{"schema":1.0},{"platform":[]},{"platform":"Mac OS"},{"architecture":{}},{"deviceId":"../private"},{"hostname":"must-not-export"}):
            with self.subTest(change=change),self.assertRaises(ValueError):origin.validate_origin(dict(good,**change))
    @unittest.skipIf(os.name=="nt","POSIX link/mode fixtures")
    def test_linked_shared_or_corrupt_device_records_are_retained_and_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary).resolve();actual=root/"actual";actual.mkdir(mode=0o700)
            link=root/"link";link.symlink_to(actual,target_is_directory=True)
            with self.assertRaises(ValueError):origin.current_origin("a"*64,state_dir=link)
            value=origin.current_origin("a"*64,state_dir=actual);path=actual/("a"*64+".json");data=path.read_bytes()
            path.chmod(0o644)
            with self.assertRaises(ValueError):origin.current_origin("a"*64,state_dir=actual)
            self.assertEqual(path.read_bytes(),data);path.chmod(0o600)
            os.link(path,root/"shared")
            with self.assertRaises(ValueError):origin.current_origin("a"*64,state_dir=actual)
            self.assertEqual(path.read_bytes(),data)
    def test_artifact_hints_group_backups_without_changing_kind_or_claiming_format(self):
        expected={"App.EXE":"windows","install.msi":"windows","install.msix":"windows","install.appx":"windows",
            "install.msixbundle":"windows","install.appxbundle":"windows","Tool.AppImage":"linux","pkg.deb":"linux","pkg.rpm":"linux","app.apk":"android","app.ipa":"ios"}
        for name,target in expected.items():
            with self.subTest(name=name):self.assertEqual(origin.application_platform(name,"file"),target)
        self.assertEqual(origin.application_platform("App.app","app"),"macos")
        self.assertIsNone(origin.application_platform("report.pdf","file"));self.assertIsNone(origin.application_platform("App.exe","folder"))
        self.assertIsNone(origin.application_platform("Folder","folder","windows"))
        self.assertIsNone(origin.ensure_restore_compatible({"name":"Folder","kind":"folder","virtualFolder":True,"applicationPlatform":"windows"},platform_name="macos"))
    def test_legacy_suffix_and_declared_conflicts_fail_closed_before_restore(self):
        for item in ({"name":"App.exe","kind":"file"},{"name":"App.exe","kind":"file","applicationPlatform":"macos"},
                     {"name":"App.app","kind":"app","applicationPlatform":"windows"}):
            with self.subTest(item=item),self.assertRaises(ValueError):origin.ensure_restore_compatible(item,platform_name="macos")
        self.assertEqual(origin.ensure_restore_compatible({"name":"App.exe","kind":"file"},platform_name="windows"),"windows")
        self.assertIsNone(origin.ensure_restore_compatible({"name":"report.pdf","kind":"file"},platform_name="macos"))
    def test_origin_only_changes_catalog_and_reuses_identical_encrypted_manifest_objects(self):
        import test_redx_transfer_performance as fixture
        storage=fixture.storage
        fixture.FixtureReceiver.blobs={};fixture.FixtureReceiver.items={};fixture.FixtureReceiver.writes=0
        with tempfile.TemporaryDirectory() as temporary:
            archive=Path(temporary)/"archive";archive.write_bytes(b"Synthetic immutable archive bytes")
            config=fixture.config(temporary);digest=storage.sha256_file(archive);key="e"*18
            with patch.object(storage,"Codec",fixture.FixtureCodec):
                first=storage.upload_archive(config,archive,key,"Tool.exe","file","flat",digest,[],client_factory=fixture.FixtureReceiver)
                objects=dict(fixture.FixtureReceiver.blobs)
                device={"schema":1,"platform":"macos","architecture":"arm64","deviceId":"a"*32}
                second=storage.upload_archive(config,archive,key,"Tool.exe","file","flat",digest,[],client_factory=fixture.FixtureReceiver,origin=device)
            self.assertEqual(first["manifestId"],second["manifestId"]);self.assertEqual(fixture.FixtureReceiver.blobs,objects)
            catalog=fixture.FixtureReceiver.items[key];self.assertEqual(catalog["origin"],device);self.assertEqual(catalog["applicationPlatform"],"windows");self.assertEqual(catalog["kind"],"file")
            root=json.loads(objects[first["manifestId"]][24:]);self.assertNotIn("origin",root);self.assertNotIn("applicationPlatform",root)
    def test_upload_returns_retained_legacy_metadata_instead_of_claiming_the_new_device(self):
        import test_redx_transfer_performance as fixture
        storage=fixture.storage
        class LegacyCatalog(fixture.FixtureReceiver):
            def register(self,key,item):return dict(item,key=key,origin=None,applicationPlatform="windows")
        LegacyCatalog.blobs={};LegacyCatalog.items={}
        with tempfile.TemporaryDirectory() as temporary:
            archive=Path(temporary)/"archive";archive.write_bytes(b"Existing legacy immutable snapshot")
            device={"schema":1,"platform":"macos","architecture":"arm64","deviceId":"a"*32}
            with patch.object(storage,"Codec",fixture.FixtureCodec):
                result=storage.upload_archive(fixture.config(temporary),archive,"f"*18,"Tool.exe","file","flat",storage.sha256_file(archive),[],client_factory=LegacyCatalog,origin=device)
            self.assertIsNone(result["origin"]);self.assertEqual(result["applicationPlatform"],"windows")
    @unittest.skipIf(os.name=="nt","macOS library helper imports fcntl")
    def test_mac_helper_refuses_foreign_leaf_and_nested_virtual_folder_before_materialization(self):
        import gendragoon_library as lib
        foreign={"name":"App.exe","kind":"file"};folder={"name":"Folder","kind":"folder","virtualFolder":True}
        with patch.object(lib,"load",return_value={}),patch.object(lib,"selected_entry",return_value=foreign),patch.object(lib,"prepare_cache") as cache:
            with self.assertRaises(ValueError):lib.stage_item("f"*18)
            cache.assert_not_called()
        entries={"a"*18:dict(folder,parentKey="f"*18),"b"*18:dict(foreign,parentKey="a"*18)}
        with patch.object(lib,"selected_entry",return_value=folder),patch.object(lib,"selected_context",return_value={}),patch.object(lib,"in_context",return_value=True),patch.object(lib,"load",return_value=entries),patch.object(lib,"stage_virtual_folder") as restore:
            with self.assertRaises(ValueError):lib.stage_item("f"*18)
            restore.assert_not_called()

if __name__=="__main__":unittest.main()
