#!/usr/bin/env python3
"""Release36's one-table network guard. The CLI only renders JSON; it cannot apply it.

The root controller must explicitly construct KernelBackend(enable_mutations=True).
Proofs are typed, fresh observations from that controller, not substitutes for its
PID/source/inspector checks. No proof may be reconstructed from an old receipt.
Failures deliberately retain installed rules; there is no finally/exit cleanup.
"""
from __future__ import annotations

import argparse
import copy
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

sys.dont_write_bytecode = True
CONTROL_SHA256 = "176ebea80c72bb6ae73017d58829fdde50489164a1a26319fb49699424e391d2"
NONCE = re.compile(r"[0-9a-f]{32}\Z")
BOOT_ID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
FRESH_SECONDS = 10.0


class BoundaryError(RuntimeError):
    """A fixed, sanitized code; never includes command output or caller values."""


def _need(value: bool, code: str) -> None:
    if not value:
        raise BoundaryError(code)


def _fresh(value: float) -> None:
    _need(type(value) in (int, float) and math.isfinite(value), "proof_time_invalid")
    _need(0 <= time.monotonic() - value <= FRESH_SECONDS, "proof_stale")


@dataclass(frozen=True)
class ControlDrainProof:
    operation_nonce: str
    pid: int
    start_ticks: int
    boot_id: str
    source_sha256: str
    observed_monotonic: float
    provenance_verified: bool
    normal_callback_installed: bool
    map_fence_immutable: bool
    map_size: int
    server_closed: bool
    refused_responses: int
    cgroup_children: int
    inspector_absent: bool

    def validate(self, nonce: str) -> None:
        _need(self.operation_nonce == nonce, "proof_operation_mismatch")
        _fresh(self.observed_monotonic)
        _need(type(self.pid) is int and self.pid > 1, "proof_pid_invalid")
        _need(type(self.start_ticks) is int and self.start_ticks > 0, "proof_start_invalid")
        _need(type(self.boot_id) is str and BOOT_ID.fullmatch(self.boot_id) is not None,
              "proof_boot_invalid")
        _need(self.source_sha256 == CONTROL_SHA256, "proof_source_mismatch")
        for value in (self.provenance_verified, self.normal_callback_installed,
                      self.map_fence_immutable, self.server_closed, self.inspector_absent):
            _need(value is True, "control_drain_unverified")
        for value in (self.map_size, self.refused_responses, self.cgroup_children):
            _need(type(value) is int and value == 0, "control_drain_incomplete")


@dataclass(frozen=True)
class CleanupProof:
    operation_nonce: str
    observed_monotonic: float
    debugger_absent: bool
    process_identities_verified: bool
    preserved_state_verified: bool
    healthy: bool = False
    rollback_complete: bool = False

    def validate(self, nonce: str) -> None:
        _need(self.operation_nonce == nonce, "proof_operation_mismatch")
        _fresh(self.observed_monotonic)
        for value in (self.debugger_absent, self.process_identities_verified,
                      self.preserved_state_verified):
            _need(value is True, "cleanup_unverified")
        _need(type(self.healthy) is bool and type(self.rollback_complete) is bool
              and (self.healthy or self.rollback_complete), "cleanup_outcome_unverified")


