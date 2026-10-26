#!/usr/bin/env python3
"""Offline ownership/failure tests plus an isolated Linux kernel proof.

Run normally on any platform. Ubuntu CI must use:
  sudo env GD36_REQUIRE_NETNS=1 python3 test-network-boundary-36.py
The only kernel worker is launched through unshare --net. It proves that its
network namespace differs from its parent's before changing loopback or rules.
No test modifies the parent/host namespace, even when run with sudo.
"""
from __future__ import annotations

import copy
from dataclasses import replace
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "gd36_network_boundary", HERE / "adapter/server-network-boundary-36.py")
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)
NONCE = "a" * 32
BOOT = "12345678-1234-1234-1234-123456789abc"


def drain(nonce=NONCE):
    return mod.ControlDrainProof(nonce, 1234, 5678, BOOT, mod.CONTROL_SHA256,
                                 time.monotonic(), True, True, True, 0,
                                 True, 0, 0, True)


def cleanup(nonce=NONCE, **changes):
    return replace(mod.CleanupProof(nonce, time.monotonic(), True, True, True,
                                    healthy=True), **changes)


class MemoryNft:
    """Models kernel object handles, atomic batches, and per-chain listing order."""

    def __init__(self):
        self.objects = []
        self.calls = []
        self.next_handle = 10
        self.fail_apply = False
        self.fail_read = False
        self.corrupt_read = False

    def invoke(self, args, script=None, *, mutation=False):
        self.calls.append((args, script, mutation))
        if args == ("-c", "-f", "-"):
            json.loads(script)
            return ""
        if args == ("-f", "-"):
            if self.fail_apply:
                raise RuntimeError("PRIVATE SENTINEL: never disclose raw error")
            before = copy.deepcopy(self.objects)
            try:
                for cmd in json.loads(script)["nftables"]:
                    if "create" in cmd:
                        obj = copy.deepcopy(cmd["create"])
                        kind, value = next(iter(obj.items()))
                        if kind == "table" and any("table" in row for row in self.objects):
                            raise RuntimeError("collision")
                        value["handle"] = self.next_handle
                        self.next_handle += 1
                        self.objects.append(obj)
                    elif "delete" in cmd:
                        kind, target = next(iter(cmd["delete"].items()))
                        if kind == "table":
                            assert target["handle"] == self.objects[0]["table"]["handle"]
                            self.objects = []
                        else:
                            matches = [row for row in self.objects if kind in row
                                       and row[kind]["handle"] == target["handle"]
                                       and row[kind]["table"] == target["table"]
                                       and row[kind]["chain"] == target["chain"]]
                            assert len(matches) == 1
                            self.objects.remove(matches[0])
                    else:
                        raise AssertionError("forbidden nft command")
            except Exception:
                self.objects = before
                raise
            return ""
        if args == ("list", "tables", "inet"):
            return json.dumps({"nftables": [row for row in self.objects if "table" in row]})
        if args[:3] == ("list", "table", "inet"):
            if self.fail_read:
                raise RuntimeError("PRIVATE SENTINEL: never disclose raw error")
            rows = [row for row in self.objects if "table" in row]
            for chain in ("output", "input"):
                rows += [row for row in self.objects
                         if row.get("chain", {}).get("name") == chain
                         or row.get("rule", {}).get("chain") == chain]
            rows = copy.deepcopy(rows)
            if self.corrupt_read:
                rows[-1]["rule"]["expr"] = [{"accept": None}]
            return json.dumps({"nftables": [{"metainfo": {"json_schema_version": 1}}, *rows]})
        raise AssertionError("unexpected command")

    def writes(self):
        return [call for call in self.calls if call[2]]


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.backend = MemoryNft()
        self.boundary = mod.NetworkBoundary(NONCE, backend=self.backend)

    def test_nonce_is_an_exact_identifier_not_a_command(self):
        for value in ("", "A" * 32, "a" * 31, "a" * 33,
                      "a" * 32 + "\n", "x; flush ruleset", 123):
            with self.subTest(value=value), self.assertRaisesRegex(mod.BoundaryError, "nonce_invalid"):
                mod.NetworkBoundary(value)
        self.assertEqual(self.backend.calls, [])

    def test_renderer_has_only_owned_create_commands_and_exact_debugger_scope(self):
        document = json.loads(self.boundary.render_guard())
        self.assertEqual(len(document["nftables"]), 5)
        for command in document["nftables"]:
            self.assertEqual(set(command), {"create"})
            kind, obj = next(iter(command["create"].items()))
            self.assertEqual(obj["family"], "inet")
            self.assertEqual(obj["name"] if kind == "table" else obj["table"], self.boundary.table)
        text = self.boundary.render_guard()
        self.assertIn('"right":"127.0.0.1"', text)
        self.assertIn('"key":"skuid"', text)
        self.assertIn('"right":9229', text)
        self.assertNotIn("17778", text)
        self.assertNotIn("17779", text)
        self.assertNotIn('"flush"', text)
        self.assertNotIn('"log"', text)
        self.assertEqual(self.backend.calls, [])

    def test_default_kernel_backend_refuses_mutation_before_starting_command(self):
        with patch.object(mod.sys, "platform", "linux"), patch.object(mod.os, "geteuid", return_value=0), \
                patch.object(mod.subprocess, "run") as run:
            with self.assertRaisesRegex(mod.BoundaryError, "kernel_mutations_disabled"):
                mod.KernelBackend().invoke(("-f", "-"), "{}", mutation=True)
            # Omitting the mutation label cannot bypass the opt-in.
            with self.assertRaisesRegex(mod.BoundaryError, "nft_command_kind_mismatch"):
                mod.KernelBackend().invoke(("-f", "-"), "{}")
            for args in (("flush", "ruleset"), ("-f", "/tmp/unreviewed"),
                         ("list", "table", "inet", "unrelated")):
                with self.assertRaisesRegex(mod.BoundaryError, "nft_command_not_allowed"):
                    mod.KernelBackend(enable_mutations=True).invoke(args)
            run.assert_not_called()

    def test_check_is_read_only_and_cli_has_no_apply_option(self):
        self.boundary.check_guard()
        self.assertEqual(self.backend.writes(), [])
        result = subprocess.run((sys.executable, str(HERE / "adapter/server-network-boundary-36.py"),
                                 "--nonce", NONCE), text=True, capture_output=True, check=True)
        self.assertEqual(json.loads(result.stdout), json.loads(self.boundary.render_guard()))
        refused = subprocess.run((sys.executable, str(HERE / "adapter/server-network-boundary-36.py"),
                                  "--nonce", NONCE, "--apply"), capture_output=True)
        self.assertNotEqual(refused.returncode, 0)

    def test_service_fence_requires_complete_fresh_exact_control_proof(self):
        self.boundary.install_guard()
        original = copy.deepcopy(self.backend.objects)
        changes = [dict(map_size=1), dict(refused_responses=1), dict(cgroup_children=1),
                   dict(map_fence_immutable=False), dict(normal_callback_installed=False),
                   dict(provenance_verified=False), dict(server_closed=False),
                   dict(inspector_absent=False), dict(pid=0), dict(start_ticks=0),
                   dict(boot_id="wrong"), dict(source_sha256="0" * 64),
                   dict(operation_nonce="b" * 32), dict(observed_monotonic=time.monotonic() - 11),
                   dict(observed_monotonic=time.monotonic() + 60),
                   dict(observed_monotonic=float("nan")), dict(map_size=False)]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(mod.BoundaryError):
                self.boundary.add_service_fence(replace(drain(), **change))
        for invalid in (True, {"drained": True}, None):
            with self.assertRaises(mod.BoundaryError):
                self.boundary.add_service_fence(invalid)
        self.assertEqual(self.backend.objects, original)
        self.assertEqual(len(self.backend.writes()), 1)
        self.assertEqual(self.boundary.add_service_fence(drain())["ruleCount"], 6)
        # No service rule is admitted before the complete proof succeeds.
        self.assertEqual(len(self.backend.writes()), 2)

    def test_cleanup_needs_debugger_absence_preservation_and_completed_outcome(self):
        self.boundary.install_guard()
        self.boundary.add_service_fence(drain())
        original = copy.deepcopy(self.backend.objects)
        for change in (dict(debugger_absent=False), dict(process_identities_verified=False),
                       dict(preserved_state_verified=False), dict(healthy=False),
                       dict(observed_monotonic=time.monotonic() - 11)):
            with self.subTest(change=change), self.assertRaises(mod.BoundaryError):
                self.boundary.remove_service_fence(cleanup(**change))
        with self.assertRaises(mod.BoundaryError):
            self.boundary.remove_guard(cleanup())
        self.assertEqual(self.backend.objects, original)
        self.boundary.remove_service_fence(cleanup(healthy=False, rollback_complete=True))
        self.assertEqual(self.boundary.phase, "guard")
        self.boundary.remove_guard(cleanup())
        self.assertEqual(self.boundary.phase, "removed")
        self.assertEqual(self.backend.objects, [])
        commands = [cmd for _, script, _ in self.backend.writes()
                    for cmd in json.loads(script)["nftables"]]
        self.assertTrue(all(set(cmd) <= {"create", "delete"} for cmd in commands))

    def test_existing_table_is_never_adopted_or_deleted(self):
        self.boundary.install_guard()
        existing = copy.deepcopy(self.backend.objects)
        duplicate = mod.NetworkBoundary(NONCE, backend=self.backend)
        with self.assertRaisesRegex(mod.BoundaryError, "boundary_command_hold"):
            duplicate.install_guard()
        self.assertEqual(self.backend.objects, existing)
        self.assertEqual(duplicate.phase, "hold")
        with self.assertRaises(mod.BoundaryError):
            duplicate.remove_guard(cleanup())

    def test_readback_tampering_or_handle_replacement_prevents_cleanup(self):
        for tamper in ("expression", "identity", "extra"):
            with self.subTest(tamper=tamper):
                backend = MemoryNft()
                boundary = mod.NetworkBoundary(NONCE, backend=backend)
                boundary.install_guard()
                if tamper == "expression":
                    backend.corrupt_read = True
                elif tamper == "identity":
                    backend.objects[0]["table"]["handle"] += 999
                else:
                    backend.objects.append({"set": {"family": "inet", "table": boundary.table,
                                                       "name": "foreign", "handle": 999}})
                    # Explicitly return the hostile object too.
                    original_invoke = backend.invoke
                    def with_extra(args, script=None, *, mutation=False):
                        out = original_invoke(args, script, mutation=mutation)
                        if args[:3] == ("list", "table", "inet"):
                            doc = json.loads(out)
                            doc["nftables"].append(backend.objects[-1])
                            return json.dumps(doc)
                        return out
                    backend.invoke = with_extra
                with self.assertRaisesRegex(mod.BoundaryError, "boundary_readback_hold"):
                    boundary.remove_guard(cleanup())
                self.assertEqual(boundary.phase, "hold")
                self.assertEqual(len(backend.writes()), 1)

    def test_failed_add_or_failed_read_never_removes_protective_guard(self):
        for failure in ("apply", "read"):
            with self.subTest(failure=failure):
                backend = MemoryNft()
                boundary = mod.NetworkBoundary(NONCE, backend=backend)
                boundary.install_guard()
                setattr(backend, "fail_" + failure, True)
                with self.assertRaises(mod.BoundaryError) as caught:
                    boundary.add_service_fence(drain())
                self.assertNotIn("PRIVATE", str(caught.exception))
                self.assertEqual(boundary.phase, "hold")
                self.assertTrue(any("rule" in row and "debugger-uid" in row["rule"]["comment"]
                                    for row in backend.objects))
                self.assertFalse(any('"delete"' in script for _, script, _ in backend.writes()))

    def test_readback_accepts_equivalent_flags_but_rejects_a_wider_syn_mask(self):
        self.boundary.install_guard()
        self.boundary.add_service_fence(drain())
        for row in self.backend.objects:
            for expression in row.get("rule", {}).get("expr", []):
                match = expression.get("match", {})
                left = match.get("left", {})
                if "fib" in left:
                    left["fib"]["flags"] = "daddr"
                if "&" in left:
                    left["&"][1] = ["ack", "rst", "syn", "fin"]
                    match["right"] = "syn"
        self.assertTrue(self.boundary.readback()["verified"])
        for row in self.backend.objects:
            for expression in row.get("rule", {}).get("expr", []):
                match = expression.get("match", {})
                if "&" in match.get("left", {}):
                    match["left"]["&"][1] = ["syn"]
        with self.assertRaisesRegex(mod.BoundaryError, "boundary_readback_hold"):
            self.boundary.remove_service_fence(cleanup())
        self.assertEqual(len(self.backend.writes()), 2)


