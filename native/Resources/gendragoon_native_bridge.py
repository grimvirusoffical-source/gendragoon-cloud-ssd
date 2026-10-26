#!/usr/bin/env python3
"""Bounded native-messaging transport to the locally approved GenDragoon app.

This process has no account credentials and performs no file operations itself.
Browser caller arguments must match the private, explicitly installed allowlist.
"""
from __future__ import annotations

import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
import json
import re
import socket
import stat
import struct
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

MAX_FRAME = 256 * 1024
PROTOCOL = "gendragoon-companion-v1"
HOST_NAME = "com.redxai.gendragoon"
VSCODE_ID = "redxai.gendragoon"
ID = re.compile(r"[a-f0-9]{32}\Z")
CHROME_ORIGIN = re.compile(r"chrome-extension://([a-p]{32})/?\Z")
FIREFOX_ID = "gendragoon@redxai.local"


class BridgeError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


def base_directory(platform: str | None = None, home: Path | None = None) -> Path:
    platform = sys.platform if platform is None else platform
    home = Path.home() if home is None else home
    if platform == "darwin":
        return home / "Library/Application Support/GenDragoon"
    if platform.startswith("linux"):
        state = Path(os.environ.get("XDG_STATE_HOME", str(home / ".local/state")))
        if not state.is_absolute():
            raise BridgeError("installation_invalid", "XDG_STATE_HOME must be an absolute path.")
        return state / "gendragoon"
    if platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA", str(home / "AppData/Local")))
        if not local.is_absolute():
            raise BridgeError("installation_invalid", "LOCALAPPDATA must be an absolute path.")
        return local / "GenDragoon"
    raise BridgeError("platform_unsupported", "The native companion transport has not been implemented for this platform.")


def private_path(path: Path, *, directory: bool = False, socket_file: bool = False) -> os.stat_result:
    """Validate the sensitive leaf and directory; reject symlinks before resolve."""
    if not path.is_absolute():
        raise BridgeError("installation_invalid", "The companion path must be absolute.")
    current = path
    while current != current.parent:
        if current.is_symlink():
            raise BridgeError("installation_invalid", "Companion paths cannot contain symbolic links.")
        current = current.parent
    try:
        value = path.lstat()
    except OSError as exc:
        raise BridgeError("companion_unavailable", "Open GenDragoon and approve this client before using the extension.") from exc
    kind = stat.S_ISDIR if directory else stat.S_ISSOCK if socket_file else stat.S_ISREG
    if not kind(value.st_mode):
        raise BridgeError("installation_invalid", "The companion path has an invalid type.")
    if sys.platform == "win32":
        try:
            from gendragoon_platform_ipc import verify_private
            verify_private(path)
        except OSError as exc:
            raise BridgeError("installation_invalid", "Companion files must have a private Windows ACL.") from exc
    elif value.st_uid != os.getuid() or value.st_mode & 0o077:
        raise BridgeError("installation_invalid", "Companion files must be private and owned by your local account.")
    return value


def private_json(path: Path) -> dict:
    private_path(path.parent, directory=True)
    value = private_path(path)
    if value.st_size > 16 * 1024:
        raise BridgeError("installation_invalid", "The companion configuration is invalid.")
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError, UnicodeError) as exc:
        raise BridgeError("installation_invalid", "The companion configuration is invalid.") from exc
    if not isinstance(data, dict):
        raise BridgeError("installation_invalid", "The companion configuration is invalid.")
    return data


def caller(arguments: list[str], config: dict, *, vscode: bool = False) -> dict:
    if config.get("schema") != 1:
        raise BridgeError("installation_invalid", "Reinstall the GenDragoon native host.")
    if vscode:
        if arguments or config.get("vscodeExtensionId") != VSCODE_ID:
            raise BridgeError("caller_denied", "This editor client has not been enabled in the native host installer.")
        return {"kind": "vscode", "id": VSCODE_ID}
    if len(arguments) == 2 and CHROME_ORIGIN.fullmatch(arguments[0]) and re.fullmatch(r"--parent-window=[0-9]{1,20}", arguments[1]):
        arguments = arguments[:1]  # Chromium supplies a window handle on Windows.
    approved = config.get("allowedOrigins")
    if not isinstance(approved, list) or not approved or len(approved) > 32:
        raise BridgeError("caller_denied", "No explicit browser extension IDs are installed.")
    # Chromium passes its origin; Firefox passes host-manifest path then add-on ID.
    if len(arguments) == 1 and CHROME_ORIGIN.fullmatch(arguments[0]):
        origin = "chrome-extension://" + CHROME_ORIGIN.fullmatch(arguments[0]).group(1) + "/"
    elif len(arguments) == 2 and arguments[1] == FIREFOX_ID and Path(arguments[0]).is_absolute():
        origin = FIREFOX_ID
    else:
        raise BridgeError("caller_denied", "The browser did not supply an approved extension identity.")
    if origin not in approved:
        raise BridgeError("caller_denied", "This browser extension ID is not in your native host allowlist.")
    return {"kind": "browser", "id": origin}


