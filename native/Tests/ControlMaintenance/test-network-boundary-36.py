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
import re
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

    @staticmethod
    def commands(script):
        document = json.loads(script)
        if (type(document) is not dict or set(document) != {"nftables"}
                or type(document["nftables"]) is not list or not document["nftables"]):
            raise ValueError("memory_nft_command_syntax_invalid")
        commands = document["nftables"]
        for command in commands:
            if type(command) is not dict or len(command) != 1:
                raise ValueError("memory_nft_command_syntax_invalid")
            operation, obj = next(iter(command.items()))
            if type(obj) is not dict or len(obj) != 1:
                raise ValueError("memory_nft_command_syntax_invalid")
            kind, value = next(iter(obj.items()))
            allowed = {"create": {"table", "chain"}, "add": {"rule"},
                       "delete": {"table", "rule"}}
            if kind not in allowed.get(operation, set()) or type(value) is not dict:
                # Match the exact adapter subset and nftables1.0.9's explicit
                # rejection of CREATE rule. Validate the WHOLE batch first.
                raise ValueError("memory_nft_command_syntax_invalid")
        return commands

    def invoke(self, args, script=None, *, mutation=False):
        self.calls.append((args, script, mutation))
        if args == ("-c", "-f", "-"):
            self.commands(script)
            return ""
        if args == ("-f", "-"):
            commands = self.commands(script)
            if self.fail_apply:
                raise RuntimeError("PRIVATE SENTINEL: never disclose raw error")
            before = copy.deepcopy(self.objects)
            before_next_handle = self.next_handle
            try:
                for cmd in commands:
                    if "create" in cmd or "add" in cmd:
                        operation = next(iter(cmd))
                        obj = copy.deepcopy(cmd[operation])
                        kind, value = next(iter(obj.items()))
                        if operation == "create" and any(
                                kind in row and row[kind]["family"] == value["family"]
                                and row[kind].get("table") == value.get("table")
                                and row[kind]["name"] == value["name"] for row in self.objects):
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
                self.next_handle = before_next_handle
                raise
            return ""
        if args == ("list", "tables", "inet"):
            return json.dumps({"nftables": [row for row in self.objects if "table" in row]})
        if args[:3] == ("list", "table", "inet"):
            if self.fail_read:
                raise RuntimeError("PRIVATE SENTINEL: never disclose raw error")
            rows = [row for row in self.objects if "table" in row]
            rows += [row for row in self.objects if "chain" in row]
            for chain in ("output", "input"):
                rows += [row for row in self.objects
                         if row.get("rule", {}).get("chain") == chain]
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

    def test_renderer_uses_exclusive_create_for_table_chains_and_add_only_for_rules(self):
        document = json.loads(self.boundary.render_guard())
        self.assertEqual(len(document["nftables"]), 5)
        for command in document["nftables"]:
            operation, value = next(iter(command.items()))
            kind, obj = next(iter(value.items()))
            self.assertEqual(operation, "add" if kind == "rule" else "create")
            self.assertEqual(set(command), {operation})
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
        service_commands = json.loads(self.backend.writes()[-1][1])["nftables"]
        self.assertEqual(len(service_commands), 4)
        self.assertTrue(all(set(command) == {"add"} and set(command["add"]) == {"rule"}
                            and command["add"]["rule"]["table"] == self.boundary.table
                            for command in service_commands))

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
        self.assertTrue(all(set(cmd) <= {"create", "add", "delete"} for cmd in commands))
        self.assertTrue(all(set(cmd["add"]) == {"rule"} for cmd in commands if "add" in cmd))

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

    def test_memory_parser_refuses_create_rule_and_wrong_add_kinds_before_any_mutation(self):
        original = json.loads(self.boundary.render_guard())
        for kind in ("table", "chain", "rule"):
            document = copy.deepcopy(original)
            index = next(index for index, command in enumerate(document["nftables"])
                         if kind in next(iter(command.values())))
            obj = next(iter(document["nftables"][index].values()))
            document["nftables"][index] = {"create" if kind == "rule" else "add": obj}
            for args, mutation in ((("-c", "-f", "-"), False), (("-f", "-"), True)):
                with self.subTest(kind=kind, mutation=mutation):
                    backend = MemoryNft()
                    with self.assertRaisesRegex(ValueError, "memory_nft_command_syntax_invalid"):
                        backend.invoke(args, json.dumps(document), mutation=mutation)
                    self.assertEqual(backend.objects, [])
                    self.assertEqual(backend.next_handle, 10)

    def test_exclusive_table_and_chain_collisions_revert_the_entire_batch(self):
        self.boundary.install_guard()
        before = copy.deepcopy(self.backend.objects)
        before_handle = self.backend.next_handle
        extra_rule = copy.deepcopy(next(row for row in before if "rule" in row))
        extra_rule["rule"].pop("handle")
        extra_rule["rule"]["comment"] += ":disposable-extra"
        for kind in ("table", "chain"):
            with self.subTest(kind=kind):
                collision = copy.deepcopy(next(row for row in before if kind in row))
                collision[kind].pop("handle")
                # The staged ADD precedes the exclusive CREATE collision: both
                # owned existing rules and every previous handle must survive.
                script = json.dumps({"nftables": [{"add": extra_rule}, {"create": collision}]})
                self.backend.invoke(("-c", "-f", "-"), script)
                self.assertEqual(self.backend.objects, before)
                with self.assertRaisesRegex(RuntimeError, "collision"):
                    self.backend.invoke(("-f", "-"), script, mutation=True)
                self.assertEqual(self.backend.objects, before)
                self.assertEqual(self.backend.next_handle, before_handle)

    def test_exact_nft_table_listing_puts_all_chains_before_ordered_rules(self):
        self.boundary.install_guard()
        for services in (False, True):
            if services:
                self.boundary.add_service_fence(drain())
            rows = json.loads(self.backend.invoke(
                ("list", "table", "inet", self.boundary.table)))["nftables"][1:]
            kinds = [next(iter(row)) for row in rows]
            self.assertEqual(kinds, ["table", "chain", "chain"] + ["rule"] * (6 if services else 2))
            self.assertEqual([row["rule"]["chain"] for row in rows if "rule" in row],
                             ["output"] * (3 if services else 1) + ["input"] * (3 if services else 1))
            self.assertTrue(self.boundary.readback()["verified"])

    def test_swapped_rules_within_one_chain_still_hold_with_every_guard_retained(self):
        self.boundary.install_guard()
        self.boundary.add_service_fence(drain())
        indices = [index for index, row in enumerate(self.backend.objects)
                   if row.get("rule", {}).get("chain") == "output"]
        self.assertEqual(len(indices), 3)
        first, second = indices[:2]
        self.backend.objects[first], self.backend.objects[second] = (
            self.backend.objects[second], self.backend.objects[first])
        before = copy.deepcopy(self.backend.objects)
        with self.assertRaisesRegex(mod.BoundaryError, "boundary_readback_hold"):
            self.boundary.remove_service_fence(cleanup())
        self.assertEqual(self.boundary.phase, "hold")
        self.assertEqual(self.backend.objects, before)
        self.assertEqual(len(self.backend.writes()), 2)

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


