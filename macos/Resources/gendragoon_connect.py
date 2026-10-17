#!/usr/bin/env python3
"""GenDragoon's macOS-only Google Cloud and GitHub browser connection bridge.

Uses official CLIs for delegated OAuth. Does not ask for passwords or export keys.
JSON responses contain status only, never tokens or account secrets.
"""
import argparse
import configparser
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.parse
import urllib.request
import urllib.error
import zipfile

if sys.platform == "darwin" and not os.environ.get("SSL_CERT_FILE") and Path("/etc/ssl/cert.pem").is_file():
    os.environ["SSL_CERT_FILE"] = "/etc/ssl/cert.pem"

SUPPORT = Path.home() / "Library" / "Application Support" / "GenDragoon Cloud SSD"
TOOLS = SUPPORT / "Tools"
APP_RCLONE_CONFIG = SUPPORT / "gendragoon-rclone.conf"
def rclone_path(helper=__file__):
    helper=Path(helper).absolute()
    if helper.parent.name=="Resources" and helper.parent.parent.name=="Contents" and helper.parent.parent.parent.suffix.lower()==".app":
        return helper.with_name("rclone")
    return Path.home()/"Applications/GenDragoon Cloud SSD.app/Contents/Resources/rclone"
RCLONE = rclone_path()
GH_API = "https://api.github.com/repos/cli/cli/releases/latest"
GCLOUD_URL = "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-darwin-arm.tar.gz"
# Pinned from official macOS ARM64 installation documentation, as checked 2026-10-13.
# If Google changes the moving download this fails safely rather than executing unknown bytes.
GCLOUD_SHA256 = "71b37ca07ab0f9bc43898e42c913e10f143166230ab31e0bbea3632dbc77b010"
AGENT = "GenDragoon-Cloud-SSD/0.4"


def reply(**data):
    print(json.dumps({"ok": True, **data}, sort_keys=True), flush=True)


def fail(message):
    print(json.dumps({"ok": False, "message": str(message)[:800]}, sort_keys=True), flush=True)
    raise SystemExit(1)


def run(argv, *, timeout=300, env=None, check=True):
    p = subprocess.run(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                       stderr=subprocess.PIPE, text=True, errors="replace", timeout=timeout, env=env)
    if p.returncode and check:
        # Don't surface OAuth URLs, credentials, access tokens, or full logs.
        raise RuntimeError(f"Command failed ({p.returncode}). Check CLI authorization and selected cloud access.")
    return p


def find_executable(name):
    candidates = [str(TOOLS / name)]
    if name == "gcloud":
        candidates += [str(TOOLS / "google-cloud-sdk" / "bin" / "gcloud")]
    candidates += ["/opt/homebrew/bin/" + name, "/usr/local/bin/" + name, shutil.which(name)]
    for c in candidates:
        if c and Path(c).is_file() and os.access(c, os.X_OK):
            v = run([c, "--version"], timeout=18, check=False)
            if v.returncode:
                continue
            if name == "gh" and not v.stdout.startswith("gh version"):
                continue  # Reject the unrelated npm package also named gh.
            return c
    return None


def opera_env():
    if platform.system() != "Darwin":
        raise RuntimeError("This connection flow requires macOS and Opera.")
    available = run(["/usr/bin/open", "-Ra", "Opera"], timeout=8, check=False)
    if available.returncode:
        raise RuntimeError("Opera was not found. Install Opera or move Opera.app to /Applications first.")
    SUPPORT.mkdir(parents=True, exist_ok=True)
    script = SUPPORT / "open-in-opera.sh"
    script.write_text('#!/bin/sh\nexec /usr/bin/open -a Opera "$@"\n', encoding="utf-8")
    script.chmod(0o700)
    env = os.environ.copy()
    env.update({"BROWSER": str(script), "GH_BROWSER": str(script),
                "GH_PROMPT_DISABLED": "1", "CLOUDSDK_CORE_DISABLE_USAGE_REPORTING": "true"})
    return env