class KernelBackend:
    """Fixed nft executable, no shell, sanitized errors, explicit mutation opt-in."""

    def __init__(self, *, enable_mutations: bool = False):
        _need(type(enable_mutations) is bool, "mutation_opt_in_invalid")
        self.enable_mutations = enable_mutations

    def invoke(self, args: tuple[str, ...], script: str | None = None,
               *, mutation: bool = False) -> str:
        _need(sys.platform == "linux" and os.geteuid() == 0, "linux_root_required")
        apply = args == ("-f", "-")
        read = (args == ("list", "tables", "inet") or
                (len(args) == 4 and args[:3] == ("list", "table", "inet")
                 and type(args[3]) is str
                 and re.fullmatch(r"gd36_[0-9a-f]{32}", args[3]) is not None))
        check = args == ("-c", "-f", "-")
        _need(apply or check or read, "nft_command_not_allowed")
        _need(type(mutation) is bool and mutation == apply, "nft_command_kind_mismatch")
        _need(not apply or self.enable_mutations, "kernel_mutations_disabled")
        _need((read and script is None) or
              ((apply or check) and type(script) is str and 0 < len(script) <= 65536),
              "nft_input_invalid")
        # The adapter supplies every argument; caller-provided command strings,
        # executable paths, include files, and environment overrides are absent.
        binary = Path("/usr/sbin/nft")
        try:
            info = binary.resolve(strict=True).stat()
            _need(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                  and info.st_mode & 0o022 == 0, "nft_executable_untrusted")
            completed = subprocess.run(
                (str(binary), "-j", "-n", *args), input=script, text=True,
                capture_output=True, timeout=15, check=False,
                env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"})
            _need(completed.returncode == 0, "nft_command_failed")
            _need(len(completed.stdout) <= 65536, "nft_readback_too_large")
            return completed.stdout
        except BoundaryError:
            raise
        except Exception:
            raise BoundaryError("nft_execution_failed") from None


def _match(left: dict, right: object, op: str = "==") -> dict:
    return {"match": {"op": op, "left": left, "right": right}}


def _meta(key: str) -> dict:
    return {"meta": {"key": key}}


def _tcp_port(port: int) -> dict:
    return _match({"payload": {"protocol": "tcp", "field": "dport"}}, port)


def _initial_syn() -> dict:
    # SYN without ACK/RST/FIN: established connections and their ACK/data pass.
    return _match({"&": [{"payload": {"protocol": "tcp", "field": "flags"}},
                           0x17]}, 0x02)


def _flag_bits(value: object) -> int:
    # nft versions may print this same typed bitmask as names or a number.
    names = {"fin": 1, "syn": 2, "rst": 4, "psh": 8, "ack": 16,
             "urg": 32, "ecn": 64, "cwr": 128}
    if type(value) is int:
        _need(0 <= value <= 255, "readback_flags_invalid")
        return value
    if type(value) is str:
        _need(value in names, "readback_flags_invalid")
        return names[value]
    _need(type(value) is list and len(value) > 0, "readback_flags_invalid")
    result = 0
    for item in value:
        result |= _flag_bits(item)
    return result


def _canonical(obj: dict) -> dict:
    """Normalize only documented equivalent flag encodings, never rule scope."""
    obj = copy.deepcopy(obj)
    for expression in obj.get("rule", {}).get("expr", []):
        match = expression.get("match", {})
        left = match.get("left", {})
        if left.get("fib", {}).get("flags") == "daddr":
            left["fib"]["flags"] = ["daddr"]
        operands = left.get("&")
        if (type(operands) is list and len(operands) == 2
                and operands[0] == {"payload": {"protocol": "tcp", "field": "flags"}}):
            operands[1] = _flag_bits(operands[1])
            match["right"] = _flag_bits(match.get("right"))
    return obj


class NetworkBoundary:
    """Own one fresh nonce table; require exact contents AND retained handles.

    install_guard -> readback -> add_service_fence(ControlDrainProof) ->
    remove_service_fence(CleanupProof) -> remove_guard(CleanupProof).
    Only an identical same-object install is usable; a preexisting table is never
    adopted, flushed, replaced, or removed. No code runs on object destruction.
    """

    def __init__(self, nonce: str, *, backend=None):
        _need(type(nonce) is str and NONCE.fullmatch(nonce) is not None, "nonce_invalid")
        self.nonce = nonce
        self.table = "gd36_" + nonce
        self.backend = backend if backend is not None else KernelBackend()
        self.phase = "new"
        self._handles: dict[str, int] = {}

    def _rule(self, chain: str, label: str, expr: list) -> dict:
        return {"rule": {"family": "inet", "table": self.table, "chain": chain,
                         "comment": "gd36:" + self.nonce + ":" + label, "expr": expr}}

    def _objects(self, services: bool) -> list[dict]:
        objects = [{"table": {"family": "inet", "name": self.table}}]
        for name in ("output", "input"):
            objects.append({"chain": {"family": "inet", "table": self.table,
                                       "name": name, "type": "filter", "hook": name,
                                       "prio": -300, "policy": "accept"}})
        objects += [
            self._rule("output", "debugger-uid", [
                _match({"payload": {"protocol": "ip", "field": "daddr"}}, "127.0.0.1"),
                _tcp_port(9229), _match(_meta("skuid"), 0, "!="),
                {"reject": {"type": "tcp reset"}}]),
            self._rule("input", "debugger-input", [
                _match(_meta("iifname"), "lo", "!="), _tcp_port(9229), {"drop": None}])]
        if services:
            for port in (17778, 17779):
                objects += [
                    self._rule("output", "service-uid-" + str(port), [
                        _match({"fib": {"result": "type", "flags": ["daddr"]}}, "local"),
                        _tcp_port(port), _match(_meta("skuid"), 0, "!="), _initial_syn(),
                        {"reject": {"type": "tcp reset"}}]),
                    self._rule("input", "service-input-" + str(port), [
                        _match(_meta("iifname"), "lo", "!="), _tcp_port(port),
                        _initial_syn(), {"drop": None}])]
        # nftables1.0.9 lists all chain declarations before their rules.
        # Rules remain grouped by chain in their exact evaluation order.
        return [obj for obj in objects if "table" in obj or "chain" in obj] + [
            obj for chain in ("output", "input") for obj in objects
            if obj.get("rule", {}).get("chain") == chain]

    def render_guard(self) -> str:
        return json.dumps({"nftables": [{"add" if "rule" in obj else "create": obj}
                                      for obj in self._objects(False)]},
                          sort_keys=True, separators=(",", ":")) + "\n"

    def _check(self, script: str) -> None:
        self.backend.invoke(("-c", "-f", "-"), script)

    def check_guard(self) -> None:
        _need(self.phase == "new", "phase_invalid")
        self._check(self.render_guard())

    def _execute(self, script: str) -> None:
        try:
            self._check(script)
            self.backend.invoke(("-f", "-"), script, mutation=True)
        except Exception:
            self.phase = "hold"
            raise BoundaryError("boundary_command_hold") from None

    @staticmethod
    def _key(kind: str, obj: dict) -> str:
        return kind + ":" + (obj["comment"] if kind == "rule" else obj["name"])

    def _read(self, services: bool, *, capture_new: bool = False) -> dict:
        try:
            raw = self.backend.invoke(("list", "table", "inet", self.table))
            _need(len(raw) <= 65536, "nft_readback_too_large")
            document = json.loads(raw)
            _need(type(document) is dict and set(document) == {"nftables"}
                  and type(document["nftables"]) is list, "readback_schema_invalid")
            normalized, handles = [], {}
            for item in document["nftables"]:
                _need(type(item) is dict and len(item) == 1, "readback_object_invalid")
                if set(item) == {"metainfo"}:
                    continue
                kind, value = next(iter(item.items()))
                _need(kind in ("table", "chain", "rule") and type(value) is dict,
                      "readback_object_forbidden")
                value = copy.deepcopy(value)
                handle = value.pop("handle", None)
                _need(type(handle) is int and handle > 0, "readback_handle_invalid")
                key = self._key(kind, value)
                _need(key not in handles, "readback_duplicate")
                handles[key] = handle
                normalized.append(_canonical({kind: value}))
            _need(normalized == [_canonical(obj) for obj in self._objects(services)],
                  "readback_rules_mismatch")
            if capture_new:
                # Existing objects must retain their kernel identities on updates.
                _need(all(handles.get(k) == v for k, v in self._handles.items()),
                      "readback_identity_changed")
                self._handles = handles
            else:
                _need(handles == self._handles, "readback_identity_changed")
            return {"table": self.table, "verified": True, "phase": self.phase,
                    "ruleCount": 6 if services else 2}
        except Exception:
            self.phase = "hold"
            raise BoundaryError("boundary_readback_hold") from None

    def install_guard(self) -> dict:
        _need(self.phase == "new", "phase_invalid")
        # Exclusive table/chain CREATE and rule ADD share one atomic batch.
        # Table nonce collisions refuse the entire batch; nothing is adopted
        # or deleted before creation, even when existing contents match.
        self._execute(self.render_guard())
        self.phase = "guard"
        return self._read(False, capture_new=True)

    def readback(self) -> dict:
        _need(self.phase in ("guard", "services"), "phase_invalid")
        return self._read(self.phase == "services")

    def add_service_fence(self, proof: ControlDrainProof) -> dict:
        _need(self.phase == "guard", "phase_invalid")
        _need(type(proof) is ControlDrainProof, "control_drain_proof_required")
        proof.validate(self.nonce)
        self._read(False)
        script = json.dumps({"nftables": [{"add": obj} for obj in self._objects(True)
                            if "rule" in obj and ":service-" in obj["rule"]["comment"]]})
        self._check(script)
        proof.validate(self.nonce)  # No asynchronous check may stale the proof.
        try:
            self.backend.invoke(("-f", "-"), script, mutation=True)
        except Exception:
            self.phase = "hold"
            raise BoundaryError("boundary_command_hold") from None
        self.phase = "services"
        return self._read(True, capture_new=True)

    def remove_service_fence(self, proof: CleanupProof) -> dict:
        _need(self.phase == "services", "phase_invalid")
        _need(type(proof) is CleanupProof, "cleanup_proof_required")
        proof.validate(self.nonce)
        self._read(True)
        objects = self._objects(True)
        commands = []
        for obj in objects:
            if "rule" in obj and ":service-" in obj["rule"]["comment"]:
                rule = obj["rule"]
                commands.append({"delete": {"rule": {
                    "family": "inet", "table": self.table, "chain": rule["chain"],
                    "handle": self._handles[self._key("rule", rule)]}}})
        script = json.dumps({"nftables": commands})
        self._check(script)
        proof.validate(self.nonce)
        try:
            self.backend.invoke(("-f", "-"), script, mutation=True)
        except Exception:
            self.phase = "hold"
            raise BoundaryError("boundary_command_hold") from None
        self._handles = {k: v for k, v in self._handles.items() if ":service-" not in k}
        self.phase = "guard"
        return self._read(False)

    def remove_guard(self, proof: CleanupProof) -> dict:
        _need(self.phase == "guard", "phase_invalid")
        _need(type(proof) is CleanupProof, "cleanup_proof_required")
        proof.validate(self.nonce)
        self._read(False)
        # A table handle pins this exact created instance, not merely its name.
        script = json.dumps({"nftables": [{"delete": {"table": {
            "family": "inet", "handle": self._handles["table:" + self.table]}}}]})
        self._check(script)
        proof.validate(self.nonce)
        try:
            self.backend.invoke(("-f", "-"), script, mutation=True)
            # A successful read of the table list is needed to prove absence.
            raw = self.backend.invoke(("list", "tables", "inet"))
            document = json.loads(raw)
            _need(type(document) is dict and set(document) == {"nftables"}, "absence_invalid")
            _need(type(document["nftables"]) is list, "absence_invalid")
            for obj in document["nftables"]:
                _need(type(obj) is dict and len(obj) == 1, "absence_invalid")
                if "metainfo" in obj:
                    continue
                _need(set(obj) == {"table"} and type(obj["table"]) is dict,
                      "absence_invalid")
                _need(obj["table"].get("family") == "inet"
                      and obj["table"].get("name") != self.table, "table_still_present")
        except Exception:
            self.phase = "hold"
            raise BoundaryError("boundary_cleanup_hold") from None
        self.phase = "removed"
        return {"table": self.table, "verified": True, "phase": "removed", "ruleCount": 0}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nonce", required=True, help="32 lower-case hexadecimal characters")
    args = parser.parse_args()
    try:
        print(NetworkBoundary(args.nonce).render_guard(), end="")
    except BoundaryError as error:
        parser.exit(2, str(error) + "\n")


if __name__ == "__main__":
    main()
