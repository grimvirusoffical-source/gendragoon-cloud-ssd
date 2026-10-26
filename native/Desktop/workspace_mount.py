"""Real read-only MachineNote drives: verified archives -> private DAV -> rclone.

Account credentials and keys stay in this process. The rclone child receives only
an ephemeral loopback DAV credential. A folder is never reported as a drive until
the platform confirms a real filesystem mount.
"""
import contextlib
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import time
import unicodedata
from urllib.parse import quote,unquote,urlsplit
from xml.etree import ElementTree as ET
import zlib

import private_fs as private
import machinenotes_client as model_api
from machinenotes_client import MachineNotesClient,DesktopReceiver,storage,safe_path,checked_manifest,extract_checked,publish_exclusive,require_space
from redx_session import SessionError
import mount_platform as platform_api

class MountError(RuntimeError):pass

def label(item):
    value=item.get("displayName",item["name"])
    safe_path(value)
    if "/" in value:raise ValueError("The MachineNote contains an unsafe display name.")
    return value

def identity(item):
    return tuple(item.get(k) for k in ("key","archiveKey","manifestId","archiveBytes","archiveSha256","name","kind"))

def metadata(client,item):
    with model_api.TRANSFER_LOCK,storage.Codec(client) as codec:
        root,_=storage._root_for_item(client,codec,item)
        meta=root["metadata"];expected=meta.get("jsonBytes")
        if (meta.get("schema")!=storage.METADATA_SCHEMA or meta.get("encoding")!="zlib-json"
                or type(expected) is not int or not 0<expected<=256*1024*1024):raise ValueError("Invalid encrypted drive metadata.")
        parts=storage._load_pages(client,codec,meta["partPages"]) if "partPages" in meta else meta.get("parts")
        if not isinstance(parts,list) or len(parts)>8192:raise ValueError("Invalid encrypted drive metadata.")
        compressed=bytearray()
        for part in parts:
            compressed.extend(storage._get_plain(client,codec,part))
            if len(compressed)>256*1024*1024:raise ValueError("Encrypted drive metadata exceeds its limit.")
        decoder=zlib.decompressobj();raw=decoder.decompress(compressed,expected+1)
        if (len(raw)!=expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail
                or hashlib.sha256(raw).hexdigest()!=meta.get("jsonSha256")):raise ValueError("Drive metadata failed integrity verification.")
        records=json.loads(raw)
    if not isinstance(records,list) or not 1<=len(records)<=model_api.MAX_ENTRIES:raise ValueError("Invalid encrypted drive metadata.")
    entries={};folded=set()
    for record in records:
        if not isinstance(record,dict) or not isinstance(record.get("path"),str):raise ValueError("Invalid encrypted drive metadata.")
        path=record["path"]
        if path!=".":safe_path(path)
        fold=unicodedata.normalize("NFC",path).casefold()
        if path in entries or fold in folded or record.get("type") not in ("file","directory","symlink"):raise ValueError("Invalid encrypted drive metadata.")
        if record["type"]=="file" and (type(record.get("size")) is not int or record["size"]<0 or not storage.SHA.fullmatch(record.get("sha256", ""))):raise ValueError("Invalid encrypted drive metadata.")
        entries[path]=record;folded.add(fold)
    if "." not in entries:raise ValueError("The encrypted backup root is missing.")
    for path in entries:
        if path!="." and entries.get(path.rpartition("/")[0] or ".",{}).get("type")!="directory":raise ValueError("Invalid encrypted backup hierarchy.")
    return entries