DIAGNOSTIC_PHASES = frozenset((
    "unknown", "namespace-check", "loopback-up", "sentinel-create", "sentinel-read",
    "server-baseline", "guard-install", "guard-connectivity", "dependency-connectivity",
    "established-connect", "service-fence-install", "service-connectivity",
    "established-preserve", "invalid-cleanup-proof", "held-protection",
    "debugger-listener-close", "service-fence-remove", "service-reopen", "guard-remove",
    "sentinel-preservation", "complete"))
DIAGNOSTIC_COMMANDS = frozenset((
    "none", "unknown", "loopback-up", "nft-check", "nft-apply", "nft-read-owned",
    "nft-read-sentinel", "nft-list-tables"))
DIAGNOSTIC_CODES = frozenset((
    "none", "unknown", "proof_time_invalid", "proof_stale", "proof_operation_mismatch",
    "proof_pid_invalid", "proof_start_invalid", "proof_boot_invalid", "proof_source_mismatch",
    "control_drain_unverified", "control_drain_incomplete", "cleanup_unverified",
    "cleanup_outcome_unverified", "mutation_opt_in_invalid", "linux_root_required",
    "nft_command_not_allowed", "nft_command_kind_mismatch", "kernel_mutations_disabled",
    "nft_input_invalid", "nft_executable_untrusted", "nft_command_failed",
    "nft_readback_too_large", "nft_execution_failed", "readback_flags_invalid",
    "nonce_invalid", "phase_invalid", "boundary_command_hold", "readback_schema_invalid",
    "readback_object_invalid", "readback_object_forbidden", "readback_handle_invalid",
    "readback_duplicate", "readback_rules_mismatch", "readback_identity_changed",
    "boundary_readback_hold", "control_drain_proof_required", "cleanup_proof_required",
    "absence_invalid", "table_still_present", "boundary_cleanup_hold",
    "isolated_worker_requires_linux_root", "isolated_network_namespace_not_proven"))