def download(url, dest, maximum):
    req = urllib.request.Request(url, headers={"User-Agent": AGENT})
    with urllib.request.urlopen(req, timeout=55) as resp, open(dest, "wb") as fh:
        written = 0
        while True:
            chunk = resp.read(1024 * 512)
            if not chunk:
                break
            written += len(chunk)
            if written > maximum:
                raise RuntimeError("Official tool download exceeds expected maximum size.")
            fh.write(chunk)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as fp:
        for part in iter(lambda: fp.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def check_macos_arm():
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        raise RuntimeError("Automatic setup currently supports Apple Silicon Macs only.")


def ensure_gcloud():
    found = find_executable("gcloud")
    if found:
        return found
    check_macos_arm()
    TOOLS.mkdir(parents=True, exist_ok=True)
    TOOLS.chmod(0o700)
    with tempfile.TemporaryDirectory(prefix="gcloud-", dir=str(SUPPORT)) as tmp:
        archive = Path(tmp) / "google-cloud-cli.tar.gz"
        download(GCLOUD_URL, archive, 160 * 1024 * 1024)
        if sha256(archive) != GCLOUD_SHA256:
            raise RuntimeError("Google updated its Cloud SDK archive. The pinned checksum no longer matches; get a refreshed GenDragoon updater. No file was installed.")
        # Verified vendor archive; installed under private application support, not system directories.
        run(["/usr/bin/tar", "-xzf", str(archive), "-C", str(tmp)], timeout=200)
        source = Path(tmp) / "google-cloud-sdk"
        if not (source / "bin" / "gcloud").is_file():
            raise RuntimeError("Official Google Cloud SDK archive did not contain gcloud.")
        dst = TOOLS / "google-cloud-sdk"
        if dst.exists():
            shutil.rmtree(dst)
        shutil.move(str(source), str(dst))
        try:
            # Install bundled Python into its FINAL path to avoid broken internal paths.
            run([str(dst / "install.sh"), "--quiet", "--command-completion=false",
                 "--path-update=false", "--usage-reporting=false", "--install-python=true"], timeout=420)
        except Exception:
            shutil.rmtree(dst, ignore_errors=True)
            raise
    result = str(TOOLS / "google-cloud-sdk" / "bin" / "gcloud")
    if run([result, "--version"], timeout=40, check=False).returncode:
        raise RuntimeError("gcloud was downloaded but cannot run. Verify your macOS/Python version.")
    return result


def ensure_gh():
    found = find_executable("gh")
    if found:
        return found
    check_macos_arm()
    TOOLS.mkdir(parents=True, exist_ok=True)
    TOOLS.chmod(0o700)
    with urllib.request.urlopen(urllib.request.Request(GH_API, headers={
            "User-Agent": AGENT, "Accept": "application/vnd.github+json"}), timeout=25) as resp:
        data = json.load(resp)
    candidates = [a for a in data.get("assets", [])
                  if re.fullmatch(r"gh_\d+\.\d+\.\d+_macOS_arm64\.zip", a.get("name", ""))]
    if len(candidates) != 1:
        raise RuntimeError("Official GitHub CLI ARM64 release asset not found.")
    asset = candidates[0]
    digest = asset.get("digest") or ""
    url = asset.get("browser_download_url", "")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest) or not url.startswith("https://github.com/cli/cli/releases/download/"):
        raise RuntimeError("GitHub CLI release lacks a verified SHA-256 digest.")
    with tempfile.TemporaryDirectory(prefix="gh-", dir=str(SUPPORT)) as tmp:
        archive = Path(tmp) / "gh.zip"
        download(url, archive, 110 * 1024 * 1024)
        if sha256(archive) != digest.partition(":")[2]:
            raise RuntimeError("GitHub CLI SHA-256 digest mismatch: installation canceled.")
        with zipfile.ZipFile(archive) as z:
            paths = [p for p in z.namelist() if re.fullmatch(r"gh_[^/]+_macOS_arm64/bin/gh", p)]
            if len(paths) != 1:
                raise RuntimeError("The verified GitHub CLI archive is missing its binary.")
            binfile = Path(tmp) / "gh"
            with z.open(paths[0]) as source, binfile.open("wb") as target:
                shutil.copyfileobj(source, target)
        binfile.chmod(0o755)
        os.replace(str(binfile), str(TOOLS / "gh"))
    return str(TOOLS / "gh")


def gcloud_token(gcloud):
    result = run([gcloud, "auth", "application-default", "print-access-token"], timeout=45)
    token = result.stdout.strip()
    if not token or len(token) < 15:
        raise RuntimeError("Google Cloud login was not completed. Click Connect Google Cloud again.")
    return token


