"""Structural non-executable resources for tests of later packaging gates."""
import hashlib
import json


def seed_compiled_runtime(package, resources):
    files = {}
    for name in package.PRIVATE_PYC_RESOURCES:
        path = resources / name
        path.parent.mkdir(parents=True, exist_ok=True)
        # These tests mock signing and never execute this deliberately fake
        # code. Actual import tests compile real Python in their own fixture.
        data = bytes.fromhex("f30d0d0a01000000") + b"\0" * 8 + b"fixture-code"
        path.write_bytes(data)
        files[name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    (resources / "gendragoon_python_runtime.json").write_text(json.dumps({
        "schema": 1, "pythonMajorMinor": "3.13", "architecture": "arm64",
        "pinnedLibrary": "9235941b431bc1c23c34286b82052f845121592f",
        "bytecodeMagic": "f30d0d0a", "sourceIncluded": False, "compiledModules": files}))
