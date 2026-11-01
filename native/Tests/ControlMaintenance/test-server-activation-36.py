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
import shutil
import re
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


ORIGIN_DIGEST = 'f8005e84b912eec2701dd1ab2386c43550f389788499a1584177d31ab23eb895'
DUMMY_KEY = 'public-snapshot-fixture-key'

def node20():
    node = os.environ.get('GD36_NODE20') or shutil.which('node')
    if not node: raise AssertionError('Mandatory Node runtime unavailable')
    return node

def scanner_program(url, io_fault=None):
    # Only deployment binding differs: all protocol/scanner/write logic is actual.
    if snapshot.NODE.count(ORIGIN_DIGEST) != 1:
        raise AssertionError('Expected exactly one immutable production origin binding')
    program = snapshot.NODE.replace(ORIGIN_DIGEST, hashlib.sha256(url.encode()).hexdigest())
    bootstrap = r'''
(()=>{const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const parent=path.dirname(process.argv[1]),oldStat=fs.lstatSync,oldOpen=fs.openSync,oldWrite=fs.writeSync,oldSync=fs.fsyncSync,oldClose=fs.closeSync,oldLoad=Module._load;
fs.lstatSync=function(p,...a){const s=oldStat.call(this,p,...a);if(p===parent)return new Proxy(s,{get(t,k){return k==='uid'?0:t[k]}});return s;};
Module._load=function(name,...a){const bare=name.replace(/^node:/,'');if(!Module.builtinModules.includes(bare))throw Error('No live or external module allowed');return oldLoad.call(this,name,...a);};
let owned,closed=false,first=true;const fault=IO_FAULT;
process.on('exit',()=>{if(owned!==undefined){if(!closed){process.stderr.write('OWNED_FD_NOT_CLOSED');process.exitCode=97;}else process.stderr.write('OWNED_FD_CLOSED');}});
fs.openSync=function(p,...a){const fd=oldOpen.call(this,p,...a);if(p===process.argv[1])owned=fd;return fd;};
fs.writeSync=function(fd,b,offset,length,position){if(fd!==owned)return oldWrite.apply(this,arguments);
 if(fault==='zero')return 0;if(fault==='invalid')return length+1;
 if(fault==='after-prefix'){if(!first)throw Error('owned write fault');first=false;return oldWrite.call(this,fd,b,offset,1,position);}
 return oldWrite.call(this,fd,b,offset,fault==='short'?Math.min(3,length):length,position);
};
fs.fsyncSync=function(fd){if(fd===owned&&fault==='fsync')throw Error('owned sync fault');return oldSync.call(this,fd);};
fs.closeSync=function(fd){const value=oldClose.call(this,fd);if(fd===owned)closed=true;if(fd===owned&&fault==='close')throw Error('owned close fault');return value;};
})();
'''
    return bootstrap.replace('IO_FAULT', json.dumps(io_fault)) + program

