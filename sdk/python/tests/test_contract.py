"""Shared contract suite (sdk/spec/CONTRACT.md) against a local backend."""
import os
import threading
import time
import urllib.parse

import pytest

import gendragoon as gd

PASS = "contract passphrase"


def uid():
    return "u" + os.urandom(6).hex()


def account(base, user, **kw):
    return gd.AccountClient(base, lambda: f"dev-user:{user}", **kw)


class Rig:
    def __init__(self, base, workspace, **kw):
        self.acct = account(base, uid())
        g = self.acct.create_grant(workspace, "Python contract", host="test")
        self.conn = gd.Connector(base, **kw).redeem_grant(g["grant"], "Python contract")
        self.client = gd.Client(base, self.conn["apiKey"], **kw)
        self.keys = gd.Keyring(self.client)


def test_c01_connect_with_grant(base):
    r = Rig(base, "ws")
    r.client.health()
    caps = r.client.capabilities()
    assert caps["events"]["poll"] and caps["maxBlobBytes"] == 16 << 20
    with pytest.raises(gd.APIError) as e:
        gd.Connector(base).redeem_grant("gdpg_" + "A" * 43, "x")
    assert e.value.code == "invalid_grant"


def test_c02_connect_with_pkce(base):
    acct = account(base, uid())
    p = gd.new_pkce()
    req = gd.parse_connect_link(gd.connect_link("Python contract", p, "http://127.0.0.1:9/cb"))
    q = urllib.parse.parse_qs(urllib.parse.urlsplit(acct.authorize("ws", req)).query)
    assert q["state"][0] == p.state
    k = gd.Connector(base)
    with pytest.raises(gd.APIError):
        k.exchange_code(q["code"][0], gd.new_pkce().verifier)
    assert k.exchange_code(q["code"][0], p.verifier)["workspaceId"] == "ws"


def test_c03_master_key_lifecycle(base):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    with pytest.raises(gd.APIError) as e:
        gd.Keyring(r.client).create(PASS)
    assert e.value.precondition_failed
    k2 = gd.Keyring(r.client)
    with pytest.raises(gd.WrongPassphraseError):
        k2.unlock("not the passphrase")
    r.keys.change_passphrase("a brand new passphrase")
    k2.unlock("a brand new passphrase")
    with pytest.raises(gd.LevelError):
        r.keys.export_master_key()


def test_c04_encrypted_files_and_folders(base):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    d = gd.Drive(r.client, "saves", r.keys, chunk_size=1024)
    data = os.urandom(5000)
    d.mkdir("levels/1")
    assert len(d.write_file("slots/slot1.sav", data)["chunks"]) == 5
    assert d.read_file("slots/slot1.sav") == data
    assert [(e.name, e.folder) for e in d.list("")] == [("levels", True), ("slots", True)]
    d.move("slots/slot1.sav", "slots/slot2.sav")
    d.stat("slots/slot2.sav")
    with pytest.raises(ValueError, match="not empty"):
        d.delete("levels")
    assert d.delete_folder("levels") == 0
    d.delete("slots/slot2.sav")
    with pytest.raises(gd.APIError) as e:
        d.read_file("slots/slot2.sav")
    assert e.value.not_found
    for b in r.client.all_blobs():
        assert data[:64] not in r.client.get_blob(b.id)


def test_c05_plain_drive(base):
    r = Rig(base, "ws")
    d = gd.Drive(r.client, "public", plain=True)
    d.write_file("readme.txt", b"hello")
    e = d.stat("readme.txt")
    assert e["chunks"][0] == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" and "key" not in e