def _object(value, allowed: set[str]) -> dict:
    if not isinstance(value, dict) or set(value) - allowed:
        raise BridgeError("request_invalid", "The extension request contains unsupported fields.")
    return value


def validate_request(value: object, client: dict) -> dict:
    value = _object(value, {"id", "method", "params", "client"})
    request_id, method = value.get("id"), value.get("method")
    if not isinstance(request_id, str) or not ID.fullmatch(request_id):
        raise BridgeError("request_invalid", "The extension request ID is invalid.")
    params = value.get("params", {})
    if method == "status":
        _object(params, set())
    elif method == "request":
        params = _object(params, {"path", "method", "body"})
        route, verb = params.get("path"), params.get("method", "GET")
        if not isinstance(route, str) or len(route) > 4096 or not route.startswith("/v1/receivers/") or any(c in route for c in ("\\", "#", "\r", "\n")):
            raise BridgeError("route_denied", "This route is outside the extension metadata interface.")
        parsed = urlsplit(route)
        if parsed.scheme or parsed.netloc or "%" in parsed.path or ".." in parsed.path:
            raise BridgeError("route_denied", "Encoded and external routes are not supported.")
        path = parsed.path
        metadata = verb == "GET" and (path == "/v1/receivers/me" or re.fullmatch(r"/v1/receivers/me/workspaces/[a-f0-9]{32}/library", path))
        teams = bool(re.fullmatch(r"/v1/receivers/(?:me/dev-(?:profile|teams)|me/workspaces/[a-f0-9]{32}/team|teams/(?:join|[a-f0-9]{32}(?:/(?:members|invites|messages|presence|signals|membership)(?:/[a-f0-9]{32})?)?))", path))
        if verb not in {"GET", "POST", "PUT", "PATCH", "DELETE"} or not (metadata or teams):
            raise BridgeError("route_denied", "Extensions can access file metadata and developer Teams only.")
        query = parse_qsl(parsed.query, keep_blank_values=True)
        if any(k not in {"limit", "cursor"} for k, _ in query) or len({k for k, _ in query}) != len(query) or (parsed.query and not teams):
            raise BridgeError("route_denied", "This metadata query is unsupported.")
        if "body" in params and (verb == "GET" or not isinstance(params["body"], dict)):
            raise BridgeError("request_invalid", "Only object request bodies are supported.")
    elif method == "selectUpload":
        params = _object(params, {"workspaceId", "kind"})
        if not isinstance(params.get("workspaceId"), str) or not ID.fullmatch(params["workspaceId"]) or params.get("kind") not in {"file", "folder"}:
            raise BridgeError("request_invalid", "Choose a MachineNote and a file or folder picker.")
    elif method == "uploadSelection":
        if client.get("kind") != "vscode":
            raise BridgeError("route_denied", "Browser extensions cannot supply local file paths.")
        params = _object(params, {"workspaceId", "selectedPaths"})
        paths = params.get("selectedPaths")
        if not isinstance(params.get("workspaceId"), str) or not ID.fullmatch(params["workspaceId"]) or not isinstance(paths, list) or not 1 <= len(paths) <= 64 or any(not isinstance(p, str) or len(p) > 4096 or not Path(p).is_absolute() or "\x00" in p for p in paths):
            raise BridgeError("request_invalid", "Select local files or folders explicitly in the editor.")
    else:
        raise BridgeError("method_denied", "This companion method is unsupported.")
    # Caller-supplied client metadata is discarded; identity comes from launch args.
    return {"id": request_id, "method": method, "params": params}


