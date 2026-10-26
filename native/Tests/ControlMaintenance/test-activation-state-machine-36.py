#!/usr/bin/env python3
"""Disposable controller fault injection. Never constructs the live backend."""
import sys
sys.dont_write_bytecode = True
import argparse
import copy
import importlib.util
import json
import hashlib
import io
import os
from pathlib import Path
import select
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location('gd36_controller_test', ROOT/'adapter/server-activation-controller-36.py')
C = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = C
SPEC.loader.exec_module(C)

def approved_mac_proof():
    return dict(source='native-mac-preflight',challenge='disposable-fresh-challenge',observedAtEpoch=time.time(),screenUnlocked=True,uploadWorkspaceTerminal=True,appControlIdle=True,nativeAppClosedVerified=True,maintenanceLeaseHeld=True)

# Separate product invariants, not a list copied from the controller's phases.
class DisposableServices:
    def __init__(self, fail=None, changed_snapshot=None):
        self.fail = fail
        self.changed_snapshot = changed_snapshot
        self.events = []
        self.guard = self.service_gate = False
        self.inspector = None
        self.fenced = set()
        self.drained = set()
        self.running = {'control', 'receiver'}
        self.candidate = set()
        self.writer_lock = True
        self.old_control_pending = ['active-account-A', 'queued-account-A']
        self.receiver_original_pending = ['pre-identity-receiver']
        self.receiver_stage_one = self.receiver_early_drained = self.receiver_sealed = False
        self.receiver_gate_identity = object()
        self.receiver_connections = 0
        self.decoder_children = 2
        self.originals_retained = False
        self.logical = 'all-three-tables-v1'
        self.payload = 'every-png-and-sidecar-v1'
        self.baseline = None
        self.full_payload_backup = False
        self.stopped_preserved = self.after_start_preserved = False
        self.healthy = False
        self.force_calls = self.lock_removals = self.restores = 0

    def record(self, event):
        self.events.append(event)
        if event == self.fail:
            raise C.Hold('disposable_injected_failure')

    def preflight(self): self.record('preflight')

    def install_guard(self):
        self.record('guard')
        self.guard = True

    def enable(self, kind):
        self.record('enable-' + kind)
        assert self.guard and self.inspector is None
        if kind == 'receiver':
            if self.receiver_stage_one:
                assert 'control' in self.drained and self.service_gate
            else:
                assert 'control' not in self.fenced and not self.service_gate
        self.inspector = kind

    def install_receiver_stage_one(self):
        self.record('receiver-stage-one')
        assert self.inspector == 'receiver' and 'control' not in self.fenced
        self.receiver_stage_one = True
        self.fenced.add('receiver')

    def drain_receiver_stage_one(self):
        self.record('receiver-early-drain')
        assert self.receiver_stage_one and 'control' not in self.fenced
        while self.receiver_original_pending:
            self.events.append('complete-' + self.receiver_original_pending.pop(0))
        self.decoder_children = 0
        self.receiver_early_drained = True

    def resume_receiver_stage_one(self):
        self.record('receiver-same-gate')
        assert self.receiver_stage_one and self.receiver_early_drained
        assert 'control' in self.drained and self.inspector == 'receiver'
        return self.receiver_gate_identity

    def seal_receiver(self):
        self.record('receiver-seal')
        assert self.receiver_early_drained and 'control' in self.drained
        assert not self.old_control_pending and not self.receiver_connections
        self.receiver_sealed = True

    def install(self, kind):
        self.record('fence-' + kind)
        assert self.inspector == kind
        assert kind == 'control' and self.receiver_early_drained
        self.fenced.add(kind)

    def drain(self, kind):
        self.record('drain-' + kind)
        assert kind in self.fenced
        if kind == 'control':
            # Already admitted Control work must be able to reach Receiver.
            assert not self.service_gate and 'receiver' in self.running
            assert self.receiver_stage_one and not self.receiver_sealed
            while self.old_control_pending:
                self.events.append('complete-' + self.old_control_pending.pop(0))
                self.receiver_connections += 1
                self.events.append('complete-restricted-receiver-dependency')
                self.receiver_connections -= 1
        else:
            assert self.service_gate and self.writer_lock and self.receiver_sealed
            self.decoder_children = 0
        self.drained.add(kind)
        return {'kind': kind, 'ready': True}

    def close_inspector(self, kind):
        self.record('close-' + kind)
        assert self.inspector == kind and (kind in self.drained or kind=='receiver' and self.receiver_early_drained)
        self.inspector = None

    def service_fence(self, proof):
        self.record('service-gate')
        assert proof == {'kind': 'control', 'ready': True}
        assert 'control' in self.drained and not self.old_control_pending
        assert self.inspector is None
        self.service_gate = True

    def snapshot(self, label):
        self.record('snapshot-' + label)
        assert self.drained == {'control', 'receiver'}
        assert self.inspector is None and self.service_gate
        value = {'metadata': self.logical, 'payload': self.payload, 'label': label}
        if label == self.changed_snapshot:
            value['metadata'] = 'externally-changed-metadata'
        if label == 'drained': self.baseline = copy.deepcopy(value)
        return value

    def backup_payload(self, before):
        self.record('full-payload-backup')
        assert before == self.baseline
        self.full_payload_backup = True

    def configure(self):
        self.record('config')
        assert self.full_payload_backup
        assert self.baseline and self.drained == {'control', 'receiver'}
        assert self.writer_lock and not self.decoder_children
        self.originals_retained = True

    def stop(self, kind):
        self.record('stop-' + kind)
        assert kind in self.drained and self.originals_retained
        assert not self.decoder_children and not self.old_control_pending
        self.running.remove(kind)
        if kind == 'receiver':
            # Models only the service's own proven graceful close, never rmdir.
            self.writer_lock = False

    def compare(self, before, after):
        self.record('compare-' + after['label'])
        assert before['metadata'] == after['metadata']
        assert before['payload'] == after['payload']
        if after['label'] == 'stopped': self.stopped_preserved = True
        if after['label'] == 'after-start': self.after_start_preserved = True

    def switch(self):
        self.record('switch')
        assert self.stopped_preserved and not self.running
        assert not self.writer_lock and self.originals_retained

    def start(self, kind):
        self.record('start-' + kind)
        assert self.stopped_preserved and self.service_gate
        if kind == 'receiver': assert 'control' in self.candidate
        self.running.add(kind)
        self.candidate.add(kind)
        if kind == 'receiver': self.writer_lock = True

    def private_health(self):
        self.record('health')
        assert self.candidate == {'control', 'receiver'} and self.service_gate
        self.healthy = True

    def release_services(self):
        self.record('release-services')
        assert self.healthy and self.after_start_preserved and self.inspector is None
        self.service_gate = False

    def service_probe(self):
        self.record('service-probe')
        assert self.healthy and not self.service_gate

    def cleanup(self):
        self.record('cleanup')
        assert self.healthy and self.after_start_preserved and not self.service_gate
        assert self.inspector is None
        self.guard = False


