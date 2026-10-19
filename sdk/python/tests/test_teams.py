"""Teams contract suite (sdk/spec/CONTRACT.md, T01-T10) against contract/teams_dev_server.cjs."""
import json
import os
import threading
import urllib.request
import uuid

import pytest

import gendragoon as gd


def user(origin, uid, max_level="L3"):
    return gd.TeamsClient(origin, lambda: f"dev-user:{uid}", gate=gd.level_gate(max_level))


def pay(origin, url):
    req = urllib.request.Request(origin + "/__dev/pay", data=json.dumps({"url": url}).encode(), method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        assert r.status == 200


def status(fn):
    try:
        fn()
    except gd.APIError as e:
        return e.status
    return 0


def test_teams_contract(teams_origin):
    o = teams_origin
    alice, bob = user(o, "alice" + os.urandom(4).hex()), user(o, "bob" + os.urandom(4).hex())

    # T01 catalog
    assert len(alice.catalog()["tiers"]) >= 3

    # T02 create and pay
    with pytest.raises(gd.LevelError):
        user(o, "x", "L2").create(str(uuid.uuid4()), "Studio", "team")
    r = alice.create(str(uuid.uuid4()), "Studio", "team")
    assert r["url"] and r["team"]["role"] == "owner"
    team = r["team"]["id"]
    pay(o, r["url"])
    teams = alice.list()
    assert len(teams) == 1 and teams[0]["subscriptionActive"]

    # T03 invite, preview, join
    inv = alice.create_invite(team, max_uses=2)
    p = bob.preview_invite(inv["code"])
    assert p["teamName"] == "Studio"
    color = next(c["id"] for c in p["colors"]["memberColors"] if not c["taken"])
    assert bob.join(inv["code"], color, display_name="Bob") == {"teamId": team, "alreadyMember": False}
    assert bob.join(inv["code"], color)["alreadyMember"] is True
    alice.revoke_invite(team, inv["inviteId"])

    # T04 view and update me
    bob.update_me(team, display_name="Bobby")
    members = alice.get(team)["team"]["members"]
    assert len(members) == 2
    b = next(m for m in members if m["role"] == "member")
    assert b["displayName"] == "Bobby"
    bob_id = b["memberId"]

    # T05 chat post, list, watch
    m = bob.post(team, "hello")
    page = alice.messages(team)
    assert page["latestSeq"] == m["seq"] and page["messages"][-1]["text"] == "hello"
    stop = threading.Event()
    it = bob.watch_chat(team, after=page["latestSeq"], stop=stop)
    threading.Timer(0.2, lambda: alice.post(team, "welcome")).start()
    assert next(it)["text"] == "welcome"
    stop.set()

    # T06 report and delete
    alice.report(team, m["seq"], "spam", "test")
    assert status(lambda: bob.delete_message(team, m["seq"], "cleanup")) == 403
    alice.delete_message(team, m["seq"], "off topic")
    assert alice.messages(team, m["seq"] - 1, 1)["messages"][0]["kind"] == "removed"

    # T07 team workspace and roles
    w = alice.create_workspace(team, str(uuid.uuid4()), "Art", {"storageTier": "100GB", "performanceTier": "boost"})
    assert w["url"] and w["workspace"]["storageRoutes"]["v3"] == "/v3/cloud/" + w["workspace"]["id"]
    pay(o, w["url"])
    alice.set_role(team, bob_id, "viewer")
    ws = bob.workspaces(team)
    assert len(ws["teamWorkspaces"]) == 1 and ws["teamWorkspaces"][0]["access"] == "read" and ws["subscriptionActive"]
    alice.set_role(team, bob_id, "member")

    # T08 mute and unmute
    alice.mute(team, bob_id, "cool down")
    assert status(lambda: bob.post(team, "hi")) == 403
    alice.unmute(team, bob_id)
    bob.post(team, "back")

    # T09 audit
    assert status(lambda: bob.audit(team)) == 403
    a = alice.audit(team)
    assert len(a) >= 4 and gd.verify_audit_chain(a)
    a[1]["prev"] = a[0]["prev"]
    assert not gd.verify_audit_chain(a)

    # T10 levels and removal
    with pytest.raises(gd.LevelError):
        alice.transfer(team, bob_id, "blue-500")
    with pytest.raises(gd.LevelError):
        alice.delete(team, "Studio")
    alice.kick(team, bob_id, "done")
    assert status(lambda: bob.get(team)) in (403, 404)
