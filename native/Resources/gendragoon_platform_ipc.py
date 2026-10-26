#!/usr/bin/env python3
"""Windows same-user named pipes and private-file ACLs for the native companion.

Only local RPC travels here. This module never reads an account token or vault.
"""
from __future__ import annotations
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import hashlib
from pathlib import Path


def modules():
    if sys.platform != "win32":
        raise OSError("Windows named-pipe transport requires Windows.")
    try:
        import pywintypes, win32api, win32con, win32event, win32file, win32pipe, win32security
    except ImportError as exc:
        raise OSError("Install the verified GenDragoon Windows runtime, including pywin32.") from exc
    return pywintypes, win32api, win32con, win32event, win32file, win32pipe, win32security


def user_sid():
    _, api, con, _, _, _, security = modules()
    token = security.OpenProcessToken(api.GetCurrentProcess(), con.TOKEN_QUERY)
    try:
        return security.GetTokenInformation(token, security.TokenUser)[0]
    finally:
        token.Close()


def pipe_name():
    *_, security = modules()
    sid = security.ConvertSidToStringSid(user_sid())
    return "\\\\.\\pipe\\GenDragoon-" + hashlib.sha256(sid.encode("ascii")).hexdigest()[:24] + "-Companion-v1"


def security_attributes(*, directory=False):
    types, _, _, _, _, _, security = modules()
    sid = security.ConvertSidToStringSid(user_sid())
    descriptor = security.ConvertStringSecurityDescriptorToSecurityDescriptor(
        "O:" + sid + "D:P(A;" + ("OICI" if directory else "") + ";GA;;;" + sid + ")", 1)
    attributes = types.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = descriptor
    return attributes


def create_private_directory(path: Path):
    """Set the current SID as owner atomically, including elevated processes."""
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        if not path.parent.exists():
            create_private_directory(path.parent)
        _, _, _, _, file, _, _ = modules()
        file.CreateDirectory(str(path), security_attributes(directory=True))
    if not path.is_dir():
        raise OSError("The companion directory has an invalid type.")
    secure_file(path)
    verify_private(path)


def create_private_file(path: Path):
    """Return a new binary file descriptor without inheriting a public ACL."""
    import msvcrt
    _, _, con, _, file, _, _ = modules()
    handle = file.CreateFile(str(path), con.GENERIC_READ | con.GENERIC_WRITE,
        con.FILE_SHARE_READ, security_attributes(), con.CREATE_NEW, con.FILE_ATTRIBUTE_NORMAL, None)
    return msvcrt.open_osfhandle(handle.Detach(), os.O_RDWR | os.O_BINARY)


def secure_file(path: Path):
    """Remove inherited access on an owned companion leaf after creation."""
    *_, security = modules()
    if path.is_symlink() or getattr(path.lstat(), "st_file_attributes", 0) & 0x400:
        raise OSError("Companion paths cannot use reparse points.")
    owner = user_sid()
    existing = security.GetFileSecurity(str(path), security.OWNER_SECURITY_INFORMATION)
    if security.ConvertSidToStringSid(existing.GetSecurityDescriptorOwner()) != security.ConvertSidToStringSid(owner):
        raise OSError("Existing companion paths belong to another Windows account.")
    descriptor = security_attributes().SECURITY_DESCRIPTOR
    security.SetNamedSecurityInfo(str(path), security.SE_FILE_OBJECT,
        security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION | security.PROTECTED_DACL_SECURITY_INFORMATION,
        owner, None, descriptor.GetSecurityDescriptorDacl(), None)


def verify_private(path: Path):
    *_, security = modules()
    descriptor = security.GetFileSecurity(str(path), security.OWNER_SECURITY_INFORMATION | security.DACL_SECURITY_INFORMATION)
    owner = security.ConvertSidToStringSid(user_sid())
    if security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()) != owner:
        raise OSError("Companion files belong to another Windows account.")
    acl = descriptor.GetSecurityDescriptorDacl()
    if acl is None:
        raise OSError("Companion files require a private Windows ACL.")
    for i in range(acl.GetAceCount()):
        ace = acl.GetAce(i)
        if ace[0][0] == security.ACCESS_DENIED_ACE_TYPE:
            continue
        if ace[0][0] != security.ACCESS_ALLOWED_ACE_TYPE or security.ConvertSidToStringSid(ace[-1]) not in {owner, "S-1-5-18", "S-1-5-32-544"}:
            raise OSError("Companion files allow another Windows account access.")


