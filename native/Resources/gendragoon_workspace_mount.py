#!/usr/bin/env python3
"""Owned read-only Finder drives: authenticated loopback DAV -> bundled NFS.

Directory metadata is verified lazily. File reads fetch authenticated ranges from
Kamatera into bounded RAM, without restoring archives to disk. No account token is stored
in a registry, rclone argument, environment variable or file.
"""
import os,sys
sys.dont_write_bytecode=True
os.environ["PYTHONDONTWRITEBYTECODE"]="1"
import argparse
import contextlib
import fcntl
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import io
import json
from pathlib import Path,PurePosixPath
import posixpath
import re
import secrets
import socket
import stat
import subprocess
import threading
import time
from urllib.parse import quote,unquote,urlsplit
from xml.etree import ElementTree as ET
import zlib
import gendragoon_library as lib
import gendragoon_storage_mode as storage
from gendragoon_remote_archive import open_member, verified_plain, VerifiedBlockCache, RemoteReadBusy
import gendragoon_auth_broker as broker
import gendragoon_app_launch as lifecycle
import gendragoon_performance as performance

ROOT=lib.SUPPORT/"WorkspaceMounts"
CONTROL_ROOT=Path("/private/tmp" if sys.platform=="darwin" else "/tmp")/("gd-workspace-mounts-"+str(os.getuid()))
HEX32=re.compile(r"[a-f0-9]{32}\Z")
HEX64=re.compile(r"[a-f0-9]{64}\Z")


def private_directory(path):
    lib.safe_path(path,directory=True)
    path.mkdir(parents=True,exist_ok=True,mode=0o700)
    info=path.stat()
    if info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError("Unsafe private workspace mount directory")
    return path


def context_root(receiver,workspace):
    if not HEX64.fullmatch(receiver or "") or not HEX32.fullmatch(workspace or ""):raise ValueError("Invalid MachineNote identity")
    for path in (ROOT,ROOT/receiver,ROOT/receiver/workspace):private_directory(path)
    return ROOT/receiver/workspace


def control_endpoint(receiver,workspace):
    if not HEX64.fullmatch(receiver or "") or not HEX32.fullmatch(workspace or ""):raise ValueError("Invalid MachineNote identity")
    private_directory(CONTROL_ROOT)
    # Darwin sun_path is only104bytes; full owner/note paths cannot be socket names.
    return CONTROL_ROOT/(hashlib.sha256((receiver+"\0"+workspace).encode()).hexdigest()[:32]+".sock")


def write_registry(root,value):
    target=root/"registry.json";temporary=root/(".registry-"+secrets.token_hex(8))
    lib.safe_path(target)
    try:
        fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,"w") as out:json.dump(value,out);out.flush();os.fsync(out.fileno())
        os.replace(temporary,target)
    finally:temporary.unlink(missing_ok=True)


def read_registry(root):
    fd=os.open(root/"registry.json",os.O_RDONLY|os.O_NOFOLLOW)
    with os.fdopen(fd,"rb") as source:
        info=os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077:raise ValueError("Unsafe mount registry")
        raw=source.read(16*1024+1)
    if len(raw)>16*1024:raise ValueError("Mount registry exceeds its limit")
    value=json.loads(raw)
    if (value.get("schema")!=1 or value.get("receiverId")!=root.parent.name or value.get("workspaceId")!=root.name
            or value.get("mountPath")!=str(root/"mount") or type(value.get("daemonPid")) is not int):raise ValueError("Invalid mount registry")
    return value


def metadata(client,item):
    with storage.codec_for_item(client,item) as codec:
        root,_=storage._root_for_item(client,codec,item)
        meta=root["metadata"];expected=meta.get("jsonBytes")
        if (meta.get("schema")!=storage.METADATA_SCHEMA or meta.get("encoding")!="zlib-json"
                or type(expected) is not int or not 0<expected<=256*1024*1024):raise ValueError("Invalid encrypted directory metadata")
        parts=storage._load_pages(client,codec,meta["partPages"]) if "partPages" in meta else meta.get("parts")
        if not isinstance(parts,list):raise ValueError("Invalid encrypted directory metadata")
        compressed=b"".join(verified_plain(client,codec,part) for part in parts)
        decoder=zlib.decompressobj();raw=decoder.decompress(compressed,expected+1)
        if (len(raw)!=expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail
                or hashlib.sha256(raw).hexdigest()!=meta.get("jsonSha256")):raise ValueError("Directory metadata failed verification")
        result=json.loads(raw)
        if not isinstance(result,list) or len(result)>1_000_000:raise ValueError("Directory metadata exceeds its limit")
        return result