class WorkspaceTree:
    def __init__(self,model,note,cache,*,manifest_loader=None,restorer=None):
        owner=model.session.receiver
        if not storage.RECEIVER.fullmatch(owner or "") or not storage.ID.fullmatch(note or ""):
            raise MountError("Connect an account and choose its MachineNote.")
        if not model.keys or model.keys.get("receiverId")!=owner or model.keymap is None:
            raise MountError("Import this account's portable vault before mounting.")
        self.owner=owner;self.note=note;self.session=model.session
        self.model=MachineNotesClient(model.session,root=cache)
        self.model.keys=dict(model.keys);self.model.keymap=model.keymap;self.model.vault_exported=model.vault_exported
        self.model.selected_note=note;self.model.notes=list(model.notes)
        self.cache=private.private_directory(cache);self.lock=threading.RLock()
        self.active=0;self.closing=False;self.items={};self.manifests={};self.materialized={};self.verified_files={}
        self.loader=manifest_loader or metadata;self.restorer=restorer or self._restore
        self.authorize()

    def authorize(self):
        if self.session.receiver!=self.owner or not self.session.token():raise SessionError("The drive account is no longer connected.",401)
        self.model.refresh_notes()
        if self.session.receiver!=self.owner or self.note not in {n["id"] for n in self.model.notes}:
            raise SessionError("The drive no longer belongs to this connected account.",403)
        self.model.selected_note=self.note
        snapshot=self.model.refresh_tree();items={i["key"]:dict(i) for i in snapshot["items"]}
        names=set()
        for item in items.values():
            name=(item.get("parentKey"),unicodedata.normalize("NFC",label(item)).casefold())
            if name in names:raise ValueError("The drive contains colliding names.")
            names.add(name)
        self.items=items;self.revision=snapshot["revision"]

    @contextlib.contextmanager
    def request(self):
        with self.lock:
            if self.closing:raise MountError("The drive is being unmounted.")
            self.active+=1
        try:
            with self.lock:self.authorize()
            yield
        finally:
            with self.lock:self.active-=1

    def manifest(self,item):
        key=identity(item)
        with self.lock:
            if key not in self.manifests:
                self.manifests[key]=self.loader(DesktopReceiver(self.model.config()),item)
            return self.manifests[key]

    def resolve(self,parts):
        parent=None
        for index,part in enumerate(parts):
            matches=[i for i in self.items.values() if i.get("parentKey")==parent and label(i)==part]
            if len(matches)!=1:raise FileNotFoundError()
            item=matches[0]
            if item.get("virtualFolder") is True:
                parent=item["key"]
                if index==len(parts)-1:return dict(type="directory",parent=parent)
            else:
                relative="/".join(parts[index+1:]) or "."
                if relative=="." and item["kind"] in ("folder","app"):
                    return dict(type="directory",item=item,relative=".")
                record=self.manifest(item).get(relative)
                if not record:raise FileNotFoundError()
                if record["type"]=="symlink":raise PermissionError("Restore links on their original platform.")
                return dict(record,item=item,relative=relative)
        return dict(type="directory",parent=parent)

    def children(self,parts):
        node=self.resolve(parts)
        if node["type"]!="directory":return []
        if "item" not in node:
            names=[label(i) for i in self.items.values() if i.get("parentKey")==node["parent"]]
        else:
            if node["item"]["kind"]=="app":raise PermissionError("Restore macOS applications on their original platform.")
            prefix="" if node["relative"]=="." else node["relative"]+"/"
            names=[p[len(prefix):] for p in self.manifest(node["item"]) if p!="." and p.startswith(prefix) and "/" not in p[len(prefix):]]
        return [(name,self.resolve((*parts,name))) for name in sorted(names)]

    def _restore(self,item):
        if item["kind"]=="app":raise PermissionError("Restore macOS applications on their original platform.")
        records=self.manifest(item);checked_manifest(list(records.values()))
        generation=hashlib.sha256(json.dumps(identity(item),separators=(",",":")).encode()).hexdigest()
        directory=private.private_directory(self.cache/item["key"]/generation);target=directory/"payload"
        if target.exists() or target.is_symlink():
            self._verify_cached(target,records);return target
        require_space(directory,sum(r.get("size",0) for r in records.values())+item["archiveBytes"]*2)
        with model_api.TRANSFER_LOCK,private.temporary_directory(directory,prefix="restore-") as temporary:
            scratch=Path(temporary);archive=scratch/"archive.zip"
            result=storage.download_archive(self.model.config(),item,archive,client_factory=DesktopReceiver)
            if result["manifest"]!=list(records.values()):raise ValueError("The encrypted drive manifest changed during restoration.")
            output=private.private_directory(scratch/"output")
            restored=extract_checked(archive,output,result["manifest"],item["name"],result["root"]["archiveLayout"])
            private.protect_generated_tree(output);publish_exclusive(restored,target)
        return target

    @staticmethod
    def _verify_cached(target,records):
        for relative,record in records.items():
            path=target if relative=="." else target/relative
            private.verify(path)
            if record["type"]=="directory":
                if not path.is_dir():raise ValueError("The private drive cache changed.")
            elif not path.is_file() or path.stat().st_size!=record["size"] or storage.sha256_file(path)!=record["sha256"]:
                raise ValueError("The private drive cache failed integrity verification.")

    @contextlib.contextmanager
    def open_file(self,node):
        if node["type"]!="file":raise IsADirectoryError()
        with self.lock:
            item=node["item"]
            if identity(self.items.get(item["key"],{}))!=identity(item):raise FileNotFoundError()
            key=identity(item)
            if key not in self.materialized:self.materialized[key]=self.restorer(item)
            root=Path(self.materialized[key]);path=root if node["relative"]=="." else root/node["relative"]
            private.verify(path)
            fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size!=node["size"]:
                os.close(fd);raise ValueError("The verified drive cache changed.")
            source=os.fdopen(fd,"rb")
            fingerprint=lambda value:(value.st_dev,value.st_ino,value.st_size,value.st_mtime_ns,value.st_ctime_ns,value.st_mode)
            verification=(key,node["relative"])
            if self.verified_files.get(verification)!=fingerprint(before):
                digest=hashlib.sha256()
                while part:=source.read(1024*1024):digest.update(part)
                if digest.hexdigest()!=node["sha256"] or fingerprint(os.fstat(fd))!=fingerprint(before):
                    source.close();raise ValueError("The verified drive cache changed.")
                self.verified_files[verification]=fingerprint(before)
            source.seek(0)
        try:yield source
        finally:source.close()