def verify_pipe_peer(handle, *, server: bool):
    _, api, con, _, _, pipe, security = modules()
    pid = pipe.GetNamedPipeClientProcessId(handle) if server else pipe.GetNamedPipeServerProcessId(handle)
    process = api.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    try:
        token = security.OpenProcessToken(process, con.TOKEN_QUERY)
        try:
            peer = security.GetTokenInformation(token, security.TokenUser)[0]
            if security.ConvertSidToStringSid(peer) != security.ConvertSidToStringSid(user_sid()):
                raise OSError("The native pipe belongs to another Windows account.")
        finally:
            token.Close()
    finally:
        process.Close()


class PipeStream:
    """Small overlapped reads/writes with deadlines; never block indefinitely."""
    def __init__(self, handle, timeout=35):
        self.handle, self.timeout = handle, timeout

    def _operation(self, data, *, reading):
        types, _, _, event, file, _, _ = modules()
        operation = types.OVERLAPPED()
        operation.hEvent = event.CreateEvent(None, True, False, None)
        try:
            buffer = file.AllocateReadBuffer(data) if reading else None
            result, buffer = file.ReadFile(self.handle, buffer, operation) if reading else file.WriteFile(self.handle, data, operation)
            if result not in {0, 997}:
                raise OSError("The native pipe operation failed.")
            if result == 997 and event.WaitForSingleObject(operation.hEvent, int(self.timeout * 1000)) != event.WAIT_OBJECT_0:
                file.CancelIoEx(self.handle, operation)
                # Wait for cancellation before releasing the OVERLAPPED buffer.
                try:
                    file.GetOverlappedResult(self.handle, operation, True)
                except OSError:
                    pass
                raise TimeoutError("The native pipe request timed out.")
            count = file.GetOverlappedResult(self.handle, operation, False)
            return bytes(buffer[:count]) if reading else count
        finally:
            operation.hEvent.Close()

    def read(self, count):
        if not 0 < count <= 256 * 1024:
            raise OSError("Invalid native pipe read length.")
        return self._operation(count, reading=True)

    def write(self, data):
        return self._operation(bytes(data), reading=False)

    def flush(self):
        pass  # FlushFileBuffers can wait forever for an abandoned client.

    def close(self):
        if self.handle is not None:
            self.handle.Close(); self.handle = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def connect_pipe(name):
    _, _, con, _, file, pipe, _ = modules()
    if name != pipe_name():
        raise OSError("The companion named-pipe identity is invalid.")
    pipe.WaitNamedPipe(name, 3000)
    handle = file.CreateFile(name, con.GENERIC_READ | con.GENERIC_WRITE, 0, None, con.OPEN_EXISTING, file.FILE_FLAG_OVERLAPPED, None)
    try:
        verify_pipe_peer(handle, server=False)
        return PipeStream(handle)
    except Exception:
        handle.Close(); raise


def create_pipe(*, first=False):
    _, _, _, _, file, pipe, _ = modules()
    return pipe.CreateNamedPipe(pipe_name(), pipe.PIPE_ACCESS_DUPLEX | file.FILE_FLAG_OVERLAPPED | (0x00080000 if first else 0),
        pipe.PIPE_TYPE_BYTE | pipe.PIPE_READMODE_BYTE | pipe.PIPE_WAIT | 0x8, 8, 256 * 1024, 256 * 1024, 35000, security_attributes())


def accept_pipe(handle, stopped):
    types, _, _, event, file, pipe, _ = modules()
    operation = types.OVERLAPPED(); operation.hEvent = event.CreateEvent(None, True, False, None)
    try:
        try:
            result = pipe.ConnectNamedPipe(handle, operation)
            if result == 535:
                verify_pipe_peer(handle, server=True); return PipeStream(handle)
        except OSError as exc:
            if getattr(exc, "winerror", exc.args[0] if exc.args else None) == 535:
                verify_pipe_peer(handle, server=True); return PipeStream(handle)
            raise
        while not stopped.is_set():
            state = event.WaitForSingleObject(operation.hEvent, 200)
            if state == event.WAIT_OBJECT_0:
                file.GetOverlappedResult(handle, operation, False)
                verify_pipe_peer(handle, server=True); return PipeStream(handle)
        file.CancelIoEx(handle, operation)
        try:
            file.GetOverlappedResult(handle, operation, True)
        except OSError:
            pass
        raise InterruptedError("Companion listener stopped.")
    finally:
        operation.hEvent.Close()


if __name__ == "__main__":
    import argparse
    argparse.ArgumentParser(description=__doc__).parse_args()
