#!/usr/bin/env python3
"""Disposable semantic tests. No SSH, production services, keys or user data."""
import sys
sys.dont_write_bytecode = True
import argparse
import ast
import copy
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

ROOT = Path(__file__).parent

def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value

activate = load('gd36_activation_test', 'server-activate-36.py')
snapshot = load('gd36_snapshot_test', 'server-snapshot-36.py')

class QuietHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

class LocalHTTP:
    def __init__(self, handler):
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.url = 'http://127.0.0.1:' + str(self.server.server_port)
    def __enter__(self):
        self.thread.start()
        return self
    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)

class PrivateHTTPTests(unittest.TestCase):
    def test_actual_301_302_303_307_308_never_forward_token(self):
        token = 'fixture-only-not-a-real-credential'
        for status in (301, 302, 303, 307, 308):
            with self.subTest(status=status):
                received = []
                original = []
                class Destination(QuietHandler):
                    def do_GET(self):
                        received.append(self.headers.get('Authorization'))
                        self.send_response(200); self.end_headers()
                    do_POST = do_GET
                with LocalHTTP(Destination) as destination:
                    class Redirect(QuietHandler):
                        def do_POST(self):
                            original.append(self.headers.get('Authorization'))
                            self.send_response(status)
                            self.send_header('Location', destination.url + '/capture')
                            self.end_headers()
                    with LocalHTTP(Redirect) as source:
                        url = source.url + '/private'
                        req = urllib.request.Request(url, data=b'{}', headers={'authorization': 'Bearer ' + token}, method='POST')
                        with self.assertRaises(urllib.error.HTTPError) as error:
                            activate.private_open(req, allowed={url}, timeout=2)
                        with error.exception:
                            self.assertEqual(error.exception.code, status)
                self.assertEqual(original, ['Bearer ' + token])
                self.assertEqual(received, [])

    def test_actual_request_bypasses_hostile_environment_proxy(self):
        captures = []
        class Proxy(QuietHandler):
            def do_GET(self):
                captures.append(self.headers.get('Authorization'))
                self.send_response(502); self.end_headers()
        class Origin(QuietHandler):
            def do_GET(self):
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
        with LocalHTTP(Proxy) as proxy, LocalHTTP(Origin) as origin:
            env = {'http_proxy': proxy.url, 'HTTP_PROXY': proxy.url, 'https_proxy': proxy.url, 'HTTPS_PROXY': proxy.url, 'all_proxy': proxy.url, 'ALL_PROXY': proxy.url, 'no_proxy': '', 'NO_PROXY': ''}
            url = origin.url + '/private'
            req = urllib.request.Request(url, headers={'authorization': 'Bearer fixture-only'})
            with patch.dict(os.environ, env), activate.private_open(req, allowed={url}, timeout=2) as response:
                self.assertEqual(json.loads(response.read()), {'ok': True})
        self.assertEqual(captures, [])

    def test_nonliteral_and_unreviewed_urls_rejected_before_open(self):
        allowed = {'http://127.0.0.1:17778/internal/receiver-entitlements'}
        for url in ('http://localhost:17778/internal/receiver-entitlements', 'http://127.0.0.1:17778/internal/receiver-entitlements?x=1', 'http://user:secret@127.0.0.1:17778/internal/receiver-entitlements', 'http://127.0.0.1:17778/internal/receiver-entitlements#fragment', 'https://127.0.0.1:17778/internal/receiver-entitlements', 'http://127.1:17778/internal/receiver-entitlements', 'http://127.0.0.1:17779/internal/receiver-entitlements'):
            with self.subTest(url=url), patch.object(urllib.request.OpenerDirector, 'open', side_effect=AssertionError('network must not run')) as opened:
                with self.assertRaises(ValueError): activate.private_open(url, allowed=allowed)
                opened.assert_not_called()