class SnapshotHTTP(QuietHandler):
    def do_POST(self):
        case = self.server.case
        try:
            size = int(self.headers.get('Content-Length', '-1'))
            if not 0 <= size <= 4096: raise AssertionError('request body bound')
            body = json.loads(self.rfile.read(size))
            case['requests'].append({'path': self.path, 'authorization': self.headers.get('Authorization'), 'body': body})
            if self.path != '/v1/db/gendragoon_receivers/bx': raise AssertionError('wrong database endpoint')
            if self.headers.get('Authorization') != 'Bearer ' + DUMMY_KEY: raise AssertionError('wrong scoped credential')
            if set(body) != {'q', 'params'} or set(body['params']) != {'after'}: raise AssertionError('unexpected request shape')
            match = re.fullmatch(r'\{Get\[\]\} = "(receivers|dev-teams|integrations)\.red-xai\.db":(Receiver|DevEntry|Integration)\[ID > \$after\] -> \[([^\]]+)\], Sort = ID, Limit = (1|10|2)', body['q'])
            if not match: raise AssertionError('unexpected query')
            table, columns, limit = match[2], match[3].split(', '), int(match[4])
            expected = {'Receiver': ('receivers', ['ID','Owner','Revision','State'], 1), 'DevEntry': ('dev-teams', ['ID','K','Scope','Kind','Position','Revision','ExpiresAtMs','State'], 10), 'Integration': ('integrations', ['ID','Revision','State'], 2)}
            if (match[1], columns, limit) != expected[table]: raise AssertionError('wrong fixed query')
            after = body['params']['after']
            if type(after) is not int or after < -1: raise AssertionError('invalid cursor')
            fault = case.get('fault')
            if fault == 'receiver404' and table == 'Receiver' or fault == 'optional404' and table in ('DevEntry', 'Integration') and after == -1 or fault == 'late404' and table == 'DevEntry' and after >= 0:
                self.send_response(404); self.end_headers(); return
            if fault in ('409', '500'):
                self.send_response(int(fault)); self.end_headers(); return
            if fault == 'redirect':
                self.send_response(case['redirectStatus']); self.send_header('Location', case['destination']); self.end_headers(); return
            rows = copy.deepcopy([r for r in case['rows'][table] if r[0] > after][:limit])
            if fault == 'duplicate' and after >= 0 and table == 'Receiver': rows = copy.deepcopy(case['rows'][table][:1])
            if fault == 'reverse' and table == 'DevEntry': rows.reverse()
            if fault == 'unsafe' and rows: rows[0][0] = 2 ** 53
            if fault == 'state' and rows: rows[0][-1] = 'invalid JSON'
            if fault == 'owner' and rows and table == 'Receiver':
                value = json.loads(rows[0][-1]); value['owner'] = 'b' * 64; rows[0][-1] = json.dumps(value)
            if fault == 'revision' and rows and table == 'Receiver': rows[0][2] += 1
            if fault == 'oversized-page' and table == 'Receiver': rows *= 2
            if fault == 'columns': columns = ['wrong']
            value = {'columns': [] if fault == 'empty-columns' and not rows else columns, 'rows': rows}
            raw = b'x' * (2 * 1024 * 1024 + 1) if fault == 'oversized-body' else json.dumps(value).encode()
            self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(raw) + (30 if fault == 'interrupted' else 0))); self.end_headers()
            self.wfile.write(raw)
            if fault == 'interrupted': self.close_connection = True
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:
            case['violations'].append(type(error).__name__)
            self.send_response(400); self.end_headers()

