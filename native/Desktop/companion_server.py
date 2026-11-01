"""Private same-user companion listener; GUI dispatch owns account consent/IO."""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import stat
import sys
import threading

sys.dont_write_bytecode = True
RESOURCES = Path(__file__).resolve().parents[1] / "Resources"
if str(RESOURCES) not in sys.path:
    sys.path.insert(0, str(RESOURCES))
import gendragoon_native_bridge as bridge


class CompanionServer:
    def __init__(self, dispatch, *, base=None, socket_directory=None, timeout=35):
        self.dispatch = dispatch
        self.base = Path(base) if base else bridge.base_directory()
        self.socket_directory = Path(socket_directory) if socket_directory else Path("/private/tmp" if sys.platform == "darwin" else "/tmp") / ("gendragoon-companion-" + str(os.getuid()) if sys.platform != "win32" else "unused")
        self.timeout = timeout
        self.stopped = threading.Event()
        self.slots = threading.BoundedSemaphore(8)
        self.listener = None
        self.thread = None
        self.locator = self.base / "Companion/endpoint.json"
        self.info = None

    @staticmethod
    def _directory(path):
        if sys.platform == "win32":
            from gendragoon_platform_ipc import create_private_directory
            create_private_directory(path)
        else:
            path.mkdir(mode=0o700, parents=True, exist_ok=True)
        bridge.private_path(path, directory=True)

    def start(self):
        if self.thread:
            return
        self._directory(self.base)
        self._directory(self.locator.parent)
        if self.locator.exists():
            bridge.private_path(self.locator)
        if sys.platform == "win32":
            from gendragoon_platform_ipc import create_pipe, pipe_name
            self.listener = create_pipe(first=True)
            self.info = {"schema": 1, "pipeName": pipe_name(), "protocol": bridge.PROTOCOL}
        else:
            self._directory(self.socket_directory)
            target = self.socket_directory / "rpc.sock"
            if target.exists():
                bridge.private_path(target, socket_file=True)
                with socket.socket(socket.AF_UNIX) as probe:
                    try:
                        probe.settimeout(1); probe.connect(str(target))
                    except ConnectionRefusedError:
                        target.unlink()
                    else:
                        raise OSError("Another GenDragoon companion is already running.")
            self.listener = socket.socket(socket.AF_UNIX)
            try:
                self.listener.bind(str(target)); target.chmod(0o600)
                self.listener.listen(8); self.listener.settimeout(0.2)
            except Exception:
                self.listener.close(); self.listener = None; raise
            self.info = {"schema": 1, "socketPath": str(target), "protocol": bridge.PROTOCOL}
        temporary = self.locator.with_suffix(".new")
        if sys.platform == "win32":
            from gendragoon_platform_ipc import create_private_file
            descriptor = create_private_file(temporary)
        else:
            descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(self.info, output); output.flush(); os.fsync(output.fileno())
        if sys.platform == "win32":
            from gendragoon_platform_ipc import secure_file
            secure_file(temporary)
        temporary.replace(self.locator)
        self.thread = threading.Thread(target=self._accept, name="GenDragoon companion", daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.listener is not None and sys.platform != "win32":
            self.listener.close()
        if self.thread:
            self.thread.join(timeout=2)
        try:
            if bridge.private_json(self.locator) == self.info:
                self.locator.unlink()
        except (OSError, bridge.BridgeError):
            pass
        if self.info and "socketPath" in self.info:
            try:
                bridge.private_path(Path(self.info["socketPath"]), socket_file=True)
                Path(self.info["socketPath"]).unlink()
            except (OSError, bridge.BridgeError):
                pass

    def _accept(self):
        first = True
        while not self.stopped.is_set():
            try:
                if sys.platform == "win32":
                    from gendragoon_platform_ipc import accept_pipe, create_pipe
                    handle = self.listener if first else create_pipe()
                    first = False
                    try:
                        stream = accept_pipe(handle, self.stopped)
                    except Exception:
                        handle.Close(); raise
                    stream.timeout = self.timeout
                else:
                    connection, _ = self.listener.accept()
                    try:
                        if bridge.peer_uid(connection) != os.getuid():
                            continue
                        connection.settimeout(self.timeout)
                        stream = connection.makefile("rwb", buffering=0)
                    finally:
                        # The file wrapper, when created, owns its own reference.
                        connection.close()
                if not self.slots.acquire(blocking=False):
                    stream.close(); continue
                threading.Thread(target=self._serve, args=(stream,), daemon=True).start()
            except socket.timeout:
                continue
            except (OSError, bridge.BridgeError):
                if self.stopped.is_set():
                    return
                self.stopped.wait(0.2)

    def _request(self, value):
        if not isinstance(value, dict) or set(value) != {"schema", "client", "request"} or type(value["schema"]) is not int or value["schema"] != 1:
            raise bridge.BridgeError("request_invalid", "Invalid companion request envelope.")
        client = value["client"]
        if not isinstance(client, dict) or set(client) != {"kind", "id"}:
            raise bridge.BridgeError("caller_denied", "An installed extension identity is required.")
        config = bridge.private_json(self.base / "NativeMessaging/config.json")
        kind, identifier = client.get("kind"), client.get("id")
        if kind == "vscode":
            verified = bridge.caller([], config, vscode=True)
        elif kind == "browser" and identifier == bridge.FIREFOX_ID:
            verified = bridge.caller([str(self.base / "NativeMessaging/host.json"), identifier], config)
        elif kind == "browser" and isinstance(identifier, str):
            verified = bridge.caller([identifier], config)
        else:
            raise bridge.BridgeError("caller_denied", "This client is not installed.")
        if verified != client:
            raise bridge.BridgeError("caller_denied", "The installed extension identity did not match.")
        request = bridge.validate_request(value["request"], verified)
        request.update(_clientLabel=kind + ":" + identifier, _clientId=identifier, _clientKind=kind)
        return request

    def _serve(self, stream):
        request_id = None
        try:
            with stream:
                try:
                    value = bridge.read_frame(stream)
                    if isinstance(value, dict) and isinstance(value.get("request"), dict):
                        request_id = value["request"].get("id")
                    request = self._request(value)
                    completed = threading.Event()
                    response = []
                    lock = threading.Lock()
                    def done(result):
                        with lock:
                            if completed.is_set():
                                return
                            if isinstance(result, dict) and type(result.get("ok")) is bool:
                                response.append({"id": request["id"], **{k: v for k, v in result.items() if k in {"ok", "result", "error"}}})
                            else:
                                response.append({"id": request["id"], "ok": True, "result": result})
                            completed.set()
                    self.dispatch(request, done)
                    if not completed.wait(self.timeout):
                        with lock:
                            completed.set()
                        raise bridge.BridgeError("request_pending", "Check the native GenDragoon window before retrying this request.")
                    result = bridge.validate_response(response[0], request)
                    bridge.write_frame(stream, result)
                except bridge.BridgeError as exc:
                    bridge.write_frame(stream, bridge.error_response(request_id, exc))
        except Exception:
            # No request body, selected path, token or backend exception is logged.
            pass
        finally:
            self.slots.release()