class ActivationBlockTests(unittest.TestCase):
    def test_activate_rejects_before_root_files_subprocess_or_network(self):
        args = types.SimpleNamespace(activate=True, plan='/nonexistent', receiver_stage='/nonexistent', control_stage='/nonexistent')
        with patch.object(activate.os, 'geteuid', side_effect=AssertionError('root check must not run')), patch.object(Path, 'read_text', side_effect=AssertionError('no files read')), patch.object(subprocess, 'check_output', side_effect=AssertionError('no subprocess')), patch.object(urllib.request.OpenerDirector, 'open', side_effect=AssertionError('no network')):
            with self.assertRaises(activate.ActivationBlocked): activate.main(args)

    def test_only_readonly_service_subprocess_allowed(self):
        for command in (('systemctl', 'stop', 'gendragoon-control'), ('systemctl', 'start', 'gendragoon-control'), ('systemctl', 'daemon-reload'), ('nft', 'add', 'table'), ('kill', '-TERM', '1')):
            with patch.object(subprocess, 'check_output') as called:
                with self.assertRaises(ValueError): activate.run(*command)
                called.assert_not_called()

    def test_snapshot_changes_never_pass_preservation_check(self):
        before = {'metadata': {'logicalSha256': 'a', 'tables': {'Receiver': 1, 'DevEntry': 1, 'Integration': 1}}, 'payload': {'fileManifestSha256': 'b'}}
        activate.same_data(before, copy.deepcopy(before))
        for key in ('metadata', 'payload'):
            after = copy.deepcopy(before)
            after[key]['logicalSha256' if key == 'metadata' else 'fileManifestSha256'] = 'changed'
            with self.assertRaises(AssertionError): activate.same_data(before, after)