class DAVServer(ThreadingHTTPServer):
    daemon_threads=True
    def __init__(self,tree):
        self.tree=tree;self.token=secrets.token_urlsafe(32);self.slots=threading.BoundedSemaphore(8)
        super().__init__(("127.0.0.1",0),DAVHandler)
    @property
    def url(self):return "http://127.0.0.1:"+str(self.server_port)+"/"
    def process_request(self,request,address):
        request.settimeout(30)
        if not self.slots.acquire(blocking=False):self.shutdown_request(request);return
        try:super().process_request(request,address)
        except Exception:self.slots.release();raise
    def process_request_thread(self,*args):
        try:super().process_request_thread(*args)
        finally:self.slots.release()
    def handle_error(self,*args):pass

class DAVHandler(BaseHTTPRequestHandler):
    protocol_version="HTTP/1.0"
    def log_message(self,*args):pass
    def result(self,status,data=b"",kind="text/plain",headers=None):
        if getattr(self,"response_started",False):self.close_connection=True;return
        self.response_started=True
        self.send_response(status);self.send_header("Content-Type",kind);self.send_header("Cache-Control","no-store")
        if "Content-Length" not in (headers or {}):self.send_header("Content-Length",str(len(data)))
        for key,value in (headers or {}).items():self.send_header(key,value)
        self.end_headers()
        if self.command!="HEAD" and data:self.wfile.write(data)
    def path_parts(self):
        path=urlsplit(self.path)
        if path.query or path.fragment or len(self.path)>8192:raise ValueError("Invalid drive path.")
        decoded=unquote(path.path,errors="strict")
        if not decoded.startswith("/") or "\\" in decoded or "\0" in decoded:raise ValueError("Invalid drive path.")
        parts=tuple(decoded.strip("/").split("/")) if decoded.strip("/") else ()
        for part in parts:
            safe_path(part)
            if not part or part in (".",".."):raise ValueError("Invalid drive path.")
        return parts
    def dispatch(self):
        if (self.headers.get("Host")!="127.0.0.1:"+str(self.server.server_port) or self.headers.get("Origin")
                or not hmac.compare_digest(self.headers.get("Authorization", ""),"Bearer "+self.server.token)):
            return self.result(401)
        try:
            with self.server.tree.request():
                if self.command not in ("OPTIONS","PROPFIND","GET","HEAD"):
                    return self.result(405,headers={"Allow":"OPTIONS, PROPFIND, GET, HEAD"})
                parts=self.path_parts();tree=self.server.tree
                if self.command=="OPTIONS":return self.result(200,headers={"Allow":"OPTIONS, PROPFIND, GET, HEAD","DAV":"1"})
                if self.command=="PROPFIND":
                    if self.headers.get("Depth","1") not in ("0","1"):return self.result(403)
                    length=int(self.headers.get("Content-Length","0"))
                    if not 0<=length<=65536:return self.result(413)
                    if length:self.rfile.read(length)
                    values=[(parts,tree.resolve(parts))]
                    if self.headers.get("Depth","1")=="1":values.extend((parts+(name,),node) for name,node in tree.children(parts))
                    document=ET.Element("{DAV:}multistatus")
                    for path,node in values:
                        response=ET.SubElement(document,"{DAV:}response")
                        ET.SubElement(response,"{DAV:}href").text="/"+"/".join(quote(p,safe="") for p in path)+("/" if path and node["type"]=="directory" else "")
                        propstat=ET.SubElement(response,"{DAV:}propstat");prop=ET.SubElement(propstat,"{DAV:}prop");resource=ET.SubElement(prop,"{DAV:}resourcetype")
                        if node["type"]=="directory":ET.SubElement(resource,"{DAV:}collection")
                        ET.SubElement(prop,"{DAV:}getcontentlength").text=str(node.get("size",0))
                        ET.SubElement(prop,"{DAV:}getetag").text='"'+str(node.get("sha256",tree.revision))+'"'
                        ET.SubElement(propstat,"{DAV:}status").text="HTTP/1.1 200 OK"
                    return self.result(207,ET.tostring(document,encoding="utf-8",xml_declaration=True),"application/xml")
                node=tree.resolve(parts)
                if node["type"]!="file":return self.result(405)
                size=node["size"];start=0;end=max(0,size-1);status=200
                requested=self.headers.get("Range")
                if requested:
                    match=re.fullmatch(r"bytes=([0-9]+)-([0-9]*)",requested)
                    if not match:return self.result(416,headers={"Content-Range":"bytes */"+str(size)})
                    start=int(match[1]);end=min(end,int(match[2])) if match[2] else end
                    if start>end or start>=size:return self.result(416,headers={"Content-Range":"bytes */"+str(size)})
                    status=206
                with tree.open_file(node) as source:
                    headers={"Content-Length":str(end-start+1 if size else 0),"Accept-Ranges":"bytes","ETag":'"'+node["sha256"]+'"'}
                    if status==206:headers["Content-Range"]=f"bytes {start}-{end}/{size}"
                    self.result(status,kind="application/octet-stream",headers=headers)
                    if self.command!="HEAD":
                        source.seek(start);remaining=end-start+1 if size else 0
                        while remaining:
                            part=source.read(min(256*1024,remaining))
                            if not part:raise OSError("Drive cache changed.")
                            self.wfile.write(part);remaining-=len(part)
        except (SessionError,PermissionError):self.result(403)
        except FileNotFoundError:self.result(404)
        except MountError:self.result(503)
        except (ValueError,KeyError,UnicodeError):self.result(400)
        except (OSError,storage.RedXStorageError):self.result(507)
    do_GET=do_HEAD=do_OPTIONS=do_PROPFIND=do_PUT=do_POST=do_PATCH=do_TRACE=do_DELETE=do_MOVE=do_COPY=do_MKCOL=do_PROPPATCH=do_LOCK=do_UNLOCK=dispatch

