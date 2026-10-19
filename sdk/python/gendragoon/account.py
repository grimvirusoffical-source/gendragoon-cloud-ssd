"""Calls of a signed-in GenDragoon user (Firebase ID token): connect codes, approving connect links and managing
connected apps. These act on the person's account; a Rotten Apple app should not make them on the person's behalf."""
from __future__ import annotations

import json
import urllib.parse
from dataclasses import dataclass, field
from typing import Callable

from .client import Transport
from .connect import CODE_RE, GRANT_RE, is_loopback


@dataclass
class ConnectRequest:
    client: dict
    scopes: list[str] = field(default_factory=list)
    challenge: str = ""
    redirect_uri: str = ""
    state: str = ""


def parse_connect_link(link: str) -> ConnectRequest:
    """Validates a connect link the way GenDragoon does before showing it to the user."""
    u = urllib.parse.urlsplit(link)
    if u.scheme != "gendragoon" or (u.netloc != "connect" and u.path.strip("/") != "connect"):
        raise ValueError("gendragoon: not a connect link")
    q = {k: v[0] for k, v in urllib.parse.parse_qs(u.query).items()}
    req = ConnectRequest({"name": q.get("client", ""), **({"host": q["host"]} if q.get("host") else {})},
                         q.get("scope", "").replace(",", " ").split() or ["blobs:rw"], q.get("code_challenge", ""),
                         q.get("redirect_uri", ""), q.get("state", ""))
    if not req.client["name"]:
        raise ValueError("gendragoon: the app did not say who it is")
    if q.get("code_challenge_method") != "S256" or len(req.challenge) != 43:
        raise ValueError("gendragoon: missing PKCE challenge")
    if not is_loopback(req.redirect_uri):
        raise ValueError("gendragoon: the code can only go to an app on this device")
    if not req.state:
        raise ValueError("gendragoon: missing state")
    for s in req.scopes:
        if s not in ("blobs:rw", "blobs:r"):
            raise ValueError(f"gendragoon: unknown scope {s}")
    return req


class AccountClient(Transport):
    def __init__(self, base: str, token: Callable[[], str], **kw):
        super().__init__(**kw)
        self.base = base.rstrip("/")
        self._token = token

    def _call(self, op: str, method: str, path: str, body=None):
        self.check(op)
        r = self._send(method, self.base + path, None if body is None else json.dumps(body).encode(),
                       {} if body is None else {"Content-Type": "application/json"}, f"Bearer {self._token()}")
        return None if r.status == 204 or not r.body else r.json()

    def create_grant(self, workspace_id: str, name: str, host: str = "", scopes: tuple[str, ...] = ("blobs:rw",)) -> dict:
        """Issues a one-time connect code for a workspace. Level L3, risk sharing."""
        g = self._call("account.createGrant", "POST", "/connect/grants", {"workspaceId": workspace_id, "scopes": list(scopes),
                       "requester": {"name": name, **({"host": host} if host else {})}})
        if not GRANT_RE.match((g or {}).get("grant", "")):
            raise RuntimeError("gendragoon: unexpected grant response")
        return g

    def authorize(self, workspace_id: str, req: ConnectRequest) -> str:
        """Approves a connect link; returns the loopback redirect (with code and state). Level L3, risk sharing."""
        out = self._call("account.authorize", "POST", "/connect/authorize", {"workspaceId": workspace_id, "scopes": req.scopes,
                         "requester": req.client, "codeChallenge": req.challenge, "codeChallengeMethod": "S256"}) or {}
        if not CODE_RE.match(out.get("code", "")):
            raise RuntimeError("gendragoon: unexpected authorize response")
        u = urllib.parse.urlsplit(req.redirect_uri)
        q = urllib.parse.parse_qsl(u.query) + [("code", out["code"]), ("state", req.state)]
        return urllib.parse.urlunsplit(u._replace(query=urllib.parse.urlencode(q)))

    def list_bindings(self) -> list[dict]:
        """The account's connected apps. Level L2, risk read."""
        return (self._call("account.listBindings", "GET", "/bindings") or {}).get("bindings", [])

    def revoke_binding(self, binding_id: str) -> None:
        """Disconnects an app at once; its data is kept. Level L3, risk sharing."""
        self._call("account.revokeBinding", "DELETE", "/bindings/" + urllib.parse.quote(binding_id, safe=""))

    def revoke_and_delete(self, binding_id: str) -> int:
        """Disconnects an app and deletes everything it stored. Level L4, risk bulk-destructive: refused by default."""
        out = self._call("account.revokeAndDelete", "DELETE", "/bindings/" + urllib.parse.quote(binding_id, safe="") + "?deleteData=true")
        return (out or {}).get("purgedObjects", 0)