def google_json(gcloud, url):
    # Bearer token is never persisted by this tool, displayed, or logged.
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + gcloud_token(gcloud),
                                               "Accept": "application/json", "User-Agent": AGENT})
    try:
        class SameOrigin(urllib.request.HTTPRedirectHandler):
            def redirect_request(self,request,response,code,message,headers,new_url):
                old,new=urllib.parse.urlsplit(request.full_url),urllib.parse.urlsplit(new_url)
                if new.scheme!="https" or (old.hostname,old.port or 443)!=(new.hostname,new.port or 443):
                    raise RuntimeError("Google API refused an unexpected authentication redirect.")
                return super().redirect_request(request,response,code,message,headers,new_url)
        with urllib.request.build_opener(SameOrigin()).open(req, timeout=35) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        if exc.code == 403:
            raise RuntimeError("Google returned HTTP 403. Check project access and whether the required API is enabled.")
        if exc.code == 401:
            raise RuntimeError("Google authentication has expired. Reconnect Google Cloud.")
        raise RuntimeError(f"Google Cloud API returned HTTP {exc.code}.")


def connect_google():
    env = opera_env()
    # Visible immediate browser response even when the official Google CLI still
    # needs its first-time setup. The actual OAuth flow follows in Opera.
    run(["/usr/bin/open", "-a", "Opera", "https://console.cloud.google.com/"], timeout=12)
    gcloud = ensure_gcloud()
    # --quiet / CLOUDSDK_CORE_DISABLE_PROMPTS previously made mandatory OAuth
    # prompts fail without giving the user an opportunity to select their account.
    run([gcloud, "auth", "application-default", "login", "--launch-browser",
         "--disable-quota-project"], timeout=600, env=env)
    gcloud_token(gcloud)
    reply(message="Google Cloud authorized through Opera. Choose a project and bucket below.")


def projects():
    gcloud = find_executable("gcloud")
    if not gcloud:
        raise RuntimeError("Click Connect Google Cloud to install tools and authorize first.")
    data = []
    url = "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=100"
    for _ in range(10):
        obj = google_json(gcloud, url)
        data += [{"id": str(p.get("projectId", "")), "name": str(p.get("name", ""))}
                 for p in obj.get("projects", []) if p.get("projectId") and p.get("lifecycleState") == "ACTIVE"]
        token = obj.get("nextPageToken")
        if not token:
            break
        url = "https://cloudresourcemanager.googleapis.com/v1/projects?pageSize=100&pageToken=" + urllib.parse.quote(token)
    reply(message=f"Found {len(data)} accessible Google Cloud projects.", projects=data)


def valid_project(name):
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", name or ""):
        raise ValueError("Invalid Google Cloud project ID.")
    return name


def valid_bucket(name):
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", name or "") or ".." in name or re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}",name):
        raise ValueError("Invalid Google Cloud bucket name.")
    return name


def buckets(project):
    valid_project(project)
    gcloud = find_executable("gcloud")
    if not gcloud:
        raise RuntimeError("Connect Google Cloud first.")
    data = []
    url = "https://storage.googleapis.com/storage/v1/b?project=" + urllib.parse.quote(project) + "&maxResults=1000"
    for _ in range(10):
        obj = google_json(gcloud, url)
        data += [str(b.get("name")) for b in obj.get("items", []) if b.get("name")]
        token = obj.get("nextPageToken")
        if not token:
            break
        url = "https://storage.googleapis.com/storage/v1/b?project=" + urllib.parse.quote(project) + "&maxResults=1000&pageToken=" + urllib.parse.quote(token)
    reply(message=f"Found {len(data)} buckets in {project}.", buckets=data)


def private_path(path, directory=False):
    path=Path(path).absolute()
    for parent in (path,*path.parents):
        if parent.is_symlink():raise RuntimeError("Unsafe linked cloud configuration path.")
        if (parent==SUPPORT or SUPPORT in parent.parents) and parent.exists() and parent.is_dir():
            info=parent.lstat()
            if info.st_uid!=os.getuid() or info.st_mode&0o022:raise RuntimeError("Unsafe cloud configuration ancestry.")
    if path.exists():
        info=path.lstat()
        if info.st_uid!=os.getuid():raise RuntimeError("Cloud configuration is not owned by this user.")
        if directory:
            if not stat.S_ISDIR(info.st_mode) or info.st_mode&0o022:raise RuntimeError("Unsafe cloud configuration directory.")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o077:
            raise RuntimeError("Unsafe shared cloud configuration file.")
    return path