DIAGNOSTIC_ERRORS = frozenset((
    "UnknownError", "AssertionError", "BoundaryError", "RuntimeError", "OSError",
    "CalledProcessError", "TimeoutExpired", "JSONDecodeError"))
DIAGNOSTIC_KEYS = frozenset((
    "nftables", "metainfo", "table", "chain", "rule", "family", "name", "type",
    "hook", "prio", "policy", "comment", "expr", "match", "op", "left", "right",
    "payload", "protocol", "field", "meta", "key", "reject", "drop", "fib", "result",
    "flags", "&", "handle"))
DIAGNOSTIC_DIFF_KINDS = frozenset(("type", "missing", "extra", "value", "length", "depth_limit"))
DIAGNOSTIC_TOKEN = r"(?:\[(?:[0-9]|[12][0-9]|3[01])\]|\.(?:" + "|".join(
    re.escape(key) for key in sorted(DIAGNOSTIC_KEYS | {"other"})) + r"))"
DIAGNOSTIC_PATH = re.compile(r"\$" + DIAGNOSTIC_TOKEN + r"{0,16}\Z")


def structural_diff(expected, actual):
    """Only fixed schema paths and kinds escape; leaf values never do."""
    differences = []

    def add(path, kind):
        if len(differences) < 16:
            entry = {"path": path, "kind": kind}
            if entry not in differences:
                differences.append(entry)

    def walk(wanted, observed, path="$", depth=0):
        if len(differences) >= 16:
            return
        if type(wanted) is not type(observed):
            add(path, "type")
        elif depth >= 16:
            if wanted != observed:
                add(path, "depth_limit")
        elif type(wanted) is dict:
            # Unknown keys collapse to one fixed token; never print their names.
            known = (set(wanted) | set(observed)) & DIAGNOSTIC_KEYS
            for key in sorted(known):
                child = path + "." + key
                if key not in wanted:
                    add(child, "extra")
                elif key not in observed:
                    add(child, "missing")
                else:
                    walk(wanted[key], observed[key], child, depth + 1)
            if set(observed) - DIAGNOSTIC_KEYS:
                add(path + ".other", "extra")
            if set(wanted) - DIAGNOSTIC_KEYS:
                add(path + ".other", "missing")
        elif type(wanted) is list:
            if len(wanted) != len(observed):
                add(path, "length")
            for index in range(min(len(wanted), len(observed), 32)):
                walk(wanted[index], observed[index], path + "[" + str(index) + "]", depth + 1)
        elif wanted != observed:
            add(path, "value")

    walk(expected, actual)
    return differences


def safe_failure_receipt(raw):
    """Revalidate child diagnostics; never interpolate arbitrary child output."""
    safe = {"schema": 1, "isolatedKernelProof": "failed", "phase": "unknown",
            "errorType": "UnknownError", "helperCode": "unknown", "commandKind": "unknown",
            "structuralDiff": []}
    try:
        if type(raw) is not str or len(raw) > 16384:
            return safe
        candidate = json.loads(raw.strip().splitlines()[-1])
        if type(candidate) is not dict or candidate.get("schema") != 1 \
                or candidate.get("isolatedKernelProof") != "failed":
            return safe
        for key, allowed in (("phase", DIAGNOSTIC_PHASES), ("errorType", DIAGNOSTIC_ERRORS),
                             ("helperCode", DIAGNOSTIC_CODES), ("commandKind", DIAGNOSTIC_COMMANDS)):
            if type(candidate.get(key)) is str and candidate[key] in allowed:
                safe[key] = candidate[key]
        rows = candidate.get("structuralDiff")
        if type(rows) is list:
            for row in rows[:16]:
                if (type(row) is dict and set(row) == {"path", "kind"}
                        and type(row["path"]) is str and len(row["path"]) <= 160
                        and DIAGNOSTIC_PATH.fullmatch(row["path"]) is not None
                        and type(row["kind"]) is str and row["kind"] in DIAGNOSTIC_DIFF_KINDS):
                    safe["structuralDiff"].append({"path": row["path"], "kind": row["kind"]})
    except (ValueError, IndexError, RecursionError):
        pass
    return safe


