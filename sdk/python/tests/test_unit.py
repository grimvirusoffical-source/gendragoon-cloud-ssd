"""Cross-language vectors (sdk/spec/vectors/v1.json), the operation table and the gate. No network."""
import json
import os
import pathlib

import pytest

import gendragoon as gd
from gendragoon.crypto import from_b64u
from gendragoon.share import seal_share

SPEC = pathlib.Path(__file__).resolve().parents[2] / "spec"
V = json.loads((SPEC / "vectors" / "v1.json").read_text())
OPSPEC = json.loads((SPEC / "operations.json").read_text())
h = bytes.fromhex


def test_hkdf():
    for v in V["hkdf"]:
        assert gd.sub_key(h(v["ikm"]), v["purpose"]).hex() == v["out"]


@pytest.mark.parametrize("name", ["envelopeScrypt", "envelopeArgon2id"])
def test_envelopes(name):
    e = V[name]
    try:
        assert gd.unwrap_master_key(e["envelope"], e["passphrase"]).hex() == e["masterKey"]
    except RuntimeError as err:  # argon2id needs cryptography >= 44
        pytest.skip(str(err))
    with pytest.raises(gd.WrongPassphraseError):
        gd.unwrap_master_key(e["envelope"], "not the passphrase")
    env = e["envelope"]
    fixed = lambda n: from_b64u(env["salt"]) if n == 16 else from_b64u(env["iv"])  # noqa: E731
    assert gd.wrap_master_key(h(e["masterKey"]), e["passphrase"], env["kdf"], 1, fixed) == env


def test_chunk():
    c = V["chunk"]
    blob_id, blob = gd.seal_chunk(h(c["fileKey"]), h(c["plaintext"]), h(c["nonce"]))
    assert (blob_id, blob.hex()) == (c["id"], c["blob"])
    assert gd.open_chunk(h(c["fileKey"]), c["id"], blob).hex() == c["plaintext"]
    with pytest.raises(gd.CorruptError):
        gd.open_chunk(h(c["fileKey"]), c["id"], blob[:-1] + bytes([blob[-1] ^ 1]))


def test_manifest():
    m = V["manifest"]
    assert gd.drive_manifest_key(h(m["masterKey"]), m["driveName"]) == m["manifestKey"]
    assert gd.drive_manifest_key(None, m["driveName"]) == m["plainManifestKey"]
    assert gd.seal_manifest(h(m["masterKey"]), m["manifestKey"], m["plaintext"].encode(), h(m["nonce"])).hex() == m["sealed"]
    assert gd.open_manifest(h(m["masterKey"]), m["manifestKey"], h(m["sealed"])).decode() == m["plaintext"]
    with pytest.raises(gd.LockedError):
        gd.open_manifest(None, m["manifestKey"], h(m["sealed"]))


def test_share():
    s = V["share"]
    ident = gd.Identity.from_private(h(s["recipientPrivate"]))
    assert ident.public == s["recipientPublic"]
    assert ident.private_bytes().hex() == s["recipientPrivate"]
    assert json.dumps(gd.open_share_envelope(ident, s["share"]), separators=(",", ":")) == s["payload"]
    eph = gd.Identity.from_private(h(s["ephemeralPrivate"]) + from_b64u(s["share"]["epk"]))
    assert seal_share(from_b64u(s["recipientPublic"][6:]), s["payload"].encode(), eph, h(s["nonce"])) == s["share"]
    other = gd.Identity.create(gd.Client("http://x", "gdpk_0123456789abcdef_" + "A" * 43))
    with pytest.raises(ValueError, match="someone else"):
        gd.open_share_envelope(other, s["share"])


def test_pkce():
    assert gd.pkce_challenge(V["pkce"]["verifier"]) == V["pkce"]["challenge"]


def test_operation_table_matches_spec():
    assert len(gd.OPERATIONS) == len(OPSPEC["operations"])
    for g, o in zip(gd.OPERATIONS, OPSPEC["operations"]):
        assert (g.id, g.level, g.service, g.risk, g.context) == (o["id"], o["level"], o["service"], o["risk"], o["context"])
        assert int(g.level[1]) >= int(OPSPEC["levelSource"]["services"][o["service"]]["level"][1])


def test_gate(monkeypatch):
    op = {o.id: o for o in gd.OPERATIONS}
    g = gd.level_gate()
    g(op["files.deleteFolder"])
    with pytest.raises(gd.LevelError):
        g(op["storage.wipe"])
    monkeypatch.setenv(gd.MAX_LEVEL_ENV, "L2")
    with pytest.raises(gd.LevelError):
        gd.level_gate("L4")(op["files.deleteFolder"])
    monkeypatch.setenv(gd.MAX_LEVEL_ENV, "L4")
    with pytest.raises(gd.LevelError):
        gd.level_gate("L3")(op["storage.wipe"])
    monkeypatch.setenv(gd.MAX_LEVEL_ENV, "banana")
    with pytest.raises(gd.LevelError):
        gd.level_gate("L4")(op["usage"])


def test_paths_and_links():
    for bad in ["", "/a", "a/", "a//b", "a/../b", ".", "a\\b", "a/\x01", "x" * 1025]:
        with pytest.raises(ValueError):
            gd.clean_path(bad)
    gd.clean_path("saves/slot 1.sav")
    p = gd.new_pkce()
    link = gd.connect_link("My Game", p, "http://127.0.0.1:5000/cb")
    req = gd.parse_connect_link(link)
    assert req.challenge == p.challenge and req.client["name"] == "My Game"
    with pytest.raises(ValueError):
        gd.connect_link("x", p, "https://evil.example/cb")
    with pytest.raises(ValueError):
        gd.parse_connect_link(link.replace("127.0.0.1", "evil.example"))


def test_secrets_not_in_repr():
    c = gd.Client("http://x", "gdpk_0123456789abcdef_" + "B" * 43)
    assert "gdpk_" not in repr(c) and "BBBB" not in repr(gd.Keyring(c))
