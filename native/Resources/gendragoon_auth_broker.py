"""Private inherited access-token renewal. Refresh credentials stay in native Keychain."""
import json
import os
import sys
sys.dont_write_bytecode=True
os.environ["PYTHONDONTWRITEBYTECODE"]="1"
import re
import socket
import threading

TOKEN = re.compile(r"rxca_[A-Za-z0-9_-]{43}\Z")
HEX = re.compile(r"[a-f0-9]{64}\Z")
_clients = {}
_lock = threading.Lock()


class BrokerError(RuntimeError):
    pass


class Client:
    def __init__(self, value):
        spec = value["authBroker"]
        fd, nonce = spec.get("fd"), spec.get("nonce")
        if (type(spec.get("protocol")) is not int or spec.get("protocol") != 1 or type(fd) is not int or fd < 0
                or not isinstance(nonce, str) or not HEX.fullmatch(nonce)):
            raise BrokerError("Invalid private renewal channel")
        self.socket = socket.socket(fileno=os.dup(fd))
        if self.socket.family != socket.AF_UNIX or self.socket.type != socket.SOCK_STREAM:
            self.socket.close()
            raise BrokerError("Invalid private renewal channel")
        if hasattr(self.socket, "getpeereid") and self.socket.getpeereid()[0] != os.getuid():
            self.socket.close()
            raise BrokerError("Private renewal channel owner changed")
        self.socket.settimeout(75)
        self.nonce, self.receiver, self.workspace = nonce, value["receiverId"], value["workspaceId"]
        self.current = value["bearerToken"]
        self.generation = spec.get("generation",0)
        if type(self.generation) is not int or self.generation < 0:
            self.socket.close()
            raise BrokerError("Invalid private renewal generation")
        self.lock = threading.Lock()

    def token(self):
        with self.lock:
            return self.current

    def authorize(self):
        return self.renew(None, authorize=True)

    def renew(self, failed_token, authorize=False):
        with self.lock:
            if not authorize and self.current != failed_token:
                return self.current
            request = {"protocol": 1, "operation": "authorize" if authorize else "renew", "nonce": self.nonce,
                       "receiverId": self.receiver, "workspaceId": self.workspace,
                       "generation": self.generation}
            try:
                self.socket.sendall(json.dumps(request, separators=(",", ":")).encode() + b"\n")
                data = bytearray()
                while len(data) <= 4096:
                    part = self.socket.recv(1)
                    if not part:
                        raise BrokerError("Native session renewal channel closed")
                    if part == b"\n":
                        break
                    data.extend(part)
                else:
                    raise BrokerError("Native session renewal response exceeded its limit")
                value = json.loads(data)
                if (not isinstance(value, dict) or value.get("ok") is not True
                        or value.get("receiverId") != self.receiver or value.get("workspaceId") != self.workspace
                        or type(value.get("generation")) is not int
                        or value["generation"] < self.generation or not authorize and value["generation"] == self.generation
                        or not isinstance(value.get("bearerToken"), str) or not TOKEN.fullmatch(value["bearerToken"])):
                    raise BrokerError("Native session renewal was denied; reconnect Red-XAI")
                self.current, self.generation = value["bearerToken"], value["generation"]
                return self.current
            except (OSError, ValueError) as error:
                raise BrokerError("Native session renewal is unavailable; reconnect Red-XAI") from error


def attach(value):
    """Duplicate fd0 before a descendant replaces stdin with its input envelope."""
    if "authBroker" not in value:
        return value
    client = client_for(value)
    with client.lock:
        value["authBroker"] = {"protocol": 1, "nonce": client.nonce, "fd": client.socket.fileno(),"generation":client.generation}
        value["bearerToken"] = client.current
    return value


def client_for(value):
    spec = value.get("authBroker")
    if spec is None:
        return None
    if not isinstance(spec, dict):
        raise BrokerError("Invalid private renewal channel")
    key = spec.get("nonce")
    if not isinstance(key, str):
        raise BrokerError("Invalid private renewal channel")
    with _lock:
        if key not in _clients:
            _clients[key] = Client(value)
        client = _clients[key]
        if client.receiver != value["receiverId"] or client.workspace != value["workspaceId"]:
            raise BrokerError("Private renewal channel destination changed")
        return client


def inherited_fds(value):
    client = client_for(value) if value else None
    return (client.socket.fileno(),) if client else ()


if __name__=="__main__":
    import argparse
    argparse.ArgumentParser(description="Private inherited native session channel; imported by GenDragoon helpers.").parse_args()