class WorkerDiagnostics:
    """Disposable-worker instrumentation; no adapter decisions are changed."""

    def __init__(self):
        self.phase = "unknown"
        self.code = "none"
        self.command = "none"
        self.boundary = None
        self.services = False
        self.last_owned_read = None
        self.original_need = mod._need

    def enter(self, phase):
        assert phase in DIAGNOSTIC_PHASES
        self.phase, self.code, self.command = phase, "none", "none"
        self.last_owned_read = None

    def need(self, value, code):
        if not value and self.code == "none":
            self.code = code if type(code) is str and code in DIAGNOSTIC_CODES else "unknown"
        return self.original_need(value, code)

    def failure(self, error):
        error_type = "UnknownError"
        for kind in (mod.BoundaryError, subprocess.CalledProcessError, subprocess.TimeoutExpired,
                     json.JSONDecodeError, AssertionError, OSError, RuntimeError):
            if isinstance(error, kind):
                error_type = kind.__name__
                break
        code = self.code
        if code == "none" and type(error) in (mod.BoundaryError, RuntimeError):
            # Only an exact literal already in the allowlist can be retained.
            code = str(error) if str(error) in DIAGNOSTIC_CODES else "unknown"
        differences = []
        if code == "readback_rules_mismatch" and self.last_owned_read is not None:
            try:
                actual = []
                for row in json.loads(self.last_owned_read)["nftables"]:
                    if set(row) == {"metainfo"}:
                        continue
                    row = copy.deepcopy(row)
                    for value in row.values():
                        if type(value) is dict:
                            value.pop("handle", None)
                    actual.append(mod._canonical(row))
                expected = [mod._canonical(row) for row in self.boundary._objects(self.services)]
                differences = structural_diff(expected, actual)
            except Exception:
                # Diagnostic parsing cannot mask the original failure or leak data.
                pass
        return safe_failure_receipt(json.dumps({
            "schema": 1, "isolatedKernelProof": "failed", "phase": self.phase,
            "errorType": error_type, "helperCode": code, "commandKind": self.command,
            "structuralDiff": differences}))


class DiagnosticKernelBackend(mod.KernelBackend):
    def __init__(self, diagnostics):
        self.diagnostics = diagnostics
        super().__init__(enable_mutations=True)

    def invoke(self, args, script=None, *, mutation=False):
        diag = self.diagnostics
        owned_read = (diag.boundary is not None
                      and args == ("list", "table", "inet", diag.boundary.table))
        diag.command = ("nft-check" if args == ("-c", "-f", "-") else
                        "nft-apply" if args == ("-f", "-") else
                        "nft-list-tables" if args == ("list", "tables", "inet") else
                        "nft-read-owned" if owned_read else
                        "nft-read-sentinel" if len(args) == 4 and args[:3] == ("list", "table", "inet")
                        else "unknown")
        output = super().invoke(args, script, mutation=mutation)
        if owned_read:
            diag.last_owned_read = output  # Memory only; never include raw readback in a receipt.
        if mutation and diag.phase in ("guard-install", "service-fence-install", "service-fence-remove"):
            diag.services = diag.phase == "service-fence-install"
        return output


