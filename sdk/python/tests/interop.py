"""The Python participant of the cross-language interop check (sdk/contract/run.sh)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import gendragoon as gd  # noqa: E402

lang = os.environ.get("GD_SDK_LANG") or "python"
c = gd.Client(os.environ["GD_SDK_BASE"], os.environ["GD_SDK_KEY"])
keys = gd.Keyring(c)
(keys.create if "--init" in sys.argv else keys.unlock)(os.environ["GD_SDK_PASSPHRASE"])
d = gd.Drive(c, "interop", keys)
verified = []
for e in d.list(""):
    if e.folder or not e.name.startswith("from-"):
        continue
    who = e.name[5:].removesuffix(".txt")
    got = d.read_file(e.path)
    if got != f"hello from {who}\n".encode():
        raise SystemExit(f"{e.path}: unexpected content {got!r}")
    verified.append(who)
d.write_file(f"from-{lang}.txt", f"hello from {lang}\n".encode())
print(json.dumps({"lang": lang, "verified": verified}))
