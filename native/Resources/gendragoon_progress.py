"""Private, optional upload telemetry. No paths, credentials, or item names.

The parent owns the progress directory and polls one atomic JSON snapshot.
Telemetry errors must never change backup, verification, or offload results.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import math
from pathlib import Path
import re
import stat
import threading
import time
import uuid

PHASES = frozenset(("preparing", "archiving", "encoding", "uploading", "publishing",
                    "readback", "decoding", "restoring", "verifying", "offloading", "complete"))
COUNTERS = frozenset(("completed_bytes", "total_bytes", "uploaded_bytes", "downloaded_bytes",
                      "encoded_bytes", "objects_done", "objects_total"))
MAX_VALUE = 2 ** 53 - 1
MAX_SNAPSHOT = 4096
MIN_INTERVAL = .2
ENVIRONMENT = "GD_UPLOAD_PROGRESS_FILE"
_instance = None
_instance_key = None
_instance_lock = threading.Lock()


def _number(value):
    return (type(value) in (int, float) and math.isfinite(value)
            and 0 <= value <= MAX_VALUE)


class _Reporter:
    def __init__(self, path, home=None):
        self.lock = threading.RLock()
        self.fd = None
        self.name = None
        self.last_write = 0.0
        self.stage_start = time.monotonic()
        self.state = {"schema": 1, "phase": "preparing", "completed_bytes": 0,
                      "total_bytes": 0, "uploaded_bytes": 0, "downloaded_bytes": 0,
                      "encoded_bytes": 0, "objects_done": 0, "objects_total": 0}
        self.active = {}
        self.sequence = 0
        self.network_busy_start = None
        self.network_wall = 0.0
        self.network_serial = 0.0
        try:
            destination = Path(path)
            home = Path.home() if home is None else Path(home)
            expected = home / "Library/Application Support/GenDragoon Cloud SSD/UploadWorkspace/Progress"
            if (not destination.is_absolute() or destination.parent != expected
                    or not re.fullmatch(r"[a-f0-9]{32}-[a-f0-9]{32}\.json", destination.name)):
                return
            # Refuse linked ancestry; open relative to directory descriptors so
            # a renamed path cannot redirect a later snapshot into another file.
            if any(p.is_symlink() for p in (home, *home.parents)):
                return
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            descriptor = os.open(home, flags)
            try:
                for part in (None, "Library", "Application Support", "GenDragoon Cloud SSD", "UploadWorkspace", "Progress"):
                    if part is not None:
                        next_descriptor = os.open(part, flags, dir_fd=descriptor)
                        os.close(descriptor)
                        descriptor = next_descriptor
                    metadata = os.fstat(descriptor)
                    if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
                        return
                if metadata.st_mode & 0o077:
                    return
                self._check_file(descriptor, destination.name)
                self.fd, descriptor = descriptor, None
                self.name = destination.name
            finally:
                if descriptor is not None:
                    os.close(descriptor)
        except (OSError, TypeError, ValueError):
            self.close()

    @staticmethod
    def _check_file(descriptor, name):
        try:
            value = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return
        if (not stat.S_ISREG(value.st_mode) or value.st_uid != os.getuid()
                or value.st_nlink != 1 or value.st_mode & 0o077):
            raise ValueError("Unsafe progress snapshot")

    def close(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def _emit(self, force=False):
        if self.fd is None:
            return
        now = time.monotonic()
        if not force and now - self.last_write < MIN_INTERVAL:
            return
        import json
        value = dict(self.state, updated_at=time.time())
        done, total = value["completed_bytes"], value["total_bytes"]
        elapsed = now - self.stage_start
        if elapsed >= 1 and done > 0 and total > done:
            value["eta_seconds"] = min(MAX_VALUE, (total - done) * elapsed / done)
        active_wall = 0 if self.network_busy_start is None else now - self.network_busy_start
        network_wall = self.network_wall + active_wall
        serial = self.network_serial + sum(now - start for start in self.active.values())
        network_bytes = value["uploaded_bytes"] + value["downloaded_bytes"]
        if network_bytes > 0 and network_wall > 0:
            value.update(network_elapsed_seconds=network_wall,
                         baseline_network_seconds=serial,
                         saved_network_seconds=max(0.0, serial - network_wall),
                         rate_bytes_per_second=network_bytes / network_wall)
        # Only these typed fields can reach disk. Never serialize caller objects.
        value = {k: v for k, v in value.items()
                 if k == "phase" and v in PHASES or k != "phase" and _number(v)}
        raw = json.dumps(value, separators=(",", ":"), allow_nan=False).encode()
        if len(raw) > MAX_SNAPSHOT:
            return
        temporary = ".progress-" + uuid.uuid4().hex
        try:
            self._check_file(self.fd, self.name)
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                 0o600, dir_fd=self.fd)
            with os.fdopen(descriptor, "wb") as output:
                output.write(raw)
            os.replace(temporary, self.name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            self.last_write = now
        except (OSError, ValueError):
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except OSError:
                pass
            self.close()
        finally:
            if self.fd is not None:
                try:
                    os.unlink(temporary, dir_fd=self.fd)
                except FileNotFoundError:
                    pass

    def phase(self, name, total_bytes=0, completed_bytes=0, workers=None, **fields):
        with self.lock:
            if not isinstance(name, str) or name not in PHASES:
                return
            self.state["phase"] = name
            self.stage_start = time.monotonic()
            self.state["total_bytes"] = int(total_bytes) if _number(total_bytes) else 0
            self.state["completed_bytes"] = int(completed_bytes) if _number(completed_bytes) else 0
            self.update(workers=workers, **fields, _force=True)

    def update(self, _force=False, **fields):
        with self.lock:
            for key, value in fields.items():
                if key in COUNTERS and _number(value):
                    self.state[key] = int(value)
                elif key == "workers" and type(value) is int and 1 <= value <= 24:
                    self.state[key] = value
                elif key == "phase" and isinstance(value, str) and value in PHASES:
                    self.state[key] = value
            if self.state["total_bytes"]:
                self.state["completed_bytes"] = min(self.state["completed_bytes"], self.state["total_bytes"])
            self._emit(_force)

    def advance(self, count, **increments):
        with self.lock:
            values = {"completed_bytes": count, **increments}
            for key, value in values.items():
                if key in COUNTERS and _number(value):
                    self.state[key] = min(MAX_VALUE, self.state[key] + int(value))
            self.update()

    def activity(self, name, during):
        with self.lock:
            if self.state["phase"] in during and self.state["phase"] != name:
                self.update(phase=name, _force=True)

    def network_begin(self):
        with self.lock:
            now = time.monotonic()
            if not self.active:
                self.network_busy_start = now
            self.sequence += 1
            self.active[self.sequence] = now
            return self.sequence

    def network_bytes(self, direction, count):
        key = {"upload": "uploaded_bytes", "download": "downloaded_bytes"}.get(direction)
        if key:
            self.advance(0, **{key: count})

    def network_end(self, token):
        with self.lock:
            start = self.active.pop(token, None)
            if start is None:
                return
            now = time.monotonic()
            self.network_serial += now - start
            if not self.active:
                self.network_wall += now - self.network_busy_start
                self.network_busy_start = None
            self._emit(force=True)


def _get():
    global _instance, _instance_key
    key = os.environ.get(ENVIRONMENT, "")
    with _instance_lock:
        if _instance is None or key != _instance_key:
            if _instance is not None:
                _instance.close()
            _instance, _instance_key = _Reporter(key), key
        return _instance


def enabled():
    try:
        return _get().fd is not None
    except Exception:
        return False


def _call(method, *arguments, **fields):
    try:
        return getattr(_get(), method)(*arguments, **fields)
    except Exception:
        # The verified transfer remains authoritative even if telemetry cannot
        # be written (disk full, a changed directory, or an unsupported field).
        return None


def phase(name, total_bytes=0, completed_bytes=0, workers=None, **fields):
    _call("phase", name, total_bytes, completed_bytes, workers, **fields)


def update(**fields):
    _call("update", **fields)


def advance(count, **increments):
    _call("advance", count, **increments)


def activity(name, during):
    _call("activity", name, during)


def network_begin():
    return _call("network_begin")


def network_bytes(direction, count):
    _call("network_bytes", direction, count)


def network_end(token):
    _call("network_end", token)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Private GenDragoon upload progress telemetry; used by the library worker.")
    parser.parse_args()
    parser.print_help()