class MetadataTests(unittest.TestCase):
    def read_fixture(self, changes):
        owner = 'a' * 64
        account = {'id': owner, 'owner': owner, 'revision': 7, 'used': 23, 'workspaces': {}, 'library': {}, 'objects': {}, 'reservations': {}}
        account.update(copy.deepcopy(changes))
        receiver = [int(owner[:13], 16), owner, 7, json.dumps(account)]
        team = [1, 'fixture-key', 'fixture-scope', 'team', 0, 1, 0, json.dumps({'value': {'fixture': True}})]
        integration = [1, 1, json.dumps({'fixture': True})]
        fixtures = {'Receiver': [receiver], 'DevEntry': [team], 'Integration': [integration]}
        # Redirect only the production module import. All production NODE scan,
        # pagination, state decoding, binding validation, counters, file creation,
        # serialization and hashing execute unmodified against disposable files.
        bootstrap = r'''
(()=>{const Module=require('node:module'),fs=require('node:fs');
const oldLoad=Module._load,oldStat=fs.lstatSync;
fs.lstatSync=function(p,...a){const s=oldStat.call(this,p,...a);if(p===require('node:path').dirname(process.argv[1]))return new Proxy(s,{get(t,k){return k==='uid'?0:t[k]}});return s;};
const fixtures=JSON.parse(process.env.GD36_TEST_ROWS);
class RedXState{
 address(owner){return Number.parseInt(owner.slice(0,13),16)}
 async call(method,route,body){
  if(method!=='POST'||route!=='bx'||!body.q.startsWith('{Get[]}'))throw Error('only Get allowed');
  const m=body.q.match(/:(Receiver|DevEntry|Integration)\[ID > \$after\] -> \[([^\]]+)\], Sort = ID, Limit = (\d+)$/);
  if(!m)throw Error('unexpected query');
  const columns=m[2].split(', '),rows=fixtures[m[1]].filter(r=>r[0]>body.params.after).slice(0,Number(m[3]));return {columns,rows};
 }
}
Module._load=function(name,...a){if(name==='/usr/local/lib/gendragoon-receiver/current/native/RedXCloud/redx-state.cjs')return {RedXState};return oldLoad.call(this,name,...a);};})();
'''
        with tempfile.TemporaryDirectory(prefix='gd36-metadata-') as temp:
            root = Path(temp); root.chmod(0o700); target = root / 'snapshot.jsonl'
            result = subprocess.run(['node', '-e', bootstrap + snapshot.NODE, str(target)], capture_output=True, text=True, timeout=15, env={**os.environ, 'GD36_TEST_ROWS': json.dumps(fixtures)})
            self.assertEqual(result.returncode, 0, result.stderr)
            value = json.loads(result.stdout)
            raw = target.read_bytes(); rows = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(len(rows), 4)
            self.assertEqual(value['logicalSha256'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(value['tables'], {'Receiver': 1, 'DevEntry': 1, 'Integration': 1})
            self.assertEqual(rows[1]['row'], receiver)
            self.assertEqual(rows[2]['row'], team)
            self.assertEqual(rows[3]['row'], integration)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        return value

    def test_real_three_table_scan_and_valid_quiet_state(self):
        value = self.read_fixture({})
        snapshot.assert_quiet_metadata(value)

    def test_each_durable_inline_and_control_deletion_independently_blocks(self):
        cases = [({'workspaceDeletions': {'a': {}}}, 'durableWorkspaceDeletions'), ({'workspaceDeletions': {'a': None}}, 'durableWorkspaceDeletions'), ({'workspaces': {'a': {'deleting': True}}}, 'deletingWorkspaceFlags'), ({'workspaces': {'a': {'status': 'deleting'}}}, 'deletingWorkspaceStatuses'), ({'control': {'projects': {'a': {'status': 'deleting'}}}}, 'deletingControlProjects'), ({'reservations': {'a': {}}}, 'reservations'), ({'accountDeletion': {'status': 'requested'}}, 'pendingAccountDeletions')]
        for state, key in cases:
            with self.subTest(key=key):
                value = self.read_fixture(state)
                self.assertEqual(value[key], 1)
                with self.assertRaises(AssertionError): snapshot.assert_quiet_metadata(value)

    def test_aggregate_deduplicates_same_workspace_but_counts_distinct(self):
        value = self.read_fixture({'workspaceDeletions': {'a': {}}, 'workspaces': {'a': {'deleting': True, 'status': 'deleting'}, 'b': {'status': 'deleting'}}, 'control': {'projects': {'a': {'status': 'deleting'}, 'c': {'status': 'deleting'}}}})
        self.assertEqual(value['deletingWorkspaces'], 3)
        with self.assertRaises(AssertionError): snapshot.assert_quiet_metadata(value)

    def test_missing_table_coverage_fails(self):
        value = self.read_fixture({}); value['tables'].pop('Integration')
        with self.assertRaises(AssertionError): snapshot.assert_quiet_metadata(value)

class PayloadTests(unittest.TestCase):
    def test_png_sidecar_and_nested_files_preserved_and_mutation_detected(self):
        with tempfile.TemporaryDirectory(prefix='gd36-payload-') as temp:
            root = Path(temp).resolve() / 'data'; backup = Path(temp).resolve() / 'backup'
            root.mkdir(mode=0o700); backup.mkdir(mode=0o700)
            (root / '.writer-lock').mkdir(mode=0o700)
            (root / 'nested').mkdir()
            (root / 'nested' / 'carrier.png').write_bytes(b'\x89PNG\r\n\x1a\nfixture-payload')
            (root / 'nested' / 'sidecar.json').write_bytes(b'{"fixture":true}')
            original = {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()}
            with patch.object(snapshot, 'private_directory', side_effect=lambda p: Path(p)):
                left = snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'before')
                right = snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'after')
                self.assertEqual(left['fileManifestSha256'], right['fileManifestSha256'])
                self.assertEqual((left['files'], left['pngFiles'], left['sidecarFiles']), (2, 1, 1))
                self.assertEqual(original, {str(p.relative_to(root)): p.read_bytes() for p in root.rglob('*') if p.is_file()})
                rows = [json.loads(line) for line in (backup / left['fileManifest']).read_text().splitlines()]
                self.assertEqual({r['path']: r['sha256'] for r in rows}, {p: hashlib.sha256(v).hexdigest() for p, v in original.items()})
                (root / 'nested' / 'sidecar.json').write_bytes(b'{"fixture":false}')
                changed = snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'changed')
                self.assertNotEqual(left['fileManifestSha256'], changed['fileManifestSha256'])

    def test_nonempty_writer_lock_symlink_and_existing_output_refused(self):
        with tempfile.TemporaryDirectory(prefix='gd36-payload-reject-') as temp:
            root = Path(temp).resolve() / 'data'; backup = Path(temp).resolve() / 'backup'
            root.mkdir(); backup.mkdir()
            (root / 'file.png').write_bytes(b'fixture')
            with patch.object(snapshot, 'private_directory', side_effect=lambda p: Path(p)):
                snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'once')
                with self.assertRaises(FileExistsError): snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'once')
                (root / 'linked.png').symlink_to(root / 'file.png')
                with self.assertRaises(AssertionError): snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'linked')
                (root / 'linked.png').unlink()
                (root / '.writer-lock').mkdir(); (root / '.writer-lock' / 'child').write_text('retained')
                with self.assertRaises(AssertionError): snapshot.payload({'REDX_RECEIVERS_ROOT': str(root)}, backup, 'lock')
                self.assertTrue((root / '.writer-lock' / 'child').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