class WorkspaceTree:
    def __init__(self,config,client=None,authorize=None,reader=None,manifest_loader=None):
        self.config=config;self.client=client or storage.RedXReceiver(config)
        self.authorize=authorize or broker.client_for(config).authorize
        self.reader=reader or open_member;self.manifest_loader=manifest_loader or metadata
        self.lock=threading.RLock();self.active_reads=0;self.manifests={};self.manifest_locks={}
        self.client.mount_block_cache=VerifiedBlockCache()
        self.client.verified_workers()
        snapshot=self.client.library_snapshot();self.revision=snapshot["revision"]
        self.items={item["key"]:item for item in snapshot["items"]}
        for item in self.items.values():
            if item.get("workspace")!=config["workspaceId"]:raise ValueError("MachineNote metadata changed")
            seen={item["key"]};parent=item.get("parentKey")
            while parent:
                if parent in seen or parent not in self.items or self.items[parent].get("virtualFolder") is not True:raise ValueError("Invalid MachineNote folder tree")
                seen.add(parent);parent=self.items[parent].get("parentKey")

    @staticmethod
    def label(item):
        value=item.get("displayName") or item["name"];lib.check_name(value);return value

    def manifest(self,item):
        # A cold app archive must not block status/unmount or every other file.
        key=item["key"]
        with self.lock:
            gate=self.manifest_locks.setdefault(key,threading.Lock())
        with gate:
            if key not in self.manifests:
                entries={}
                for entry in self.manifest_loader(self.client,item):
                    path=entry.get("path")
                    if (not isinstance(path,str) or path in entries or entry.get("type") not in ("directory","file","symlink")
                            or path!="." and (path.startswith("/") or any(p in ("",".","..") for p in path.split("/")))):raise ValueError("Unsafe backup directory metadata")
                    for part in path.split("/"):
                        if part!=".":lib.check_name(part)
                    if entry["type"]=="file" and (type(entry.get("size")) is not int or entry["size"]<0):raise ValueError("Invalid backup file metadata")
                    entries[path]=entry
                if "." not in entries:raise ValueError("Backup root metadata is missing")
                self.manifests[key]=entries
            return self.manifests[key]

    def archive_node(self,item,parts):
        # Library metadata identifies an app/folder root without decrypting all
        # archives just to answer Finder's top-level directory listing.
        if not parts and item.get("kind") in ("app","folder"):
            return dict(type="directory",item=item,relative=".")
        entries=self.manifest(item);parts=list(parts)
        for unused in range(32):
            for index in range(len(parts)+1):
                prefix="/".join(parts[:index]) or ".";entry=entries.get(prefix)
                if entry and entry["type"]=="symlink":
                    target=entry.get("target")
                    if not isinstance(target,str) or target.startswith("/"):raise ValueError("Unsafe backup link")
                    resolved=posixpath.normpath(posixpath.join(posixpath.dirname(prefix),target,*parts[index:]))
                    if resolved==".." or resolved.startswith("../"):raise ValueError("Unsafe backup link")
                    parts=[] if resolved=="." else resolved.split("/");break
            else:
                relative="/".join(parts) or "."
                if relative not in entries:raise FileNotFoundError()
                return dict(entries[relative],item=item,relative=relative)
        raise ValueError("Backup link loop")

    def resolve(self,parts):
        parent=None
        for index,part in enumerate(parts):
            matches=[i for i in self.items.values() if i.get("parentKey")==parent and self.label(i)==part]
            if len(matches)!=1:raise FileNotFoundError()
            item=matches[0]
            if item.get("virtualFolder") is True:
                parent=item["key"]
                if index==len(parts)-1:return dict(type="directory",parent=parent)
            else:return self.archive_node(item,parts[index+1:])
        return dict(type="directory",parent=parent)

    def children(self,parts):
        node=self.resolve(parts)
        if node["type"]!="directory":return []
        if "item" not in node:
            return [(self.label(i),self.resolve((*parts,self.label(i)))) for i in self.items.values() if i.get("parentKey")==node["parent"]]
        prefix="" if node["relative"]=="." else node["relative"]+"/"
        names=[p[len(prefix):] for p in self.manifest(node["item"]) if p!="." and p.startswith(prefix) and "/" not in p[len(prefix):]]
        return [(name,self.resolve((*parts,name))) for name in names]

    @contextlib.contextmanager
    def open_file(self,node):
        if node["type"]!="file":raise IsADirectoryError()
        with self.lock:
            self.active_reads+=1
        try:
            item=node["item"]
            current=next((i for i in self.client.library_snapshot()["items"] if i["key"]==item["key"]),None)
            if not current or any(current.get(k)!=item.get(k) for k in ("manifestId","archiveBytes","archiveSha256")):raise FileNotFoundError()
            # Each object and data range is authenticated by the Receiver codec.
            # No stage_item/full extraction or persistent payload cache is used.
            with self.reader(self.client,item,node["relative"],node) as source:
                yield source
        finally:
            with self.lock:self.active_reads-=1


class DAVServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,tree,token):
        self.tree,self.token=tree,token
        super().__init__(("127.0.0.1",0),DAVHandler)


class DAVHandler(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.1"
    def log_message(self,*args):pass
    def end_headers(self):
        super().end_headers();self.response_started=True
    def failure(self,status,retry=False):
        # Never append a second HTTP response to a partially delivered file.
        # Closing a truncated response lets rclone retry the authenticated range.
        self.close_connection=True
        if getattr(self,"response_started",False):return
        self.result(status,headers={"Connection":"close",**({"Retry-After":"1"} if retry else {})})
    def result(self,status,data=b"",kind="text/plain",headers=None):
        self.send_response(status);self.send_header("Content-Type",kind)
        if "Content-Length" not in (headers or {}):self.send_header("Content-Length",str(len(data)))
        self.send_header("Cache-Control","no-store")
        for key,value in (headers or {}).items():self.send_header(key,value)
        self.end_headers()
        if self.command!="HEAD" and data:self.wfile.write(data)
    def path_parts(self):
        path=urlsplit(self.path)
        if path.query or path.fragment:raise ValueError("Invalid DAV path")
        decoded=unquote(path.path,errors="strict")
        if not decoded.startswith("/") or "\\" in decoded or "\0" in decoded:raise ValueError("Invalid DAV path")
        parts=tuple(decoded.strip("/").split("/")) if decoded.strip("/") else ()
        for part in parts:lib.check_name(part)
        return parts
    def handle_request(self):
        self.response_started=False
        self.connection.settimeout(30)
        if not hmac.compare_digest(self.headers.get("Authorization", ""),"Bearer "+self.server.token):return self.failure(401)
        try:
            self.server.tree.authorize() # Includes cached data and metadata; native EOF/logout fails closed.
            parts=self.path_parts();tree=self.server.tree
            if self.command not in ("GET","HEAD","PROPFIND","OPTIONS"):
                self.close_connection=True
                return self.result(405,headers={"Connection":"close","Allow":"OPTIONS, PROPFIND, GET, HEAD"})
            if self.command=="OPTIONS":return self.result(200,headers={"Allow":"OPTIONS, PROPFIND, GET, HEAD","DAV":"1"})
            if self.command=="PROPFIND":
                if self.headers.get("Depth","1") not in ("0","1"):return self.result(403)
                length=int(self.headers.get("Content-Length","0"))
                if not 0<=length<=64*1024:return self.result(413)
                if length:self.rfile.read(length)
                node=tree.resolve(parts);values=[(parts,node)]
                if self.headers.get("Depth","1")=="1":values += [(parts+(name,),child) for name,child in tree.children(parts)]
                doc=ET.Element("{DAV:}multistatus")
                for path,node in values:
                    response=ET.SubElement(doc,"{DAV:}response");ET.SubElement(response,"{DAV:}href").text="/"+"/".join(quote(p,safe="") for p in path)+("/" if node["type"]=="directory" and path else "")
                    propstat=ET.SubElement(response,"{DAV:}propstat");prop=ET.SubElement(propstat,"{DAV:}prop")
                    resource=ET.SubElement(prop,"{DAV:}resourcetype")
                    if node["type"]=="directory":ET.SubElement(resource,"{DAV:}collection")
                    ET.SubElement(prop,"{DAV:}getcontentlength").text=str(node.get("size",0))
                    ET.SubElement(prop,"{DAV:}getetag").text='"'+str(node.get("sha256",tree.revision))+'"'
                    ET.SubElement(propstat,"{DAV:}status").text="HTTP/1.1 200 OK"
                return self.result(207,ET.tostring(doc,encoding="utf-8",xml_declaration=True),"application/xml")
            if self.command not in ("GET","HEAD"):return self.result(405,headers={"Allow":"OPTIONS, PROPFIND, GET, HEAD"})
            node=tree.resolve(parts)
            if node["type"]!="file":return self.result(405)
            size=node["size"];start,end=0,max(0,size-1);status=200
            requested=self.headers.get("Range")
            if requested:
                match=re.fullmatch(r"bytes=([0-9]+)-([0-9]*)",requested)
                if not match:return self.result(416,headers={"Content-Range":"bytes */"+str(size)})
                start=int(match[1]);end=min(end,int(match[2])) if match[2] else end
                if start>end or start>=size:return self.result(416,headers={"Content-Range":"bytes */"+str(size)})
                status=206
            if self.command=="HEAD":return self.result(200,b"",headers={"Content-Length":str(size),"Accept-Ranges":"bytes"})
            with tree.open_file(node) as source:
                remaining=end-start+1 if size else 0
                source.seek(start)
                # Fetch/authenticate the first block before committing success.
                # A temporarily disconnected upstream returns retryable 503.
                block=source.read(min(256*1024,remaining)) if remaining else b""
                if remaining and not block:raise OSError("Remote file returned no bytes")
                self.send_response(status);self.send_header("Content-Length",str(remaining));self.send_header("Accept-Ranges","bytes")
                self.send_header("Cache-Control","no-store")
                if status==206:self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
                self.end_headers()
                while remaining:
                    if not block:raise OSError("Remote file was interrupted")
                    self.wfile.write(block);remaining-=len(block)
                    if remaining:block=source.read(min(256*1024,remaining))
        except (BrokenPipeError,ConnectionResetError):self.close_connection=True
        except broker.BrokerError:
            self.server.tree.client.mount_block_cache.clear()
            self.failure(403)
        except FileNotFoundError:self.failure(404)
        except RemoteReadBusy:self.failure(503,retry=True)
        except storage.RedXStorageError as error:
            code=getattr(error,"status",0)
            self.failure(403 if code in (401,403) else 404 if code==404 else 507 if code==507 else 503,retry=code not in (401,403,404,507))
        except (ValueError,KeyError):self.failure(400)
        except (RuntimeError,OSError):self.failure(503,retry=True)
    do_GET=do_HEAD=do_PROPFIND=do_OPTIONS=do_PUT=do_POST=do_DELETE=do_MOVE=do_COPY=do_MKCOL=do_PROPPATCH=do_LOCK=do_UNLOCK=handle_request


def owned_daemon(record):
    identity=record.get("daemonIdentity")
    return isinstance(identity,dict) and lifecycle.process_identity(record["daemonPid"])==identity


def stop_owned_mount(record,tree,mount):
    with tree.lock:
        if tree.active_reads or lifecycle.cache_users(mount):raise RuntimeError("Drive in use")
        if os.path.ismount(mount):
            if (not record.get("mountIdentity") or lifecycle.process_identity(record.get("mountPid",0))!=record["mountIdentity"]):raise RuntimeError("Mount owner needs review")
            unmount=subprocess.run(["/sbin/umount",str(mount)],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
            if unmount.returncode or os.path.ismount(mount):raise RuntimeError("Drive in use")


def status():
    records=[];unknown=False
    if ROOT.exists():
        lib.safe_path(ROOT,directory=True)
        for owner in ROOT.iterdir():
            if not owner.is_dir() or owner.is_symlink() or not HEX64.fullmatch(owner.name):unknown=True;continue
            for root in owner.iterdir():
                if not root.is_dir() or root.is_symlink() or not HEX32.fullmatch(root.name):unknown=True;continue
                try:
                    value=read_registry(root);mounted=os.path.ismount(root/"mount");alive=owned_daemon(value)
                    native_alive=lifecycle.process_identity(value.get("nativePid",0))==value.get("nativeIdentity") if value.get("nativeIdentity") else False
                    value={key:value[key] for key in ("receiverId","workspaceId","mountPath","name","revision") if key in value}
                    value.update(state="mounted" if mounted and alive and native_alive else "orphaned" if mounted else "preparing" if alive else "unmounted",readOnly=True)
                    records.append(value)
                except (ValueError,OSError,KeyError):unknown=True
    return {"ok":True,"mounts":records,"unknownMounts":unknown}


def request_unmount(receiver,workspace):
    root=context_root(receiver,workspace);record=read_registry(root)
    if not os.path.ismount(root/"mount") and not owned_daemon(record):return {"ok":True,"unmounted":True}
    if not owned_daemon(record):raise RuntimeError("An orphaned mount needs review; no process was stopped")
    endpoint=control_endpoint(receiver,workspace);lib.safe_path(endpoint.parent,directory=True)
    info=endpoint.lstat()
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError("Unsafe mount control channel")
    with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
        client.settimeout(40);client.connect(str(endpoint))
        client.sendall(json.dumps({"operation":"unmount","receiverId":receiver,"workspaceId":workspace}).encode()+b"\n")
        raw=client.makefile("rb").readline(4097)
    result=json.loads(raw)
    if result.get("ok") is not True:raise RuntimeError("Close applications and files using this drive before unmounting; the drive was retained")
    return result


def serve(receiver,workspace,name):
    if sys.platform!="darwin":raise RuntimeError("Finder workspace drives require macOS")
    config=performance.private_payload()
    if not config or config.get("receiverId")!=receiver or config.get("workspaceId")!=workspace or not broker.client_for(config):raise ValueError("Private MachineNote authorization is required")
    if not isinstance(name,str) or not name or len(name)>255 or any(ord(c)<32 for c in name):raise ValueError("Invalid MachineNote label")
    root=context_root(receiver,workspace);mount=private_directory(root/"mount")
    if os.path.ismount(mount):raise RuntimeError("This MachineNote already has a drive")
    if any(mount.iterdir()):raise RuntimeError("The generated mount directory contains unexpected files; retained for review")
    lock=os.open(root/"daemon.lock",os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:os.close(lock);raise RuntimeError("This MachineNote is already preparing a drive") from None
    record={"schema":1,"receiverId":receiver,"workspaceId":workspace,"name":name,"mountPath":str(mount),"revision":0,
            "payloadMode":"remote-memory-v1","daemonPid":os.getpid(),"daemonIdentity":lifecycle.process_identity(os.getpid()),"nativePid":os.getppid(),
            "nativeIdentity":lifecycle.process_identity(os.getppid()),"createdAt":int(time.time())}
    if not record["daemonIdentity"]:raise RuntimeError("Mount process identity is unavailable")
    write_registry(root,record)
    startup=contextlib.ExitStack()
    try:
        startup.enter_context(lib.maintenance_lock(None))
        return serve_ready(config,receiver,workspace,root,mount,record,startup)
    finally:startup.close();os.close(lock)


def serve_ready(config,receiver,workspace,root,mount,record,startup):
    tree=WorkspaceTree(config)
    token=secrets.token_urlsafe(32);http=DAVServer(tree,token)
    thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
    endpoint=control_endpoint(receiver,workspace)
    if endpoint.exists():
        info=endpoint.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid!=os.getuid():raise ValueError("Unsafe previous mount control channel")
        endpoint.unlink()
    control=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);control.bind(str(endpoint));endpoint.chmod(0o600);control.listen(4);control.settimeout(.5)
    environment=os.environ.copy()
    environment.update(RCLONE_WEBDAV_URL="http://127.0.0.1:"+str(http.server_port)+"/",RCLONE_WEBDAV_VENDOR="other",RCLONE_WEBDAV_BEARER_TOKEN=token)
    cache=private_directory(root/"vfs")
    record["revision"]=tree.revision
    write_registry(root,record)
    process=None;completed=False
    try:
        process=subprocess.Popen([str(lib.RCLONE),"--config","/dev/null","nfsmount",":webdav:",str(mount),
            "--read-only","--vfs-cache-mode=off","--cache-dir="+str(cache),"--addr=127.0.0.1:0","--nfs-cache-type=memory",
            "--dir-cache-time=0s","--attr-timeout=0s","--buffer-size=1M","--vfs-read-chunk-size=1M","--vfs-read-chunk-size-limit=4M",
            "--dir-perms=0700","--file-perms=0500"],
            env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=sys.stderr,start_new_session=True)
        record.update(mountPid=process.pid,mountIdentity=lifecycle.process_identity(process.pid));write_registry(root,record)
        for unused in range(300):
            if os.path.ismount(mount):break
            if process.poll() is not None:raise RuntimeError("The read-only Finder drive could not be mounted")
            time.sleep(.1)
        if not os.path.ismount(mount):raise RuntimeError("Finder drive preparation timed out; inspect retained mount status")
        startup.close() # The real mounted path now blocks every update worker.
        print(json.dumps(dict(ok=True,**{key:record[key] for key in ("receiverId","workspaceId","name","mountPath","revision")},readOnly=True)),flush=True)
        while True:
            if process.poll() is not None and not os.path.ismount(mount):completed=True;break
            try:connection,_=control.accept()
            except socket.timeout:continue
            with connection:
                connection.settimeout(5)
                if hasattr(connection,"getpeereid") and connection.getpeereid()[0]!=os.getuid():continue
                try:
                    request=json.loads(connection.makefile("rb").readline(4097))
                    if request!={"operation":"unmount","receiverId":receiver,"workspaceId":workspace}:raise ValueError("Invalid mount control request")
                    stop_owned_mount(record,tree,mount)
                    connection.sendall(b'{"ok":true,"unmounted":true}\n');completed=True;break
                except (ValueError,OSError,RuntimeError,subprocess.TimeoutExpired):connection.sendall(b'{"ok":false,"error":"mount_in_use"}\n')
    finally:
        # Never force-unmount, signal apps, or remove an uncertain mounted root.
        if not os.path.ismount(mount):
            if process and process.poll() is None and record.get("mountIdentity")==lifecycle.process_identity(process.pid):
                process.terminate()
                try:process.wait(timeout=5)
                except subprocess.TimeoutExpired:pass
            http.shutdown();http.server_close();control.close();endpoint.unlink(missing_ok=True)
    if not completed:raise RuntimeError("The mount stopped before completion; private cache was retained")


def main():
    parser=argparse.ArgumentParser();parser.add_argument("action",choices=("serve","status","unmount"))
    parser.add_argument("--receiver");parser.add_argument("--workspace");parser.add_argument("--name",default="MachineNote")
    parser.add_argument("--performance-stdin",action="store_true");args=parser.parse_args()
    if args.performance_stdin:performance.configure_from_stdin()
    if args.action=="serve":serve(args.receiver,args.workspace,args.name)
    else:print(json.dumps(status() if args.action=="status" else request_unmount(args.receiver,args.workspace)),flush=True)


if __name__=="__main__":
    try:main()
    except Exception:print(json.dumps({"ok":False,"message":"The workspace drive could not complete this request. Its data and any active mount were retained."}),flush=True);sys.exit(1)