@contextmanager
def maintenance_lock():
    private_path(SUPPORT,directory=True);SUPPORT.mkdir(parents=True,exist_ok=True,mode=0o700)
    root=SUPPORT/"AutoUpdates"
    private_path(root,directory=True);root.mkdir(mode=0o700,exist_ok=True)
    path=private_path(root/"update.lock")
    descriptor=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    locked=False
    try:
        info=os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid():raise RuntimeError("Unsafe maintenance lock.")
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True
        except BlockingIOError:raise RuntimeError("An upload, update or restart is active. Wait before configuring cloud storage.") from None
        yield
    finally:
        if locked:fcntl.flock(descriptor,fcntl.LOCK_UN)
        os.close(descriptor)


def workspace_module():
    # Explicit adjacent resource; do not import a user's unrelated Python module.
    import importlib.util
    name="gendragoon_upload_workspace"
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+".py"))
    module=importlib.util.module_from_spec(spec)
    sys.modules[name]=module;spec.loader.exec_module(module)
    return module


def atomic_config(path,content):
    private_path(path)
    descriptor,temporary=tempfile.mkstemp(prefix=".cloud-config-",dir=SUPPORT)
    try:
        with os.fdopen(descriptor,"wb") as output:
            output.write(content);output.flush();os.fsync(output.fileno())
        private_path(path);os.replace(temporary,path)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)


def configure(project, bucket, remote="gendragoon", prefix=None, expected_revision=None):
    valid_project(project)
    valid_bucket(bucket)
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}",remote or ""):raise ValueError("Invalid cloud remote.")
    if not RCLONE.is_file() or any(path.is_symlink() for path in (RCLONE,*RCLONE.parents)):
        raise RuntimeError("Bundled rclone is missing from your existing GenDragoon app.")
    gcloud = find_executable("gcloud")
    if not gcloud:
        raise RuntimeError("Connect Google Cloud first.")
    with maintenance_lock():
        workspace=workspace_module()
        before=workspace.read_state()
        revision=before["revision"] if expected_revision is None else expected_revision
        if revision!=before["revision"]:raise RuntimeError("Workspace changed. Refresh the selected project and bucket before retrying.")
        if before.get("active_job_id") or any(job.get("state")=="running" for job in before.get("jobs",[])):
            raise RuntimeError("An upload is active. Wait before configuring cloud storage.")
        chosen_prefix=prefix if prefix is not None else (before.get("destination") or {}).get("prefix","GenDragoon-App-Library")
        if not isinstance(chosen_prefix,str) or chosen_prefix.startswith("/") or "\\" in chosen_prefix or ":" in chosen_prefix or any(ord(c)<32 or ord(c)==127 for c in chosen_prefix) or (chosen_prefix and any(part in (".","..","") for part in chosen_prefix.split("/"))):
            raise ValueError("Invalid cloud folder prefix.")
        # Read permission alone is insufficient: match the bucket's owning
        # project number to the exact project selected by the user.
        owner=google_json(gcloud,"https://cloudresourcemanager.googleapis.com/v1/projects/"+urllib.parse.quote(project,safe=""))
        number=str(owner.get("projectNumber",""))
        if owner.get("projectId")!=project or not number.isdecimal() or owner.get("lifecycleState","ACTIVE")!="ACTIVE":
            raise RuntimeError("Selected Google Cloud project could not be verified.")
        allowed=google_json(gcloud,"https://storage.googleapis.com/storage/v1/b/"+urllib.parse.quote(bucket,safe=""))
        if allowed.get("name")!=bucket or str(allowed.get("projectNumber",""))!=number:
            raise RuntimeError("Selected bucket does not belong to the selected Google Cloud project. Previous configuration was preserved.")
        private_path(APP_RCLONE_CONFIG)
        original=APP_RCLONE_CONFIG.read_bytes() if APP_RCLONE_CONFIG.exists() else None
        with tempfile.TemporaryDirectory(prefix=".gd-rclone-",dir=SUPPORT) as td:
            cfg=Path(td)/"rclone.conf"
            if original is not None:
                parser=configparser.RawConfigParser(interpolation=None);parser.optionxform=str
                try:parser.read_string(original.decode("utf8"))
                except (ValueError,UnicodeError,configparser.Error):raise RuntimeError("Existing cloud configuration cannot be safely edited; it was preserved.") from None
                # Recreate only the chosen alias as GCS. Updating arbitrary old
                # provider options could validate a Google bucket but upload to
                # a same-named S3/local path through a mismatched remote type.
                parser.remove_section(remote)
                with cfg.open("w") as output:parser.write(output)
                cfg.chmod(0o600)
            args=[str(RCLONE),"--config",str(cfg),"config","create",remote,"google cloud storage"]
            args += ["env_auth","true","bucket_policy_only","true","--non-interactive"]
            run(args,timeout=45)
            run([str(RCLONE),"--config",str(cfg),"lsf",remote+":"+bucket,"--max-depth","1"],timeout=90)
            private_path(cfg)
            prepared=cfg.read_bytes()
            # Recheck CAS before the first persistent change, then again inside
            # select_destination under the authoritative workspace state lock.
            if workspace.read_state()["revision"]!=revision:raise RuntimeError("Workspace changed during cloud validation. Previous configuration was preserved.")
            if (APP_RCLONE_CONFIG.read_bytes() if APP_RCLONE_CONFIG.exists() else None)!=original:raise RuntimeError("Cloud configuration changed during validation; retry without overwriting it.")
            atomic_config(APP_RCLONE_CONFIG,prepared)
            try:
                committed=workspace.select_destination(project,bucket,remote,chosen_prefix,revision)
            except BaseException:
                if APP_RCLONE_CONFIG.read_bytes()==prepared:
                    if original is None:APP_RCLONE_CONFIG.unlink()
                    else:atomic_config(APP_RCLONE_CONFIG,original)
                raise
        reply(message=f"Connected and tested gs://{bucket} in {project}.",remote=remote,bucket=bucket,project=project,
              context=committed.get("destination"),workspace=committed)


