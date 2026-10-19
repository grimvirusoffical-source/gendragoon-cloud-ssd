#!/usr/bin/env python3
"""Disposable project package tests; native ditto itself has a Darwin smoke gate."""
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'Resources'))
project = importlib.import_module('gendragoon_project_files')
library = project.library


def portable_package(source, archive):
    """Test adapter for Apple's ditto, retaining Unix mode/link/empty-dir data."""
    source = Path(source)
    with zipfile.ZipFile(archive, 'x') as output:
        for path in [source, *sorted(source.rglob('*'))] if source.is_dir() else [source]:
            relative = source.name if path == source else source.name + '/' + path.relative_to(source).as_posix()
            info = path.lstat()
            member = zipfile.ZipInfo(relative + ('/' if stat.S_ISDIR(info.st_mode) else ''))
            member.create_system = 3
            member.external_attr = info.st_mode << 16
            if stat.S_ISDIR(info.st_mode): data = b''
            elif stat.S_ISLNK(info.st_mode): data = os.readlink(path).encode()
            else: data = path.read_bytes()
            output.writestr(member, data)


def portable_extract(command, timeout=1800):
    if list(command[:3]) != ['/usr/bin/ditto', '-x', '-k']:
        raise AssertionError('Unexpected process: ' + repr(command))
    archive, destination = Path(command[3]), Path(command[4])
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            target = destination / entry.filename
            mode = entry.external_attr >> 16
            if stat.S_ISDIR(mode): target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                if stat.S_ISLNK(mode): target.symlink_to(source.read(entry).decode())
                else: target.write_bytes(source.read(entry))
            if not stat.S_ISLNK(mode): target.chmod(mode & 0o777)
    return ''


class ProjectFileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gd-project-test-')
        self.home = Path(self.temporary.name)
        self.support = self.home / 'support'
        self.scope = 'a' * 64
        self.patches = [mock.patch.object(library, 'HOME', self.home),
                        mock.patch.object(library, 'SUPPORT', self.support),
                        mock.patch.object(project, 'ROOT', self.support / 'ProjectFiles'),
                        mock.patch.object(library, 'require_space'),
                        mock.patch.object(library, 'package', side_effect=portable_package),
                        mock.patch.object(library, 'run', side_effect=portable_extract)]
        self.mocks = [patch.start() for patch in self.patches]
        self.addCleanup(self.temporary.cleanup)
        for patch in self.patches: self.addCleanup(patch.stop)

    def folder(self):
        source = self.home / 'Folder with spaces'
        (source / 'nested' / 'empty folder').mkdir(parents=True)
        (source / 'empty file').write_bytes(b'')
        (source / 'nested' / 'run.command').write_bytes(b'#!/bin/sh\nexit 0\n')
        (source / 'nested' / 'run.command').chmod(0o755)
        (source / 'nested' / 'relative link').symlink_to('run.command')
        return source

    def prepare(self, source):
        result = project.prepare(str(source), self.scope)
        downloaded = self.home / 'separate-cloud-download.gdpackage'
        shutil.copyfile(result['path'], downloaded)
        return result, downloaded

    def test_complete_folder_readback_preserves_nested_empty_and_symlink_items(self):
        source = self.folder()
        before = library.snapshot(source)
        prepared, downloaded = self.prepare(source)
        self.assertEqual(prepared['kind'], 'folder')
        with mock.patch.object(library, 'trash') as trash:
            result = project.verify_remote(downloaded, self.scope, prepared['key'])
        self.assertTrue(result['verified']); self.assertFalse(result['offloaded']); trash.assert_not_called()
        self.assertEqual(library.snapshot(source), before)
        self.assertFalse(Path(prepared['path']).exists(), 'Verified transfer staging should be released')
        preview = project.inspect(downloaded, prepared['manifestSHA256'])
        self.assertIn('nested/empty folder', {entry['path'] for entry in preview['entries']})
        self.assertIn('empty file', {entry['path'] for entry in preview['entries']})

    def test_zero_byte_extensionless_file_is_a_valid_package(self):
        source = self.home / 'EMPTY'; source.write_bytes(b'')
        prepared, downloaded = self.prepare(source)
        self.assertEqual(prepared['logicalBytes'], 0)
        self.assertEqual(prepared['kind'], 'file')
        self.assertTrue(project.verify_remote(downloaded, self.scope, prepared['key'])['verified'])
        self.assertEqual(source.read_bytes(), b'')

    def test_unchanged_preparation_is_reused_for_resuming(self):
        source = self.folder()
        first = project.prepare(source, self.scope)
        second = project.prepare(source, self.scope)
        self.assertEqual(first, second)
        self.assertEqual(self.mocks[4].call_count, 1)

    def test_mutated_source_is_retained_even_with_offload_checked(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        (source / 'new user data').write_bytes(b'keep me')
        with mock.patch.object(library, 'trash') as trash:
            with self.assertRaisesRegex(RuntimeError, 'source changed'):
                project.verify_remote(downloaded, self.scope, prepared['key'], offload=True)
            trash.assert_not_called()
        self.assertEqual((source / 'new user data').read_bytes(), b'keep me')
        self.assertTrue(Path(prepared['path']).exists())

    def test_corrupt_download_never_authorizes_offload(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        with downloaded.open('ab') as target: target.write(b'corrupt')
        with mock.patch.object(library, 'trash') as trash:
            with self.assertRaisesRegex(RuntimeError, 'differs'):
                project.verify_remote(downloaded, self.scope, prepared['key'], offload=True)
            trash.assert_not_called()
        self.assertTrue(source.is_dir())

    def test_prepared_local_copy_cannot_substitute_for_cloud_readback(self):
        source = self.folder(); prepared = project.prepare(source, self.scope)
        with self.assertRaisesRegex(ValueError, 'separately downloaded'):
            project.verify_remote(prepared['path'], self.scope, prepared['key'], offload=True)
        self.assertTrue(source.is_dir())

    def test_explicit_offload_uses_only_exact_unchanged_receipt_source(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        trash_target = self.home / 'fixture-trash'
        with mock.patch.object(library, 'is_running', return_value=False), \
                mock.patch.object(library, 'trash', side_effect=lambda path: path.rename(trash_target)) as trash:
            result = project.verify_remote(downloaded, self.scope, prepared['key'], offload=True)
        self.assertTrue(result['offloaded']); trash.assert_called_once_with(source)
        self.assertTrue(trash_target.is_dir()); self.assertTrue(downloaded.is_file())

    def test_source_running_check_prevents_offload(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        with mock.patch.object(library, 'is_running', return_value=True), mock.patch.object(library, 'trash') as trash:
            with self.assertRaisesRegex(RuntimeError, 'Quit'):
                project.verify_remote(downloaded, self.scope, prepared['key'], offload=True)
            trash.assert_not_called()
        self.assertTrue(source.is_dir())

    def test_finder_failure_does_not_claim_original_was_retained_or_moved(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        target = self.home / 'fixture-trash'
        def moved_then_error(path):
            path.rename(target)
            raise RuntimeError('Finder returned an error after its move')
        with mock.patch.object(library, 'is_running', return_value=False), \
                mock.patch.object(library, 'trash', side_effect=moved_then_error):
            result = project.verify_remote(downloaded, self.scope, prepared['key'], offload=True)
        self.assertTrue(result['verified']); self.assertFalse(result['offloaded'])
        self.assertIn('did not confirm', result['message'])
        self.assertNotIn('Original retained', result['message'])
        self.assertTrue(target.exists())

    def test_existing_restore_destination_is_never_replaced(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        destination = self.home / 'existing'; destination.mkdir(); (destination / 'user').write_text('keep')
        with self.assertRaisesRegex(ValueError, 'already exists'):
            project.restore(downloaded, destination, prepared['manifestSHA256'])
        self.assertEqual((destination / 'user').read_text(), 'keep')

    def test_manifest_digest_mismatch_prevents_extract(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        target = self.home / 'extract'; target.mkdir()
        self.mocks[5].reset_mock()
        with self.assertRaisesRegex(RuntimeError, 'metadata checksum'):
            project.extract_verified(downloaded, target, 'f' * 64)
        self.mocks[5].assert_not_called()

    def test_outer_traversal_member_is_rejected_without_writes(self):
        archive = self.home / 'unsafe.gdpackage'
        with zipfile.ZipFile(archive, 'x') as output:
            output.writestr('../outside', b'bad'); output.writestr('manifest.json', b'{}')
        destination = self.home / 'extract'; destination.mkdir()
        with self.assertRaisesRegex(ValueError, 'unexpected'):
            project.envelope(archive, destination)
        self.assertEqual(list(destination.iterdir()), [])
        self.assertFalse((self.home / 'outside').exists())

    def test_payload_local_header_mismatch_is_rejected_before_ditto(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        with zipfile.ZipFile(downloaded) as outer:
            metadata = json.loads(outer.read('manifest.json'))
            payload = bytearray(outer.read('payload.zip'))
        with zipfile.ZipFile(io.BytesIO(payload)) as inner:
            entry = inner.getinfo(source.name + '/empty file')
            offset = entry.header_offset + 30
            name_length = len(entry.filename.encode('utf-8'))
        payload[offset:offset + name_length] = b'../' + b'x' * (name_length - 3)
        metadata['payloadSHA256'] = hashlib.sha256(payload).hexdigest()
        hostile = self.home / 'local-header-mismatch.gdpackage'
        with zipfile.ZipFile(hostile, 'x') as outer:
            for name, data in [('manifest.json', project.canonical(metadata)), ('payload.zip', payload)]:
                member = zipfile.ZipInfo(name)
                member.external_attr = (stat.S_IFREG | 0o600) << 16
                outer.writestr(member, data)
        destination = self.home / 'extract'; destination.mkdir()
        self.mocks[5].reset_mock()
        with self.assertRaisesRegex(zipfile.BadZipFile, 'differ'):
            project.extract_verified(hostile, destination)
        self.mocks[5].assert_not_called()
        self.assertFalse((destination / 'restore').exists())

    def test_unexpected_preparation_sibling_is_retained(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        sibling = Path(prepared['path']).parent / 'new user data'; sibling.write_bytes(b'keep')
        project.verify_remote(downloaded, self.scope, prepared['key'])
        self.assertEqual(sibling.read_bytes(), b'keep')
        self.assertTrue(Path(prepared['path']).exists())

    def test_original_protected_root_and_shortcut_are_rejected(self):
        source = self.folder(); alias = self.home / 'alias'; alias.symlink_to(source)
        with self.assertRaises(ValueError): project.prepare(alias, self.scope)
        with self.assertRaises(ValueError): project.prepare(self.home, self.scope)

    def test_envelope_never_contains_local_absolute_source_or_guard(self):
        source = self.folder(); prepared, downloaded = self.prepare(source)
        with zipfile.ZipFile(downloaded) as archive:
            self.assertEqual(set(archive.namelist()), {'manifest.json', 'payload.zip'})
            data = archive.read('manifest.json')
        self.assertNotIn(str(self.home).encode(), data)
        self.assertNotIn(b'"guard"', data)
        self.assertEqual(hashlib.sha256(data).hexdigest(), prepared['manifestSHA256'])
        metadata = json.loads(data); self.assertEqual(metadata['name'], source.name)


if __name__ == '__main__': unittest.main()
