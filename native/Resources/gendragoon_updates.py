#!/usr/bin/env python3
"""GenDragoon owner-only GitHub publishing and verified release downloads.

No Google credentials or GitHub tokens are accepted by this program. GitHub CLI
manages the signed-in account; publish actions re-check its verified owner email.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import ssl

OWNER_EMAIL = "grimvirusoffical@gmail.com"
REPO_NAME = "gendragoon-cloud-ssd"
APP = Path.home() / "Applications" / "GenDragoon Cloud SSD.app"
SUPPORT = Path.home() / "Library" / "Application Support" / "GenDragoon Cloud SSD"
REPO_SETTINGS = SUPPORT / "release-repo.json"
ZIP_BASENAME = "GenDragoon-Cloud-SSD-Mac"
USER_AGENT = "GenDragoonCloudSSD/0.13 (macOS)"
HTTPS_CONTEXT = ssl.create_default_context(cafile="/etc/ssl/cert.pem") if Path("/etc/ssl/cert.pem").exists() else ssl.create_default_context()


def reply(ok=True, **fields):
    print(json.dumps({"ok": bool(ok), **fields}, sort_keys=True))


def fail(message, code=1):
    reply(False, message=str(message))
    raise SystemExit(code)


def find_gh():
    # Prefer GenDragoon's checksum-verified GitHub CLI; reject npm's unrelated gh.
    names = (str(SUPPORT / "Tools" / "gh"), "/opt/homebrew/bin/gh", "/usr/local/bin/gh", shutil.which("gh"))
    for candidate in names:
        if candidate and Path(candidate).is_file() and os.access(candidate, os.X_OK):
            try:
                p = subprocess.run([candidate, "--version"], capture_output=True, text=True, timeout=10)
                if p.returncode == 0 and p.stdout.startswith("gh version"):
                    return candidate
            except (OSError, subprocess.TimeoutExpired):
                continue
    return None


def cmd(args, *, check=True, timeout=90):
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    if check and p.returncode:
        # Do not expose environment, auth tokens or full command strings in UI errors.
        detail = (p.stderr or p.stdout).strip()[:420]
        raise RuntimeError(detail or f"Command exited with status {p.returncode}")
    return p


def identity():
    gh = find_gh()
    if not gh:
        return {"owner": False, "login": "", "message": "GitHub CLI missing. Install gh, then log in using your browser."}
    try:
        info = json.loads(cmd([gh, "api", "user"]).stdout)
        emails = json.loads(cmd([gh, "api", "--paginate", "user/emails?per_page=100"]).stdout)
        verified = any(str(item.get("email", "")).lower() == OWNER_EMAIL and item.get("verified") is True for item in emails)
        login = str(info.get("login") or "")
        return {"owner": verified, "login": login, "message": (
            f"Owner verified: @{login} has {OWNER_EMAIL} confirmed by GitHub." if verified else
            f"Signed in as @{login}, but {OWNER_EMAIL} is not among this account's verified emails. Publishing is locked."
        )}
    except Exception:
        return {"owner": False, "login": "", "message": "GitHub authentication or email verification failed. Run: gh auth login --web --scopes repo,user:email"}


def require_owner():
    who = identity()
    if not who["owner"] or not who["login"]:
        fail(who["message"])
    return who["login"]


def repo_file_in_app():
    return APP / "Contents" / "Resources" / "release-repo.json"


def valid_repo(value):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}", value or ""):
        raise ValueError("Invalid repository slug. Expected owner/repository.")
    return value


def read_repo():
    for location in (REPO_SETTINGS, repo_file_in_app()):
        if location.is_file():
            try:
                return valid_repo(json.loads(location.read_text(encoding="utf-8"))["repo"])
            except (ValueError, KeyError, TypeError):
                continue
    return ""


def save_repo(repo):
    repo = valid_repo(repo)
    SUPPORT.mkdir(parents=True, exist_ok=True)
    SUPPORT.chmod(0o700)
    data = json.dumps({"repo": repo}, indent=2) + "\n"
    REPO_SETTINGS.write_text(data, encoding="utf-8")
    REPO_SETTINGS.chmod(0o600)
    # Never alter installed .app resources: that invalidates its code signature.
    # The published preview is built from a separately signed copy below.


def make_repo():
    login = require_owner()
    repo = f"{login}/{REPO_NAME}"
    gh = find_gh()
    existing = cmd([gh, "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"], check=False)
    if existing.returncode == 0:
        visibility = cmd([gh, "repo", "view", repo, "--json", "visibility", "--jq", ".visibility"]).stdout.strip().upper()
        if visibility != "PUBLIC":
            fail(f"Repository {repo} exists but isn't public. Public downloads require a public release repository; change its visibility explicitly on GitHub first.")
        save_repo(repo)
        return reply(message=f"Existing public repository connected: {repo}", repo=repo)
    # Explicit user-confirmed action from the app. Public is necessary for updates
    # without authenticating every end-user. Never push private local data.
    cmd([gh, "repo", "create", repo, "--public", "--add-readme", "--description",
         "GenDragoon Cloud SSD app updates (no user data or Google credentials)"])
    save_repo(repo)
    return reply(message=f"Created PUBLIC update repository: {repo}. Only an initial README was created.", repo=repo)


def app_version():
    info = APP / "Contents" / "Info.plist"
    if not info.exists():
        return "0.2.0"
    with info.open("rb") as fp:
        return str(plistlib.load(fp).get("CFBundleShortVersionString") or "0.2.0")


def request_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=18, context=HTTPS_CONTEXT) as response:
        return json.load(response)


def latest_release():
    repo = read_repo()
    if not repo:
        fail("Update repository isn't configured. The owner must create it and publish a release first.")
    try:
        releases = request_json(f"https://api.github.com/repos/{repo}/releases?per_page=30")
        data = next((item for item in releases if not item.get("draft") and
                     re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", str(item.get("tag_name") or ""))), None)
        if data is None:
            fail("No published releases found yet. Ask the owner to publish a preview.")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            fail("No public release available yet. Owner: use Publish Preview after connecting a repository.")
        fail(f"GitHub request failed (HTTP {exc.code}).")
    except (urllib.error.URLError, TimeoutError):
        fail("Could not contact GitHub. Check your internet connection.")
    tag = str(data.get("tag_name") or "")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        fail("Release tag is not a supported version (expected v1.2.3).")
    assets = data.get("assets", [])
    zipname = f"{ZIP_BASENAME}-{tag}.zip"
    found = {item.get("name"): item.get("browser_download_url") for item in assets}
    if zipname not in found or "sha256.txt" not in found:
        fail("Release is missing its app ZIP or sha256.txt integrity file.")
    for name in (zipname, "sha256.txt"):
        url = found[name] or ""
        if not url.startswith("https://github.com/"):
            fail("Unexpected release asset download URL.")
    return {"repo": repo, "tag": tag, "zip": zipname, "urls": found,
            "current": app_version(), "page": f"https://github.com/{repo}/releases/tag/{tag}"}


def download_url(url, target, max_bytes):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=90, context=HTTPS_CONTEXT) as resp, target.open("wb") as fh:
        total = 0
        while True:
            chunk = resp.read(1024 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise RuntimeError("Downloaded update exceeds the maximum supported size")
            fh.write(chunk)


def download_release():
    rel = latest_release()
    dest = Path.home() / "Downloads" / "GenDragoonUpdates"
    dest.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gd-update-") as td:
        directory = Path(td)
        checksum_path = directory / "sha256.txt"
        archive_path = directory / rel["zip"]
        download_url(rel["urls"]["sha256.txt"], checksum_path, 128 * 1024)
        entry = checksum_path.read_text(encoding="utf-8")
        expected = None
        for line in entry.splitlines():
            m = re.fullmatch(r"([a-fA-F0-9]{64})\s+\*?(.+)", line.strip())
            if m and m.group(2) == rel["zip"]:
                expected = m.group(1).lower()
        if not expected:
            fail("Release checksum manifest does not mention the expected app ZIP.")
        download_url(rel["urls"][rel["zip"]], archive_path, 2 * 1024**3)
        sha = hashlib.sha256()
        with archive_path.open("rb") as fh:
            for block in iter(lambda: fh.read(1024 * 1024), b""):
                sha.update(block)
        if sha.hexdigest() != expected:
            fail("Checksum mismatch! Update was not saved.")
        output = dest / rel["zip"]
        shutil.copy2(archive_path, output)
    reply(message=f"Downloaded and SHA-256 verified {rel['tag']} to {output}. Review the app's signature before installing; installation is NOT automatic.", path=str(output), tag=rel["tag"])


def publish_preview():
    login = require_owner()
    repo = read_repo()
    if not repo or repo.lower() != f"{login}/{REPO_NAME}".lower():
        fail(f"Publishing is locked. Connect your own {REPO_NAME} repository first.")
    if not (APP / "Contents" / "MacOS" / "GenDragoon Cloud SSD").is_file():
        fail("Installed GenDragoon app is missing. Run the installer first.")
    version = app_version()
    tag = "v" + version
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag):
        fail("Invalid app version.")
    gh = find_gh()
    # Confirm the repository is owned by the authenticated identity.
    actual = cmd([gh, "repo", "view", repo, "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).stdout.strip()
    if actual.lower() != repo.lower():
        fail("GitHub repository ownership did not match.")
    existing = cmd([gh, "release", "view", tag, "-R", repo], check=False)
    if existing.returncode == 0:
        fail(f"{tag} already exists. Bump the app version before publishing another release.")
    # The app is intentionally published as a PREVIEW pending Developer ID
    # signing + Apple notarization. Never silently execute downloaded updates.
    with tempfile.TemporaryDirectory(prefix="gd-publish-") as td:
        directory = Path(td)
        zipname = f"{ZIP_BASENAME}-{tag}.zip"
        archive = directory / zipname
        publish_app = directory / APP.name
        shutil.copytree(APP, publish_app, symlinks=True)
        (publish_app / "Contents" / "Resources" / "release-repo.json").write_text(
            json.dumps({"repo": repo}, indent=2) + "\n", encoding="utf-8")
        # This is intentionally a preview build. Developer ID signing and
        # notarization must replace this local ad-hoc signing before auto-install.
        cmd(["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(publish_app)], timeout=180)
        cmd(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(publish_app)], timeout=60)
        cmd(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(publish_app), str(archive)], timeout=600)
        sha256 = hashlib.sha256()
        with archive.open("rb") as inp:
            for chunk in iter(lambda: inp.read(1024 * 1024), b""):
                sha256.update(chunk)
        sha = sha256.hexdigest()
        manifest = directory / "sha256.txt"
        manifest.write_text(f"{sha}  {zipname}\n", encoding="utf-8")
        notes = "Developer preview: manual installation only. Apple Developer ID signing and notarization required for trusted automatic updates."
        cmd([gh, "release", "create", tag, str(archive), str(manifest), "-R", repo,
             "--title", f"GenDragoon Cloud SSD {version} (preview)", "--notes", notes,
             "--prerelease"], timeout=600)
    reply(message=f"Published preview {tag} to {repo}. This is not a notarized automatic-install update.", repo=repo)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("action", choices=["status", "create-repo", "check", "download", "publish-preview"])
    args = ap.parse_args()
    try:
        if args.action == "status":
            reply(**identity(), repo=read_repo())
        elif args.action == "create-repo":
            make_repo()
        elif args.action == "check":
            result = latest_release()
            reply(message=f"Latest published release: {result['tag']}; installed: {result['current']}",
                  repo=result["repo"], tag=result["tag"], current=result["current"], page=result["page"])
        elif args.action == "download":
            download_release()
        elif args.action == "publish-preview":
            publish_preview()
    except (OSError, RuntimeError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