def test_c06_concurrent_writers(base):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    errs = []

    def writer(w):
        d = gd.Drive(r.client, "shared", r.keys)
        try:
            for i in range(10):
                d.write_file(f"w{w}/f{i}", bytes([i]))
        except Exception as e:  # noqa: BLE001
            errs.append(e)
    ts = [threading.Thread(target=writer, args=(w,)) for w in range(2)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert not errs
    assert len(gd.Drive(r.client, "shared", r.keys).snapshot()["files"]) == 20


def test_c07_quota(base):
    r = Rig(base, "small")
    with pytest.raises(gd.APIError) as e:
        gd.Drive(r.client, "big", plain=True).write_file("too-big.bin", bytes(100 << 10))
    assert e.value.quota_exceeded
    u = r.client.usage()
    assert u["quotaBytes"] == 64 << 10 and u["usedBytes"] <= u["quotaBytes"]


def test_c08_gate(base):
    r = Rig(base, "ws", gate=gd.level_gate("L2"))
    with pytest.raises(gd.LevelError) as e:
        gd.Drive(r.client, "x", plain=True).delete_folder("a")
    assert e.value.op.id == "files.deleteFolder" and e.value.op.level == "L3"
    with pytest.raises(gd.LevelError):
        r.client.wipe()


def test_c09_events(base):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    d = gd.Drive(r.client, "watched", r.keys)
    stop = threading.Event()
    events = []

    def run():
        for ev in gd.watch(r.client, interval=1, stop=stop):
            events.append(ev)
    t = threading.Thread(target=run, daemon=True)
    t.start()

    def wait_for(kind, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            for ev in events:
                if ev.type == kind:
                    return ev
            time.sleep(0.1)
        pytest.fail(f"no {kind} event")
    time.sleep(1.2)
    d.write_file("a", b"1")
    assert wait_for("manifest.created").key == d.manifest_key
    d.write_file("a", b"2")
    wait_for("manifest.updated")
    r.acct.revoke_binding(r.conn["bindingId"])
    wait_for("binding.revoked")
    stop.set()


def test_c10_sharing(base):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    d = gd.Drive(r.client, "docs", r.keys)
    d.write_file("letter.txt", b"for your eyes only")
    rk = gd.create_read_key(r.client, "recipient", 1)
    reader = gd.Client(base, rk["apiKey"])
    ident = gd.Identity.create(reader)
    share = gd.export_share(r.client, d, "letter.txt", ident.public)
    f, data = gd.open_share(reader, ident, share)
    assert f["path"] == "letter.txt" and data == b"for your eyes only"
    with pytest.raises(ValueError):
        gd.open_share(reader, gd.Identity.create(reader), share)
    with pytest.raises(gd.APIError):
        reader.put_sealed_blob("0" * 64, b"x")
    with pytest.raises(gd.APIError):
        gd.Keyring(reader).unlock(PASS)
    keys = gd.list_read_keys(r.client)
    assert len(keys) == 1 and "apiKey" not in keys[0]
    gd.revoke_read_key(r.client, rk["keyId"])
    with pytest.raises(gd.APIError) as e:
        gd.open_share(reader, ident, share)
    assert e.value.unauthorized


def test_c11_sync(base, tmp_path):
    r = Rig(base, "ws")
    r.keys.create(PASS)
    d = gd.Drive(r.client, "sync", r.keys)
    src, dst = tmp_path / "src", tmp_path / "dst"
    (src / "a" / "b").mkdir(parents=True)
    (src / "a" / "b" / "one.txt").write_text("one")
    (src / "two.txt").write_text("two")
    assert len(gd.push(r.client, d, str(src), prefix="backup").uploaded) == 2
    again = gd.push(r.client, d, str(src), prefix="backup")
    assert (len(again.uploaded), again.unchanged) == (0, 2)
    assert len(gd.pull(r.client, d, str(dst), prefix="backup").downloaded) == 2
    assert (dst / "a" / "b" / "one.txt").read_text() == "one"
    (src / "two.txt").unlink()
    assert gd.mirror(r.client, d, str(src), "to_drive", prefix="backup", dry_run=True).deleted == ["backup/two.txt"]
    d.stat("backup/two.txt")
    gd.mirror(r.client, d, str(src), "to_drive", prefix="backup")
    with pytest.raises(gd.APIError):
        d.stat("backup/two.txt")


def test_c12_garbage_and_wipe(base):
    r = Rig(base, "ws", gate=gd.level_gate("L4"))
    r.keys.create(PASS)
    d = gd.Drive(r.client, "g", r.keys)
    d.write_file("keep", b"keep")
    d.write_file("drop", b"drop")
    d.delete("drop")
    assert gd.collect_garbage(r.client, r.keys) == 1
    assert d.read_file("keep") == b"keep"
    with pytest.raises(RuntimeError, match="refusing"):
        gd.collect_garbage(r.client, None)
    r.client.wipe()
    assert r.client.all_manifests() == []
    u = r.client.usage()
    assert (u["usedBytes"], u["objectCount"]) == (0, 0)


def test_c13_rotate_key(base):
    r = Rig(base, "ws")
    old = r.client.api_key
    assert r.client.rotate_api_key() != old
    r.client.health()


def test_c14_account_bindings(base):
    r = Rig(base, "ws")
    gd.Drive(r.client, "p", plain=True).write_file("x", b"12345")
    lst = r.acct.list_bindings()
    assert len(lst) == 1 and lst[0]["active"] and lst[0]["usedBytes"] > 0
    with pytest.raises(gd.LevelError):
        r.acct.revoke_and_delete(lst[0]["id"])
    with pytest.raises(gd.APIError) as e:
        account(base, "nobody", gate=gd.level_gate("L4")).revoke_and_delete(lst[0]["id"])
    assert e.value.not_found