def connect_github():
    env = opera_env()
    run(["/usr/bin/open", "-a", "Opera", "https://github.com/"], timeout=12)
    gh = ensure_gh()
    # If already signed in, still open Opera to make the account explicit.
    existing = run([gh, "auth", "status", "--hostname", "github.com"], timeout=25, check=False)
    if existing.returncode == 0:
        run(["/usr/bin/open", "-a", "Opera", "https://github.com/settings/profile"], timeout=10)
        reply(message="GitHub was already connected. Checking your verified owner email.")
        return
    # GitHub's official OAuth device flow places the one-time code on clipboard.
    # GH_PROMPT_DISABLED prevents an invisible non-TTY prompt in a GUI app.
    run([gh, "auth", "login", "--hostname", "github.com", "--web", "--clipboard",
         "--git-protocol", "https", "--scopes", "repo,user:email"], timeout=600, env=env)
    # github publisher bridge separately verifies the owner's *verified* email.
    result = run([gh, "auth", "status"], timeout=25, check=False)
    if result.returncode:
        raise RuntimeError("GitHub login did not complete. Use Connect GitHub again.")
    reply(message="GitHub connected through Opera. Owner permissions will now be checked.")


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["google-login", "projects", "buckets", "configure", "github-login", "tools"])
    p.add_argument("--project", default="")
    p.add_argument("--bucket", default="")
    p.add_argument("--remote", default="gendragoon")
    p.add_argument("--prefix")
    p.add_argument("--expected-revision",type=int)
    args = p.parse_args()
    try:
        if args.action == "google-login":
            connect_google()
        elif args.action == "github-login":
            connect_github()
        elif args.action == "projects":
            projects()
        elif args.action == "buckets":
            buckets(args.project)
        elif args.action == "configure":
            configure(args.project,args.bucket,args.remote,args.prefix,args.expected_revision)
        else:
            reply(message="Checking installed tools", gcloud=bool(find_executable("gcloud")),
                  github=bool(find_executable("gh")))
    except (RuntimeError, ValueError, OSError, subprocess.TimeoutExpired, urllib.error.URLError,
            zipfile.BadZipFile, tarfile.TarError, json.JSONDecodeError) as exc:
        fail(str(exc))


if __name__ == "__main__":
    main()
