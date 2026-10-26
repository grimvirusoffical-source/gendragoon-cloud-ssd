#!/usr/bin/env python3
"""Windows/Linux GenDragoon desktop Files and Teams client for current MachineNotes."""
import argparse
import concurrent.futures
import json
from pathlib import Path
import queue
import sys
import uuid
import webbrowser
from workspace_mount import WorkspaceMountManager,MountError
from mount_platform import PlatformMountError

sys.dont_write_bytecode=True
from redx_session import RedXSession, IntegrationSession, SessionError
from machinenotes_client import MachineNotesClient, DesktopInstance, storage
from portable_vault import VaultError, ENVELOPE_LIMIT

class GenDragoonGUI:
    def __init__(self,root,*,companion_directory=None):
        import tkinter as tk
        from tkinter import ttk
        self.instance=DesktopInstance()
        self.tk=tk;self.ttk=ttk;self.root=root;self.model=MachineNotesClient()
        self.mounts=WorkspaceMountManager(self.model.root);self.rclone_path=None
        self.executor=concurrent.futures.ThreadPoolExecutor(max_workers=1,thread_name_prefix="gendragoon-desktop")
        self.messages=queue.Queue();self.busy=False;self.clipboard=None;self.team=None;self.team_cursor=None;self.chat_cursor=None
        self.team_values=[];self.drag=None
        self.companion_grants=set();self.companion=None;self.companion_completed={}
        root.title("GenDragoon · MachineNotes");root.geometry("1060x760");root.minsize(800,600)
        self.status=tk.StringVar(value="Connect Red-XAI to browse your MachineNotes.")
        header=ttk.Frame(root,padding=12);header.pack(fill="x")
        ttk.Label(header,text="GenDragoon",font=("TkDefaultFont",19,"bold")).pack(side="left")
        ttk.Button(header,text="Connect Red-XAI…",command=self.login).pack(side="right",padx=3)
        ttk.Button(header,text="Integration key…",command=self.integration_login).pack(side="right",padx=3)
        ttk.Button(header,text="Disconnect",command=self.disconnect).pack(side="right",padx=3)
        self.tabs=ttk.Notebook(root);self.tabs.pack(fill="both",expand=True,padx=12)
        self.files=ttk.Frame(self.tabs,padding=10);self.teams=ttk.Frame(self.tabs,padding=10);self.settings=ttk.Frame(self.tabs,padding=10)
        self.tabs.add(self.files,text="Files");self.tabs.add(self.teams,text="Teams");self.tabs.add(self.settings,text="Storage keys")
        self._files();self._teams();self._settings()
        ttk.Label(root,textvariable=self.status,wraplength=1000,padding=12).pack(fill="x")
        root.protocol("WM_DELETE_WINDOW",self.close);root.after(40,self.pump)
        try:
            from companion_server import CompanionServer
            self.companion=CompanionServer(self.companion_dispatch,socket_directory=companion_directory);self.companion.start()
        except (ImportError,RuntimeError,OSError):
            self.status.set("Desktop Files and Teams are ready. Browser companion is unavailable in this runtime.")
    def pump(self):
        while True:
            try:self.messages.get_nowait()()
            except queue.Empty:break
        if self.busy and self.model.progress is not None:
            progress=self.model.progress.snapshot();total=progress.get("total_bytes",0);completed=progress.get("completed_bytes",0)
            stage=str(progress["phase"]).capitalize()
            self.status.set(stage+(" · archive bytes "+str(int(completed))+" / "+str(int(total)) if total else "")
                +" · carrier bytes sent "+str(int(progress.get("uploaded_bytes",0)))+" · received "+str(int(progress.get("downloaded_bytes",0))))
        self.root.after(40,self.pump)
    def _error(self,error):
        if isinstance(error,(SessionError,VaultError,storage.RedXStorageError,ValueError,MountError,PlatformMountError)):
            return str(error)[:600]
        return "The operation could not finish. Your originals and existing keys were preserved."
    def run(self,label,work,done=None,failed=None):
        if self.busy:
            self.status.set("Wait for the current operation to finish.")
            if failed:failed(SessionError("Another desktop operation is active.",409))
            return
        self.busy=True;self.model.progress=None;self.status.set(label)
        future=self.executor.submit(work)
        def finished():
            self.busy=False
            try:
                value=future.result()
                self.status.set("Ready. Originals are retained after uploads.")
                if done:done(value)
            except Exception as error:
                self.status.set(self._error(error))
                if failed:failed(error)
        future.add_done_callback(lambda _:self.messages.put(finished))
    def _files(self):
        from tkinter import ttk
        bar=ttk.Frame(self.files);bar.pack(fill="x")
        self.note=ttk.Combobox(bar,state="readonly");self.note.pack(side="left",fill="x",expand=True)
        self.note.bind("<<ComboboxSelected>>",self.note_changed)
        ttk.Button(bar,text="Refresh",command=self.refresh).pack(side="left",padx=4)
        toolbar=ttk.Frame(self.files);toolbar.pack(fill="x",pady=8)
        for title,command in (("New folder",self.new_folder),("Upload file…",lambda:self.upload(False)),("Upload folder…",lambda:self.upload(True)),("Resume queued",self.resume_queue),("Download…",self.download),("Rename",self.rename),("Delete",self.delete)):
            ttk.Button(toolbar,text=title,command=command).pack(side="left",padx=2)
        self.tree=ttk.Treeview(self.files,columns=("kind","bytes"),selectmode="extended")
        self.tree.heading("#0",text="Name");self.tree.heading("kind",text="Type");self.tree.heading("bytes",text="Archive bytes")
        self.tree.column("#0",width=500);self.tree.column("kind",width=140);self.tree.column("bytes",width=130,anchor="e")
        self.tree.pack(fill="both",expand=True)
        self.tree.bind("<Button-3>",self.context);self.tree.bind("<Control-c>",lambda _:self.copy(False));self.tree.bind("<Control-x>",lambda _:self.copy(True));self.tree.bind("<Control-v>",lambda _:self.paste())
        self.tree.bind("<ButtonPress-1>",self.drag_start,add=True);self.tree.bind("<ButtonRelease-1>",self.drag_end,add=True)
        ttk.Label(self.files,text="Folders organize archive items. Folder backups keep their archived contents together. Uploads retain your originals; library deletion retains encrypted payload bytes and does not reclaim quota.",wraplength=980).pack(fill="x",pady=8)
        drives=ttk.LabelFrame(self.files,text="Read-only workspace drives",padding=6);drives.pack(fill="x")
        actions=ttk.Frame(drives);actions.pack(fill="x")
        for title,command in (("Mount selected MachineNote",self.mount_drive),("Open drive",self.open_drive),("Unmount selected drive",self.unmount_drive),("Choose rclone…",self.choose_rclone)):
            ttk.Button(actions,text=title,command=command).pack(side="left",padx=3)
        self.drive_list=ttk.Treeview(drives,columns=("state","path"),height=3,selectmode="browse")
        self.drive_list.heading("#0",text="MachineNote");self.drive_list.heading("state",text="Status");self.drive_list.heading("path",text="Actual mount path")
        self.drive_list.column("#0",width=240);self.drive_list.column("state",width=120);self.drive_list.column("path",width=550);self.drive_list.pack(fill="x",pady=5)
        ttk.Label(drives,text="Requires existing rclone and WinFsp (Windows) or FUSE (Linux). Files are verified in a private local cache before reading; opening a folder backup can restore its complete archive. Make changes in GenDragoon. Unmount every drive before disconnecting, changing accounts, or quitting because the OS may cache file data.",wraplength=980).pack(fill="x")
        self.refresh_drives()
    def _teams(self):
        from tkinter import ttk
        bar=ttk.Frame(self.teams);bar.pack(fill="x")
        for title,command in (("Set username…",self.username),("Refresh teams",self.refresh_teams),("More teams",self.more_teams),("Create note team…",self.create_team),("Join invitation…",self.join_team)):
            ttk.Button(bar,text=title,command=command).pack(side="left",padx=2)
        self.team_list=ttk.Combobox(self.teams,state="readonly");self.team_list.pack(fill="x",pady=8);self.team_list.bind("<<ComboboxSelected>>",self.team_changed)
        actions=ttk.Frame(self.teams);actions.pack(fill="x")
        ttk.Button(actions,text="Create invitation…",command=self.invite).pack(side="left")
        ttk.Button(actions,text="Members…",command=self.members).pack(side="left",padx=4)
        ttk.Button(actions,text="Refresh chat",command=self.refresh_chat).pack(side="left")
        ttk.Button(actions,text="More messages",command=self.more_chat).pack(side="left",padx=4)
        self.chat=self.tk.Text(self.teams,wrap="word",state="disabled",height=18);self.chat.pack(fill="both",expand=True,pady=8)
        compose=ttk.Frame(self.teams);compose.pack(fill="x")
        self.message=ttk.Entry(compose);self.message.pack(side="left",fill="x",expand=True);self.message.bind("<Return>",lambda _:self.send())
        ttk.Button(compose,text="Send",command=self.send).pack(side="left",padx=4)
        ttk.Label(self.teams,text="Chat uses the authenticated GenDragoon server relay. Teams membership grants no access to MachineNote files. Peer calls and live media are not available in this desktop view.",wraplength=980).pack(fill="x",pady=8)
    def _settings(self):
        from tkinter import ttk
        ttk.Label(self.settings,text="Portable encrypted storage vault",font=("TkDefaultFont",15,"bold")).pack(anchor="w")
        ttk.Label(self.settings,text="Import the vault exported by the device that encrypted your files. Account sign-in and scoped keys cannot recover encryption keys. Vault passphrases and account credentials are held only in memory while this client is open.",wraplength=900).pack(fill="x",pady=12)
        for title,command in (("Import encrypted vault…",self.import_vault),("Export encrypted vault…",self.export_vault),("Initialize a new empty account…",self.initialize_vault)):
            ttk.Button(self.settings,text=title,command=command).pack(anchor="w",pady=5)
        ttk.Label(self.settings,text="The exported file uses AES-256-GCM and PBKDF2-HMAC-SHA256 (600,000 iterations). Keep it and its passphrase safe. Different local keys are never replaced. New keys must be exported before uploading.",wraplength=900).pack(fill="x",pady=12)
        ttk.Label(self.settings,text="Windows/Linux supports portable files, folder archives, and read-only workspace drives when existing rclone and WinFsp/FUSE are available. Backups containing macOS apps, extended attributes, or symbolic links must be restored on their original platform. Drives do not provide writeback or managed app launch.",wraplength=900).pack(fill="x",pady=12)
        ttk.Separator(self.settings).pack(fill="x",pady=10)
        ttk.Label(self.settings,text="Browser and VS Code companion",font=("TkDefaultFont",13,"bold")).pack(anchor="w")
        ttk.Label(self.settings,text="Enable only your exact installed extension IDs. Each extension still needs native approval for the connected account. Account tokens and storage keys are never sent to a browser or editor.",wraplength=900).pack(fill="x",pady=8)
        ttk.Button(self.settings,text="Configure browser/editor access…",command=self.configure_companion).pack(anchor="w")
        ttk.Button(self.settings,text="Clear this session's extension approvals",command=lambda:(self.companion_grants.clear(),self.companion_completed.clear(),self.status.set("Extension approvals cleared. Each client must be approved again."))).pack(anchor="w",pady=5)
    def configure_companion(self):
        if self.busy:return
        window=self.tk.Toplevel(self.root);window.title("Explicit extension IDs");window.transient(self.root)
        fields={}
        for row,label in enumerate(("chrome","edge","opera")):
            self.ttk.Label(window,text=label.capitalize()+" extension ID").grid(row=row,column=0,padx=10,pady=6)
            field=self.ttk.Entry(window,width=40);field.grid(row=row,column=1,padx=10,pady=6);fields[label]=field
        firefox=self.tk.BooleanVar();vscode=self.tk.BooleanVar()
        self.ttk.Checkbutton(window,text="Enable GenDragoon Firefox extension",variable=firefox).grid(row=3,column=0,columnspan=2,sticky="w",padx=10)
        self.ttk.Checkbutton(window,text="Enable redxai.gendragoon VS Code extension",variable=vscode).grid(row=4,column=0,columnspan=2,sticky="w",padx=10)
        def install():
            ids={k:v.get().strip() or None for k,v in fields.items()};ff=firefox.get();vs=vscode.get();window.destroy()
            def work():
                import importlib.util
                here=Path(__file__).resolve().parent
                installer=here/"install_native_host.py"
                if not installer.is_file():installer=here.parent/"Extensions/install_native_host.py"
                spec=importlib.util.spec_from_file_location("gd_desktop_host_installer",installer);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
                host_root=Path(sys.executable).resolve().parent if getattr(sys,"frozen",False) else here
                host=host_root/("GenDragoonNativeHost.exe" if sys.platform=="win32" else "GenDragoonNativeHost")
                return module.install(platform=sys.platform,home=Path.home(),helper=storage.RESOURCE/"gendragoon_native_bridge.py",
                    python=Path(sys.executable),browser_ids=ids,firefox=ff,vscode=vs,
                    host_executable=host if sys.platform=="win32" or getattr(sys,"frozen",False) else None)
            self.run("Installing only the selected current-user extension allowlist…",work,lambda _:self.status.set("Companion allowlist installed. Open your extension and approve it in this GenDragoon session."))
        self.ttk.Button(window,text="Enable selected extensions",command=install).grid(row=5,column=0,columnspan=2,pady=12)
    def login(self):
        if not self.can_switch():return
        session=RedXSession()
        def work():
            session.login(lambda code:self.messages.put(lambda:self.status.set("Approve GenDragoon in your browser · code "+code)),webbrowser.open)
            model=MachineNotesClient(session);model.refresh_notes();return model
        self.run("Starting Red-XAI browser approval…",work,self.connected)
    def integration_login(self):
        from tkinter import simpledialog
        if not self.can_switch():return
        key=simpledialog.askstring("Scoped integration key","Enter a key issued by GenDragoon for one MachineNote. Teams requires browser approval.",show="•",parent=self.root)
        if not key:return
        def work():
            model=MachineNotesClient(IntegrationSession(key));model.refresh_notes();return model
        self.run("Verifying the scoped integration key…",work,self.connected)
    def connected(self,model):
        self.model.session.logout();self.model=model;self.clipboard=None;self.team=None;self.team_values=[];self.companion_grants.clear();self.companion_completed.clear()
        self.team_list["values"]=[];self.team_list.set("");self.display_notes()
        if model.selected_note:self.refresh_tree()
    def disconnect(self):
        from tkinter import messagebox
        if not self.can_switch():return
        if self.model.keys and not self.model.vault_exported:
            messagebox.showwarning("Export your vault","Export your new vault before disconnecting, so its storage key is not lost.",parent=self.root);return
        self.model.session.logout();self.model=MachineNotesClient();self.note["values"]=[];self.note.set("");self.tree.delete(*self.tree.get_children());self.clipboard=None;self.team=None;self.companion_grants.clear();self.status.set("Disconnected. Account credentials are no longer held in this session.")
    def can_switch(self):
        from tkinter import messagebox
        if self.busy:return False
        if self.mounts.has_mounts:
            messagebox.showwarning("Unmount workspace drives","Unmount all drives before disconnecting, changing accounts, or quitting. Retained or uncertain drives also need review; the current session was preserved.",parent=self.root);return False
        if self.model.keys and not self.model.vault_exported:
            messagebox.showwarning("Export your vault","Export your new vault before changing accounts, so its storage key is not lost.",parent=self.root);return False
        return True
    def display_notes(self):
        self.note["values"]=[str(n.get("name") or "MachineNote")+(" · read only" if not n.get("active") or n.get("readOnly") else "") for n in self.model.notes]
        for i,n in enumerate(self.model.notes):
            if n["id"]==self.model.selected_note:self.note.current(i)
    def note_changed(self,_=None):
        index=self.note.current()
        if self.busy:self.display_notes();return
        if index>=0:self.model.selected_note=self.model.notes[index]["id"];self.model.selected_parent=None;self.refresh_tree()
    def refresh(self):
        self.run("Refreshing owned MachineNotes…",self.model.refresh_notes,lambda _:(self.display_notes(),self.refresh_tree() if self.model.selected_note else None))
    def refresh_tree(self):self.run("Loading the current library…",self.model.refresh_tree,lambda _:self.display_tree())
    def display_tree(self):
        self.tree.delete(*self.tree.get_children())
        pending={i["key"]:i for i in self.model.items};inserted=set()
        while pending:
            progressed=False
            for key,item in list(pending.items()):
                parent=item.get("parentKey")
                if parent is None or parent in inserted:
                    kind="Folder" if item.get("virtualFolder") else "Folder backup" if item["kind"]=="folder" else "macOS app" if item["kind"]=="app" else "File"
                    self.tree.insert(parent or "","end",iid=key,text=item.get("displayName",item["name"]),values=(kind,item.get("archiveBytes",0)),open=True)
                    inserted.add(key);del pending[key];progressed=True
            if not progressed:self.status.set("The library hierarchy needs review. Refresh before changing it.");break
    def selected(self):return list(self.tree.selection())
    def refresh_drives(self):
        self.drive_list.delete(*self.drive_list.get_children())
        for record in self.mounts.refresh():
            self.drive_list.insert("","end",iid=record["id"],text=record.get("name","MachineNote"),values=(record["state"],record["mountPath"]))
        if self.mounts.unknown:self.status.set("The private drive registry needs review. Account switching and Quit remain blocked.")
    def choose_rclone(self):
        from tkinter import filedialog
        if self.busy:return
        chosen=filedialog.askopenfilename(parent=self.root,title="Select an existing trusted rclone executable")
        if chosen:self.rclone_path=chosen;self.status.set("Selected rclone. The executable and filesystem prerequisites will be checked before mounting.")
    def mount_drive(self):
        if self.busy or not self.model.selected_note:return
        model=self.model;note=model.selected_note;binary=self.rclone_path
        self.run("Preparing an authenticated read-only filesystem drive…",lambda:self.mounts.mount(model,note,binary),lambda _:(self.refresh_drives(),self.status.set("Read-only filesystem drive mounted. Unmount every drive before changing accounts or quitting.")),lambda _:self.refresh_drives())
    def unmount_drive(self):
        selected=self.drive_list.selection()
        if self.busy or len(selected)!=1:return
        key=selected[0]
        self.run("Requesting normal filesystem unmount…",lambda:self.mounts.unmount(key),lambda _:(self.refresh_drives(),self.status.set("The drive was normally unmounted. Its verified private cache was retained.")),lambda _:self.refresh_drives())
    def open_drive(self):
        import os,subprocess
        selected=self.drive_list.selection()
        if self.busy or len(selected)!=1:return
        record=next((r for r in self.mounts.refresh() if r["id"]==selected[0]),None)
        if not record or record["state"]!="mounted":self.status.set("This path is not a confirmed active filesystem drive.");return
        if sys.platform=="win32":os.startfile(record["mountPath"])
        else:subprocess.Popen(["xdg-open",record["mountPath"]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    def folder(self):
        selected=self.selected()
        if len(selected)==1:
            item=next(i for i in self.model.items if i["key"]==selected[0])
            if item.get("virtualFolder"):return item["key"]
            return item.get("parentKey")
        return None
    def mutate(self,operation,keys=(),name=None,parent=None):
        self.run("Updating the library…",lambda:self.model.organize(operation,keys,name,parent),lambda _:self.display_tree())
    def new_folder(self):
        from tkinter import simpledialog
        if self.busy:return
        name=simpledialog.askstring("New folder","Folder name",parent=self.root)
        if name:self.mutate("create-folder",name=name,parent=self.folder())
    def rename(self):
        from tkinter import simpledialog
        selected=self.selected()
        if self.busy or len(selected)!=1:return
        name=simpledialog.askstring("Rename item","New display name",initialvalue=self.tree.item(selected[0],"text"),parent=self.root)
        if name:self.mutate("rename",selected,name=name)
    def delete(self):
        from tkinter import messagebox
        selected=self.selected()
        if self.busy or not selected:return
        if messagebox.askyesno("Remove library items?","Remove the selected items and their nested library references? Encrypted payload bytes are retained and quota is not reclaimed. Your original local files are retained.",parent=self.root):self.mutate("delete",selected)
    def copy(self,cut=False):
        if self.busy:return
        self.clipboard=(self.model.session.receiver,self.model.selected_note,self.selected(),"move" if cut else "copy")
        self.status.set("Selected items are ready to "+("move" if cut else "copy")+". Select a destination folder and Paste.")
    def paste(self):
        if self.busy or not self.clipboard:return
        receiver,note,keys,operation=self.clipboard
        if receiver!=self.model.session.receiver or note!=self.model.selected_note:self.status.set("Copy and paste must stay within the same account and MachineNote.");return
        self.mutate(operation,keys,parent=self.folder())
        if operation=="move":self.clipboard=None
    def context(self,event):
        key=self.tree.identify_row(event.y)
        if key and key not in self.selected():self.tree.selection_set(key)
        menu=self.tk.Menu(self.root,tearoff=False)
        for title,command in (("New folder",self.new_folder),("Rename",self.rename),("Copy",lambda:self.copy(False)),("Cut / move",lambda:self.copy(True)),("Paste here",self.paste),("Download…",self.download),("Delete",self.delete)):
            menu.add_command(label=title,command=command)
        menu.tk_popup(event.x_root,event.y_root)
    def drag_start(self,event):self.drag=(event.x,event.y,self.tree.identify_row(event.y))
    def drag_end(self,event):
        if self.busy or not self.drag:return
        x,y,key=self.drag;self.drag=None
        if not key or abs(x-event.x)+abs(y-event.y)<12:return
        target=self.tree.identify_row(event.y)
        if target:
            item=next((i for i in self.model.items if i["key"]==target),None)
            if not item or not item.get("virtualFolder"):self.status.set("Drop into a Folder, or into blank space for the MachineNote root.");return
        self.mutate("move",self.selected() or [key],parent=target or None)
    def upload(self,directory=False):
        from tkinter import filedialog
        if self.busy:return
        path=filedialog.askdirectory(parent=self.root,title="Upload folder · original retained") if directory else filedialog.askopenfilename(parent=self.root,title="Upload file · original retained")
        if path:
            try:self.model.enqueue_selection(self.model.selected_note,self.folder(),[str(Path(path).absolute())]);self.drain_queue()
            except Exception as error:self.status.set(self._error(error))
    def drain_queue(self):
        if self.busy or self.model.keys is None or not self.model.vault_exported:return
        try:
            if not any(j["state"]=="queued" for j in self.model.jobs()):return
        except Exception as error:self.status.set(self._error(error));return
        def completed(_):
            if any(j["state"]=="queued" for j in self.model.jobs()):self.drain_queue()
            else:self.refresh_tree()
        self.run("Encrypting queued files, uploading, and verifying readback…",self.model.run_next_job,completed)
    def resume_queue(self):
        if self.busy:return
        try:self.model.retry_jobs();self.drain_queue()
        except Exception as error:self.status.set(self._error(error))
    def download(self):
        from tkinter import filedialog
        selected=self.selected()
        if self.busy or not selected:return
        destination=filedialog.askdirectory(parent=self.root,title="Restore verified copies into this folder")
        if not destination:return
        def work():return [self.model.download(key,Path(destination)) for key in selected]
        self.run("Downloading, decrypting, and verifying selected items…",work)
    def import_vault(self):
        from tkinter import filedialog,simpledialog
        if self.busy:return
        if self.mounts.has_mounts:self.status.set("Unmount every workspace drive before importing storage keys.");return
        path=filedialog.askopenfilename(parent=self.root,title="Import encrypted vault",filetypes=[("GenDragoon vault","*.gdvault"),("JSON","*.json"),("All files","*")])
        if not path:return
        password=simpledialog.askstring("Vault passphrase","Enter this vault's passphrase",show="•",parent=self.root)
        if password is None:return
        def work():
            with open(path,"rb") as source:envelope=source.read(ENVELOPE_LIMIT+1)
            self.model.import_vault(envelope,password)
        self.run("Verifying the vault and unlocking its encrypted keymap…",work,lambda _:(self.status.set("Portable vault verified. Encrypted transfers are ready."),self.drain_queue()))
    def export_vault(self):
        from tkinter import filedialog,simpledialog
        if self.busy:return
        password=simpledialog.askstring("Export vault","Use a passphrase with at least 12 characters",show="•",parent=self.root)
        if password is None:return
        confirmation=simpledialog.askstring("Confirm vault passphrase","Repeat the passphrase",show="•",parent=self.root)
        if password!=confirmation:self.status.set("The passphrases do not match.");return
        path=filedialog.asksaveasfilename(parent=self.root,title="Save encrypted vault",defaultextension=".gdvault",initialfile="GenDragoon-Storage.gdvault")
        if not path:return
        def work():
            data=self.model.export_vault(password)
            # The save picker supplies explicit user permission for this export file.
            import os,tempfile
            directory=Path(path).absolute().parent
            fd,temp=tempfile.mkstemp(prefix=".gendragoon-vault-",dir=directory)
            try:
                with os.fdopen(fd,"wb") as output:output.write(data);output.flush();os.fsync(output.fileno())
                os.replace(temp,path);self.model.vault_exported=True
            finally:Path(temp).unlink(missing_ok=True)
        self.run("Encrypting the portable vault…",work,lambda _:self.status.set("Encrypted vault exported. Keep its passphrase separately."))
    def initialize_vault(self):
        from tkinter import messagebox
        if self.busy:return
        if self.mounts.has_mounts:self.status.set("Unmount every workspace drive before initializing storage keys.");return
        if not messagebox.askyesno("Initialize empty storage?","This is for a new, empty account. Existing encrypted storage requires the vault from its original device. Export your new vault before uploading.",parent=self.root):return
        self.run("Verifying the account is empty before creating keys…",self.model.initialize_empty_vault,lambda _:self.export_vault())
    def username(self):
        from tkinter import simpledialog
        if self.busy:return
        name=simpledialog.askstring("Teams username","3–32 characters: a letter first, then letters, numbers, underscore, dot, or hyphen.",parent=self.root)
        if name:self.run("Saving your Teams username…",lambda:self.model.team_request("/v1/receivers/me/dev-profile","PUT",{"username":name}))
    def refresh_teams(self):
        self.team_values=[];self.team_cursor=None
        self.run("Loading your Teams…",lambda:self.model.teams(),self.display_teams)
    def more_teams(self):
        if self.team_cursor:self.run("Loading more Teams…",lambda:self.model.teams(self.team_cursor),self.display_teams)
    def display_teams(self,value):
        for team in value.get("teams",[]):
            if team["id"] not in {t["id"] for t in self.team_values}:self.team_values.append(team)
        self.team_cursor=value.get("nextCursor");self.team_list["values"]=[t["name"]+" · "+t["role"] for t in self.team_values]
        if self.team_values:self.team_list.current(0);self.team=self.team_values[0]["id"];self.refresh_chat()
    def team_changed(self,_=None):
        if self.busy:return
        index=self.team_list.current()
        if index>=0:self.team=self.team_values[index]["id"];self.refresh_chat()
    def create_team(self):
        from tkinter import simpledialog
        if self.busy or not self.model.selected_note:return
        name=simpledialog.askstring("Create MachineNote team","Team display name",parent=self.root)
        if name:self.run("Creating this MachineNote's team…",lambda:self.model.team_request("/v1/receivers/me/workspaces/"+self.model.selected_note+"/team","POST",{"name":name}),lambda _:self.refresh_teams())
    def join_team(self):
        from tkinter import simpledialog
        if self.busy:return
        token=simpledialog.askstring("Join team","Paste the single-use invitation",show="•",parent=self.root)
        if token:self.run("Accepting the team invitation…",lambda:self.model.team_request("/v1/receivers/teams/join","POST",{"token":token}),lambda _:self.refresh_teams())
    def invite(self):
        from tkinter import simpledialog
        if self.busy or not self.team:return
        def show(value):
            simpledialog.askstring("Single-use invitation","Share this invitation with the intended teammate. It expires in 72 hours.",initialvalue=value["token"],parent=self.root)
        self.run("Creating a single-use invitation…",lambda:self.model.team_request("/v1/receivers/teams/"+self.team+"/invites","POST",{"expiresInHours":72}),show)
    def members(self):
        from tkinter import messagebox
        if self.busy or not self.team:return
        def work():
            rows=[];cursor=None;seen=set()
            for _ in range(200):
                path="/v1/receivers/teams/"+self.team+"/members"+("?cursor="+self.model._cursor(cursor) if cursor else "")
                value=self.model.team_request(path);rows.extend(value.get("members",[]));cursor=value.get("nextCursor")
                if not cursor:return rows
                if cursor in seen:raise SessionError("The member page cursor repeated.")
                seen.add(cursor)
            raise SessionError("The member list is too large for one desktop dialog.")
        self.run("Loading team members…",work,lambda rows:messagebox.showinfo("Team members","\n".join(str(r.get("username") or "Username not set")+" · "+str(r["role"]) for r in rows),parent=self.root))
    def refresh_chat(self):
        if self.busy or not self.team:return
        self.chat_cursor=None;self.chat.configure(state="normal");self.chat.delete("1.0","end");self.chat.configure(state="disabled")
        self.more_chat(first=True)
    def more_chat(self,first=False):
        if self.busy or not self.team or not first and not self.chat_cursor:return
        cursor=self.chat_cursor
        path="/v1/receivers/teams/"+self.team+"/messages"+("?cursor="+self.model._cursor(cursor) if cursor else "")
        self.run("Loading team chat…",lambda:self.model.team_request(path),self.display_chat)
    def display_chat(self,value):
        self.chat_cursor=value.get("nextCursor");self.chat.configure(state="normal")
        for item in value.get("messages",[]):self.chat.insert("end",str(item.get("username") or "Teammate")+": "+("[removed]" if item.get("deleted") else str(item.get("text", "")))+"\n")
        self.chat.configure(state="disabled");self.chat.see("end")
    def send(self):
        if self.busy or not self.team:return
        text=self.message.get()
        if not text:return
        value={"text":text,"messageId":uuid.uuid4().hex}
        self.run("Sending team message…",lambda:self.model.team_request("/v1/receivers/teams/"+self.team+"/messages","POST",value),lambda _:(self.message.delete(0,"end"),self.refresh_chat()))
    def companion_dispatch(self,request,done):
        """Thread-safe hook for the separately permissioned native companion server.

        No account token is returned. Upload requests always show a native
        confirmation and freeze the explicit workspace/folder selection.
        """
        def dispatch():
            from tkinter import messagebox
            def reject(code="request_rejected"):
                done({"ok":False,"error":{"code":code,"message":"Check the native GenDragoon window and retry the permitted action."}})
            try:
                import re,time,hashlib
                method=request.get("method");params=request.get("params",{})
                if method=="status":return done({"connected":bool(self.model.session.receiver),"version":"0.22.0"})
                if not self.model.session.receiver:return reject("connect_required")
                client=request.get("_clientId");label=request.get("_clientLabel");kind=request.get("_clientKind")
                if not isinstance(client,str) or not isinstance(label,str) or kind not in ("browser","vscode"):
                    raise ValueError("An authenticated companion client is required.")
                grant=(self.model.session.receiver,client)
                if grant not in self.companion_grants:
                    if not messagebox.askyesno("Allow desktop companion?","Allow "+label[:120]+" to use this account's MachineNotes metadata and Teams in this session? File uploads still require a native picker or confirmation. Account credentials and storage keys stay in GenDragoon.",parent=self.root):
                        return reject("approval_required")
                    self.companion_grants.add(grant)
                identifier=request.get("id")
                if not isinstance(params,dict) or not isinstance(identifier,str) or not re.fullmatch(r"[a-f0-9]{32}",identifier):raise ValueError("Invalid companion request.")
                cache_key=(self.model.session.receiver,client,identifier)
                fingerprint=hashlib.sha256(json.dumps({"method":method,"params":params},sort_keys=True,separators=(",",":")).encode()).hexdigest()
                self.companion_completed={k:v for k,v in self.companion_completed.items() if time.monotonic()-v[0]<600}
                prior=self.companion_completed.get(cache_key)
                if prior:
                    if prior[1]!=fingerprint:return reject("request_conflict")
                    return done(prior[2])
                def respond(value):
                    if len(self.companion_completed)>=64:self.companion_completed.pop(next(iter(self.companion_completed)))
                    self.companion_completed[cache_key]=(time.monotonic(),fingerprint,value)
                    done(value)
                if method=="request":
                    path=params.get("path");verb=params.get("method","GET");body=params.get("body")
                    if not isinstance(path,str) or not isinstance(verb,str):raise ValueError("Invalid request.")
                    if path=="/v1/receivers/me" and verb=="GET":
                        def inventory():
                            self.model.refresh_notes()
                            notes=[{k:n[k] for k in ("id","name","active","readOnly","workers","quotaBytes","usedBytes") if k in n} for n in self.model.notes]
                            return {"id":self.model.session.receiver,"state":"ready","workspaces":notes,"machineNotes":notes}
                        return self.run("Refreshing browser workspace metadata…",inventory,respond,lambda _:reject("request_failed"))
                    library_route=re.fullmatch(r"/v1/receivers/me/workspaces/([a-f0-9]{32})/library",path)
                    if library_route and verb=="GET" and library_route[1] in {n["id"] for n in self.model.notes}:
                        return self.run("Loading browser library metadata…",lambda:self.model.session.request(path),respond,lambda _:reject("request_failed"))
                    team_route=re.fullmatch(r"/v1/receivers/(?:me/dev-(?:profile|teams)|me/workspaces/[a-f0-9]{32}/team|teams/(?:join|[a-f0-9]{32}(?:/(?:members|invites|messages|presence|signals|membership)(?:/[a-f0-9]{32})?)?))(?:\?(?:limit=[0-9]{1,2}&)?cursor=[A-Za-z0-9_-]{1,300})?",path)
                    if not team_route or verb not in ("GET","POST","PUT","DELETE","PATCH"):raise ValueError("Unsupported companion service request.")
                    return self.run("Processing the authenticated Teams request…",lambda:self.model.team_request(path,verb,body),respond,lambda _:reject("request_failed"))
                if method not in ("selectUpload","uploadSelection","enqueue-selection"):raise ValueError("Unsupported desktop companion action.")
                if self.busy:raise ValueError("The desktop is busy.")
                note=params.get("workspaceId");parent=params.get("parentKey")
                if method=="selectUpload":
                    from tkinter import filedialog
                    if params.get("kind")=="folder":
                        chosen=filedialog.askdirectory(parent=self.root,title="Upload selected folder · original retained");paths=[chosen] if chosen else []
                    elif params.get("kind")=="file":paths=list(filedialog.askopenfilenames(parent=self.root,title="Upload selected files · originals retained"))
                    else:raise ValueError("Choose files or a folder.")
                    if not paths:return reject("user_cancelled")
                else:
                    if kind!="vscode":raise ValueError("Use the native picker for browser uploads.")
                    paths=params.get("selectedPaths",params.get("paths"))
                    if not isinstance(paths,list) or not messagebox.askyesno("Upload editor selection?","Queue "+str(len(paths))+" selected local items? Originals are retained.",parent=self.root):return reject("user_cancelled")
                job=self.model.enqueue_selection(note,parent,[str(Path(p).absolute()) for p in paths])
                respond({"queued":True,"jobId":job["id"],"sourceCount":len(job["sources"]),"workspaceId":note})
                self.drain_queue()
            except Exception:reject()
        self.messages.put(dispatch)
    def close(self):
        from tkinter import messagebox
        if self.busy:
            messagebox.showwarning("Operation active","Wait for the transfer or account operation to finish. Active writers are not terminated.",parent=self.root);return
        if self.mounts.has_mounts:
            messagebox.showwarning("Workspace drives active","Unmount every workspace drive before quitting. Mounted, orphaned, or uncertain drives keep this account session protected.",parent=self.root);return
        if self.model.keys and not self.model.vault_exported:
            messagebox.showwarning("Export your vault","Export your new vault before quitting, so its storage key is not lost.",parent=self.root);return
        if self.companion:self.companion.close()
        self.model.session.logout();self.executor.shutdown(wait=False);self.instance.close();self.root.destroy()

def check_gui():
    """Exercise bundled Tk and local IPC with a disposable, signed-out profile."""
    import os
    import tempfile
    import tkinter as tk
    with tempfile.TemporaryDirectory(prefix="gd-gui-check-") as temporary:
        directory=Path(temporary).resolve()
        variables={"XDG_DATA_HOME":str(directory/"data"),"XDG_STATE_HOME":str(directory/"state"),"LOCALAPPDATA":str(directory/"local")}
        previous={key:os.environ.get(key) for key in variables}
        os.environ.update(variables)
        root=None;app=None
        try:
            root=tk.Tk();root.withdraw()
            app=GenDragoonGUI(root,companion_directory=directory/"ipc")
            root.update_idletasks();root.update()
            if ([app.tabs.tab(tab,"text") for tab in app.tabs.tabs()]!=["Files","Teams","Storage keys"]
                    or app.companion is None or app.model.session.receiver is not None
                    or app.model.keys is not None or app.tree.get_children()):
                raise RuntimeError("The packaged desktop window or private companion could not start.")
        finally:
            try:
                if app is not None:app.close()
                elif root is not None:root.destroy()
            finally:
                for key,value in previous.items():
                    if value is None:os.environ.pop(key,None)
                    else:os.environ[key]=value

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check",action="store_true",help="Check the GUI and encryption runtime without signing in or opening a window")
    parser.add_argument("--check-gui",action="store_true",help="Construct and close the actual window and private companion using a disposable signed-out profile")
    parser.add_argument("--check-idle",action="store_true",help="Refuse installation while this user's desktop coordinator is active")
    arguments=parser.parse_args(argv)
    import tkinter as tk
    if arguments.check_gui:
        check_gui();return
    if arguments.check_idle:
        instance=DesktopInstance();instance.close();return
    if arguments.check:
        from machinenotes_client import crypto_runtime
        import tempfile
        import private_fs as private
        rsx=crypto_runtime()
        if rsx.abi_version()!=2:raise RuntimeError("The native codec ABI is unsupported.")
        from redsecretsxai import encode_image,decode_image
        probe=b"GenDragoon public runtime check"*32
        with tempfile.TemporaryDirectory(prefix="gd-runtime-測試-📦-") as temporary:
            directory=private.private_directory(Path(temporary).resolve()/"codec")
            source=directory/"plain-測試-📦";encrypted=directory/"encrypted";restored=directory/"restored"
            private.write_private(source,probe)
            with rsx.session_open("GenDragoon public disposable runtime check",str(directory/"fixture.keymap")) as session:
                rsx.encrypt_file(session,str(source),out_path=str(encrypted),aad=b"gendragoon.desktop.runtime-check/v1")
                ciphertext=encrypted.read_bytes()
                decoded=decode_image(encode_image(ciphertext,module=3,bits=3,noise=0,deterministic=True))
                if decoded!=ciphertext:raise RuntimeError("The packaged visual codec check failed.")
                encrypted.write_bytes(decoded)
                rsx.decrypt_file(session,str(encrypted),out_path=str(restored),aad=b"gendragoon.desktop.runtime-check/v1")
            if restored.read_bytes()!=probe:raise RuntimeError("The native Unicode-path encrypted roundtrip failed.")
            private.protect_generated_tree(directory)
        print(json.dumps({"ok":True,"protocol":"MachineNotes-v1","gui":"tkinter","encryptedTransfer":True,"accountTokens":"memory-only","teams":"server-relay"}))
        return
    root=tk.Tk();GenDragoonGUI(root);root.mainloop()

if __name__=="__main__":main()