CLIENT = r'''
import json, os, socket, sys
os.setgroups([]); os.setgid(65534); os.setuid(65534)
port = int(sys.argv[1]); hold = sys.argv[2] == 'hold'
try:
    connection = socket.create_connection(('127.0.0.1', port), timeout=1)
    connection.sendall(b'initial'); assert connection.recv(7) == b'initial'
    print(json.dumps({'connected': True}), flush=True)
    if hold:
        assert sys.stdin.readline().strip() == 'continue'
        connection.sendall(b'preserved'); assert connection.recv(9) == b'preserved'
        print(json.dumps({'establishedPreserved': True}), flush=True)
    connection.close()
except OSError:
    print(json.dumps({'connected': False}), flush=True)
'''


class Echo(socketserver.BaseRequestHandler):
    def handle(self):
        while True:
            block = self.request.recv(1024)
            if not block:
                return
            self.request.sendall(block)


class EchoServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def _nonroot(port):
    result = subprocess.run((sys.executable, "-c", CLIENT, str(port), "once"),
                            text=True, capture_output=True, timeout=5, check=True)
    return json.loads(result.stdout)["connected"]


def _root(port):
    with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
        connection.sendall(b"root")
        return connection.recv(4) == b"root"


def isolated_worker(parent_identity):
    # This check precedes EVERY network mutation, including bringing up lo.
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("isolated_worker_requires_linux_root")
    current = os.readlink("/proc/self/ns/net")
    actual_parent = os.readlink("/proc/" + str(os.getppid()) + "/ns/net")
    if (not parent_identity.startswith("net:[") or current == parent_identity
            or actual_parent != parent_identity or current == actual_parent):
        raise RuntimeError("isolated_network_namespace_not_proven")
    subprocess.run(("ip", "link", "set", "lo", "up"), check=True, capture_output=True)
    backend = mod.KernelBackend(enable_mutations=True)
    # A disposable unrelated table proves lifecycle operations preserve others.
    sentinel = "gd36_" + secrets.token_hex(16)
    backend.invoke(("-f", "-"), json.dumps({"nftables": [{"create": {"table": {
        "family": "inet", "name": sentinel}}}]}), mutation=True)
    sentinel_before = backend.invoke(("list", "table", "inet", sentinel))
    servers = []
    established = None
    boundary = mod.NetworkBoundary(secrets.token_hex(16), backend=backend)
    try:
        for port in (9229, 17778, 17779, 18080):
            server = EchoServer(("127.0.0.1", port), Echo)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
        assert all(_nonroot(port) and _root(port) for port in (9229, 17778, 17779, 18080))
        boundary.install_guard()
        assert _root(9229) and not _nonroot(9229)
        # Receiver dependency connections remain possible before Control drain.
        assert _nonroot(17778) and _nonroot(17779) and _nonroot(18080)
        established = subprocess.Popen((sys.executable, "-c", CLIENT, "17779", "hold"),
                                       text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE)
        assert json.loads(established.stdout.readline())["connected"] is True
        boundary.add_service_fence(drain(boundary.nonce))
        assert not _nonroot(17778) and not _nonroot(17779)
        assert all(_root(port) for port in (9229, 17778, 17779, 18080)) and _nonroot(18080)
        established.stdin.write("continue\n"); established.stdin.flush()
        assert json.loads(established.stdout.readline())["establishedPreserved"] is True
        assert established.wait(timeout=5) == 0
        # Failed cleanup proof leaves both guard and admissions in effect.
        try:
            boundary.remove_service_fence(cleanup(boundary.nonce, debugger_absent=False))
            raise AssertionError("incomplete proof accepted")
        except mod.BoundaryError:
            pass
        assert not _nonroot(9229) and not _nonroot(17779)
        servers[0].shutdown(); servers[0].server_close()
        try:
            socket.create_connection(("127.0.0.1", 9229), timeout=0.2)
            raise AssertionError("debugger test listener remains")
        except OSError:
            pass
        boundary.remove_service_fence(cleanup(boundary.nonce))
        assert _nonroot(17778) and _nonroot(17779)
        boundary.remove_guard(cleanup(boundary.nonce))
        assert backend.invoke(("list", "table", "inet", sentinel)) == sentinel_before
        print(json.dumps({"isolatedKernelProof": "passed", "rootDebuggerAllowed": True,
                          "nonrootDebuggerDenied": True, "dependencyBeforeDrainAllowed": True,
                          "newServiceSynDeniedAfterDrain": True, "establishedPreserved": True,
                          "unrelatedTablePreserved": True}), flush=True)
    finally:
        # Do not call guard cleanup from failure paths. Namespace destruction is
        # the only disposal mechanism if the test fails; the host is untouched.
        for server in servers:
            server.shutdown(); server.server_close()
        if established is not None:
            if established.stdin is not None and not established.stdin.closed:
                established.stdin.close()
            established.wait(timeout=5)


