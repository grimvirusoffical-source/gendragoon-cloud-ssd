"""App-side connect: a one-time connect code (gdpg_) or a connect link with PKCE (gdpc_ code + verifier)."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import threading
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from .client import API_KEY_RE, Transport
from .crypto import b64u

GRANT_RE = re.compile(r"^gdpg_[A-Za-z0-9_-]{43}$")
CODE_RE = re.compile(r"^gdpc_[A-Za-z0-9_-]{43}$")


@dataclass
class PKCE:
    verifier: str
    challenge: str
    state: str


def pkce_challenge(verifier: str) -> str:
    return b64u(hashlib.sha256(verifier.encode()).digest())


def new_pkce() -> PKCE:
    """A fresh verifier (43 characters), its S256 challenge and a random state value."""
    v = b64u(os.urandom(32))
    return PKCE(v, pkce_challenge(v), b64u(os.urandom(16)))


def is_loopback(redirect: str) -> bool:
    try:
        u = urllib.parse.urlsplit(redirect)
        return u.scheme == "http" and u.hostname in ("127.0.0.1", "::1") and u.port is not None and not u.username and not u.password
    except ValueError:
        return False


def connect_link(name: str, p: PKCE, redirect: str, *, host: str = "", scopes: tuple[str, ...] = ("blobs:rw",)) -> str:
    """The gendragoon://connect link to open. redirect must be http://127.0.0.1:<port>/..."""
    if not is_loopback(redirect):
        raise ValueError("gendragoon: redirect must be http://127.0.0.1:<port>/...")
    q = {"client": name, "scope": " ".join(scopes), "code_challenge": p.challenge, "code_challenge_method": "S256",
         "redirect_uri": redirect, "state": p.state}
    if host:
        q["host"] = host
    return "gendragoon://connect?" + urllib.parse.urlencode(sorted(q.items()))


class Connector(Transport):
    """The calls an app makes before it has a key."""

    def __init__(self, base: str, **kw):
        super().__init__(**kw)
        self.base = base.rstrip("/")

    def _post(self, op: str, path: str, body: dict) -> dict:
        self.check(op)
        c = self._send("POST", self.base + path, json.dumps(body).encode(), {"Content-Type": "application/json"}, None).json()
        if not isinstance(c, dict) or not API_KEY_RE.match(c.get("apiKey", "")):
            raise RuntimeError("gendragoon: unexpected connect response")
        return c

    def redeem_grant(self, grant: str, name: str, host: str = "") -> dict:
        """Exchanges a one-time connect code for an API key. Level L2, risk credential.
        Returns bindingId, apiKey, keyExpiresAt, scopes, workspaceId, quotaBytes, capabilities."""
        grant = grant.strip()
        if not GRANT_RE.match(grant):
            raise ValueError("gendragoon: that is not a GenDragoon connect code")
        client = {"name": name, **({"host": host} if host else {})}
        return self._post("connect.redeemGrant", "/connect/redeem", {"grant": grant, "client": client})

    def exchange_code(self, code: str, verifier: str) -> dict:
        """Exchanges an authorization code and the PKCE verifier for an API key. Level L2, risk credential."""
        if not CODE_RE.match(code):
            raise ValueError("gendragoon: that is not a GenDragoon authorization code")
        return self._post("connect.exchangeCode", "/connect/token", {"code": code, "codeVerifier": verifier})


class Loopback:
    """Listens on 127.0.0.1 for the redirect that carries the authorization code."""

    def __init__(self, p: PKCE):
        got: dict = {}
        ready = threading.Event()
        want = p.state.encode()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # never log the code
                pass

            def do_GET(self):
                u = urllib.parse.urlsplit(self.path)
                q = urllib.parse.parse_qs(u.query)
                state, code = (q.get("state") or [""])[0], (q.get("code") or [""])[0]
                ok = u.path == "/gendragoon/callback" and hmac.compare_digest(state.encode(), want) and CODE_RE.match(code)
                self.send_response(200 if ok else 400)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.end_headers()
                if ok:
                    got.setdefault("code", code)
                    ready.set()
                    self.wfile.write(b"Connected. You can close this window and return to the app.\n")
                else:
                    self.wfile.write(b"This link is not for this app.\n")

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._got, self._ready = got, ready
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()
        self.redirect_uri = f"http://127.0.0.1:{self._srv.server_address[1]}/gendragoon/callback"

    def wait(self, timeout: float = 300.0) -> Optional[str]:
        """The authorization code, or None after timeout. Closes the listener either way."""
        try:
            return self._got["code"] if self._ready.wait(timeout) else None
        finally:
            self.close()

    def close(self) -> None:
        self._srv.shutdown()
        self._srv.server_close()