class ScannerHarness(unittest.TestCase):
    def fixture_rows(self, changes=None, many=False):
        owners = ['1' * 64, '2' * 64, '3' * 64] if many else ['a' * 64]
        receivers = []
        for owner in owners:
            account = {'id': owner, 'owner': owner, 'revision': 7, 'used': 23, 'workspaces': {}, 'library': {}, 'objects': {}, 'reservations': {}}
            account.update(copy.deepcopy(changes or {}))
            receivers.append([int(owner[:13], 16), owner, 7, json.dumps(account)])
        teams = [[n, 'fixture-key', 'fixture-scope', 'team', n, 1, 0, json.dumps({'value': {'fixture': n}})] for n in range(1, 22 if many else 2)]
        integrations = [[n, 1, json.dumps({'fixture': n})] for n in range(1, 6 if many else 2)]
        return {'Receiver': receivers, 'DevEntry': teams, 'Integration': integrations}

    def run_scan(self, rows=None, fault=None, io_fault=None, extra_env=None, redirect_status=302):
        case = {'rows': rows or self.fixture_rows(), 'requests': [], 'violations': [], 'fault': fault, 'redirectStatus': redirect_status}
        received = []
        class Destination(QuietHandler):
            def do_GET(self):
                received.append(self.headers.get('Authorization')); self.send_response(200); self.end_headers()
            do_POST = do_GET
        with LocalHTTP(Destination) as destination, LocalHTTP(SnapshotHTTP) as source:
            source.server.case = case; case['destination'] = destination.url + '/forbidden'
            with tempfile.TemporaryDirectory(prefix='gd36-private-scan-') as temp:
                parent = Path(temp).resolve(); parent.chmod(0o700); target = parent / 'snapshot.jsonl'
                env = {'PATH': os.environ.get('PATH', ''), 'LC_ALL': 'C', 'REDX_URL': source.url, 'REDX_RECEIVERS_KEY': DUMMY_KEY, 'REDX_RECEIVERS_DB': 'gendragoon_receivers', 'REDX_LOCAL_LOOPBACK': '1'}
                env.update(extra_env or {})
                result = subprocess.run([node20(), '-e', scanner_program(source.url, io_fault), str(target)], env=env, capture_output=True, text=True, timeout=20)
                raw = target.read_bytes() if target.exists() else None
                mode = target.stat().st_mode & 0o777 if target.exists() else None
                value = json.loads(result.stdout) if result.returncode == 0 else None
                self.assertEqual(case['violations'], [])
                return types.SimpleNamespace(result=result, raw=raw, mode=mode, value=value, requests=case['requests'], redirected=received)

    def success(self, scan):
        self.assertEqual(scan.result.returncode, 0, scan.result.stderr)
        self.assertEqual(scan.mode, 0o600)
        self.assertIn('OWNED_FD_CLOSED',scan.result.stderr); self.assertNotIn('OWNED_FD_NOT_CLOSED',scan.result.stderr)
        self.assertEqual(scan.value['logicalSha256'], hashlib.sha256(scan.raw).hexdigest())
        return [json.loads(line) for line in scan.raw.splitlines()]

    def refused(self, scan):
        self.assertNotEqual(scan.result.returncode, 0)
        self.assertEqual(scan.result.stdout, '')
        if scan.raw is not None:
            self.assertEqual(scan.mode, 0o600)
            self.assertIn('OWNED_FD_CLOSED',scan.result.stderr); self.assertNotIn('OWNED_FD_NOT_CLOSED',scan.result.stderr)

