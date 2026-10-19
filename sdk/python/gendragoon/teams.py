"""Teams calls of a signed-in GenDragoon user (/v2/teams on the API origin, Firebase ID token).

The server refuses gdsk_ API keys for teams and team workspaces. Calls that start a subscription return a Stripe
Checkout URL for the person to open; the SDK never completes a payment. Levels are listed in docs/LEVELS.md."""
from __future__ import annotations

import json
import re
import threading
import urllib.parse
from datetime import datetime
from typing import Callable, Iterator, Optional

from .client import Transport
from .errors import APIError

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)
_HASH = re.compile(r"^[0-9a-f]{64}$")


def _seg(v) -> str:
    s = str(v)
    if not s or len(s) > 128 or any(c in s for c in "/?#"):
        raise ValueError(f"gendragoon: invalid id {s!r}")
    return urllib.parse.quote(s, safe="")


def _until(until: Optional[datetime]) -> dict:
    return {} if until is None else {"until": int(until.timestamp() * 1000)}


def verify_audit_chain(entries: list[dict]) -> bool:
    """Checks that audit entries are consecutive and each links to the previous hash. The digests themselves are
    recomputed by the server."""
    prev = "0" * 64
    for i, e in enumerate(entries):
        if e.get("seq") != i + 1 or e.get("prev") != prev or not _HASH.match(str(e.get("hash", ""))):
            return False
        prev = e["hash"]
    return True


