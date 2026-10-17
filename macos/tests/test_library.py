"""Archive upload/restore fixtures: no cloud calls or user-file deletion."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

HELPER=Path(__file__).resolve().parents[1]/"Resources/gendragoon_library.py"
spec=importlib.util.spec_from_file_location("library_fixture",HELPER)
library=importlib.util.module_from_spec(spec);spec.loader.exec_module(library)


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="gd-library-")
        self.home=Path(self.temporary.name);self.home.chmod(0o700)
        self.support=self.home/"Library/Application Support/GenDragoon Cloud SSD"
        self.support.mkdir(parents=True,mode=0o700)
        self.config=self.support/"gendragoon-rclone.conf";self.config.write_text("[fixture]\ntype = gcs\n");self.config.chmod(0o600)
        self.patches=[]
        for name,value in {"HOME":self.home,"SUPPORT":self.support,"CONFIG":self.config,"CACHE":self.support/"AppLibrary","INDEX":self.support/"app-library.json","RCLONE":self.home/"rclone"}.items():
            item=patch.object(library,name,value);item.start();self.patches.append(item)
        self.remote={};self.hook=None;self.bad_readback=False;self.bad_restore=False;self.restored=False
        self.fake_run=patch.object(library,"run",side_effect=self.fake_command);self.fake_run.start();self.patches.append(self.fake_run)
        item=patch.object(library,"is_running",return_value=False);item.start();self.patches.append(item)
        self.trash=patch.object(library,"trash");self.mock_trash=self.trash.start();self.patches.append(self.trash)
        self.reply=patch.object(library,"reply");self.mock_reply=self.reply.start();self.patches.append(self.reply)

    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        self.temporary.cleanup()

    def fake_command(self,args,timeout=1800):
        args=[str(x) for x in args]
        if args[0]=="/usr/bin/ditto":
            if "-c" in args:
                source,destination=map(Path,args[-2:])
                with zipfile.ZipFile(destination,"w") as archive:
                    for path in [source,*sorted(source.rglob("*"))]:
                        name=str(path.relative_to(source.parent));info=path.lstat()
                        if stat.S_ISDIR(info.st_mode):name+="/"
                        entry=zipfile.ZipInfo(name);entry.create_system=3;entry.external_attr=info.st_mode<<16
                        content=os.readlink(path).encode() if path.is_symlink() else (path.read_bytes() if path.is_file() else b"")
                        archive.writestr(entry,content)
            else:
                source,destination=map(Path,args[-2:])
                with zipfile.ZipFile(source) as archive:
                    for entry in archive.infolist():
                        path=destination/entry.filename;mode=entry.external_attr>>16
                        if self.bad_restore and entry.filename.endswith("payload"):continue
                        if entry.is_dir():path.mkdir(parents=True,exist_ok=True);path.chmod(mode&0o777)
                        elif stat.S_ISLNK(mode):path.parent.mkdir(parents=True,exist_ok=True);path.symlink_to(archive.read(entry).decode())
                        else:path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(archive.read(entry));path.chmod(mode&0o777)
                self.restored=True
            return ""
        operation=args[args.index("--config")+2]
        if operation=="copyto":
            origin,target=args[args.index(operation)+1:args.index(operation)+3]
            if ":" in target:self.remote[target]=Path(origin).read_bytes()
            else:
                Path(target).write_bytes(self.remote[origin]+(b"corrupt" if self.bad_readback else b""))
                if self.hook:self.hook()
            return ""
        if operation=="lsf":return "Remote.app/\n" if "--dirs-only" in args else "cloud-file.txt\n"
        raise AssertionError("Unexpected fixture command "+operation)

    def source(self,kind):
        path=self.home/("Example.app" if kind=="app" else "Folder" if kind=="folder" else "executable.command")
        if kind=="file":path.write_bytes(b"payload bytes");path.chmod(0o755)
        else:
            (path/"nested").mkdir(parents=True)
            (path/"nested/payload").write_bytes(b"payload bytes");(path/"nested/payload").chmod(0o755)
            (path/"shortcut").symlink_to("nested/payload")
            (path/"empty").mkdir()
            if kind=="app":
                (path/"Contents").mkdir();(path/"Contents/Info.plist").write_bytes(b"fixture plist")
        return path

    def upload(self,path,offload=False,project="project-one",bucket="bucket-one"):
        library.upload(path,"gendragoon",bucket+"/GenDragoon-App-Library",offload,project,bucket)
        return self.mock_reply.call_args.kwargs

    def test_file_folder_and_atomic_app_roundtrip_preserves_manifest(self):
        for kind in ("file","folder","app"):
            with self.subTest(kind=kind):
                source=self.source(kind);before=library.snapshot(source)
                result=self.upload(source)
                self.assertTrue(result["verified"]);self.assertFalse(result["offloaded"])
                self.assertEqual(library.snapshot(source),before)
                library.stage_item(result["key"],False,"project-one","bucket-one")
                restored=Path(self.mock_reply.call_args.kwargs["localPath"])
                self.assertEqual(library.snapshot(restored)["manifest"],before["manifest"])
        self.mock_trash.assert_not_called()

    def test_offload_occurs_only_after_full_restore_and_unchanged_guard(self):
        source=self.source("app")
        def trash(path):
            self.assertTrue(self.restored)
            self.assertEqual(library.snapshot(path)["manifest"],library.load()[library.keyfor("gendragoon","bucket-one/GenDragoon-App-Library",source.name,"project-one","bucket-one")]["manifest"])
        self.mock_trash.side_effect=trash
        result=self.upload(source,True)
        self.assertTrue(result["offloaded"]);self.mock_trash.assert_called_once_with(source)

    def test_failed_cloud_readback_never_trashes_original(self):
        source=self.source("folder");self.bad_readback=True
        with self.assertRaisesRegex(RuntimeError,"read-back"):self.upload(source,True)
        self.assertTrue(source.exists());self.mock_trash.assert_not_called()
        self.assertEqual(library.load(),{})

    def test_incomplete_restore_never_trashes_original(self):
        source=self.source("app");self.bad_restore=True
        with self.assertRaisesRegex(RuntimeError,"Restored content"):self.upload(source,True)
        self.assertTrue((source/"nested/payload").exists());self.mock_trash.assert_not_called()

    def test_source_mutation_during_upload_preserves_original(self):
        source=self.source("folder")
        self.hook=lambda:(source/"nested/payload").write_bytes(b"modified while upload running")
        with self.assertRaisesRegex(RuntimeError,"Source changed"):self.upload(source,True)
        self.assertEqual((source/"nested/payload").read_bytes(),b"modified while upload running");self.mock_trash.assert_not_called()

    def test_source_mutation_during_archiving_is_rejected(self):
        source=self.source("folder");actual_run=self.fake_command
        def mutate(args,timeout=1800):
            result=actual_run(args,timeout)
            if str(args[0])=="/usr/bin/ditto" and "-c" in args:(source/"nested/payload").chmod(0o644)
            return result
        with patch.object(library,"run",side_effect=mutate):
            with self.assertRaisesRegex(RuntimeError,"Source changed"):self.upload(source,True)
        self.assertFalse(self.remote);self.mock_trash.assert_not_called()

    def test_mutation_immediately_before_trash_keeps_original(self):
        source=self.source("file");original_store=library.store_revision
        def mutate(key,entry,expected):
            original_store(key,entry,expected);source.write_bytes(b"changed after verification/index write")
        with patch.object(library,"store_revision",side_effect=mutate):
            with self.assertRaisesRegex(RuntimeError,"Source changed"):self.upload(source,True)
        self.assertTrue(source.exists());self.mock_trash.assert_not_called()

    def test_escaping_symlinks_are_rejected_without_cloud_write(self):
        source=self.source("folder");(source/"escape").symlink_to("../outside")
        with self.assertRaisesRegex(ValueError,"escaping"):self.upload(source,True)
        self.assertFalse(self.remote);self.mock_trash.assert_not_called()

    def test_archive_traversal_and_escaping_symlinks_rejected(self):
        for name,target in (("../outside",None),("Folder/link","../../outside"),("Folder/link","/etc/passwd")):
            path=self.home/"bad.zip"
            with zipfile.ZipFile(path,"w") as archive:
                entry=zipfile.ZipInfo(name)
                if target is not None:entry.external_attr=(stat.S_IFLNK|0o777)<<16
                archive.writestr(entry,target or "payload")
            with self.subTest(name=name,target=target),self.assertRaises(ValueError):library.validate_archive(path,"Folder")

    def test_ancestors_of_managed_output_are_rejected_before_cache_creation(self):
        for source in (self.home,self.home/"Library",self.support.parent):
            with self.subTest(source=source),self.assertRaises(ValueError):self.upload(source,True)
        self.assertFalse(library.CACHE.exists());self.assertFalse(self.remote);self.mock_trash.assert_not_called()

    def test_custom_native_install_uses_its_adjacent_rclone(self):
        helper=Path("/Applications/Custom Location/GenDragoon Cloud SSD.app/Contents/Resources/gendragoon_library.py")
        self.assertEqual(library.rclone_path(helper),helper.with_name("rclone"))

    def test_context_isolates_keys_listing_scan_and_restore(self):
        source=self.source("file")
        first=self.upload(source)
        other=self.upload(source,project="project-two",bucket="bucket-two")
        self.assertNotEqual(first["key"],other["key"])
        legacy=library.keyfor("gendragoon","gen-dragoon-ssd",source.name)
        library.store(legacy,{"name":"legacy","remote":"gendragoon","format":"raw"})
        library.listing("project-one","bucket-one")
        self.assertEqual([i["key"] for i in self.mock_reply.call_args.kwargs["items"]],[first["key"]])
        library.scan("gendragoon","bucket-one","project-one","bucket-one")
        visible=self.mock_reply.call_args.kwargs["items"]
        self.assertEqual(len(visible),3);self.assertTrue(all(i["project"]=="project-one" for i in visible))
        with self.assertRaises(ValueError):library.stage_item(other["key"],False,"project-one","bucket-one")
        with self.assertRaises(ValueError):library.upload(source,"gendragoon","bucket-two/archive",False,"project-one","bucket-one")

    def test_index_atomic_updates_serialize_and_reject_symlink(self):
        errors=[]
        def store(number):
            try:library.store(format(number,"018x"),{"name":str(number)})
            except Exception as error:errors.append(error)
        threads=[threading.Thread(target=store,args=(n,)) for n in range(12)]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertFalse(errors);self.assertEqual(len(library.load()),12)
        self.assertEqual(library.INDEX.stat().st_mode&0o777,0o600)
        library.INDEX.unlink();preserved=self.home/"preserved";preserved.write_text("keep")
        library.INDEX.symlink_to(preserved)
        with self.assertRaises(ValueError):library.store("0"*18,{"name":"bad"})
        self.assertEqual(preserved.read_text(),"keep")

    def test_modified_cache_is_not_evicted(self):
        source=self.source("file");result=self.upload(source)
        library.stage_item(result["key"],False,"project-one","bucket-one")
        cache=Path(self.mock_reply.call_args.kwargs["localPath"]);cache.write_bytes(b"local user changes")
        with self.assertRaisesRegex(RuntimeError,"Restored content"):library.clear_cache(result["key"],"project-one","bucket-one")
        self.assertEqual(cache.read_bytes(),b"local user changes")

    def test_maintenance_lease_serializes_direct_and_inherited_operations(self):
        with library.maintenance_lock():
            with self.assertRaises(RuntimeError):
                with library.maintenance_lock():pass
        lock=self.support/"AutoUpdates/update.lock"
        descriptor=os.open(lock,os.O_RDWR)
        import fcntl
        fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
        try:
            with library.maintenance_lock(descriptor):pass
            # Returning from the inherited context must retain the parent's lease.
            with self.assertRaises(RuntimeError):
                with library.maintenance_lock():pass
        finally:os.close(descriptor)
        unrelated=self.home/"unrelated.lock";unrelated.write_text("");unrelated.chmod(0o600)
        descriptor=os.open(unrelated,os.O_RDWR)
        try:
            with self.assertRaises(ValueError):
                with library.maintenance_lock(descriptor):pass
        finally:os.close(descriptor)

    def test_failed_new_revision_preserves_previous_verified_object_and_index(self):
        source=self.source("file");first=self.upload(source,True)
        original_index=library.load();original_objects=dict(self.remote)
        source.write_bytes(b"new revision that must not destroy old backup")
        self.bad_readback=True
        with self.assertRaisesRegex(RuntimeError,"read-back"):self.upload(source,True)
        self.assertEqual(library.load(),original_index)
        self.assertTrue(all(self.remote[path]==content for path,content in original_objects.items()))
        self.assertTrue(source.exists())
        self.assertEqual(self.mock_trash.call_count,1)

    def test_upload_failure_and_index_commit_failure_preserve_old_backup(self):
        source=self.source("file");self.upload(source,True)
        index=library.load();old=dict(self.remote)
        source.write_bytes(b"a new source revision")
        original_command=self.fake_command
        def fail_upload(args,timeout=1800):
            values=[str(value) for value in args]
            if "copyto" in values and ":" in values[values.index("copyto")+2]:
                self.remote[values[values.index("copyto")+2]]=b"partial new upload"
                raise RuntimeError("cloud upload fixture failed")
            return original_command(args,timeout)
        with patch.object(library,"run",side_effect=fail_upload):
            with self.assertRaisesRegex(RuntimeError,"fixture failed"):self.upload(source,True)
        self.assertEqual(library.load(),index)
        self.assertTrue(all(self.remote[path]==content for path,content in old.items()))
        with patch.object(library.os,"replace",side_effect=OSError("atomic index rename fixture failed")):
            with self.assertRaises(OSError):self.upload(source,True)
        self.assertEqual(library.load(),index)
        self.assertTrue(all(self.remote[path]==content for path,content in old.items()))
        self.assertTrue(source.exists());self.assertEqual(self.mock_trash.call_count,1)

    def test_different_same_name_source_is_rejected_before_cloud_write(self):
        first=self.source("file");self.upload(first,True)
        objects=dict(self.remote);index=library.load()
        other=self.home/"Elsewhere"/first.name;other.parent.mkdir();other.write_bytes(b"distinct source")
        with self.assertRaisesRegex(RuntimeError,"same-name source"):self.upload(other,True)
        self.assertEqual(self.remote,objects);self.assertEqual(library.load(),index)
        self.assertTrue(other.exists());self.assertEqual(self.mock_trash.call_count,1)

    def test_verified_revisions_keep_previous_objects_and_recovery_metadata(self):
        source=self.source("file");first=self.upload(source)
        old=library.load()[first["key"]];old_objects=dict(self.remote)
        source.write_bytes(b"new verified content")
        second=self.upload(source)
        entry=library.load()[second["key"]]
        self.assertNotEqual(old["file"],entry["file"])
        self.assertEqual(entry["previousVersions"],[old])
        self.assertTrue(all(self.remote[path]==content for path,content in old_objects.items()))

    def test_case_alias_and_unicode_archive_collisions_are_rejected_before_extract(self):
        path=self.home/"case-alias.zip"
        with zipfile.ZipFile(path,"w") as archive:
            for name,target in (("Folder/Link","."),("Folder/Escape","link/link/link/../../../outside")):
                info=zipfile.ZipInfo(name);info.external_attr=(stat.S_IFLNK|0o777)<<16;archive.writestr(info,target)
            archive.writestr("Folder/escape/payload",b"must not extract")
        with self.assertRaises(ValueError):library.validate_archive(path,"Folder")
        for left,right in (("Folder/Foo","Folder/foo"),("Folder/\u00e9","Folder/e\u0301")):
            with zipfile.ZipFile(path,"w") as archive:
                archive.writestr(left,b"first");archive.writestr(right,b"second")
            with self.assertRaises(ValueError):library.validate_archive(path,"Folder")


if __name__=="__main__":unittest.main()