class DiagnosticTests(unittest.TestCase):
    def test_structural_diff_contains_fixed_paths_and_no_leaf_values_or_identifiers(self):
        private = "PRIVATE-DIAGNOSTIC-SENTINEL"
        expected = [{"rule": {"comment": private, "expr": [{"reject": {"type": "tcp reset"}}]}}]
        actual = [{"rule": {"comment": private + "-changed",
                            "expr": [{"reject": {"type": "changed", private: private}}]}}]
        rows = structural_diff(expected, actual)
        self.assertEqual(rows, [{"path": "$[0].rule.comment", "kind": "value"},
                                {"path": "$[0].rule.expr[0].reject.type", "kind": "value"},
                                {"path": "$[0].rule.expr[0].reject.other", "kind": "extra"}])
        self.assertNotIn(private, json.dumps(rows))
        self.assertTrue(all(DIAGNOSTIC_PATH.fullmatch(row["path"]) for row in rows))

    def test_structural_diff_and_parent_validation_are_bounded(self):
        rows = structural_diff([{"rule": {"comment": "a"}}] * 1000,
                               [{"rule": {"comment": "b"}}] * 1000)
        self.assertEqual(len(rows), 16)
        nested = {"rule": "a"}
        altered = {"rule": "b"}
        for _ in range(100):
            nested, altered = {"expr": nested}, {"expr": altered}
        self.assertEqual(structural_diff(nested, altered)[0]["kind"], "depth_limit")
        self.assertEqual(len(safe_failure_receipt("x" * 16385)["structuralDiff"]), 0)

    def test_parent_drops_untrusted_worker_fields_paths_and_error_text(self):
        private = "PRIVATE-DIAGNOSTIC-SENTINEL"
        candidate = {"schema": 1, "isolatedKernelProof": "failed", "phase": private,
                     "helperCode": private, "errorType": private, "commandKind": private,
                     "output": private, "structuralDiff": [
                         {"path": "$." + private, "kind": "extra"},
                         {"path": "$[0].rule", "kind": private},
                         {"path": "$[0].rule", "kind": "extra", "value": private},
                         {"path": "$[0].rule.expr[0].reject.type", "kind": "value"}]}
        receipt = safe_failure_receipt(json.dumps(candidate))
        self.assertEqual(receipt["structuralDiff"], [
            {"path": "$[0].rule.expr[0].reject.type", "kind": "value"}])
        self.assertEqual(receipt["phase"], "unknown")
        self.assertNotIn(private, json.dumps(receipt))
        for raw in ("", "not json", "[]", "null", "{\"schema\": 1}", "[" * 2000 + "0" + "]" * 2000):
            self.assertEqual(safe_failure_receipt(raw)["phase"], "unknown")

    def test_need_instrumentation_preserves_failure_and_retains_inner_fixed_code(self):
        diag = WorkerDiagnostics()
        diag.enter("guard-install")
        with patch.object(mod, "_need", diag.need):
            with self.assertRaisesRegex(mod.BoundaryError, "boundary_readback_hold") as caught:
                try:
                    mod._need(False, "readback_rules_mismatch")
                except mod.BoundaryError:
                    raise mod.BoundaryError("boundary_readback_hold") from None
            self.assertIsNone(mod._need(True, "proof_stale"))
        receipt = diag.failure(caught.exception)
        self.assertEqual(receipt["helperCode"], "readback_rules_mismatch")
        self.assertEqual(receipt["errorType"], "BoundaryError")
        self.assertIs(mod._need, diag.original_need)
        diag.enter("held-protection")
        self.assertEqual(diag.code, "none")

    def test_worker_readback_diff_strips_handles_and_only_reports_schema_locations(self):
        diag = WorkerDiagnostics()
        diag.enter("guard-install")
        diag.boundary = mod.NetworkBoundary(NONCE, backend=MemoryNft())
        objects = copy.deepcopy(diag.boundary._objects(False))
        for index, row in enumerate(objects):
            next(iter(row.values()))["handle"] = index + 1
        rule_index = next(index for index, row in enumerate(objects) if "rule" in row)
        objects[rule_index]["rule"]["expr"][-1]["reject"]["expr"] = "PRIVATE-DIAGNOSTIC-SENTINEL"
        diag.last_owned_read = json.dumps({"nftables": [{"metainfo": {}}, *objects]})
        diag.code = "readback_rules_mismatch"
        receipt = diag.failure(mod.BoundaryError("boundary_readback_hold"))
        self.assertEqual(receipt["structuralDiff"], [
            {"path": "$[" + str(rule_index) + "].rule.expr[3].reject.expr", "kind": "extra"}])
        self.assertNotIn("PRIVATE", json.dumps(receipt))
        self.assertNotIn(NONCE, json.dumps(receipt))

    def test_backend_records_fixed_kind_without_changing_arguments_or_output(self):
        diag = WorkerDiagnostics()
        diag.enter("service-fence-install")
        backend = DiagnosticKernelBackend(diag)
        diag.boundary = mod.NetworkBoundary(NONCE, backend=backend)
        raw = '{"nftables":[]}'
        with patch.object(mod.KernelBackend, "invoke", return_value=raw) as invoke:
            self.assertEqual(backend.invoke(("-f", "-"), raw, mutation=True), raw)
            invoke.assert_called_once_with(("-f", "-"), raw, mutation=True)
            self.assertEqual(diag.command, "nft-apply")
            self.assertTrue(diag.services)
        with patch.object(mod.KernelBackend, "invoke", return_value=raw) as invoke:
            args = ("list", "table", "inet", diag.boundary.table)
            self.assertEqual(backend.invoke(args), raw)
            invoke.assert_called_once_with(args, None, mutation=False)
            self.assertEqual(diag.command, "nft-read-owned")
            self.assertEqual(diag.last_owned_read, raw)

    def test_namespace_failure_precedes_any_network_command(self):
        diag = WorkerDiagnostics()
        with patch.object(sys, "platform", "linux"), patch.object(os, "geteuid", return_value=0), \
                patch.object(os, "readlink", return_value="net:[same]"), \
                patch.object(subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "isolated_network_namespace_not_proven") as caught:
                isolated_worker("net:[same]", diag)
            run.assert_not_called()
        receipt = diag.failure(caught.exception)
        self.assertEqual(receipt["phase"], "namespace-check")
        self.assertEqual(receipt["helperCode"], "isolated_network_namespace_not_proven")
        self.assertNotIn("net:[same]", json.dumps(receipt))

    def test_parent_reports_only_sanitized_receipt_on_worker_failure_or_timeout(self):
        private = "PRIVATE-DIAGNOSTIC-SENTINEL"
        raw = json.dumps({"schema": 1, "isolatedKernelProof": "failed", "phase": "guard-install",
                          "errorType": "BoundaryError", "helperCode": "readback_rules_mismatch",
                          "commandKind": "nft-read-owned", "output": private, "structuralDiff": [
                              {"path": "$[2].rule.expr[3].reject.expr", "kind": "extra"}]})
        worker_failure = subprocess.CompletedProcess([], 1, raw, private)
        worker_timeout = subprocess.TimeoutExpired([private], 45, output=private, stderr=private)
        for outcome in (worker_failure, worker_timeout):
            with self.subTest(timeout=isinstance(outcome, subprocess.TimeoutExpired)), \
                    patch.object(sys, "platform", "linux"), patch.object(os, "geteuid", return_value=0), \
                    patch.object(os, "readlink", return_value="net:[private]"), \
                    patch.object(shutil, "which", side_effect=lambda name: "/fixed/" + name), \
                    patch.object(subprocess, "run", side_effect=[subprocess.CompletedProcess([], 0), outcome]):
                case = IsolatedKernelTests("test_actual_linux_root_and_nonroot_connections")
                with self.assertRaises(AssertionError) as caught:
                    case.test_actual_linux_root_and_nonroot_connections()
            text = str(caught.exception)
            self.assertNotIn(private, text)
            self.assertNotIn("net:[private]", text)
            self.assertIn("TimeoutExpired" if isinstance(outcome, subprocess.TimeoutExpired)
                          else "readback_rules_mismatch", text)


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