def read_frame(stream):
    header = stream.read(4)
    if not header:
        return None
    while len(header) < 4:
        part = stream.read(4 - len(header))
        if not part:
            raise BridgeError("frame_invalid", "The native message header was truncated.")
        header += part
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= MAX_FRAME:
        raise BridgeError("frame_invalid", "The native message exceeds the bounded message limit.")
    parts, remaining = [], length
    while remaining:
        part = stream.read(remaining)
        if not part:
            raise BridgeError("frame_invalid", "The native message was truncated.")
        parts.append(part)
        remaining -= len(part)
    try:
        return json.loads(b"".join(parts).decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise BridgeError("frame_invalid", "The native message is not valid UTF-8 JSON.") from exc


def write_frame(stream, value):
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if not 0 < len(data) <= MAX_FRAME:
        raise BridgeError("frame_invalid", "The companion response exceeded its message limit.")
    packet = memoryview(struct.pack("<I", len(data)) + data)
    while packet:
        written = stream.write(packet)
        if not isinstance(written, int) or written <= 0:
            raise BridgeError("frame_invalid", "The native transport could not write a complete frame.")
        packet = packet[written:]
    stream.flush()


def peer_uid(connection) -> int:
    if hasattr(connection, "getpeereid"):
        return connection.getpeereid()[0]
    if hasattr(socket, "SO_PEERCRED"):
        return struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))[1]
    if sys.platform == "darwin":
        # CPython on macOS exposes LOCAL_PEERCRED but not socket.getpeereid.
        # Use the platform syscall instead of assuming path ownership proves
        # which process accepted this connection.
        import ctypes
        function = ctypes.CDLL(None, use_errno=True).getpeereid
        function.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        function.restype = ctypes.c_int
        uid, gid = ctypes.c_uint(), ctypes.c_uint()
        if function(connection.fileno(), ctypes.byref(uid), ctypes.byref(gid)) != 0:
            raise BridgeError("caller_denied", "The companion peer identity could not be verified.")
        return uid.value
    raise BridgeError("platform_unsupported", "Peer credential verification is unavailable on this platform.")


def socket_request(request: dict, client: dict, locator: Path) -> dict:
    info = private_json(locator)
    if sys.platform == "win32":
        try:
            from gendragoon_platform_ipc import connect_pipe
            if info.get("schema") != 1 or info.get("protocol") != PROTOCOL or not isinstance(info.get("pipeName"), str):
                raise OSError("Invalid companion pipe locator")
            with connect_pipe(info["pipeName"]) as stream:
                write_frame(stream, {"schema": 1, "client": client, "request": request})
                response = read_frame(stream)
        except OSError as exc:
            raise BridgeError("companion_unavailable", "Open the verified Windows GenDragoon app and approve this client.") from exc
        return validate_response(response, request)
    socket_path = info.get("socketPath")
    if info.get("schema") != 1 or info.get("protocol") != PROTOCOL or not isinstance(socket_path, str):
        raise BridgeError("installation_invalid", "The companion locator is invalid.")
    target = Path(socket_path)
    private_path(target.parent, directory=True)
    private_path(target, socket_file=True)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
            connection.settimeout(35)
            connection.connect(str(target))
            if peer_uid(connection) != os.getuid():
                raise BridgeError("caller_denied", "The companion belongs to another local account.")
            with connection.makefile("rwb", buffering=0) as stream:
                write_frame(stream, {"schema": 1, "client": client, "request": request})
                response = read_frame(stream)
    except BridgeError:
        raise
    except OSError as exc:
        raise BridgeError("companion_unavailable", "Open GenDragoon, connect your account, and approve this client.") from exc
    return validate_response(response, request)


def validate_response(response, request):
    if not isinstance(response, dict) or response.get("id") != request["id"] or type(response.get("ok")) is not bool:
        raise BridgeError("response_invalid", "The installed companion returned an invalid response.")
    if response["ok"] and set(response) != {"id", "ok", "result"} or not response["ok"] and (set(response) != {"id", "ok", "error"} or not isinstance(response.get("error"), dict)):
        raise BridgeError("response_invalid", "The installed companion response is invalid.")
    return response


def error_response(request_id, exc: BridgeError):
    return {"id": request_id if isinstance(request_id, str) and ID.fullmatch(request_id) else "0" * 32, "ok": False, "error": {"code": exc.code, "message": exc.message}}


def serve(input_stream, output_stream, client: dict, locator: Path):
    while True:
        request_id = None
        try:
            value = read_frame(input_stream)
            if value is None:
                return
            if isinstance(value, dict):
                request_id = value.get("id")
            request = validate_request(value, client)
            response = socket_request(request, client, locator)
        except BridgeError as exc:
            write_frame(output_stream, error_response(request_id, exc))
            if exc.code == "frame_invalid":
                return
            continue
        write_frame(output_stream, response)


def main():
    parser = argparse.ArgumentParser(description="Private GenDragoon native messaging transport; requires the running, approved companion.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--native-messaging", action="store_true")
    group.add_argument("--vscode-bridge", action="store_true")
    parser.add_argument("caller", nargs="*")
    options = parser.parse_args()
    try:
        base = base_directory()
        config = private_json(base / "NativeMessaging/config.json")
        client = caller(options.caller, config, vscode=options.vscode_bridge)
        serve(sys.stdin.buffer, sys.stdout.buffer, client, base / "Companion/endpoint.json")
    except BridgeError as exc:
        write_frame(sys.stdout.buffer, error_response(None, exc))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
