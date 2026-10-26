#!/usr/bin/env python3
"""Disposable controller fault injection. Never constructs the live backend."""
import sys
sys.dont_write_bytecode = True
import argparse
import copy
import importlib.util
import json
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
SPEC.loader.exec_module(C)

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
        self.decoder_children = 2
        self.originals_retained = False
        self.logical = 'all-three-tables-v1'
        self.payload = 'every-png-and-sidecar-v1'
        self.baseline = None
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
            assert 'control' in self.drained and self.service_gate
            assert self.decoder_children == 2  # Existing children may finish.
        self.inspector = kind

    def install(self, kind):
        self.record('fence-' + kind)
        assert self.inspector == kind
        self.fenced.add(kind)

    def drain(self, kind):
        self.record('drain-' + kind)
        assert kind in self.fenced
        if kind == 'control':
            # Already admitted Control work must be able to reach Receiver.
            assert not self.service_gate and 'receiver' in self.running
            while self.old_control_pending:
                self.events.append('complete-' + self.old_control_pending.pop(0))
        else:
            assert self.service_gate and self.writer_lock
            self.decoder_children = 0
        self.drained.add(kind)
        return {'kind': kind, 'ready': True}

    def close_inspector(self, kind):
        self.record('close-' + kind)
        assert self.inspector == kind and kind in self.drained
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

    def configure(self):
        self.record('config')
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
        self.assertLess(ops.events.index('close-control'), ops.events.index('enable-receiver'))
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
            with self.assertRaises(C.Hold): C.LiveOps({}, {'reviewedForExecution': True})
            load.assert_not_called()

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
        ops = object.__new__(C.LiveOps)
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
                self.assertNotIn('env', kwargs)
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

class ControllerBackendTests(unittest.TestCase):
    """Call real backend methods against disposable /proc and cgroup trees."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gd36-process-fixture-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.proc = self.root/'proc'; self.proc.mkdir()
        self.system_slice = self.root/'cgroup/system.slice'
        self.system_slice.mkdir(parents=True)
        self.ops = object.__new__(C.LiveOps)
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