def isolated_worker(parent_identity, diagnostics):
    diagnostics.enter("namespace-check")
    # This check precedes EVERY network mutation, including bringing up lo.
    if sys.platform != "linux" or os.geteuid() != 0:
        raise RuntimeError("isolated_worker_requires_linux_root")
    current = os.readlink("/proc/self/ns/net")
    actual_parent = os.readlink("/proc/" + str(os.getppid()) + "/ns/net")
    if (not parent_identity.startswith("net:[") or current == parent_identity
            or actual_parent != parent_identity or current == actual_parent):
        raise RuntimeError("isolated_network_namespace_not_proven")
    diagnostics.enter("loopback-up")
    diagnostics.command = "loopback-up"
    subprocess.run(("ip", "link", "set", "lo", "up"), check=True, capture_output=True)
    backend = DiagnosticKernelBackend(diagnostics)
    # A disposable unrelated table proves lifecycle operations preserve others.
    sentinel = "gd36_" + secrets.token_hex(16)
    diagnostics.enter("sentinel-create")
    backend.invoke(("-f", "-"), json.dumps({"nftables": [{"create": {"table": {
        "family": "inet", "name": sentinel}}}]}), mutation=True)
    diagnostics.enter("sentinel-read")
    sentinel_before = backend.invoke(("list", "table", "inet", sentinel))
    servers = []
    established = None
    boundary = mod.NetworkBoundary(secrets.token_hex(16), backend=backend)
    diagnostics.boundary = boundary
    try:
        diagnostics.enter("server-baseline")
        for port in (9229, 17778, 17779, 18080):
            server = EchoServer(("127.0.0.1", port), Echo)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            servers.append(server)
        assert all(_nonroot(port) and _root(port) for port in (9229, 17778, 17779, 18080))
        diagnostics.enter("guard-install")
        boundary.install_guard()
        diagnostics.enter("guard-connectivity")
        assert _root(9229) and not _nonroot(9229)
        # Receiver dependency connections remain possible before Control drain.
        diagnostics.enter("dependency-connectivity")
        assert _nonroot(17778) and _nonroot(17779) and _nonroot(18080)
        diagnostics.enter("established-connect")
        established = subprocess.Popen((sys.executable, "-c", CLIENT, "17779", "hold"),
                                       text=True, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE)
        assert json.loads(established.stdout.readline())["connected"] is True
        diagnostics.enter("service-fence-install")
        boundary.add_service_fence(drain(boundary.nonce))
        diagnostics.enter("service-connectivity")
        assert not _nonroot(17778) and not _nonroot(17779)
        assert all(_root(port) for port in (9229, 17778, 17779, 18080)) and _nonroot(18080)
        diagnostics.enter("established-preserve")
        established.stdin.write("continue\n"); established.stdin.flush()
        assert json.loads(established.stdout.readline())["establishedPreserved"] is True
        assert established.wait(timeout=5) == 0
        # Failed cleanup proof leaves both guard and admissions in effect.
        diagnostics.enter("invalid-cleanup-proof")
        try:
            boundary.remove_service_fence(cleanup(boundary.nonce, debugger_absent=False))
            raise AssertionError("incomplete proof accepted")
        except mod.BoundaryError:
            pass
        diagnostics.enter("held-protection")
        assert not _nonroot(9229) and not _nonroot(17779)
        diagnostics.enter("debugger-listener-close")
        servers[0].shutdown(); servers[0].server_close()
        try:
            socket.create_connection(("127.0.0.1", 9229), timeout=0.2)
            raise AssertionError("debugger test listener remains")
        except OSError:
            pass
        diagnostics.enter("service-fence-remove")
        boundary.remove_service_fence(cleanup(boundary.nonce))
        diagnostics.enter("service-reopen")
        assert _nonroot(17778) and _nonroot(17779)
        diagnostics.enter("guard-remove")
        boundary.remove_guard(cleanup(boundary.nonce))
        diagnostics.enter("sentinel-preservation")
        assert backend.invoke(("list", "table", "inet", sentinel)) == sentinel_before
        diagnostics.enter("complete")
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
        result = None
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=45)
        except subprocess.TimeoutExpired:
            pass
        if result is None:
            receipt = safe_failure_receipt("")
            receipt["errorType"] = "TimeoutExpired"
            # Outside the except block: unittest must not print the raw command
            # or captured child output from a chained TimeoutExpired exception.
            self.fail("isolated kernel proof timed out: " + json.dumps(receipt, sort_keys=True))
        if result.returncode != 0:
            self.fail("isolated kernel proof failed (exit " + str(result.returncode) + "): "
                      + json.dumps(safe_failure_receipt(result.stdout), sort_keys=True))
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt["isolatedKernelProof"], "passed")
        self.assertTrue(all(value is True for key, value in receipt.items()
                            if key != "isolatedKernelProof"))


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--netns-child":
        diagnostics = WorkerDiagnostics()
        try:
            # Retain an inner fixed helper code before its public HOLD wrapper;
            # the original _need still makes every admission/error decision.
            with patch.object(mod, "_need", diagnostics.need):
                isolated_worker(sys.argv[2], diagnostics)
        except Exception as error:
            # No nft output, environment, request objects, or source values.
            print(json.dumps(diagnostics.failure(error)), flush=True)
            raise SystemExit(1)
    else:
        unittest.main(verbosity=2)
