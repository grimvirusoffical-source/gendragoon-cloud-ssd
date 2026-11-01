#!/usr/bin/env python3
"""Build a standalone desktop candidate from a verified staged platform runtime."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from build_native_host import build as build_host

def drop_package_options(runtime):
    """The dependency's official 0.7 hook selects matching OS/CPU/Tcl data.

    Keep its version metadata for the runtime's mandatory dependency check and
    original notices alongside the candidate. Actual native loading is checked
    by the packaged --check-gui probe below; missing TkDND fails the build.
    """
    options=["--hidden-import","tkinterdnd2","--copy-metadata","tkinterdnd2"]
    for name in ("tkdnd-runtime.json","tkinterdnd2-LICENSE.txt","tkdnd-LICENSE.txt"):
        path=Path(runtime)/name
        if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<128*1024:
            raise RuntimeError("The required native file-drop manifest and original notices are missing.")
        options.extend(["--add-data",str(path)+":."])
    return options

def check_native_host(host,runtime):
    """Send a real native message through the packaged host to private IPC."""
    import io
    import struct
    sys.path.insert(0,str(runtime));sys.path.insert(0,str(runtime/"runtime"))
    import private_fs as private
    import gendragoon_native_bridge as bridge
    from companion_server import CompanionServer
    with tempfile.TemporaryDirectory(prefix="gd-host-check-") as temporary:
        directory=Path(temporary).resolve()
        environment=dict(os.environ,XDG_STATE_HOME=str(directory/"state"),LOCALAPPDATA=str(directory/"local"))
        base=Path(environment["LOCALAPPDATA"])/"GenDragoon" if sys.platform=="win32" else Path(environment["XDG_STATE_HOME"])/"gendragoon"
        config=private.private_directory(base/"NativeMessaging")
        origin="chrome-extension://"+"a"*32+"/"
        private.write_private(config/"config.json",json.dumps({"schema":1,"allowedOrigins":[origin]}).encode("utf-8"))
        observed=[]
        def dispatch(request,done):
            observed.append(request)
            done({"connected":False,"packagedHost":True})
        server=CompanionServer(dispatch,base=base,socket_directory=directory/"ipc",timeout=5)
        server.start()
        try:
            request={"id":"f"*32,"method":"status","params":{}}
            encoded=json.dumps(request).encode("utf-8");packet=struct.pack("<I",len(encoded))+encoded
            result=subprocess.run([str(host),origin],input=packet,capture_output=True,timeout=30,env=environment)
            response=bridge.read_frame(io.BytesIO(result.stdout))
            if (result.returncode or response!={"id":request["id"],"ok":True,"result":{"connected":False,"packagedHost":True}}
                    or len(observed)!=1 or observed[0].get("_clientId")!=origin):
                raise RuntimeError("The packaged native host could not complete private same-user IPC.")
            denied=subprocess.run([str(host),"chrome-extension://"+"b"*32+"/"],input=packet,capture_output=True,timeout=30,env=environment)
            response=bridge.read_frame(io.BytesIO(denied.stdout))
            if denied.returncode!=1 or response.get("ok") is not False or response.get("error",{}).get("code")!="caller_denied" or len(observed)!=1:
                raise RuntimeError("The packaged native host did not reject an unlisted extension.")
        finally:server.close()

def check_packaged_portable_broker(binary,runtime):
    """Actual target binary, generated native app, detached child, retained cache.

    Only disposable test programs are compiled or launched. Missing compiler,
    packaged broker support, descendant accounting or exit receipts fails the
    candidate build; none of these target checks can turn into a skip.
    """
    from unittest.mock import patch
    sys.path.insert(0,str(runtime));sys.path.insert(0,str(runtime/"runtime"))
    sys.path.insert(0,str(Path(__file__).resolve().parent/"tests"))
    import portable_apps as apps
    from test_machinenotes import compile_portable_fixture,prepare_native_fixture,wait_fixture,launch_native_fixture
    with tempfile.TemporaryDirectory(prefix="gd-packaged-app-check-") as temporary:
        directory=Path(temporary).resolve();native=compile_portable_fixture(directory)
        original_hash=hashlib.sha256(native.read_bytes()).hexdigest()
        manager=apps.PortableApps(directory/"cache");prepared=prepare_native_fixture(manager,native)
        try:
            with patch.object(apps,"_broker_command",lambda spec:[str(binary),"--portable-broker",str(spec)]):
                launch_native_fixture(lambda:manager.launch(prepared,native.name,approved=True))
            wait_fixture(lambda:(prepared.payload/"child-heartbeat").exists())
            if sys.platform=="win32":
                if (prepared.payload/"child-dll-directory").read_text()!="0":raise RuntimeError("The external app inherited the packaged Windows DLL directory.")
            elif (prepared.payload/"child-ld-library-path").read_text()!="":
                raise RuntimeError("The external app inherited the packaged Linux library path.")
            wait_fixture(lambda:manager.leases()[0].get("mainExitCode")==7)
            if manager.leases()[0]["state"]!="running":raise RuntimeError("The packaged broker lost its detached child after the main app exited.")
            try:manager.assert_safe("change accounts")
            except apps.PortableAppError:pass
            else:raise RuntimeError("The packaged app lease did not protect account changes.")
            before=(prepared.payload/"child-heartbeat").read_text();time.sleep(.2)
            if (prepared.payload/"child-heartbeat").read_text()==before:raise RuntimeError("The native app child did not outlive packaged launch preparation.")
        finally:(prepared.payload/"release-child").write_text("release only this generated packaged-app fixture")
        wait_fixture(lambda:manager.leases()[0]["state"]=="complete")
        receipt=manager.leases()[0]
        if (receipt.get("mainExitCode")!=7 or not (prepared.payload/"child-finished").exists()
                or hashlib.sha256((prepared.payload/native.name).read_bytes()).hexdigest()!=original_hash
                or hashlib.sha256(native.read_bytes()).hexdigest()!=original_hash):
            raise RuntimeError("The packaged portable app outcome or retained original/cache failed verification.")
    return {"packagedBroker":True,"mainExitCode":7,"childTreeTracked":True,"cacheRetained":True,"originalRetained":True,"externalLibrarySearchClean":True}

def package(runtime,output):
    runtime=Path(runtime).resolve();output=Path(output).resolve()
    if sys.platform!="win32" and not sys.platform.startswith("linux"):raise RuntimeError("Package desktop candidates on their Windows/Linux target.")
    if not (runtime/"runtime.json").is_file():raise RuntimeError("Stage and verify the pinned platform runtime first.")
    check_compiled_codec(runtime/"runtime")
    output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gd-gui-build-") as td:
        args=[sys.executable,"-B","-m","PyInstaller","--onedir","--noconfirm","--clean","--name","GenDragoon",
            "--distpath",str(output),"--workpath",str(Path(td)/"work"),"--specpath",td,
            "--paths",str(runtime),"--paths",str(runtime/"runtime"),
            "--add-data",str(runtime/"runtime")+":runtime",
            "--add-data",str(runtime/"install_native_host.py")+":.",
            "--hidden-import","tkinter","--hidden-import","tkinter.ttk",
            "--exclude-module","redxai","--exclude-module","redsecretsxai"]
        args.extend(drop_package_options(runtime))
        if sys.platform=="win32":args.extend(["--windowed","--manifest",str(Path(__file__).resolve().parent/"windows-utf8.manifest"),"--hidden-import","win32timezone"])
        for module in ("numpy","PIL","cryptography"):args.extend(["--collect-all",module])
        args.append(str(runtime/"gendragoon_gui.py"))
        result=subprocess.run(args,capture_output=True,text=True,timeout=900)
        if result.returncode:raise RuntimeError("Desktop GUI packaging failed:\n"+result.stderr[-5000:])
    folder=output/"GenDragoon";host=build_host(folder)
    binary=folder/("GenDragoon.exe" if sys.platform=="win32" else "GenDragoon")
    checked=subprocess.run([str(binary),"--check"],capture_output=True,timeout=90)
    if checked.returncode:raise RuntimeError("The packaged GUI could not load its native encryption runtime.")
    gui_check=[str(binary),"--check-gui"]
    if sys.platform.startswith("linux") and not os.environ.get("DISPLAY"):
        xvfb=shutil.which("xvfb-run")
        if not xvfb:raise RuntimeError("A display or Xvfb is required to verify the actual packaged desktop window.")
        gui_check=[xvfb,"-a",*gui_check]
    checked=subprocess.run(gui_check,capture_output=True,timeout=60)
    if checked.returncode:raise RuntimeError("The packaged desktop window or private companion could not start.")
    checked=subprocess.run([str(host),"--help"],capture_output=True,timeout=45)
    if checked.returncode:raise RuntimeError("The packaged native host could not start.")
    check_native_host(host,runtime)
    portable_check=check_packaged_portable_broker(binary,runtime)
    manifest={"schema":1,"platform":sys.platform,"protocol":"MachineNotes-v1","candidate":True,"portableAppCheck":portable_check,"files":{}}
    for path in folder.rglob("*"):
        if path.is_file():manifest["files"][path.relative_to(folder).as_posix()]={"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    (folder/"CANDIDATE_MANIFEST.json").write_text(json.dumps(manifest,sort_keys=True,indent=2)+"\n")
    archive=shutil.make_archive(str(output/("GenDragoon-"+sys.platform+"-candidate")),"zip",output,"GenDragoon")
    return {"archive":archive,"sha256":hashlib.sha256(Path(archive).read_bytes()).hexdigest(),"gui":str(binary),"nativeHost":str(host)}

def check_compiled_codec(runtime):
    """Release packages may contain compiled codec wrappers and legal notices."""
    runtime=Path(runtime)
    for name in ("LICENSE","NOTICE"):
        source=runtime/name
        if source.is_symlink() or not source.is_file() or not 0<source.stat().st_size<128*1024:
            raise RuntimeError("The codec's original license and notice are required in every desktop package.")
    for package in ("redxai","redsecretsxai"):
        directory=runtime/package
        if directory.is_symlink() or not directory.is_dir():raise RuntimeError("The compiled codec package is missing.")
        if any(path.is_symlink() or path.suffix==".py" for path in directory.rglob("*")):
            raise RuntimeError("A desktop release cannot include private codec source or linked codec inputs. Stage a compiled runtime first.")

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--runtime",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(argv);print(json.dumps(package(args.runtime,args.output)))

if __name__=="__main__":main()
