import contextlib
import io
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parent.parent / 'Resources' / 'gendragoon_updates.py'
spec = importlib.util.spec_from_file_location('gd', SOURCE)
gd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gd)

class UpdaterTests(unittest.TestCase):
    def test_unverified_email_cannot_publish(self):
        with patch.object(gd, 'identity', return_value={'owner': False, 'login': 'imposter', 'message': 'Denied'}):
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()) as capture:
                gd.require_owner()
            self.assertIn('Denied', capture.getvalue())

    def test_owner_is_checked_again_at_publishing_time(self):
        with patch.object(gd, 'identity', return_value={'owner': False, 'login': 'other', 'message': 'Not verified'}):
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
                gd.make_repo()
            with self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
                gd.publish_preview()

    def test_identity_checks_server_verified_flag(self):
        class Result:
            def __init__(self, value): self.stdout = json.dumps(value)
        with patch.object(gd, 'find_gh', return_value='/usr/local/bin/gh'), patch.object(gd, 'cmd', side_effect=[
            Result({'login':'grim'}), Result([{'email':gd.OWNER_EMAIL,'verified':False}])
        ]):
            self.assertFalse(gd.identity()['owner'])
        with patch.object(gd, 'find_gh', return_value='/usr/local/bin/gh'), patch.object(gd, 'cmd', side_effect=[
            Result({'login':'grim'}), Result([{'email':gd.OWNER_EMAIL,'verified':True}])
        ]):
            self.assertTrue(gd.identity()['owner'])

    def test_saves_repo_without_mutating_installed_app(self):
        with tempfile.TemporaryDirectory() as td:
            base = Path(td)
            app_resources = base / 'The App.app' / 'Contents' / 'Resources'
            app_resources.mkdir(parents=True)
            with patch.object(gd, 'SUPPORT', base), patch.object(gd, 'REPO_SETTINGS', base/'release-repo.json'), patch.object(gd, 'APP', base/'The App.app'):
                gd.save_repo('owner/gendragoon-cloud-ssd')
                self.assertEqual(gd.read_repo(), 'owner/gendragoon-cloud-ssd')
                self.assertFalse((app_resources/'release-repo.json').exists())

    def test_latest_sees_prerelease(self):
        manifest = 'https://github.com/o/gendragoon-cloud-ssd/releases/download/v0.2.0/sha256.txt'
        zipurl = 'https://github.com/o/gendragoon-cloud-ssd/releases/download/v0.2.0/GenDragoon-Cloud-SSD-Mac-v0.2.0.zip'
        releases = [dict(tag_name='v0.2.0', draft=False, prerelease=True, assets=[
            dict(name='sha256.txt', browser_download_url=manifest),
            dict(name='GenDragoon-Cloud-SSD-Mac-v0.2.0.zip', browser_download_url=zipurl)])]
        with patch.object(gd, 'read_repo', return_value='o/gendragoon-cloud-ssd'), patch.object(gd, 'request_json', return_value=releases):
            self.assertEqual(gd.latest_release()['tag'], 'v0.2.0')

    def test_download_refuses_incorrect_hash(self):
        with tempfile.TemporaryDirectory() as td:
            with patch.object(gd, 'latest_release', return_value={
                'zip':'GenDragoon-Cloud-SSD-Mac-v0.2.0.zip', 'tag':'v0.2.0',
                'urls':{'sha256.txt':'https://github.com/foo/sha256.txt','GenDragoon-Cloud-SSD-Mac-v0.2.0.zip':'https://github.com/foo/a.zip'}}), \
                 patch.object(gd.Path, 'home', return_value=Path(td)):
                def write_fake(url, path, cap):
                    if path.name == 'sha256.txt':
                        path.write_text(f"{'0'*64}  GenDragoon-Cloud-SSD-Mac-v0.2.0.zip\n")
                    else:
                        path.write_bytes(b'legitimate content but wrong digest')
                with patch.object(gd, 'download_url', side_effect=write_fake), self.assertRaises(SystemExit), contextlib.redirect_stdout(io.StringIO()):
                    gd.download_release()
                self.assertFalse(any((Path(td)/'Downloads'/'GenDragoonUpdates').glob('*.zip')))

if __name__ == '__main__': unittest.main()