class IsolatedKernelTests(unittest.TestCase):
    def test_actual_linux_root_and_nonroot_connections(self):
        required = os.environ.get("GD36_REQUIRE_NETNS") == "1"
        if sys.platform != "linux":
            if required:
                self.fail("Linux network namespace proof required on this platform")
            self.skipTest("Linux-only isolated kernel proof; Ubuntu CI must require it")
        needed = [name for name in ("unshare", "ip", "nft") if shutil.which(name) is None]
        if needed:
            if required:
                self.fail("isolated proof prerequisites missing: " + ",".join(needed))
            self.skipTest("isolated proof prerequisites missing: " + ",".join(needed))
        parent = os.readlink("/proc/self/ns/net")
        command = ["unshare", "--net", "--", sys.executable, str(Path(__file__).resolve()),
                   "--netns-child", parent]
        if os.geteuid() != 0:
            command = ["sudo", "-n", *command]
        # Capability absence may skip in optional local mode. Once a namespace
        # can start, every proof failure is a failure even without required mode.
        probe = ["unshare", "--net", "--", "true"]
        if os.geteuid() != 0:
            probe = ["sudo", "-n", *probe]
        available = subprocess.run(probe, capture_output=True, timeout=10).returncode == 0
        if not available:
            if required:
                self.fail("isolated namespace capabilities unavailable")
            self.skipTest("isolated namespace capabilities unavailable")
        result = subprocess.run(command, capture_output=True, text=True, timeout=45)
        if result.returncode != 0:
            self.fail("isolated kernel proof failed (exit " + str(result.returncode) + ")")
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["isolatedKernelProof"], "passed")
        self.assertTrue(all(value is True for key, value in receipt.items()
                            if key != "isolatedKernelProof"))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--netns-child":
        try:
            isolated_worker(sys.argv[2])
        except Exception as error:
            # No nft output, environment, request objects, or source values.
            print(json.dumps({"isolatedKernelProof": "failed", "errorType": type(error).__name__}))
            raise SystemExit(1)
    else:
        unittest.main(verbosity=2)