class TeamsClient(Transport):
    """``origin`` is the GenDragoon API origin; ``token`` returns a current Firebase ID token."""

    def __init__(self, origin: str, token: Callable[[], str], **kw):
        super().__init__(**kw)
        self.origin = origin.rstrip("/")
        self._token = token

    def _call(self, op: str, method: str, path: str, body=None) -> dict:
        self.check(op)
        r = self._send(method, self.origin + "/v2/teams" + path, None if body is None else json.dumps(body).encode(),
                       {} if body is None else {"Content-Type": "application/json"}, f"Bearer {self._token()}")
        return {} if r.status == 204 or not r.body else r.json()

    @staticmethod
    def _intent(intent_id: str) -> None:
        if not _UUID.match(intent_id or ""):
            raise ValueError("gendragoon: intent_id must be a UUID")

    def catalog(self) -> dict:
        """Team tiers, the Enterprise contact and the color palette. Level L2, risk read."""
        return self._call("teams.catalog", "GET", "/catalog")

    def list(self) -> list[dict]:
        """Teams the account belongs to. Level L2, risk read."""
        return self._call("teams.list", "GET", "")["teams"]

    def create(self, intent_id: str, name: str, tier: str, interval: str = "month", owner_shade: str = "") -> dict:
        """Creates a team and opens its subscription checkout ({team, url, totalCents, ...}). Reuse intent_id on retry.
        Level L3, risk billing."""
        self._intent(intent_id)
        body = {"intentId": intent_id, "name": name, "tier": tier, "interval": interval}
        if owner_shade:
            body["ownerShade"] = owner_shade
        return self._call("teams.create", "POST", "", body)

    def get(self, team_id: str) -> dict:
        """A team with its members and color choices ({team, colors}). Level L2, risk read."""
        return self._call("teams.get", "GET", f"/{_seg(team_id)}")

    def checkout(self, team_id: str, tier: str = "", interval: str = "") -> dict:
        """Resumes or replaces the team subscription checkout. Level L3, risk billing."""
        body = {k: v for k, v in (("tier", tier), ("interval", interval)) if v}
        return self._call("teams.checkout", "POST", f"/{_seg(team_id)}/checkout", body)

    def create_invite(self, team_id: str, expires_in_hours: int = 0, max_uses: int = 0) -> dict:
        """Creates an invite code (owner); the code is shown once. Level L3, risk sharing."""
        body = {k: v for k, v in (("expiresInHours", expires_in_hours), ("maxUses", max_uses)) if v}
        return self._call("teams.createInvite", "POST", f"/{_seg(team_id)}/invites", body)

    def revoke_invite(self, team_id: str, invite_id: str) -> None:
        """Revokes an invite code (owner). Level L3, risk sharing."""
        self._call("teams.revokeInvite", "POST", f"/{_seg(team_id)}/invites/{_seg(invite_id)}/revoke", {})

    def preview_invite(self, code: str) -> dict:
        """Team name, size and free colors for an invite code. Level L2, risk read."""
        return self._call("teams.previewInvite", "POST", "/join/preview", {"code": code})

    def join(self, code: str, color: str, display_name: str = "", device_name: str = "") -> dict:
        """Joins a team with an invite code and a free member color ({teamId, alreadyMember}). Level L3, risk sharing."""
        body = {"code": code, "color": color}
        if display_name:
            body["displayName"] = display_name
        if device_name:
            body["deviceName"] = device_name
        return self._call("teams.join", "POST", "/join", body)

    def update_me(self, team_id: str, display_name: Optional[str] = None, color: Optional[str] = None) -> None:
        """Changes your display name or color in a team. Level L2, risk write."""
        body = {k: v for k, v in (("displayName", display_name), ("color", color)) if v is not None}
        self._call("teams.updateMe", "PATCH", f"/{_seg(team_id)}/me", body)

    def leave(self, team_id: str) -> None:
        """Leaves a team; your shared personal workspaces are unshared. Level L3, risk destructive."""
        self._call("teams.leave", "POST", f"/{_seg(team_id)}/leave", {})

    def workspaces(self, team_id: str) -> dict:
        """Team workspaces (files over storageRoutes) and shared personal workspaces. Level L2, risk read."""
        return self._call("teams.workspaces", "GET", f"/{_seg(team_id)}/workspaces")

    def create_workspace(self, team_id: str, intent_id: str, name: str, plans: dict, storage: str = "managed") -> dict:
        """Creates a team workspace and opens its plans checkout (owner). Level L3, risk billing."""
        self._intent(intent_id)
        return self._call("teams.createWorkspace", "POST", f"/{_seg(team_id)}/workspaces",
                          {"intentId": intent_id, "name": name, "storage": storage, "plans": plans})

    def checkout_workspace(self, team_id: str, workspace_id: str) -> dict:
        """Resumes a team workspace's plans checkout (owner). Level L3, risk billing."""
        return self._call("teams.checkoutWorkspace", "POST", f"/{_seg(team_id)}/workspaces/{_seg(workspace_id)}/checkout", {})

    def share(self, team_id: str, workspace_id: str) -> None:
        """Shows one of your personal workspaces to the team, view only. Level L3, risk sharing."""
        self._call("teams.share", "POST", f"/{_seg(team_id)}/shares", {"workspaceId": workspace_id})

    def unshare(self, team_id: str, workspace_id: str) -> None:
        """Stops showing a personal workspace to the team. Level L3, risk sharing."""
        self._call("teams.unshare", "DELETE", f"/{_seg(team_id)}/shares/{_seg(workspace_id)}")

    def messages(self, team_id: str, after: int = 0, limit: int = 0) -> dict:
        """Chat messages above ``after`` ({messages, latestSeq, pollAfterMs}). Level L2, risk read."""
        q = f"?after={int(after)}" + (f"&limit={int(limit)}" if limit else "")
        return self._call("teams.chat.list", "GET", f"/{_seg(team_id)}/chat{q}")

    def watch_chat(self, team_id: str, after: int = 0, stop: Optional[threading.Event] = None,
                   interval: float = 0.0) -> Iterator[dict]:
        """Yields new chat messages until stop is set or you lose access to the team. Polls every pollAfterMs (the
        server also offers Server-Sent Events at /chat/stream; this SDK polls). Level L2, risk read."""
        self.check("teams.chat.watch")
        stop = stop or threading.Event()
        wait = 3.0
        while not stop.is_set():
            try:
                p = self.messages(team_id, after, 100)
                for m in p["messages"]:
                    if m["seq"] > after:
                        after = m["seq"]
                        yield m
                if p.get("pollAfterMs"):
                    wait = p["pollAfterMs"] / 1000
            except APIError as e:
                if e.status in (401, 403, 404):
                    return
            except ConnectionError:
                pass
            stop.wait(max(wait, interval))

    def post(self, team_id: str, text: str) -> dict:
        """Posts a text message. Level L2, risk write."""
        return self._call("teams.chat.post", "POST", f"/{_seg(team_id)}/chat", {"text": text})["message"]

    def post_card(self, team_id: str, scope: str, workspace_id: str, text: str = "") -> dict:
        """Posts a workspace card. A personal-workspace card also shares it with the team, so it needs the sharing
        level too. Level L2, risk write."""
        if scope == "personal":
            self.check("teams.share")
        return self._call("teams.chat.post", "POST", f"/{_seg(team_id)}/chat",
                          {"text": text, "card": {"scope": scope, "workspaceId": workspace_id}})["message"]

    def report(self, team_id: str, seq: int, category: str, note: str = "") -> None:
        """Reports a message (spam, abuse, harassment, illegal or other). Level L2, risk write."""
        self._call("teams.chat.report", "POST", f"/{_seg(team_id)}/chat/{_seg(seq)}/report", {"category": category, "note": note})

    def delete_message(self, team_id: str, seq: int, reason: str) -> None:
        """Removes a message (owner; reason required). Level L3, risk destructive."""
        self._call("teams.chat.delete", "POST", f"/{_seg(team_id)}/chat/{_seg(seq)}/delete", {"reason": reason})

    def _moderate(self, action: str, team_id: str, member_id: str, body: dict) -> None:
        self._call(f"teams.members.{action}", "POST", f"/{_seg(team_id)}/members/{_seg(member_id)}/{action}", body)

    def mute(self, team_id: str, member_id: str, reason: str, until: Optional[datetime] = None) -> None:
        """Mutes a member until a time, or until lifted (owner; reason required). Level L3, risk destructive."""
        self._moderate("mute", team_id, member_id, {"reason": reason, **_until(until)})

    def unmute(self, team_id: str, member_id: str, reason: str = "") -> None:
        """Lifts a mute (owner). Level L3, risk write."""
        self._moderate("unmute", team_id, member_id, {"reason": reason})

    def kick(self, team_id: str, member_id: str, reason: str) -> None:
        """Removes a member; they can rejoin with a new invite (owner; reason required). Level L3, risk destructive."""
        self._moderate("kick", team_id, member_id, {"reason": reason})

    def ban(self, team_id: str, member_id: str, reason: str, until: Optional[datetime] = None) -> None:
        """Removes a member and blocks rejoining until a time, or for good (owner; reason required).
        Level L3, risk destructive."""
        self._moderate("ban", team_id, member_id, {"reason": reason, **_until(until)})

    def set_role(self, team_id: str, member_id: str, role: str) -> None:
        """Makes a member a "viewer" (read team files) or a "member" (read and write) (owner). Level L3, risk sharing."""
        if role not in ("viewer", "member"):
            raise ValueError('gendragoon: role must be "viewer" or "member"')
        self._call("teams.members.setRole", "POST", f"/{_seg(team_id)}/members/{_seg(member_id)}/role", {"role": role})

    def audit(self, team_id: str) -> list[dict]:
        """The team's hash-chained audit log, oldest first (owner). Level L2, risk read."""
        return self._call("teams.audit", "GET", f"/{_seg(team_id)}/audit")["entries"]

    def transfer(self, team_id: str, member_id: str, color: str, owner_shade: str = "") -> None:
        """Hands the team to another member (owner). Level L4, risk sharing: the default gate refuses it."""
        body = {"memberId": member_id, "color": color}
        if owner_shade:
            body["ownerShade"] = owner_shade
        self._call("teams.transfer", "POST", f"/{_seg(team_id)}/transfer", body)

    def delete(self, team_id: str, confirm_name: str) -> None:
        """Deletes the team, its chat and its team workspaces with their files (owner). Level L4, risk
        bulk-destructive: the default gate refuses it."""
        self._call("teams.delete", "POST", f"/{_seg(team_id)}/delete", {"confirmName": confirm_name})