class WorkspaceMountManager:
    def __init__(self,root):
        self.root=private.private_directory(Path(root)/"WorkspaceDrives");self.lock=threading.RLock();self.live={};self.unknown=False
        self.saved={};self.refresh()
    def _path(self,owner,note):
        if not storage.RECEIVER.fullmatch(owner or "") or not storage.ID.fullmatch(note or ""):raise MountError("Invalid drive identity.")
        for path in (self.root/owner,self.root/owner/note):
            if path.exists() or path.is_symlink():
                private.verify(path)
                if not path.is_dir() or path.resolve()!=path:raise MountError("The drive identity path is linked or unsafe.")
        return self.root/owner/note
    def _save(self,record):
        root=private.private_directory(self._path(record["receiverId"],record["workspaceId"]))
        private.write_private(root/"registry.json",json.dumps(record,sort_keys=True).encode("utf-8"),replace=True)
        self.saved[record["id"]]=record
    def refresh(self):
        with self.lock:
            self.unknown=False
            known=set()
            for owner in self.root.iterdir():
                if owner.is_symlink() or getattr(owner.lstat(),"st_file_attributes",0)&0x400:self.unknown=True
            for path in self.root.glob("*/*/registry.json"):
                try:
                    private.verify(path)
                    if path.stat().st_size>16384:raise ValueError()
                    record=json.loads(path.read_bytes());owner=record["receiverId"];note=record["workspaceId"]
                    if (record.get("schema")!=1 or path.parent!=self._path(owner,note) or record.get("id")!=owner+"/"+note
                            or not isinstance(record.get("mountPath"),str) or not platform_api.valid_mount_path(record,self._path(owner,note))):raise ValueError()
                    actual=platform_api.mounted(record)
                    known.add(record["mountPath"])
                    process=record.get("process")
                    alive=platform_api.process_matches(process) if process else False
                    uncertain=process is not None and alive is not False or process is None and record.get("state")!="unmounted"
                    record["state"]="mounted" if actual is True and record["id"] in self.live else "orphaned" if actual is not False or uncertain or record["id"] in self.live else "unmounted"
                    self.saved[record["id"]]=record
                except Exception:self.unknown=True
            if platform_api.unrecorded_mounts(self.root,known):self.unknown=True
            return self.records
    @property
    def records(self):return [dict(r) for r in self.saved.values() if r.get("state")!="unmounted"]
    @property
    def has_mounts(self):
        self.refresh()
        return self.unknown or bool(self.records) or bool(self.live)
    def mount(self,model,note,rclone=None):
        with self.lock:
            self.refresh();owner=model.session.receiver;root=self._path(owner,note);key=owner+"/"+note
            if self.unknown:raise MountError("The existing drive registry needs review before mounting another drive.")
            if key in self.live or self.saved.get(key,{}).get("state")!="unmounted" and key in self.saved:
                raise MountError("This MachineNote already has a mounted or retained drive.")
            if len(self.records)>=20:raise MountError("Unmount a drive before mounting more than twenty MachineNotes.")
            tools=platform_api.prerequisites(rclone)
            mount_path=platform_api.choose_mount_path(root)
            record={"schema":1,"id":key,"receiverId":owner,"workspaceId":note,"mountPath":str(mount_path),"readOnly":True,
                "label":platform_api.volume_label(owner,note),"state":"preparing","process":None,"tools":tools,
                "name":next((str(n.get("name") or "MachineNote")[:128] for n in model.notes if n["id"]==note),"MachineNote")}
            tree=WorkspaceTree(model,note,private.private_directory(root/"cache"));server=DAVServer(tree)
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            process=None;started=False;registered=False
            try:
                self._save(record);registered=True
                thread.start();started=True
                process=platform_api.start(tools,record,server.url,server.token,private.private_directory(root/"rclone-cache"))
                self.live[key]=(tree,server,thread,process)
                record["process"]=platform_api.process_identity(process.pid);self._save(record)
                deadline=time.monotonic()+30
                while time.monotonic()<deadline:
                    if platform_api.mounted(record) is True and platform_api.ready(process):
                        record.update(platform_api.capture_mount_identity(record))
                        record["state"]="mounted";self._save(record);return dict(record)
                    if process.poll() is not None:break
                    time.sleep(.1)
                if process.poll() is not None:raise platform_api.startup_failure(process)
                raise MountError("The filesystem driver could not create a drive. Check rclone, WinFsp/FUSE and retained drive status.")
            except Exception:
                actual=platform_api.mounted(record)
                if process is None or process.poll() is not None:
                    self.live.pop(key,None)
                    if started:server.shutdown()
                    server.server_close()
                    if started:thread.join(timeout=2)
                    if registered:
                        record["state"]="orphaned" if actual is not False else "unmounted";self._save(record)
                else:
                    record["state"]="orphaned";self._save(record)
                raise
    def unmount(self,key):
        with self.lock:
            self.refresh();record=self.saved.get(key)
            if record is None:raise MountError("Choose a known drive.")
            live=self.live.get(key)
            if not live:
                if platform_api.mounted(record) is False and platform_api.process_matches(record.get("process")) is False:
                    record["state"]="unmounted";self._save(record);return
                raise MountError("This retained drive belongs to a previous process. Unmount it normally in the operating system; no process was stopped.")
            tree,server,thread,process=live
            with tree.lock:
                if tree.active:raise MountError("Close files using this drive and retry. The drive was retained.")
                tree.closing=True
            try:
                if not (platform_api.mounted(record) is False and process.poll() is not None):
                    platform_api.unmount(record,process)
                if platform_api.mounted(record) is not False or process.poll() is None:
                    raise MountError("The drive or its filesystem process is still active; the session was retained.")
                server.shutdown();server.server_close();thread.join(timeout=2)
                self.live.pop(key);record["state"]="unmounted";self._save(record)
            except Exception:
                with tree.lock:tree.closing=False
                raise