class ControllerTests(unittest.TestCase):
    def run_model(self, ops, gate=lambda: None):
        journal = []
        result = C.Controller(ops, gate, journal.append).run()
        self.assertEqual((ops.force_calls, ops.lock_removals, ops.restores), (0, 0, 0))
        return result, journal

    def test_dependency_drain_preservation_and_new_process_order(self):
        ops = DisposableServices()
        result, journal = self.run_model(ops)
        self.assertEqual(result['decision'], 'COMPLETE')
        self.assertEqual(ops.candidate, {'control', 'receiver'})
        self.assertFalse(ops.guard or ops.service_gate)
        self.assertEqual(ops.fenced, {'control', 'receiver'})  # Old admission stays fenced.
        self.assertTrue(ops.originals_retained)
        self.assertLess(ops.events.index('complete-queued-account-A'), ops.events.index('service-gate'))
        self.assertLess(ops.events.index('complete-pre-identity-receiver'), ops.events.index('fence-control'))
        self.assertLess(ops.events.index('receiver-early-drain'), ops.events.index('close-receiver'))
        self.assertLess(ops.events.index('close-control'), len(ops.events)-1-ops.events[::-1].index('enable-receiver'))
        self.assertLess(ops.events.index('complete-restricted-receiver-dependency'), ops.events.index('receiver-seal'))
        self.assertEqual(journal[-1]['decision'], 'COMPLETE')

    def test_every_observed_backend_failure_stops_before_any_later_operation(self):
        baseline = DisposableServices()
        self.run_model(baseline)
        # Completion telemetry is not a backend operation.
        events = [v for v in baseline.events if not v.startswith('complete-')]
        for event in events:
            with self.subTest(event=event):
                ops = DisposableServices(fail=event)
                result, journal = self.run_model(ops)
                self.assertFalse(result['activationComplete'])
                self.assertEqual(ops.events[-1], event)
                self.assertEqual(result['decision'], 'NO_GO' if event == 'preflight' else 'HOLD')
                self.assertEqual(journal[-1]['decision'], result['decision'])
                if 'guard' in ops.events and event != 'guard':
                    self.assertTrue(ops.guard)
                if 'service-gate' in ops.events and event not in ('service-gate', 'service-probe', 'cleanup'):
                    self.assertTrue(ops.service_gate)
                if event not in ('release-services', 'service-probe', 'cleanup'):
                    self.assertNotIn('release-services', ops.events)
                    self.assertFalse(result['publicAdmissionMayBeOpen'])
                else:
                    self.assertTrue(result['publicAdmissionMayBeOpen'])
                    self.assertTrue(result['candidateMayBeRunning'])
                    self.assertIsNone(result['activated'])

    def test_each_phase_requires_a_new_mac_challenge_before_its_operation(self):
        baseline = DisposableServices()
        _, records = self.run_model(baseline)
        phase_count = sum(v.get('state') == 'before' for v in records)
        for stop_at in range(phase_count):
            calls = []
            def gate():
                calls.append(len(calls))
                if len(calls) == stop_at + 1:
                    raise C.Hold('mac_opened_or_coordinator_lost')
            ops = DisposableServices()
            result, records = self.run_model(ops, gate)
            self.assertFalse(result['activationComplete'])
            self.assertEqual(len(calls), stop_at + 1)
            self.assertEqual(sum(v.get('state') == 'complete' for v in records), stop_at)
            self.assertNotIn('cleanup', ops.events)

    def test_early_receiver_failure_never_fences_control_or_seals_dependencies(self):
        for event in ('receiver-stage-one', 'receiver-early-drain', 'close-receiver'):
            with self.subTest(event=event):
                ops = DisposableServices(fail=event)
                result, _ = self.run_model(ops)
                self.assertEqual(result['decision'], 'HOLD')
                self.assertNotIn('fence-control', ops.events)
                self.assertNotIn('receiver-seal', ops.events)
                self.assertNotIn('snapshot-drained', ops.events)
                self.assertFalse(ops.receiver_sealed)

    def test_resume_or_seal_failure_retains_old_gate_and_prevents_snapshot(self):
        for event in ('receiver-same-gate', 'receiver-seal'):
            with self.subTest(event=event):
                ops = DisposableServices(fail=event)
                gate = ops.receiver_gate_identity
                result, _ = self.run_model(ops)
                self.assertEqual(result['decision'], 'HOLD')
                self.assertIs(ops.receiver_gate_identity, gate)
                self.assertTrue(ops.receiver_stage_one and ops.receiver_early_drained)
                self.assertIn('control', ops.drained)
                self.assertTrue(ops.service_gate and ops.guard and ops.writer_lock)
                self.assertNotIn('snapshot-drained', ops.events)
                self.assertNotIn('config', ops.events)

    def test_changed_data_at_either_preservation_boundary_retains_admission(self):
        for label in ('stopped', 'after-start'):
            ops = DisposableServices(changed_snapshot=label)
            result, _ = self.run_model(ops)
            self.assertEqual(result['decision'], 'HOLD')
            self.assertTrue(ops.service_gate and ops.guard)
            self.assertNotIn('release-services', ops.events)
            if label == 'stopped': self.assertNotIn('switch', ops.events)

    def test_stale_wrong_challenge_and_each_protected_mac_state_fail_closed(self):
        good = dict(source='native-mac-preflight', challenge='fresh-unique', observedAtEpoch=100,
                    screenUnlocked=True, uploadWorkspaceTerminal=True, appControlIdle=True,
                    nativeAppClosedVerified=True, maintenanceLeaseHeld=True)
        self.assertTrue(C.validate_mac_proof(good, 'fresh-unique', now=105))
        for field in ('screenUnlocked', 'uploadWorkspaceTerminal', 'appControlIdle', 'nativeAppClosedVerified', 'maintenanceLeaseHeld'):
            value = dict(good, **{field: False})
            with self.subTest(field=field), self.assertRaises(C.Hold):
                C.validate_mac_proof(value, 'fresh-unique', now=105)
        for value in (dict(good, challenge='replay'), dict(good, observedAtEpoch=89), dict(good, observedAtEpoch=106)):
            with self.assertRaises(C.Hold): C.validate_mac_proof(value, 'fresh-unique', now=105)

    def test_unreviewed_bundle_cannot_import_the_mutation_backend(self):
        with patch.object(C, 'module') as load, patch.object(C.sys, 'platform', 'linux'), patch.object(C.os, 'geteuid', return_value=0):
            with self.assertRaises(C.Hold): C.LiveOps({}, {'reviewedForExecution': True}, mac_gate=lambda:None)
            load.assert_not_called()

    def test_optimized_controller_refuses_before_backend_or_assertion_helper_import(self):
        with patch.object(C.sys,'flags',SimpleNamespace(optimize=1)), patch.object(C,'module') as imported:
            with self.assertRaisesRegex(C.Hold,'optimized_python_forbidden'):C.LiveOps({}, {}, mac_gate=lambda:None)
            imported.assert_not_called()

    def test_real_disposable_private_file_rejects_link_and_permissions(self):
        with tempfile.TemporaryDirectory(prefix='gd36-controller-') as raw:
            root = Path(raw).resolve()
            file = root/'private'; file.write_bytes(b'fixture-secret'); file.chmod(0o600)
            self.assertEqual(C.private_file(file, os.getuid()).st_size, 14)
            file.chmod(0o644)
            with self.assertRaises(C.Hold): C.private_file(file, os.getuid())
            file.chmod(0o600)
            link = root/'link'; link.symlink_to(file)
            with self.assertRaises(C.Hold): C.private_file(link, os.getuid())
            os.link(file, root/'hardlink')
            with self.assertRaises(C.Hold): C.private_file(file, os.getuid())

    def test_actual_atomic_replacement_keeps_private_bytes_and_rejects_symlink(self):
        ops = object.__new__(C.LiveOps);ops.mutation_proof=approved_mac_proof()
        with tempfile.TemporaryDirectory(prefix='gd36-atomic-') as raw:
            root = Path(raw); target = root/'owned'
            def only_disposable_directory(path):
                self.assertEqual(Path(path), root)
            with patch.object(C, 'trusted_directory', side_effect=only_disposable_directory), patch.object(C.os, 'chown'):
                ops.atomic(target, b'fixture-first')
                ops.atomic(target, b'fixture-second')
                self.assertEqual(target.read_bytes(), b'fixture-second')
                self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
                link = root/'link'; link.symlink_to(target)
                with self.assertRaises(C.Hold): ops.atomic(link, b'forbidden')
                self.assertEqual(target.read_bytes(), b'fixture-second')
                self.assertEqual(sorted(v.name for v in root.iterdir()), ['link', 'owned'])

    def test_service_identity_probe_streams_trusted_bytes_without_private_path_or_token_argv(self):
        ops = object.__new__(C.LiveOps); ops.token = 'DISPOSABLE_TOKEN_NEVER_ARGV'; ops.old_env = {'REDXAI_ISSUER':'https://fixture.invalid'}
        with tempfile.TemporaryDirectory(prefix='gd36-probe-') as raw:
            adapter = Path(raw)/'adapter'; adapter.mkdir()
            helper = adapter.parent/'server-activate-36.py'
            helper.write_text('def verify_internal_boundary(token,issuer):\n assert token == "DISPOSABLE_TOKEN_NEVER_ARGV" and issuer == "https://fixture.invalid"\n')
            actual_run = subprocess.run
            def disposable_subprocess(argv, **kwargs):
                self.assertEqual(argv[:5], ['/usr/sbin/runuser', '-u', 'redxai', '--', '/usr/bin/python3'])
                self.assertNotIn(ops.token, repr(argv)); self.assertNotIn(str(helper), repr(argv))
                self.assertEqual(argv[5:8], ['-I', '-S', '-B'])
                self.assertEqual(kwargs['env'], {'PATH':'/usr/bin:/bin','LC_ALL':'C','PYTHONDONTWRITEBYTECODE':'1'})
                return actual_run([sys.executable, *argv[5:]], **kwargs)
            with patch.object(C, 'HERE', adapter), patch.dict(C.HELPER_HASHES, {helper.name:C.sha(helper)}), patch.object(C, 'private_file'), patch.object(C.subprocess, 'run', side_effect=disposable_subprocess):
                ops.service_probe()

    def test_default_cli_has_no_execution_capability_enabled(self):
        result = subprocess.run([sys.executable, str(ROOT/'adapter/server-activation-controller-36.py')], capture_output=True, text=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)['decision'], 'NO_GO')
        self.assertTrue(json.loads(result.stdout)['noLiveActionsPerformed'])
        self.assertEqual(result.stderr, '')

    def test_absent_plan_execute_fails_before_backend_construction(self):
        result = subprocess.run([sys.executable, str(ROOT/'adapter/server-activation-controller-36.py'), '--execute'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 3)
        self.assertEqual(json.loads(result.stdout)['decision'], 'NO_GO')
        self.assertEqual(result.stderr, '')

class ReceiverBarrierTests(unittest.TestCase):
    def status(self, *, final=False):
        value = dict(role='receiver', pid=4242, stage='sealed' if final else 'dependency-open',
                     sameGateVerified=True, installationCount=1, ordinaryAdmissionFenced=True,
                     workAdmissionFenced=True, installedFromSetImmediate=True, listenerStillFenced=True,
                     dependencyAdmissionOpen=not final, dependencyAdmissionSealed=final,
                     closeError=False, closed=final, earlyReady=True, ready=final,
                     originalRequestsBound=0)
        value.update({key:0 for key in (*C.RECEIVER_ORIGINAL_COUNTERS, *C.RECEIVER_GATE_COUNTERS)})
        return value

    def proof(self):
        return C.receiver_barrier(self.status(), 'a'*32, 4242, 91)

    def ops(self):
        ops = object.__new__(C.LiveOps)
        ops.nonce = 'a'*32
        ops.receiver_stage_one_proof = self.proof()
        ops.receiver_resume_verified = False
        ops.plan = {'expectedPIDs':{'receiver':4242}, 'expectedStartTicks':{'receiver':91}}
        ops.identity = lambda role:(4242, 91, {})
        ops.service_listeners = lambda role,pid:True
        ops.verify_session = lambda role:True
        ops.clients = {'receiver':SimpleNamespace(call=lambda op:self.status())}
        return ops

    def test_typed_early_barrier_proves_original_drain_without_cancelling_owned_dependencies(self):
        value = self.status()
        value.update(activeContinuations=1, authenticatingDependencies=1, pendingResponses=1, queuedDependencies=2)
        proof = C.receiver_barrier(value, 'a'*32, 4242, 91)
        self.assertIs(type(proof), C.ReceiverBarrierProof)
        self.assertEqual(proof.operation_nonce, 'a'*32)
        self.assertEqual(proof.source_sha256, C.SOURCE_HASHES['receiver'])
        self.assertEqual(dict(proof.gate_counters)['queuedDependencies'], 2)
        for field in C.RECEIVER_ORIGINAL_COUNTERS:
            with self.subTest(field=field), self.assertRaises(C.Hold):
                C.receiver_barrier(dict(value, **{field:1}), 'a'*32, 4242, 91)

    def test_untyped_counters_capacity_wrong_stage_and_replaced_gate_are_refused(self):
        bad = [dict(self.status(), sameGateVerified=False), dict(self.status(), installationCount=True),
               dict(self.status(), pid=4242.0), dict(self.status(), requests=1, originalRequestsBound=0),
               dict(self.status(), dependencyAdmissionOpen=False), dict(self.status(), stage='sealed'),
               dict(self.status(), originalRequestsBound=1, activeContinuations=128),
               dict(self.status(), queuedDependencies=129)]
        for key in (*C.RECEIVER_ORIGINAL_COUNTERS, *C.RECEIVER_GATE_COUNTERS, 'originalRequestsBound'):
            bad.extend(dict(self.status(), **{key:v}) for v in (True, -1, 0.0, None))
        for value in bad:
            with self.subTest(value=value), self.assertRaises(C.Hold):
                C.receiver_status(value, 4242, stage='dependency-open')

    def test_final_barrier_requires_real_close_and_every_owned_finally_counter_zero(self):
        value = self.status(final=True)
        self.assertEqual(C.receiver_barrier(value, 'a'*32, 4242, 91, final=True).stage, 'sealed')
        bad = [dict(value, closed=False), dict(value, ready=False)]
        bad.extend(dict(value, **{key:1}) for key in C.RECEIVER_GATE_COUNTERS)
        for candidate in bad:
            with self.subTest(candidate=candidate), self.assertRaises(C.Hold):
                C.receiver_barrier(candidate, 'a'*32, 4242, 91, final=True)

    def test_control_fence_requires_receiver_barrier_from_same_original_process(self):
        ops = self.ops()
        calls = []
        ops.clients['control'] = SimpleNamespace(call=lambda op:calls.append(op))
        ops.identity = lambda role:(4243, 92, {})
        with self.assertRaisesRegex(C.Hold, 'receiver_stage_one_process_changed'):
            ops.install('control')
        self.assertEqual(calls, [])
        ops.receiver_stage_one_proof = dict(stage='dependency-open')
        with self.assertRaisesRegex(C.Hold, 'receiver_stage_one_proof_required'):
            ops.install('control')
        self.assertEqual(calls, [])

    def test_reattach_accepts_pending_owned_auth_but_rejects_counter_or_gate_reset(self):
        ops = self.ops()
        value = dict(self.status(), activeContinuations=1, authenticatingDependencies=1, pendingResponses=1)
        ops.clients['receiver'].call = lambda op:value
        self.assertIs(ops.resume_receiver_stage_one(), value)
        self.assertTrue(ops.receiver_resume_verified)
        for change in ({'sameGateVerified':False}, {'installationCount':2}, {'requests':1}, {'originalRequestsBound':1}):
            with self.subTest(change=change):
                ops.receiver_resume_verified = False
                ops.clients['receiver'].call = lambda op:dict(value, **change)
                with self.assertRaises(C.Hold): ops.resume_receiver_stage_one()
                self.assertFalse(ops.receiver_resume_verified)

    def test_final_seal_cannot_precede_verified_control_drain_and_same_gate_resume(self):
        ops = self.ops()
        calls = []
        ops.clients['receiver'].call = lambda op:calls.append(op)
        ops.boundary = SimpleNamespace(phase='services')
        ops.status = {'control':{'ready':True}}
        with self.assertRaisesRegex(C.Hold, 'control_dependencies_not_drained'): ops.seal_receiver()
        ops.receiver_resume_verified = True
        ops.status['control']['ready'] = False
        with self.assertRaisesRegex(C.Hold, 'control_dependencies_not_drained'): ops.seal_receiver()
        self.assertEqual(calls, [])


class FullPayloadBackupTests(unittest.TestCase):
    def make_fixture(self, root):
        source=root/'source'; source.mkdir(); backup=root/'backup'; backup.mkdir(mode=0o700)
        files={'notes/one.png':b'PNG DISPOSABLE BYTES', 'notes/one.json':b'{"fixture":true}', 'other.bin':bytes(range(256))}
        rows=[]
        for name,data in files.items():
            path=source/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
            rows.append({'path':name,'bytes':len(data),'sha256':C.sha(path)})
        manifest=backup/'drained-files.jsonl';manifest.write_text(''.join(json.dumps(v,separators=(',',':'))+'\n' for v in rows));manifest.chmod(0o600)
        baseline={'payload':{'files':len(rows),'bytes':sum(v['bytes'] for v in rows),'fileManifest':manifest.name,'fileManifestSha256':C.sha(manifest)}}
        return source,backup,baseline,files

    def test_actual_complete_copies_survive_source_change_and_reopen_independently(self):
        with tempfile.TemporaryDirectory(prefix='gd36-payload-copy-') as raw:
            source,backup,baseline,files=self.make_fixture(Path(raw).resolve())
            with patch.object(C.shutil,'disk_usage',return_value=SimpleNamespace(free=4*1024**3)):
                proof=C.copy_payload_bytes(source,backup,baseline)
            self.assertTrue(proof['verified']);self.assertTrue(C.verify_payload_copies(proof['destination'],proof['rows']))
            for name,data in files.items():
                original=source/name;copy=proof['destination']/name
                self.assertNotEqual((original.stat().st_dev,original.stat().st_ino),(copy.stat().st_dev,copy.stat().st_ino))
                self.assertEqual(stat.S_IMODE(copy.stat().st_mode),0o600)
                original.write_bytes(b'CHANGED SOURCE ONLY')
                self.assertEqual(copy.read_bytes(),data)
            self.assertTrue(C.verify_payload_copies(proof['destination'],proof['rows']))

    def test_space_and_source_digest_fail_before_configuration_and_preserve_originals(self):
        for failure in ('space','source'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(prefix='gd36-payload-failure-') as raw:
                source,backup,baseline,files=self.make_fixture(Path(raw).resolve())
                if failure=='source':(source/'notes/one.png').write_bytes(b'X'*len(files['notes/one.png']))
                captured={name:(source/name).read_bytes() for name in files}
                class ActualCopyFailure(DisposableServices):
                    def backup_payload(self,before):
                        self.record('full-payload-backup')
                        C.copy_payload_bytes(source,backup,baseline)
                ops=ActualCopyFailure()
                with patch.object(C.shutil,'disk_usage',return_value=SimpleNamespace(free=0 if failure=='space' else 4*1024**3)):
                    result=C.Controller(ops,lambda:None).run()
                self.assertEqual(result['decision'],'HOLD');self.assertNotIn('config',ops.events)
                self.assertEqual(captured,{name:(source/name).read_bytes() for name in files})

    def test_configure_itself_refuses_absent_or_corrupted_full_backup(self):
        ops=object.__new__(C.LiveOps);ops.full_payload_backup=None
        with self.assertRaisesRegex(C.Hold,'full_payload_backup_required'):ops.configure()
        with tempfile.TemporaryDirectory(prefix='gd36-payload-config-') as raw:
            source,backup,baseline,files=self.make_fixture(Path(raw).resolve())
            with patch.object(C.shutil,'disk_usage',return_value=SimpleNamespace(free=4*1024**3)):
                ops.full_payload_backup=C.copy_payload_bytes(source,backup,baseline)
            (ops.full_payload_backup['destination']/'other.bin').write_bytes(b'corrupt')
            with self.assertRaises(C.Hold):ops.configure()

class LiveWriteFreshnessTests(unittest.TestCase):
    def fixture(self,root):
        ops=object.__new__(C.LiveOps);ops.full_payload_backup={'verified':True,'destination':root/'copies','rows':[]};ops.status={k:{'ready':True} for k in C.KINDS};ops.backup=root/'private-backup';ops.backup.mkdir();ops.plan={'privateConfig':{'preparedReceiverSha256':'fixture-sha'}};ops.debugger_absent=lambda:True;ops.identity=lambda k:None;ops.config_unchanged=lambda:None;ops.fast_continuity=lambda k,**kw:'stable-'+k;ops.config_stamps=lambda:{}
        return ops

    def test_withdrawn_gate_after_large_verification_blocks_every_config_write(self):
        with tempfile.TemporaryDirectory(prefix='gd36-write-gate-') as raw:
            ops=self.fixture(Path(raw).resolve());events=[]
            ops.mac_gate=lambda:(_ for _ in ()).throw(C.Hold('mac_withdrawn_after_hashing'))
            with patch.object(C,'verify_payload_copies',side_effect=lambda *a:events.append('hashed')), patch.object(ops,'atomic') as write, patch.object(ops,'command') as command, patch.object(C.Path,'mkdir') as mkdir:
                with self.assertRaisesRegex(C.Hold,'mac_withdrawn'):ops.configure()
                self.assertEqual(events,['hashed']);write.assert_not_called();command.assert_not_called();mkdir.assert_not_called()

    def test_success_orders_hash_then_fresh_gate_then_writes_and_predaemon_gate(self):
        with tempfile.TemporaryDirectory(prefix='gd36-write-order-') as raw:
            root=Path(raw).resolve();ops=self.fixture(root);events=[]
            receiver=root/'receiver.env';shared=root/'shared.env';overlay=root/'control.env'
            receiver.write_bytes(b'OLD=value\n');shared.write_bytes(b'SHARED=value\n')
            drops={k:root/(k+'.d')/'36.conf' for k in C.KINDS};token='t'*43
            prepared={'OLD':'value','GENDRAGOON_CONTROL_INTERNAL_TOKEN':token,'GENDRAGOON_INTEGRATION_ENTITLEMENTS_URL':'http://127.0.0.1:17778/internal/receiver-entitlements'}
            ops.proof=SimpleNamespace(environment_values=lambda value:{'OLD':'value'} if value==b'OLD=value\n' else prepared)
            ops.mac_gate=lambda:events.append('fresh-gate') or approved_mac_proof();ops.atomic=lambda path,data:events.append('write');ops.command=lambda *a:events.append('daemon-reload')
            real_read=Path.read_bytes
            def read(path):
                if str(path)=='/etc/red-x-ai/gendragoon-receiver.env.prepared-36':return b'PREPARED'
                return real_read(path)
            with patch.object(C,'verify_payload_copies',side_effect=lambda *a:events.append('hashed')), patch.object(C,'RECEIVER_ENV',receiver), patch.object(C,'SHARED_ENV',shared), patch.object(C,'OVERLAY',overlay), patch.object(C,'DROPINS',drops), patch.object(C,'private_file',side_effect=lambda p:Path(p).stat()), patch.object(C,'sha',return_value='fixture-sha'), patch.object(C.Path,'read_bytes',read):
                ops.configure()
            self.assertEqual(events[:3],['hashed','fresh-gate','write']);self.assertEqual(events[-2:],['fresh-gate','daemon-reload'])

    def test_cleanup_manifest_reads_then_gate_before_either_network_removal(self):
        for method,event in (('release_services','remove-service'),('cleanup','remove-guard')):
            for withdrawn in (True,False):
                with self.subTest(method=method,withdrawn=withdrawn):
                    ops=object.__new__(C.LiveOps);events=[];ops.nonce='f'*32;ops.preservation={'after-start'};ops.plan={'privateConfig':{'sharedRedXEnvSha256':'unchanged'}};ops.debugger_absent=lambda:True
                    ops.candidate_identity=lambda k:events.append('manifest-'+k) or True;ops.fast_continuity=lambda k,**kw:'stable-'+k
                    def gate():
                        events.append('fresh-gate')
                        if withdrawn:raise C.Hold('mac_withdrawn_after_manifests')
                        return approved_mac_proof()
                    ops.mac_gate=gate;ops.net=SimpleNamespace(CleanupProof=lambda *a,**kw:'proof');ops.boundary=SimpleNamespace(remove_service_fence=lambda p:events.append('remove-service'),remove_guard=lambda p:events.append('remove-guard'))
                    with patch.object(C,'sha',return_value='unchanged'):
                        if withdrawn:
                            with self.assertRaises(C.Hold):getattr(ops,method)()
                        else:getattr(ops,method)()
                    self.assertEqual(events,['manifest-control','manifest-receiver','fresh-gate']+([] if withdrawn else [event]))

    def test_real_ops_and_controller_must_share_the_explicit_gate_instance(self):
        ops=object.__new__(C.LiveOps);same=lambda:None;ops.mac_gate=same
        C.Controller(ops,same)
        with self.assertRaisesRegex(C.Hold,'mac_gate_instance_mismatch'):C.Controller(ops,lambda:None)
        with self.assertRaises(TypeError):C.LiveOps({}, {})

class PeriodicMacObserverTests(unittest.TestCase):
    def test_protected_state_while_remote_stdout_idle_closes_only_stdin(self):
        child=SimpleNamespace(stdout=object(),stdin=io.StringIO(),wait=unittest.mock.Mock())
        ticks=iter([0,.2,.8,1.1,1.2,1.3])
        with patch.object(C.time,'monotonic',side_effect=lambda:next(ticks)), patch.object(C.select,'select',return_value=([],[],[])), patch.object(C.uuid,'uuid4',return_value=SimpleNamespace(hex='periodic')):
            proof=unittest.mock.Mock(side_effect=C.Hold('app_opened'))
            with self.assertRaises(C.Hold):C.coordinate_stream(child,proof)
        proof.assert_called_once_with('periodic');self.assertTrue(child.stdin.closed);child.wait.assert_not_called()

    def test_partial_stdout_line_cannot_block_periodic_mac_observation(self):
        reader=SimpleNamespace(fileno=lambda:123);child=SimpleNamespace(stdout=reader,stdin=io.StringIO(),wait=unittest.mock.Mock())
        ticks=iter([0,.1,.2,1.1])
        with patch.object(C.time,'monotonic',side_effect=lambda:next(ticks)), patch.object(C.select,'select',return_value=([reader],[],[])), patch.object(C.os,'read',return_value=b'{"partial":'), patch.object(C.uuid,'uuid4',return_value=SimpleNamespace(hex='periodic')):
            proof=unittest.mock.Mock(side_effect=C.Hold('app_opened'))
            with self.assertRaises(C.Hold):C.coordinate_stream(child,proof)
        proof.assert_called_once_with('periodic');self.assertTrue(child.stdin.closed);child.wait.assert_not_called()

    def test_phase_challenge_receives_fresh_matching_proof_and_natural_exit(self):
        request={'type':'mac_gate_request','challenge':'new-phase'}
        reader=SimpleNamespace(fileno=lambda:123);writer=io.StringIO()
        child=SimpleNamespace(stdout=reader,stdin=writer,wait=unittest.mock.Mock(return_value=0))
        answers=[]
        class Capture(io.StringIO):
            def close(self):answers.append(self.getvalue());super().close()
        child.stdin=Capture();proof=unittest.mock.Mock(return_value={'challenge':'new-phase','fresh':True})
        with patch.object(C.select,'select',return_value=([reader],[],[])), patch.object(C.os,'read',side_effect=[(json.dumps(request)+'\n').encode(),b'']):
            self.assertEqual(C.coordinate_stream(child,proof),0)
        proof.assert_called_once_with('new-phase');self.assertEqual(json.loads(answers[0]),{'challenge':'new-phase','fresh':True});self.assertTrue(child.stdin.closed)

class ControllerBackendTests(unittest.TestCase):
    """Call real backend methods against disposable /proc and cgroup trees."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gd36-process-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.proc = self.root/'proc'; self.proc.mkdir()
        self.system_slice = self.root/'cgroup/system.slice'
        self.system_slice.mkdir(parents=True)
        self.ops = object.__new__(C.LiveOps);self.ops.mutation_proof=approved_mac_proof()
        self.ops.plan = {'expectedPIDs': {'control': 100, 'receiver': 200},
                         'expectedNodeSha256': 'fixture-node-digest'}
        self.ops.candidates = {}
        self.ops.old_environments = {
            kind: {'REDXAI_ISSUER': 'https://fixture.invalid',
                   'REDX_RECEIVERS_ROOT': '/disposable/storage',
                   'SHARED_SETTING': 'preserve-exactly', 'INVOCATION_ID': 'old-invocation'}
            for kind in ('control', 'receiver')}
        self.ops.token = 'DISPOSABLE_TOKEN_ONLY'
        self.prepared_values = {
            'GENDRAGOON_CONTROL_INTERNAL_TOKEN': self.ops.token,
            'GENDRAGOON_INTEGRATION_ENTITLEMENTS_URL':
                'http://127.0.0.1:17778/internal/receiver-entitlements'}
        self.ops.prepared = b'disposable-prepared-environment'
        self.ops.proof = SimpleNamespace(
            manifest=lambda target, digest: C.STAGE_COUNTS[
                'control' if target == C.TARGETS['control'] else 'receiver'],
            environment_values=lambda raw: dict(self.prepared_values))
        self.links = {kind: self.root/(kind+'-current') for kind in ('control', 'receiver')}
        for kind, link in self.links.items(): link.symlink_to(C.TARGETS[kind])
        self.path_patch = patch.object(C, 'Path', side_effect=self.map_path)
        self.path_patch.start(); self.addCleanup(self.path_patch.stop)
        self.link_patch = patch.dict(C.LINKS, self.links)
        self.link_patch.start(); self.addCleanup(self.link_patch.stop)

    def map_path(self, value):
        value = Path(value)
        if value == Path('/proc') or Path('/proc') in value.parents:
            return self.proc/value.relative_to('/proc')
        if value == Path('/sys/fs/cgroup/system.slice'):
            return self.system_slice
        return value

    def group(self, kind='control', members='123\n', descendants=()):
        group = self.system_slice/('gendragoon-'+kind+'.service')
        group.mkdir(exist_ok=True)
        (group/'cgroup.procs').write_text(members)
        for name, rows in descendants:
            child = group/name; child.mkdir(parents=True, exist_ok=True)
            (child/'cgroup.procs').write_text(rows)
        return group

    def process(self, kind='control', pid=123, start=456, env_changes=None):
        folder = self.proc/str(pid); folder.mkdir(exist_ok=True)
        executable = folder/'exe'
        if not executable.is_symlink(): executable.symlink_to('/usr/bin/node')
        source = str(self.links[kind]/'native/RedXCloud'/
                     ('control-server.cjs' if kind == 'control' else 'server.cjs'))
        (folder/'cmdline').write_bytes(b'/usr/bin/node\0'+source.encode()+b'\0')
        (folder/'stat').write_text(str(pid)+' (disposable node) S '+'0 '*18+str(start)+'\n')
        (folder/'cgroup').write_text('0::/system.slice/gendragoon-'+kind+'.service\n')
        env = {key: value for key, value in self.ops.old_environments[kind].items()
               if key != 'INVOCATION_ID'}
        env.update(self.prepared_values if kind == 'receiver' else
                   {'GENDRAGOON_CONTROL_INTERNAL_TOKEN': self.ops.token})
        env.update({'INVOCATION_ID': 'new-invocation', 'JOURNAL_STREAM': '1:2',
                    'SYSTEMD_EXEC_PID': str(pid)})
        env.update(env_changes or {})
        (folder/'environ').write_bytes(b''.join((key+'='+value).encode()+b'\0'
                                               for key, value in env.items()))
        self.group(kind, str(pid)+'\n')
        return folder

    def candidate_context(self, kind='control', pid=123):
        properties = {'MainPID': str(pid), 'ActiveState': 'active',
                      'ControlGroup': '/system.slice/gendragoon-'+kind+'.service'}
        return properties

    def test_cgroup_reads_descendants_and_never_treats_them_as_stopped(self):
        self.group(descendants=(('decoder', '124\n'), ('decoder/nested', '125\n')))
        expected = {'123', '124', '125'}
        self.assertEqual(self.ops.cgroup_members('control', 123), expected)
        with patch.object(self.ops, 'properties', return_value={
                'MainPID': '123', 'ControlGroup': '/system.slice/gendragoon-control.service'}):
            self.assertEqual(self.ops.children('control'), {'124', '125'})
        # A vanished MainPID does not erase descendants that remain alive.
        (self.system_slice/'gendragoon-control.service/cgroup.procs').write_text('')
        self.assertEqual(self.ops.cgroup_members('control'), {'124', '125'})

    def test_active_missing_cgroup_or_missing_main_pid_fails_closed(self):
        with self.assertRaisesRegex(C.Hold, 'active_cgroup_missing'):
            self.ops.cgroup_members('control', 123)
        self.assertEqual(self.ops.cgroup_members('control'), set())
        group = self.group(members='124\n')
        with self.assertRaisesRegex(C.Hold, 'main_pid_not_in_cgroup'):
            self.ops.cgroup_members('control', 123)
        (group/'cgroup.procs').write_text('123\nnot-a-pid\n')
        with self.assertRaisesRegex(C.Hold, 'cgroup_members_invalid'):
            self.ops.cgroup_members('control', 123)

    def test_inaccessible_descendant_and_symlink_are_not_ignored(self):
        group = self.group()
        incomplete = group/'decoder'; incomplete.mkdir()
        with self.assertRaisesRegex(C.Hold, 'cgroup_membership_unavailable'):
            self.ops.cgroup_members('control', 123)
        incomplete.rmdir()
        outside = self.root/'unrelated'; outside.mkdir()
        (group/'decoder').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(C.Hold, 'cgroup_symlink'):
            self.ops.cgroup_members('control', 123)

    def test_actual_proc_membership_must_match_unit_and_observed_group(self):
        folder = self.process()
        self.ops.verify_membership('control', 123)
        (folder/'cgroup').write_text('0::/system.slice/unrelated.service\n')
        with self.assertRaisesRegex(C.Hold, 'process_cgroup_mismatch'):
            self.ops.verify_membership('control', 123)
        (folder/'cgroup').write_text('0::/system.slice/gendragoon-control.service\n')
        (self.system_slice/'gendragoon-control.service/cgroup.procs').write_text('124\n')
        with self.assertRaisesRegex(C.Hold, 'main_pid_not_in_cgroup'):
            self.ops.verify_membership('control', 123)

    def test_candidate_pins_pid_start_and_complete_environment(self):
        for kind in ('control', 'receiver'):
            with self.subTest(kind=kind):
                self.ops.candidates = {}
                self.process(kind)
                properties = self.candidate_context(kind)
                with patch.object(self.ops, 'properties', return_value=properties), \
                        patch.object(C.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())), \
                        patch.object(C, 'sha', return_value='fixture-node-digest'), \
                        patch.object(self.ops, 'service_listeners'):
                    with self.assertRaisesRegex(C.Hold, 'candidate_identity_not_pinned'):
                        self.ops.candidate_identity(kind)
                    self.assertTrue(self.ops.candidate_identity(kind, allow_initial=True))
                    original = self.ops.candidates[kind]
                    self.assertTrue(self.ops.candidate_identity(kind))
                    self.process(kind, pid=124, start=457)
                    properties['MainPID'] = '124'
                    with self.assertRaisesRegex(C.Hold, 'candidate_identity_changed'):
                        self.ops.candidate_identity(kind)
                    self.assertEqual(self.ops.candidates[kind], original)
                    properties['MainPID'] = '123'
                    self.process(kind, pid=123, start=999)
                    with self.assertRaisesRegex(C.Hold, 'candidate_identity_changed'):
                        self.ops.candidate_identity(kind)

    def test_candidate_rejects_configuration_change_and_new_preload(self):
        self.process()
        with patch.object(self.ops, 'properties', return_value=self.candidate_context()), \
                patch.object(C.pwd, 'getpwnam', return_value=SimpleNamespace(pw_uid=os.getuid())), \
                patch.object(C, 'sha', return_value='fixture-node-digest'), \
                patch.object(self.ops, 'service_listeners'):
            self.ops.candidate_identity('control', allow_initial=True)
            for change, expected in (({'SHARED_SETTING': 'changed'}, 'candidate_environment_unexpected'),
                                     ({'UNREVIEWED_SETTING': 'injected'}, 'candidate_environment_unexpected'),
                                     ({'NODE_OPTIONS': '--require=unreviewed.cjs'}, 'candidate_preload_invalid'),
                                     ({'INVOCATION_ID': 'replaced-process'}, 'candidate_identity_changed')):
                with self.subTest(change=change):
                    self.process(env_changes=change)
                    with self.assertRaisesRegex(C.Hold, expected):
                        self.ops.candidate_identity('control')

    def test_enable_sends_only_to_bound_pidfd_and_always_closes_it(self):
        self.ops.guard_probe = True
        self.ops.boundary = SimpleNamespace(readback=lambda: {'verified': True})
        with patch.object(self.ops, 'debugger_absent'), \
                patch.object(self.ops, 'identity', return_value=(123, 456, {})) as identity, \
                patch.object(self.ops, 'children', return_value=set()), \
                patch.object(C.os, 'pidfd_open', return_value=91, create=True) as opened, \
                patch.object(C.signal, 'pidfd_send_signal', create=True,
                             side_effect=C.Hold('disposable_after_signal_stop')) as sent, \
                patch.object(C.os, 'close') as closed, patch.object(C.os, 'kill') as numeric:
            with self.assertRaisesRegex(C.Hold, 'disposable_after_signal_stop'):
                self.ops.enable('control')
            self.assertEqual(identity.call_count, 2)
            opened.assert_called_once_with(123, 0)
            sent.assert_called_once_with(91, C.signal.SIGUSR1)
            closed.assert_called_once_with(91)
            numeric.assert_not_called()

    def test_process_replacement_after_pidfd_open_refuses_signal(self):
        self.ops.guard_probe = True
        self.ops.boundary = SimpleNamespace(readback=lambda: {'verified': True})
        for replacement in (C.Hold('process_start_changed'), (124, 457, {})):
            with self.subTest(replacement=type(replacement).__name__), \
                    patch.object(self.ops, 'debugger_absent'), \
                    patch.object(self.ops, 'identity', side_effect=[(123, 456, {}), replacement]), \
                    patch.object(self.ops, 'children', return_value=set()), \
                    patch.object(C.os, 'pidfd_open', return_value=91, create=True) as opened, \
                    patch.object(C.signal, 'pidfd_send_signal', create=True) as sent, \
                    patch.object(C.os, 'close') as closed, patch.object(C.os, 'kill') as numeric:
                with self.assertRaises(C.Hold): self.ops.enable('control')
                opened.assert_called_once_with(123, 0)
                sent.assert_not_called(); numeric.assert_not_called()
                closed.assert_called_once_with(91)

    def test_mac_proof_rejects_nan_and_both_infinities(self):
        proof = dict(source='native-mac-preflight', challenge='fresh-unique',
                     observedAtEpoch=100, screenUnlocked=True, uploadWorkspaceTerminal=True,
                     appControlIdle=True, nativeAppClosedVerified=True, maintenanceLeaseHeld=True)
        for stamp in (float('nan'), float('inf'), float('-inf')):
            with self.subTest(timestamp=str(stamp)), self.assertRaises(C.Hold):
                C.validate_mac_proof(dict(proof, observedAtEpoch=stamp), 'fresh-unique', now=105)

    def test_failed_actual_mac_signature_gate_prevents_helper_import_lease_and_ssh(self):
        app = self.root/'Fixture.app'; resources = app/'Contents/Resources'
        resources.mkdir(parents=True)
        repo = self.root/'source'; repo.mkdir()
        required = ['gendragoon_update_restart.py', 'gendragoon_auto_update.py',
                    'gendragoon_app_control.py', 'gendragoon_app_launch.py',
                    'gendragoon_library.py', 'gendragoon_upload_workspace.py',
                    'gendragoon_performance.py', 'gendragoon_redx_storage.py',
                    'gendragoon_progress.py', 'gendragoon_device_origin.py',
                    'gendragoon_auth_broker.py', 'gendragoon_transfer_errors.py',
                    'gendragoon_platform_ipc.py', 'gendragoon_performance_profiles.json']
        names = required + ['mapped-'+str(i)+'.txt' for i in range(23)]
        names += ['unmapped-'+str(i)+'.txt' for i in range(49)]
        inputs, mappings = {}, {}
        for index, name in enumerate(names):
            data = ('DISPOSABLE NEVER IMPORTED '+str(index)).encode()
            relative = 'native/Resources/'+name
            source = repo/relative; source.parent.mkdir(parents=True, exist_ok=True)
            source.write_bytes(data); source.chmod(0o644)
            inputs[relative] = {'bytes': len(data), 'sha256': C.sha(source)}
            if index < 37:
                packaged = resources/name; packaged.write_bytes(data); packaged.chmod(0o644)
                mappings[relative] = 'Contents/Resources/'+name
        record = {'schema': 1, 'sourceCommit': 'bd5983e98965fa5f554f9c53232f25550a1e8887',
                  'sourceInputs': inputs, 'packagedSourceMappings': mappings}
        provenance = self.root/'fixture-provenance.json'
        provenance.write_text(json.dumps(record))
        def fixture_path(value):
            if str(value) == '/Applications/GenDragoon Cloud SSD.app': return app
            return self.map_path(value)
        with patch.object(C.sys, 'platform', 'darwin'), \
                patch.object(C, 'Path', side_effect=fixture_path), \
                patch.object(C, 'MAC_REPO', repo), patch.object(C, 'MAC_PROVENANCE', provenance), \
                patch.object(C, 'MAC_PROVENANCE_SHA', C.sha(provenance)), \
                patch.object(C.subprocess, 'run', return_value=SimpleNamespace(
                    returncode=1, stdout='', stderr='PRIVATE SIGNATURE DIAGNOSTIC')) as codesign, \
                patch.object(C, 'module') as imported, \
                patch.object(C.os, 'open') as lease, patch.object(C.subprocess, 'Popen') as ssh:
            with self.assertRaisesRegex(C.Hold, 'mac_signature_invalid'):
                C.mac_coordinate(SimpleNamespace(remote_bundle='/root/never-contacted'))
            self.assertEqual(codesign.call_count, 1)
            self.assertEqual(codesign.call_args.args[0],
                             ['/usr/bin/codesign', '--verify', '--strict', '--deep', str(app)])
            imported.assert_not_called(); lease.assert_not_called(); ssh.assert_not_called()

    def lifecycle(self, events, failure=None, app_running=False):
        def queue(support):
            self.assertEqual(support, self.root/'support'); events.append('queue')
            if failure == 'queue': raise C.Hold('disposable_queue_active')
        def cache(support):
            self.assertEqual(support, self.root/'support'); events.append('cache')
            if failure == 'cache': raise C.Hold('disposable_cache_dirty')
        def quiet(app, samples):
            self.assertEqual((app, samples), (self.root/'Fixture.app', 1)); events.append('quiet')
            if failure in ('session', 'open-file', 'mount', 'helper'):
                raise C.Hold('disposable_'+failure+'_active')
        def app_pids(executable):
            self.assertEqual(executable, self.root/'Fixture.app/Contents/MacOS/fixture')
            events.append('app-pids'); return [123] if app_running else []
        return SimpleNamespace(ensure_queue_idle=queue, ensure_clean_cache=cache,
                               ensure_quiet=quiet, control=SimpleNamespace(app_pids=app_pids))

    def collect_proof(self, lifecycle, lease=True):
        return C.collect_mac_proof(lifecycle, self.root/'Fixture.app', self.root/'support',
                                   self.root/'Fixture.app/Contents/MacOS/fixture',
                                   'fresh-fixture-challenge', lease)

    def test_mac_lifecycle_failures_stop_before_screen_or_process_observation(self):
        for failure in ('queue', 'cache', 'session', 'open-file', 'mount', 'helper'):
            with self.subTest(failure=failure):
                events = []
                with patch.object(C.subprocess, 'check_output') as screen, \
                        patch.object(C, 'module') as imports:
                    with self.assertRaises(C.Hold):
                        self.collect_proof(self.lifecycle(events, failure=failure))
                    screen.assert_not_called(); imports.assert_not_called()
                    self.assertNotIn('app-pids', events)
                    expected = ['queue'] if failure == 'queue' else ['queue', 'cache']
                    if failure not in ('queue', 'cache'): expected.append('quiet')
                    self.assertEqual(events, expected)

    def test_mac_proof_needs_every_lifecycle_check_before_fresh_success(self):
        events = []
        def screen(*args, **kwargs):
            self.assertEqual(events, ['queue', 'cache', 'quiet']); events.append('screen')
            return '"IOConsoleLocked" = No'
        with patch.object(C.subprocess, 'check_output', side_effect=screen), \
                patch.object(C.time, 'time', return_value=100), patch.object(C, 'module') as imports:
            value = self.collect_proof(self.lifecycle(events))
            self.assertEqual(events, ['queue', 'cache', 'quiet', 'screen', 'app-pids'])
            self.assertEqual(value['challenge'], 'fresh-fixture-challenge')
            self.assertEqual(value['observedAtEpoch'], 100)
            self.assertTrue(all(value[key] is True for key in (
                'screenUnlocked', 'uploadWorkspaceTerminal', 'appControlIdle',
                'nativeAppClosedVerified', 'maintenanceLeaseHeld')))
            imports.assert_not_called()

    def test_mac_locked_unknown_screen_running_app_and_missing_lease_refuse_proof(self):
        cases = [('locked', '"IOConsoleLocked" = Yes', False, True),
                 ('unknown-screen', 'no lock field', False, True),
                 ('app-running', '"IOConsoleLocked" = No', True, True),
                 ('missing-lease', '"IOConsoleLocked" = No', False, False)]
        for name, screen, running, lease in cases:
            with self.subTest(case=name), patch.object(C.subprocess, 'check_output', return_value=screen), \
                    patch.object(C.time, 'time', return_value=100), patch.object(C, 'module') as imports:
                events = []
                with self.assertRaisesRegex(C.Hold, 'mac_protected_or_open'):
                    self.collect_proof(self.lifecycle(events, app_running=running), lease=lease)
                self.assertEqual(events[:3], ['queue', 'cache', 'quiet'])
                imports.assert_not_called()


class PostGateContinuityTests(unittest.TestCase):
    def fixture(self,candidate=False):
        f=ControllerBackendTests(methodName='runTest');f.setUp();self.addCleanup(f.doCleanups);ops=f.ops;props={}
        ops.plan['expectedStartTicks']={};ops.plan['expectedProcessEnvironmentSha256']={};ops.status={};ops.preservation={'stopped','after-start'};ops.nonce='a'*32
        for kind,pid in (('control',123),('receiver',223)):
            folder=f.process(kind,pid=pid);raw=(folder/'environ').read_bytes();envsha=hashlib.sha256(raw).hexdigest();ops.plan['expectedPIDs'][kind]=pid;ops.plan['expectedStartTicks'][kind]=456;ops.plan['expectedProcessEnvironmentSha256'][kind]=envsha;ops.candidates[kind]=(pid,456,envsha)
            props[kind]={**f.candidate_context(kind,pid),'KillMode':'mixed','SendSIGKILL':'no','TimeoutStopUSec':'infinity'}
            ops.status[kind]={'pid':pid,'ready':True,'closed':True,'workAdmissionFenced':True,'pendingRejected':0}
            if not candidate:f.links[kind].unlink();f.links[kind].symlink_to(C.ACTIVE[kind])
        ops.properties=lambda k,**kw:dict(props[k]);ops.identity=lambda k:(ops.plan['expectedPIDs'][k],456,{})
        ops.config_unchanged=lambda:None;ops.config_stamps=lambda:{};ops.owned_listeners=lambda pid:[];ops.service_listeners=lambda k,pid:None;ops.debugger_absent=lambda:True
        self.addCleanup(patch.stopall)
        patch.object(C.pwd,'getpwnam',return_value=SimpleNamespace(pw_uid=os.getuid())).start()
        patch.object(C,'file_stamp',side_effect=lambda path:('stable',str(path))).start()
        return f,ops,props

    def change(self,f,ops,props,kind,change):
        if change=='pid':props[kind]['MainPID']='999'
        if change=='start':
            pid=ops.plan['expectedPIDs'][kind];(f.proc/str(pid)/'stat').write_text(str(pid)+' (node) S '+'0 '*18+'999\n')
        if change=='environment':
            pid=ops.plan['expectedPIDs'][kind];(f.proc/str(pid)/'environ').write_bytes(b'UNREVIEWED=changed\0')

    def test_gate_replacement_prevents_ordinary_stop(self):
        for change in ('pid','start','environment'):
            with self.subTest(change=change):
                f,ops,props=self.fixture();ops.command=unittest.mock.Mock()
                def gate():self.change(f,ops,props,'control',change);return approved_mac_proof()
                ops.mac_gate=gate
                with self.assertRaises(C.Hold):ops.stop('control')
                ops.command.assert_not_called()

    def test_gate_replacement_prevents_owned_configuration_writes(self):
        f,ops,props=self.fixture();ops.full_payload_backup={'verified':True,'destination':f.root/'copies','rows':[]};ops.command=unittest.mock.Mock();ops.atomic=unittest.mock.Mock()
        def gate():self.change(f,ops,props,'receiver','start');return approved_mac_proof()
        ops.mac_gate=gate
        with patch.object(C,'verify_payload_copies'):
            with self.assertRaises(C.Hold):ops.configure()
        ops.command.assert_not_called();ops.atomic.assert_not_called()

    def test_gate_replacement_prevents_both_network_fence_removals(self):
        for method in ('release_services','cleanup'):
            for change in ('pid','start','environment'):
                with self.subTest(method=method,change=change):
                    f,ops,props=self.fixture(candidate=True);ops.candidate_identity=lambda k:True;ops.net=SimpleNamespace(CleanupProof=lambda *a,**kw:'proof');ops.boundary=SimpleNamespace(remove_service_fence=unittest.mock.Mock(),remove_guard=unittest.mock.Mock())
                    def gate():self.change(f,ops,props,'control',change);return approved_mac_proof()
                    ops.mac_gate=gate
                    with self.assertRaises(C.Hold):getattr(ops,method)()
                    ops.boundary.remove_service_fence.assert_not_called();ops.boundary.remove_guard.assert_not_called()

    def test_gate_start_or_orphan_or_lock_prevents_environment_and_link_switch(self):
        for change in ('start','orphan','lock'):
            with self.subTest(change=change):
                f,ops,props=self.fixture();storage=f.root/'payload';storage.mkdir();ops.old_env={'REDX_RECEIVERS_ROOT':str(storage)};ops.plan['privateConfig']={'sharedRedXEnvSha256':'unchanged'};ops.atomic=unittest.mock.Mock()
                for kind in C.KINDS:props[kind].update(MainPID='0',ActiveState='inactive');(f.system_slice/('gendragoon-'+kind+'.service')/'cgroup.procs').write_text('')
                def gate():
                    if change=='start':props['receiver'].update(MainPID='223',ActiveState='active')
                    if change=='orphan':(f.system_slice/'gendragoon-control.service/cgroup.procs').write_text('123\n')
                    if change=='lock':(storage/'.writer-lock').mkdir()
                    return approved_mac_proof()
                ops.mac_gate=gate
                with patch.object(C,'sha',return_value='unchanged'),patch.object(C.os,'symlink') as symlink:
                    with self.assertRaises(C.Hold):ops.switch()
                    ops.atomic.assert_not_called();symlink.assert_not_called()

    def test_proof_aging_during_post_gate_continuity_blocks_configuration(self):
        f,ops,props=self.fixture();ops.full_payload_backup={'verified':True,'destination':f.root/'copies','rows':[]};ops.command=unittest.mock.Mock();ops.atomic=unittest.mock.Mock();clock=[100];calls=[0]
        real=ops.fast_continuity
        def continuity(*a,**kw):
            result=real(*a,**kw);calls[0]+=1
            if calls[0]==4:clock[0]=111
            return result
        ops.fast_continuity=continuity;ops.mac_gate=approved_mac_proof
        with patch.object(C.time,'time',side_effect=lambda:clock[0]),patch.object(C,'verify_payload_copies'):
            with self.assertRaisesRegex(C.Hold,'mac_proof_stale'):ops.configure()
        ops.command.assert_not_called();ops.atomic.assert_not_called()

    def test_post_gate_show_uses_two_second_bound(self):
        ops=object.__new__(C.LiveOps);ops.command=unittest.mock.Mock(return_value='MainPID=0\nActiveState=inactive')
        ops.properties('control',timeout=2)
        self.assertEqual(ops.command.call_args.kwargs['timeout'],2)

    def test_mutating_command_rejects_original_expired_proof_before_subprocess(self):
        ops=object.__new__(C.LiveOps);ops.mutation_proof={**approved_mac_proof(),'observedAtEpoch':time.time()-11}
        with patch.object(C.subprocess,'check_output') as launch:
            for verb in ('start','stop','daemon-reload'):
                with self.assertRaisesRegex(C.Hold,'mac_proof_stale'):ops.command('/usr/bin/systemctl',verb,'gendragoon-control.service')
            launch.assert_not_called()

    def test_retained_original_proof_aging_during_kernel_check_prevents_apply(self):
        clock=[100];events=[]
        class FakeKernel:
            def __init__(self,**kw):self.guard_retained=True
            def invoke(self,args,script=None,*,mutation=False):
                events.append('apply' if mutation else 'check')
                if mutation:self.guard_retained=False
                else:clock[0]=111
                return '{}'
        net=SimpleNamespace(KernelBackend=FakeKernel,NetworkBoundary=lambda nonce,backend:SimpleNamespace(backend=backend))
        gate=approved_mac_proof
        with patch.object(C,'verify_bundle'),patch.object(C,'module',return_value=net),patch.object(C.time,'time',side_effect=lambda:clock[0]):
            ops=C.LiveOps({}, {}, mac_gate=gate);controller=C.Controller(ops,gate)
            def operation():
                ops.boundary.backend.invoke(('-c','-f','-'),'fixture')
                ops.boundary.backend.invoke(('-f','-'),'fixture',mutation=True)
            with self.assertRaisesRegex(C.Hold,'mac_proof_stale'):controller.step('debugger-guard',operation)
        self.assertEqual(events,['check']);self.assertTrue(ops.boundary.backend.guard_retained)

class ExpiredPhaseJournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='gd36-journal-');self.addCleanup(self.temporary.cleanup);self.root=Path(self.temporary.name).resolve()/'root';self.root.mkdir(mode=0o700);self.nonce='a'*32;self.backup=self.root/('gendragoon36-preactivation-'+self.nonce);self.backup.mkdir(mode=0o700)
        self.ops=object.__new__(C.LiveOps);self.ops.nonce=self.nonce;self.ops.backup=self.backup;self.ops.mutation_proof=approved_mac_proof();self.clock=[100];self.ops.mac_gate=approved_mac_proof
        real_path=Path;real_lstat=Path.lstat
        def mapped(value):return self.root if str(value)=='/root' else real_path(value)
        def root_owned_info(path,*args,**kwargs):
            info=real_lstat(path,*args,**kwargs)
            if path in (self.root,self.backup,self.backup/'phase.json'):
                fields={name:getattr(info,name) for name in dir(info) if name.startswith('st_')};fields['st_uid']=0;return SimpleNamespace(**fields)
            return info
        for context in (patch.object(C,'Path',side_effect=mapped),patch.object(Path,'lstat',root_owned_info),patch.object(C.os,'fchown'),patch.object(C.time,'time',side_effect=lambda:self.clock[0])):
            context.start();self.addCleanup(context.stop)

    def test_real_completion_and_hold_journal_survive_expired_long_phase(self):
        controller=C.Controller(self.ops,self.ops.mac_gate,self.ops.journal)
        def long_phase():self.clock[0]=700;return 'read-only-phase-finished'
        self.assertEqual(controller.step('full-payload-byte-backup',long_phase),'read-only-phase-finished')
        leaf=self.backup/'phase.json';record=json.loads(leaf.read_text());self.assertEqual(record,{'operationNonce':self.nonce,'phase':'full-payload-byte-backup','state':'complete'});self.assertEqual(stat.S_IMODE(leaf.stat().st_mode),0o600)
        self.ops.journal({'decision':'HOLD','phase':'owned-config','activationComplete':False})
        self.assertEqual(json.loads(leaf.read_text())['decision'],'HOLD')
        self.assertEqual(sorted(p.name for p in self.backup.iterdir()),['phase.json'])

    def test_config_atomic_stays_proof_gated_after_expired_journal(self):
        self.ops.mutation_proof={**approved_mac_proof(),'observedAtEpoch':100};self.clock[0]=700;self.ops.journal({'decision':'HOLD','phase':'drained-snapshot'})
        target=self.backup/'owned-config.env';target.write_bytes(b'ORIGINAL')
        with self.assertRaisesRegex(C.Hold,'mac_proof_stale'):self.ops.atomic(target,b'FORBIDDEN')
        self.assertEqual(target.read_bytes(),b'ORIGINAL');self.assertEqual(sorted(p.name for p in self.backup.iterdir()),['owned-config.env','phase.json'])

    def test_journal_rejects_other_directory_permissions_and_symlink_leaf(self):
        other=self.root/'other';other.mkdir(mode=0o700);self.ops.backup=other
        with self.assertRaisesRegex(C.Hold,'phase_journal_scope_invalid'):self.ops.journal({'decision':'HOLD'})
        self.assertEqual(list(other.iterdir()),[]);self.ops.backup=self.backup;self.backup.chmod(0o755)
        with self.assertRaisesRegex(C.Hold,'phase_journal_directory_invalid'):self.ops.journal({'decision':'HOLD'})
        self.backup.chmod(0o700);target=self.root/'preserve.env';target.write_bytes(b'ORIGINAL');(self.backup/'phase.json').symlink_to(target)
        with self.assertRaises(C.Hold):self.ops.journal({'decision':'HOLD'})
        self.assertEqual(target.read_bytes(),b'ORIGINAL')

class InspectorSocketOwnershipTests(unittest.TestCase):
    def test_linux_actual_duplicate_websocket_client_is_refused(self):
        if sys.platform != 'linux':
            self.skipTest('Linux /proc socket ownership proof; Ubuntu CI must run this case')
        node = os.environ.get('GD36_NODE20') or shutil.which('node')
        self.assertIsNotNone(node, 'exact Node20.20.2 required for owned inspector fixture')
        environment = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LC_ALL': 'C'}
        version = subprocess.run([node, '--version'], capture_output=True, text=True,
                                 timeout=5, env=environment)
        self.assertEqual((version.returncode, version.stdout.strip()), (0, 'v20.20.2'))
        target_code = r'''
const inspector=require('node:inspector');
process.stdout.write(JSON.stringify({port:Number(new URL(inspector.url()).port)})+'\n');
process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{if(v.trim()==='quit')process.exit(0);});
process.stdin.on('end',()=>process.exit(0));process.stdin.resume();
'''
        client_code = r'''
const http=require('node:http');const port=Number(process.argv[1]);let ws;
const stop=()=>{if(ws)ws.close();else process.exit(0);};
process.stdin.setEncoding('utf8');process.stdin.on('data',v=>{if(v.trim()==='quit')stop();});
process.stdin.on('end',stop);process.stdin.resume();
const request=http.get({host:'127.0.0.1',port,path:'/json/list',agent:false},response=>{
 let raw='';response.on('data',v=>raw+=v);response.on('end',()=>{
  try{const rows=JSON.parse(raw);if(rows.length!==1)throw Error();
   ws=new WebSocket(rows[0].webSocketDebuggerUrl);
   ws.addEventListener('open',()=>process.stdout.write('{"connected":true}\n'));
   ws.addEventListener('close',()=>process.exit(0));ws.addEventListener('error',()=>process.exit(2));
  }catch{process.exit(2);}
 });
});request.on('error',()=>process.exit(2));
'''
        def stop_owned(process):
            if process.stdin is not None and not process.stdin.closed:
                try:
                    if process.poll() is None:
                        process.stdin.write('quit\n'); process.stdin.flush()
                except BrokenPipeError:
                    pass
                process.stdin.close()
            process.wait(timeout=10)
            if process.stdout is not None: process.stdout.close()

        def line(process):
            self.assertTrue(select.select([process.stdout], [], [], 10)[0],
                            'owned fixture did not acknowledge connection')
            raw = process.stdout.readline(1025)
            self.assertTrue(0 < len(raw) <= 1024)
            return json.loads(raw)

        def sole_pair(target, client, port):
            # HTTP discovery may briefly be FIN_WAIT/CLOSE_WAIT before it is
            # gone or TIME_WAIT. No elapsed interval substitutes for the check.
            end = time.monotonic()+5
            while True:
                try:
                    return C.inspector_session_pair(target.pid, client.pid, port)
                except C.Hold:
                    if time.monotonic() >= end: raise
                    time.sleep(.02)

        target = subprocess.Popen([node, '--inspect=127.0.0.1:0', '-e', target_code],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, env=environment)
        self.addCleanup(stop_owned, target)
        port = line(target)['port']
        first = subprocess.Popen([node, '--experimental-websocket', '-e', client_code, str(port)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True, env=environment)
        self.addCleanup(stop_owned, first)
        self.assertEqual(line(first), {'connected': True})
        self.assertTrue(sole_pair(target, first, port))
        second = subprocess.Popen([node, '--experimental-websocket', '-e', client_code, str(port)],
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, text=True, env=environment)
        self.addCleanup(stop_owned, second)
        self.assertEqual(line(second), {'connected': True})
        deadline = time.monotonic()+5
        while True:
            try:
                C.inspector_session_pair(target.pid, first.pid, port)
                self.fail('two acknowledged WebSocket sessions accepted as sole owner')
            except C.Hold as error:
                if str(error) == 'inspector_coowner_or_binding': break
                # Wait only for discovery's closing HTTP socket to disappear;
                # every observed state must still refuse ownership throughout.
                if time.monotonic() >= deadline: raise
                time.sleep(.02)
        stop_owned(second)
        self.assertTrue(sole_pair(target, first, port))


if __name__ == '__main__': unittest.main(verbosity=2)
