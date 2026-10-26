#!/usr/bin/env python3
"""Install only explicitly selected GenDragoon native-messaging caller IDs."""
from __future__ import annotations
import os
import sys
sys.dont_write_bytecode = True
import argparse
import json
import re
import shutil
import stat
import uuid
from pathlib import Path

HOST = "com.redxai.gendragoon"
RESOURCES=Path(__file__).resolve().parents[1]/"Resources"
if str(RESOURCES) not in sys.path:sys.path.insert(0,str(RESOURCES))
FIREFOX_ID = "gendragoon@redxai.local"
BROWSER_ID = re.compile(r"[a-p]{32}\Z")


def base_directory(platform, home):
    if platform == "darwin":
        return home / "Library/Application Support/GenDragoon"
    if platform.startswith("linux"):
        state = Path(os.environ.get("XDG_STATE_HOME", str(home / ".local/state")))
        if not state.is_absolute():
            raise ValueError("XDG_STATE_HOME must be absolute")
        return state / "gendragoon"
    if platform=="win32":
        local=Path(os.environ.get("LOCALAPPDATA",str(home/"AppData/Local")))
        if not local.is_absolute():raise ValueError("LOCALAPPDATA must be absolute")
        return local/"GenDragoon"
    raise ValueError("This platform does not support the native companion")


def manifest_directories(platform, home):
    if platform == "darwin":
        base = home / "Library/Application Support"
        # Opera's documented macOS location is Chrome's host directory. Merge
        # the two explicit caller IDs rather than overwriting one manifest.
        return {"chrome": base / "Google/Chrome/NativeMessagingHosts", "edge": base / "Microsoft Edge/NativeMessagingHosts", "opera": base / "Google/Chrome/NativeMessagingHosts", "firefox": base / "Mozilla/NativeMessagingHosts"}
    return {"chrome": home / ".config/google-chrome/NativeMessagingHosts", "edge": home / ".config/microsoft-edge/NativeMessagingHosts", "opera": home / ".config/opera/NativeMessagingHosts", "firefox": home / ".mozilla/native-messaging-hosts"}


def private_directory(path):
    current = path
    while current != current.parent:
        if current.is_symlink():
            raise ValueError("Native-host directories must not contain symbolic links")
        current = current.parent
    if sys.platform=="win32":
        from gendragoon_platform_ipc import create_private_directory
        create_private_directory(path)
    else:
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid():
            raise ValueError("Native-host directories must belong to the current local user")
    os.chmod(path, 0o700)


def private_write(path, data, executable=False):
    if path.is_symlink():
        raise ValueError("Native-host files must not be symbolic links")
    if sys.platform=="win32":
        from gendragoon_platform_ipc import create_private_file,verify_private
        if path.exists():verify_private(path)
        temporary=path.with_name('.install-'+uuid.uuid4().hex)
        try:
            with os.fdopen(create_private_file(temporary),'wb') as output:
                output.write(data.encode('utf-8') if isinstance(data,str) else data)
                output.flush();os.fsync(output.fileno())
            verify_private(temporary)
            os.replace(temporary,path)
        finally:temporary.unlink(missing_ok=True)
        return
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o700 if executable else 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(data)
    os.chmod(path, 0o700 if executable else 0o600)


def install(*, platform, home, helper, python, browser_ids, firefox=False, vscode=False,host_executable=None):
    if not any(browser_ids.values()) and not firefox and not vscode:
        raise ValueError("Select at least one browser with its exact extension ID, --firefox, or --vscode")
    for name, identifier in browser_ids.items():
        if name not in {"chrome", "edge", "opera"} or identifier and not BROWSER_ID.fullmatch(identifier):
            raise ValueError("Chromium extension IDs must contain exactly 32 letters a-p; wildcards are forbidden")
    if platform.startswith("linux") and browser_ids.get("opera"):
        raise ValueError("Opera documents a system-wide Linux native-host path; user-level Opera installation is not verified. No root/system install is performed.")
    if platform=="win32":
        return install_windows(home=home,browser_ids=browser_ids,firefox=firefox,vscode=vscode,executable=host_executable)
    helper, python = Path(helper), Path(python)
    if not helper.is_absolute() or not python.is_absolute() or not helper.is_file() or not python.is_file() or any(c.isspace() for c in str(python)):
        raise ValueError("Provide existing absolute helper and Python executable paths; the interpreter path cannot contain whitespace")
    helper = helper.resolve()
    base = base_directory(platform, home)
    private_directory(base)
    directory = base / "NativeMessaging"
    private_directory(directory)
    wrapper = directory / "gendragoon-native-host"
    script = "#!" + str(python) + "\nimport os,runpy,sys\nsys.dont_write_bytecode=True\nos.environ['PYTHONDONTWRITEBYTECODE']='1'\nhelper=" + repr(str(helper)) + "\nargs=sys.argv[1:]\nsys.argv=[helper]+(args if args and args[0]=='--vscode-bridge' else ['--native-messaging']+args)\nrunpy.run_path(helper,run_name='__main__')\n"
    private_write(wrapper, script, executable=True)
    origins = ["chrome-extension://" + value + "/" for value in browser_ids.values() if value]
    if firefox:
        origins.append(FIREFOX_ID)
    private_write(directory / "config.json", json.dumps({"schema": 1, "allowedOrigins": sorted(set(origins)), **({"vscodeExtensionId": "redxai.gendragoon"} if vscode else {})}, indent=2) + "\n")
    manifests, grouped = [], {}
    for browser, destination in manifest_directories(platform, home).items():
        identifier = browser_ids.get(browser)
        if not identifier and not (browser == "firefox" and firefox):
            continue
        group = grouped.setdefault(destination, {"firefox": browser == "firefox", "ids": []})
        group["ids"].append(FIREFOX_ID if browser == "firefox" else "chrome-extension://" + identifier + "/")
    for destination, group in grouped.items():
        private_directory(destination)
        manifest = {"name": HOST, "description": "GenDragoon locally approved account companion", "path": str(wrapper), "type": "stdio"}
        manifest["allowed_extensions" if group["firefox"] else "allowed_origins"] = sorted(set(group["ids"]))
        filename = destination / (HOST + ".json")
        private_write(filename, json.dumps(manifest, indent=2) + "\n")
        manifests.append(str(filename))
    return {"host": str(wrapper), "manifests": manifests, "vscode": vscode, "platform": platform}


