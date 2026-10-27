"""Explicit Stop requests handled by the broker which owns the application's tree.

No basename matching, pkill, taskkill or arbitrary client-provided process IDs.
Force mode requires a separate native confirmation; ordinary Stop never escalates.
"""
import os
from pathlib import Path
import signal
import time


class StopControl:
    def __init__(self, lease, record, reader, identity, clock=time.time):
        self.path = Path(lease).with_name('stop-' + record['id'] + '.json')
        self.record = record
        self.reader = reader
        self.identity = identity
        self.clock = clock
        self.nonce = None
        self.mode = None
        self.sent = set()

    def poll(self):
        # A malformed or stale request must never become permission to signal.
        try:
            value = self.reader(self.path)
            now = self.clock()
            if (not isinstance(value, dict) or value.get('schema') != 1
                    or value.get('id') != self.record['id']
                    or value.get('brokerIdentity') != self.record['brokerIdentity']
                    or self.identity(os.getpid()) != self.record['brokerIdentity']
                    or value.get('mode') not in ('graceful', 'force')
                    or type(value.get('createdAt')) not in (int, float)
                    or not 0 <= now - value['createdAt'] <= 120
                    or not isinstance(value.get('nonce'), str) or len(value['nonce']) != 32):
                return self.mode
            if value['nonce'] != self.nonce:
                self.nonce = value['nonce']
                # A late ordinary Stop must not downgrade an approved force stop.
                self.mode = 'force' if self.mode == 'force' else value['mode']
        except (OSError, ValueError, KeyError, TypeError):
            pass
        return self.mode


def linux_descendants(root):
    """Only descendants of this dedicated subreaper, not all user processes."""
    pending = [root]
    seen = {root}
    found = []
    while pending:
        parent = pending.pop()
        try:
            children = Path(f'/proc/{parent}/task/{parent}/children').read_text().split()
        except OSError:
            continue
        for raw in children:
            if not raw.isdecimal():
                continue
            pid = int(raw)
            if pid <= 1 or pid in seen:
                continue
            seen.add(pid)
            found.append(pid)
            pending.append(pid)
    return found


def stop_linux(control):
    mode = control.poll()
    if mode is None:
        return
    # pidfds bind the signal to an exact process, even if its PID is later reused.
    # Older kernels without pidfds keep the app alive rather than unsafe fallback.
    if not hasattr(os, 'pidfd_open') or not hasattr(signal, 'pidfd_send_signal'):
        return
    sig = signal.SIGKILL if mode == 'force' else signal.SIGTERM
    for pid in reversed(linux_descendants(os.getpid())):
        expected = control.identity(pid)
        marker = (pid, expected, mode)
        if not expected or marker in control.sent:
            continue
        fd = None
        try:
            fd = os.pidfd_open(pid)
            if control.identity(pid) != expected:
                continue
            signal.pidfd_send_signal(fd, sig)
            control.sent.add(marker)
        except (OSError, ProcessLookupError):
            pass
        finally:
            if fd is not None:
                os.close(fd)


def stop_windows(control, job):
    mode = control.poll()
    if mode is None:
        return
    import win32api, win32con, win32gui, win32job, win32process
    if mode == 'force':
        # This private unnamed Job handle was created before the app started.
        # It cannot resolve to an unrelated process after PID reuse.
        if ('job', 'force') not in control.sent:
            win32job.TerminateJobObject(job, 1)
            control.sent.add(('job', 'force'))
        return

    def close_window(hwnd, _):
        handle = None
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            handle = win32api.OpenProcess(0x1000, False, pid)
            if not win32job.IsProcessInJob(handle, job):
                return
            identity = control.identity(pid)
            marker = (hwnd, pid, identity)
            if not identity or marker in control.sent:
                return
            # An ordinary Close request lets GUI applications show save dialogs.
            win32gui.PostMessage(hwnd, win32con.WM_CLOSE, 0, 0)
            control.sent.add(marker)
        except Exception:
            pass  # Missing windows or access errors never authorize force quit.
        finally:
            if handle is not None:
                handle.Close()
    win32gui.EnumWindows(close_window, None)