class MetadataTests(ScannerHarness):
    def read_fixture(self, changes):
        fixtures = self.fixture_rows(changes)
        scan = self.run_scan(fixtures); rows = self.success(scan)
        self.assertEqual(rows[0], {'schema': 1, 'format': 'gendragoon-private-logical-snapshot/v1'})
        self.assertEqual(len(rows), 4)
        self.assertEqual(scan.value['tables'], {'Receiver': 1, 'DevEntry': 1, 'Integration': 1})
        for index, table in enumerate(('Receiver', 'DevEntry', 'Integration'), 1):
            self.assertEqual(rows[index]['row'], fixtures[table][0])
        return scan.value

    def test_real_three_table_scan_and_valid_quiet_state(self):
        snapshot.assert_quiet_metadata(self.read_fixture({}))

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

    def test_multiple_full_and_short_pages_preserve_all_raw_rows(self):
        fixtures = self.fixture_rows(many=True)
        for fault in (None, 'empty-columns'):
            with self.subTest(empty_form=fault):
                scan = self.run_scan(fixtures, fault); rows = self.success(scan)
                self.assertEqual(scan.value['tables'], {'Receiver': 3, 'DevEntry': 21, 'Integration': 5})
                for table in fixtures:
                    self.assertEqual([r['row'] for r in rows[1:] if r['table'] == table], fixtures[table])
                self.assertGreaterEqual(len(scan.requests), 12)

    def test_optional_initial404_accepted_but_post_data_and_receiver404_refuse(self):
        scan = self.run_scan(fault='optional404'); self.success(scan)
        self.assertEqual(scan.value['tables'], {'Receiver': 1, 'DevEntry': 0, 'Integration': 0})
        for fault in ('receiver404', 'late404'):
            with self.subTest(fault=fault): self.refused(self.run_scan(self.fixture_rows(many=True), fault))
        # A late404 is a conservative backup hold, not proof of real DB EOF semantics.

    def test_bad_transport_shape_order_and_account_binding_refuse(self):
        for fault in ('409','500','columns','duplicate','reverse','unsafe','state','owner','revision','oversized-page','oversized-body','interrupted'):
            with self.subTest(fault=fault): self.refused(self.run_scan(self.fixture_rows(many=True), fault))

    def test_wrong_scope_refuses_before_output_or_request(self):
        for env in ({'REDX_URL':'http://127.0.0.1:1'},{'REDX_RECEIVERS_DB':'foreign'},{'REDX_LOCAL_LOOPBACK':'0'},{'REDX_RECEIVERS_KEY':''}):
            with self.subTest(keys=sorted(env)):
                scan = self.run_scan(extra_env=env); self.refused(scan)
                self.assertEqual(scan.requests, []); self.assertIsNone(scan.raw)

    def test_actual_node_redirects_never_forward_scoped_key(self):
        for status in (301,302,303,307,308):
            with self.subTest(status=status):
                scan = self.run_scan(fault='redirect', redirect_status=status); self.refused(scan)
                self.assertEqual(len(scan.requests), 1); self.assertEqual(scan.redirected, [])

    def test_partial_writes_complete_and_failed_writes_never_claim_success(self):
        normal = self.run_scan(); short = self.run_scan(io_fault='short')
        self.success(normal); self.success(short); self.assertEqual(normal.raw, short.raw)
        for fault in ('zero','invalid','after-prefix','fsync','close'):
            with self.subTest(fault=fault):
                scan = self.run_scan(io_fault=fault); self.refused(scan); self.assertIsNotNone(scan.raw)

    def test_exact_protocol_refuses_arbitrary_calls_before_fetch(self):
        prefix = snapshot.NODE.split('(async()=>{', 1)[0]
        script = prefix + r'''
(async()=>{let calls=0;const store=new RedXState({url:'http://127.0.0.1:1',key:'public',db:'gendragoon_receivers',local:true,fetchImpl:async()=>{calls++;throw Error('unreviewed request');}});
const q='{Get[]} = "receivers.red-xai.db":Receiver[ID > $after] -> [ID, Owner, Revision, State], Sort = ID, Limit = 1';
const bad=[['GET','bx',{q,params:{after:-1}}],['POST','other',{q,params:{after:-1}}],['POST','bx',{q:'{Delete[]} = "receivers.red-xai.db":Receiver[]',params:{after:-1}}],['POST','bx',{q,params:{after:-2}}],['POST','bx',{q,params:{after:1.5}}],['POST','bx',{q,params:{after:9007199254740992}}],['POST','bx',{q,params:{after:-1,extra:true}}],['POST','bx',{q,params:{after:-1},extra:true}]];
let rejected=0;for(const args of bad){try{await store.call(...args);}catch{rejected++;}}if(rejected!==bad.length||calls!==0)throw Error('protocol scope escaped');console.log(JSON.stringify({rejected,calls}));})().catch(()=>process.exitCode=1);
'''
        result = subprocess.run([node20(), '-e', script], capture_output=True, text=True, timeout=10, env={'PATH': os.environ.get('PATH',''), 'LC_ALL':'C'})
        self.assertEqual(result.returncode, 0, result.stderr); self.assertEqual(json.loads(result.stdout), {'rejected':8,'calls':0})

    def metadata_wrapper(self, fault=None):
        case = {'rows': self.fixture_rows(), 'requests': [], 'violations': [], 'fault': None}
        proxy_captures = []
        class Proxy(QuietHandler):
            def do_GET(self):
                proxy_captures.append(self.headers.get('Authorization')); self.send_response(502); self.end_headers()
            do_POST = do_GET
        with LocalHTTP(Proxy) as proxy, LocalHTTP(SnapshotHTTP) as source, tempfile.TemporaryDirectory(prefix='gd36-readback-') as raw:
            source.server.case = case; directory = Path(raw).resolve(); directory.chmod(0o700)
            program = scanner_program(source.url); actual_run = subprocess.run
            env = {'REDX_URL':source.url,'REDX_RECEIVERS_KEY':DUMMY_KEY,'REDX_RECEIVERS_DB':'gendragoon_receivers','REDX_LOCAL_LOOPBACK':'1','NODE_OPTIONS':'--require=/UNTRUSTED','NODE_PATH':'/UNTRUSTED','HTTP_PROXY':proxy.url,'http_proxy':proxy.url,'HTTPS_PROXY':proxy.url,'ALL_PROXY':proxy.url,'NO_PROXY':'','OTHER_SECRET':'public-never-forwarded'}
            observed = []
            def owned_directory(path):
                self.assertEqual(Path(path), directory)
                self.assertEqual(directory.resolve(), directory)
                self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
                return directory
            def real_child(args, **kwargs):
                self.assertEqual(args[:2], ['/usr/bin/node', '-e'])
                self.assertNotIn(DUMMY_KEY, repr(args))
                self.assertEqual(set(kwargs['env']), {'PATH','LC_ALL','REDX_URL','REDX_RECEIVERS_KEY','REDX_RECEIVERS_DB','REDX_LOCAL_LOOPBACK'})
                observed.append(kwargs['env'])
                result = actual_run([node20(), *args[1:]], **kwargs)
                target = Path(args[-1])
                if result.returncode == 0:
                    if fault == 'hash': target.write_bytes(b'public changed owned bytes')
                    if fault == 'mode': target.chmod(0o644)
                    if fault == 'link': os.link(target, directory / 'owned-hardlink')
                    if fault == 'summary': return subprocess.CompletedProcess(args,0,json.dumps({'logicalSha256':'0'*64}),'')
                return result
            original_env = dict(env)
            with patch.object(snapshot,'NODE',program), patch.object(snapshot,'private_directory',side_effect=owned_directory), patch.object(snapshot.subprocess,'run',side_effect=real_child):
                if fault in ('hash','mode','link','summary'):
                    with self.assertRaises(AssertionError): snapshot.metadata(env,directory,'owned')
                elif fault == 'identity':
                    real_open = snapshot.os.open
                    target = directory/'owned-metadata.jsonl'
                    def swapped_open(name, flags, *args, **kwargs):
                        fd = real_open(name, flags, *args, **kwargs)
                        if name == target:
                            replacement = directory/'owned-replacement'
                            replacement.write_bytes(target.read_bytes()); replacement.chmod(0o600)
                            os.replace(replacement,target)
                        return fd
                    with patch.object(snapshot.os,'open',side_effect=swapped_open), self.assertRaises(AssertionError):
                        snapshot.metadata(env,directory,'owned')
                elif fault == 'directory-fsync':
                    with patch.object(snapshot.os,'fsync',side_effect=OSError('owned fsync failure')), self.assertRaises(OSError): snapshot.metadata(env,directory,'owned')
                else:
                    value = snapshot.metadata(env,directory,'owned')
                    self.assertEqual(value['logicalSha256'],hashlib.sha256((directory/value['metadataFile']).read_bytes()).hexdigest())
                self.assertEqual(env,original_env); self.assertEqual(len(observed),1); self.assertEqual(case['violations'],[]); self.assertEqual(proxy_captures,[])
                self.assertTrue((directory/'owned-metadata.jsonl').exists())

    def test_python_metadata_sanitizes_child_and_verifies_actual_private_bytes(self):
        self.metadata_wrapper()

    def test_python_readback_refuses_modified_bytes_mode_links_or_summary(self):
        for fault in ('hash','mode','link','summary','identity','directory-fsync'):
            with self.subTest(fault=fault): self.metadata_wrapper(fault)

    def test_metadata_prefix_refuses_before_files_or_child(self):
        with patch.object(snapshot,'private_directory') as directory, patch.object(snapshot.subprocess,'run') as child:
            for prefix in ('../outside','a/b','', 'a'*73):
                with self.subTest(prefix=prefix), self.assertRaises(AssertionError): snapshot.metadata({},'/unopened',prefix)
            directory.assert_not_called(); child.assert_not_called()

    def test_controller_pin_tracks_the_exact_snapshot_helper(self):
        controller = load('gd36_snapshot_controller_pin', 'adapter/server-activation-controller-36.py')
        self.assertEqual(controller.HELPER_HASHES['server-snapshot-36.py'],hashlib.sha256((ROOT/'server-snapshot-36.py').read_bytes()).hexdigest())


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