def install_windows(*,home,browser_ids,firefox,vscode,executable):
    if sys.platform!="win32":raise ValueError("Windows registry installation requires Windows")
    import winreg
    from gendragoon_platform_ipc import secure_file,verify_private
    if executable is None:raise ValueError("Select the verified GenDragoonNativeHost.exe using --host-executable")
    source=Path(executable)
    if not source.is_absolute() or source.is_symlink() or not source.is_file() or source.suffix.lower()!=".exe":
        raise ValueError("The native host must be an existing absolute Windows executable")
    with source.open('rb') as probe:
        if probe.read(2)!=b'MZ':raise ValueError("The native host is not a Windows executable")
    base=base_directory('win32',home);private_directory(base)
    directory=base/'NativeMessaging';private_directory(directory)
    wrapper=directory/'GenDragoonNativeHost.exe'
    if wrapper.exists():
        if wrapper.is_symlink():raise ValueError("The installed native host cannot be a link")
        verify_private(wrapper)
    if source.resolve()!=wrapper.resolve():private_write(wrapper,source.read_bytes(),executable=True)
    secure_file(wrapper)
    origins=["chrome-extension://"+value+"/" for value in browser_ids.values() if value]
    private_write(directory/'config.json',json.dumps({'schema':1,'allowedOrigins':sorted(set(origins+([FIREFOX_ID] if firefox else []))),**({'vscodeExtensionId':'redxai.gendragoon'} if vscode else {})},indent=2)+'\n')
    registry={'chrome':r'Software\Google\Chrome\NativeMessagingHosts','edge':r'Software\Microsoft\Edge\NativeMessagingHosts','opera':r'Software\Google\Chrome\NativeMessagingHosts','firefox':r'Software\Mozilla\NativeMessagingHosts'}
    grouped={}
    for browser in ('chrome','edge','opera','firefox'):
        identifier=browser_ids.get(browser)
        if not identifier and not(browser=='firefox' and firefox):continue
        item=grouped.setdefault(registry[browser],{'firefox':browser=='firefox','ids':[]})
        item['ids'].append(FIREFOX_ID if browser=='firefox' else 'chrome-extension://'+identifier+'/')
    manifests=[]
    for index,(key,group) in enumerate(grouped.items()):
        filename=directory/('host-'+str(index)+'.json')
        value={'name':HOST,'description':'GenDragoon locally approved account companion','path':str(wrapper),'type':'stdio'}
        value['allowed_extensions' if group['firefox'] else 'allowed_origins']=sorted(set(group['ids']))
        private_write(filename,json.dumps(value,indent=2)+'\n')
        with winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER,key+'\\'+HOST,0,winreg.KEY_SET_VALUE) as handle:
            winreg.SetValueEx(handle,'',0,winreg.REG_SZ,str(filename))
        manifests.append(str(filename))
    return {'host':str(wrapper),'manifests':manifests,'vscode':vscode,'platform':'win32','registryScope':'current-user'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chrome-id")
    parser.add_argument("--edge-id")
    parser.add_argument("--opera-id")
    parser.add_argument("--firefox", action="store_true")
    parser.add_argument("--vscode", action="store_true")
    parser.add_argument("--helper", type=Path, default=Path("/Applications/GenDragoon Cloud SSD.app/Contents/Resources/gendragoon_native_bridge.py") if sys.platform == "darwin" else None)
    parser.add_argument("--python", type=Path, default=Path(shutil.which("python3.13") or sys.executable))
    parser.add_argument("--host-executable",type=Path,help="Verified self-contained GenDragoonNativeHost.exe on Windows")
    options = parser.parse_args()
    try:
        if options.helper is None and sys.platform!="win32":
            raise ValueError("Linux requires --helper with the installed GenDragoon companion helper path")
        result = install(platform=sys.platform, home=Path.home(), helper=options.helper, python=options.python, browser_ids={"chrome": options.chrome_id, "edge": options.edge_id, "opera": options.opera_id}, firefox=options.firefox, vscode=options.vscode,host_executable=options.host_executable)
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
