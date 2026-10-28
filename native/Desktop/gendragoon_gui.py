#!/usr/bin/env python3
"""Windows/Linux GenDragoon desktop Files and Teams client for current MachineNotes."""
import argparse
import concurrent.futures
import json
import os
import time
from pathlib import Path
import queue
import sys
import uuid
import webbrowser
from workspace_mount import WorkspaceMountManager,MountError
from mount_platform import PlatformMountError

sys.dont_write_bytecode=True
from redx_session import RedXSession, IntegrationSession, SessionError
from machinenotes_client import MachineNotesClient, DesktopInstance, storage, team_route_allowed
from portable_vault import VaultError, ENVELOPE_LIMIT
from portable_apps import PortableAppError, broker as portable_broker
from app_platform import capabilities as app_capabilities, playable, public_sessions
from desktop_transfer_ui import destination,validate_sources,directory_page,TransferPresentation,format_bytes,format_eta,filter_library,source_key,source_label,PLATFORM_LABELS
from gendragoon_device_origin import application_platform
from desktop_drop import create_root,bind_file_drop
from gui_onboarding import build_home, build_account, drive_selection, update_navigation

class MixedSourcePicker:
    """One lazy PC tree; its sole Upload action queues the mixed selection."""
    def __init__(self,app,context,accepted,*,roots=None,lister=directory_page,initial_paths=None):
        self.app=app;self.context=dict(context);self.accepted=accepted;self.lister=lister
        self.window=app.tk.Toplevel(app.root);self.window.title("Select files, folders and application backups")
        self.window.geometry("850x620");self.window.minsize(650,420);self.window.transient(app.root)
        self.after=None;self.closed=False;self.nodes={};self.sequence=0;self.loading_count=0;self.results=queue.Queue();self.executor=concurrent.futures.ThreadPoolExecutor(max_workers=1,thread_name_prefix="gendragoon-picker")
        self.status=app.tk.StringVar(value="Select files and folders together with Ctrl/Shift. Expand folders to browse; originals are retained.")
        app.ttk.Label(self.window,text="Upload to "+context['noteName']+" / "+context['folderName'],wraplength=800,padding=10).pack(fill="x")
        app.ttk.Label(self.window,text="Application files or folders are backups here. Managed app launch and original offload are not enabled.",wraplength=800,padding=6).pack(fill="x")
        frame=app.ttk.Frame(self.window);frame.pack(fill="both",expand=True,padx=10)
        self.tree=app.ttk.Treeview(frame,columns=("kind",),selectmode="extended");self.tree.heading("#0",text="This PC · local files and folders");self.tree.heading("kind",text="Type");self.tree.column("#0",width=600);self.tree.column("kind",width=160)
        scroll=app.ttk.Scrollbar(frame,orient="vertical",command=self.tree.yview);self.tree.configure(yscrollcommand=scroll.set);scroll.pack(side="right",fill="y");self.tree.pack(fill="both",expand=True)
        self.file_drop=bind_file_drop(self.tree,self.stage_paths,self.status.set)
        self.tree.bind("<<TreeviewOpen>>",self.expand);self.tree.bind("<Double-1>",self.activate);self.tree.bind("<Return>",self.activate);self.tree.bind("<<TreeviewSelect>>",self.selection_changed)
        app.ttk.Label(self.window,textvariable=self.status,wraplength=800,padding=10).pack(fill="x")
        buttons=app.ttk.Frame(self.window,padding=10);buttons.pack(fill="x")
        app.ttk.Button(buttons,text="Cancel",command=self.close).pack(side="right",padx=5)
        self.upload_button=app.ttk.Button(buttons,text="Upload selected",command=self.accept);self.upload_button.pack(side="right")
        if roots is None:
            roots=[("Home",Path.home())]
            roots.extend((str(p),Path(p)) for p in (os.listdrives() if os.name=="nt" and hasattr(os,"listdrives") else [Path.home().anchor or "/"]))
        seen=set()
        for label,path in roots:
            value=str(Path(path).absolute())
            if value in seen:continue
            seen.add(value);self.insert("",{'path':value,'name':label,'label':'Folder','kind':'folder','selectable':True,'expandable':True})
        if initial_paths:
            try:self.stage_paths(initial_paths)
            except Exception:self.close();raise
        self.window.protocol("WM_DELETE_WINDOW",self.close);self.after=self.window.after(50,self.pump)
        self.window.grab_set()
    def stage_paths(self,paths):
        selected=list(self.tree.selection())
        for value in validate_sources(paths):
            key=next((k for k,n in self.nodes.items() if n.get('path')==value and n.get('selectable')),None)
            if key is None:
                path=Path(value);is_folder=path.is_dir()
                key=self.insert('',{'path':value,'name':path.name or str(path),'label':'Folder' if is_folder else 'File / app backup','kind':'folder' if is_folder else 'file','selectable':True,'expandable':is_folder})
            if key not in selected:selected.append(key)
        self.tree.selection_set(selected);self.selection_changed()
    def insert(self,parent,value):
        self.sequence+=1;key="local-"+str(self.sequence);self.nodes[key]=dict(value)
        self.tree.insert(parent,"end",iid=key,text=value['name'],values=(value.get('label',''),))
        if value.get('expandable'):self.tree.insert(key,"end",text="Expand to load…")
        return key
    def expand(self,_=None):
        key=self.tree.focus();node=self.nodes.get(key,{})
        if node.get('expandable') and not node.get('loaded') and not node.get('loading'):self.load(key,0)
    def activate(self,_=None):
        key=self.tree.focus();node=self.nodes.get(key,{})
        if node.get('more'):self.load(node['parent'],node['offset'],more_key=key);return "break"
        self.expand()
    def load(self,key,offset,more_key=None):
        node=self.nodes[key]
        if node.get('loading'):return
        if self.loading_count>=8:self.status.set('Wait for the current directory pages to finish.');return
        self.loading_count+=1;node['loading']=True;self.status.set("Reading one directory page…")
        future=self.executor.submit(self.lister,node['path'],offset)
        future.add_done_callback(lambda f:self.results.put((key,more_key,f)))
    def pump(self):
        if self.closed:return
        while True:
            try:key,more_key,future=self.results.get_nowait()
            except queue.Empty:break
            node=self.nodes[key];node['loading']=False;self.loading_count-=1
            try:
                page=future.result()
                if more_key:self.tree.delete(more_key);self.nodes.pop(more_key,None)
                elif not node.get('loaded'):
                    for child in self.tree.get_children(key):self.tree.delete(child)
                for item in page['entries']:self.insert(key,item)
                if page['nextOffset'] is not None:self.insert(key,{'name':'Load more… (double-click)','label':'More entries','more':True,'parent':key,'offset':page['nextOffset']})
                node['loaded']=True;self.tree.item(key,open=True);self.selection_changed()
            except (OSError,ValueError) as error:self.status.set("This folder could not be listed. Choose another folder. "+str(error)[:160])
        self.after=self.window.after(50,self.pump)
    def selection_changed(self,_=None):
        values=[self.nodes.get(k,{}) for k in self.tree.selection()]
        count=sum(bool(v.get('selectable')) for v in values)
        self.status.set(str(count)+" selected source(s). Expand folders or Ctrl/Shift-select files and folders, then Upload selected.")
    def accept(self):
        from tkinter import messagebox
        try:
            nodes=[self.nodes.get(k,{}) for k in self.tree.selection()]
            if not nodes or any(not n.get('selectable') for n in nodes):raise ValueError("Select real files or folders; unsupported links and Load more rows cannot be uploaded.")
            paths=validate_sources([n['path'] for n in nodes]);self.accepted(self.context,paths)
        except Exception as error:messagebox.showerror("Selection could not be queued",self.app._error(error),parent=self.window);return
        self.close()
    def close(self):
        if self.closed:return
        self.closed=True
        if self.after is not None:self.window.after_cancel(self.after)
        self.executor.shutdown(wait=False,cancel_futures=True)
        try:self.window.grab_release()
        except self.app.tk.TclError:pass
        self.window.destroy()

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
        self.visible_items={};self.visible_note=None;self.source_picker=None;self.active_job=None;self.transfer_presentations={};self.transfer_rows={};self.last_transfer=None;self.next_jobs_refresh=0;self.operation_job=None
        self.companion_grants=set();self.companion=None;self.companion_completed={}
        self.portable_lease_id=None;self.portable_lease_state=None;self.app_sessions=[]
        root.title("GenDragoon · MachineNotes");root.geometry("1060x760");root.minsize(800,600)
        self.status=tk.StringVar(value="Connect Red-XAI to browse your MachineNotes.")
        header=ttk.Frame(root,padding=12);header.pack(fill="x")
        ttk.Label(header,text="GenDragoon",font=("TkDefaultFont",19,"bold")).pack(side="left")
        ttk.Button(header,text="Connect Red-XAI…",command=self.login).pack(side="right",padx=3)
        ttk.Button(header,text="Integration key…",command=self.integration_login).pack(side="right",padx=3)
        ttk.Button(header,text="Disconnect",command=self.disconnect).pack(side="right",padx=3)
        self.tabs=ttk.Notebook(root);self.tabs.pack(fill="both",expand=True,padx=12)
        self.home=ttk.Frame(self.tabs,padding=16);self.account=ttk.Frame(self.tabs,padding=16)
        self.files=ttk.Frame(self.tabs,padding=10);self.teams=ttk.Frame(self.tabs,padding=10);self.settings=ttk.Frame(self.tabs,padding=10)
        for name,panel in (("Home",self.home),("Files",self.files),("Teams",self.teams),("Storage keys",self.settings),("Account",self.account)):
            self.tabs.add(panel,text=name)
        build_home(self);self._files();self._teams();self._settings();build_account(self);self._transfers()
        update_navigation(self, [])
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
        self.update_transfer_progress()
        if time.monotonic()>=self.next_jobs_refresh:
            self.next_jobs_refresh=time.monotonic()+.75;self.refresh_jobs();self.refresh_portable_status()
        self.root.after(40,self.pump)
    def _error(self,error):
        if isinstance(error,(SessionError,VaultError,storage.RedXStorageError,ValueError,MountError,PlatformMountError)):
            return str(error)[:600]
        return "The operation could not finish. Your originals and existing keys were preserved."
    def run(self,label,work,done=None,failed=None,*,transfer_job=None):
        if self.busy:
            self.status.set("Wait for the current operation to finish.")
            if failed:failed(SessionError("Another desktop operation is active.",409))
            return
        self.busy=True;self.model.progress=None;self.status.set(label)
        if self.active_job is None:self.operation_progress=TransferPresentation();self.operation_job=transfer_job
        future=self.executor.submit(work)
        def finished():
            self.busy=False
            try:
                value=future.result()
                self.status.set("Ready. Originals are retained after uploads.")
                if self.active_job is None:self.finish_transfer(True)
                if done:done(value)
            except Exception as error:
                self.status.set(self._error(error))
                if self.active_job is None:self.finish_transfer(False)
                if failed:failed(error)
        future.add_done_callback(lambda _:self.messages.put(finished))
    def _files(self):
        from tkinter import ttk
        bar=ttk.Frame(self.files);bar.pack(fill="x")
        self.note=ttk.Combobox(bar,state="readonly");self.note.pack(side="left",fill="x",expand=True)
        self.note.bind("<<ComboboxSelected>>",self.note_changed)
        ttk.Button(bar,text="Refresh",command=self.refresh).pack(side="left",padx=4)
        filters=ttk.Frame(self.files);filters.pack(fill="x",pady=4)
        ttk.Label(filters,text="Artifact OS hint").pack(side="left")
        self.artifact_choice=ttk.Combobox(filters,state="readonly",values=('All items','Documents / folders','macOS','Windows','Linux','Android','iOS'),width=21);self.artifact_choice.current(0);self.artifact_choice.pack(side="left",padx=4)
        ttk.Label(filters,text="Uploaded from").pack(side="left",padx=(12,0))
        self.source_choice=ttk.Combobox(filters,state="readonly",values=('All source devices',),width=45);self.source_choice.current(0);self.source_choice.pack(side="left",fill="x",expand=True)
        self.source_choices={'All source devices':'all'}
        for chooser in (self.artifact_choice,self.source_choice):chooser.bind('<<ComboboxSelected>>',lambda _:self.display_tree(refresh_snapshot=False))
        toolbar=ttk.Frame(self.files);toolbar.pack(fill="x",pady=8)
        for title,command in (("New folder",self.new_folder),("Upload selected…",self.upload),("Transfers…",self.show_transfers),("Download…",self.download),("Play / Stop app",self.toggle_app),("Rename",self.rename),("Delete",self.delete)):
            ttk.Button(toolbar,text=title,command=command).pack(side="left",padx=2)
        protection=ttk.Frame(self.files);protection.pack(fill="x",pady=6)
        ttk.Label(protection,text="Upload protection").pack(side="left")
        self.upload_mode=self.tk.StringVar(value="Standard encrypted")
        ttk.Combobox(protection,textvariable=self.upload_mode,state="readonly",width=27,
                     values=("Standard encrypted","Fast encrypted","Off — not encrypted")).pack(side="left",padx=8)
        ttk.Label(protection,text="Fast retains encryption; Off exposes stored contents.").pack(side="left")
        self.upload_offload=self.tk.BooleanVar(value=False)
        ttk.Checkbutton(self.files,text="Move selected originals to OS Trash only after full cloud readback and restore verification",variable=self.upload_offload).pack(anchor="w",pady=5)
        self.tree=ttk.Treeview(self.files,columns=("kind","source","bytes","action"),selectmode="extended")
        self.tree.heading("#0",text="Name");self.tree.heading("kind",text="Type / artifact OS hint");self.tree.heading("source",text="Uploaded from (client reported)");self.tree.heading("bytes",text="Archive bytes")
        self.tree.column("#0",width=330);self.tree.column("kind",width=230);self.tree.column("source",width=270);self.tree.column("bytes",width=120,anchor="e")
        self.tree.heading("action",text="App control");self.tree.column("action",width=95,anchor="center")
        self.tree.bind("<ButtonRelease-1>",self.app_cell,add=True)
        self.tree.pack(fill="both",expand=True)
        self.progress_text=self.tk.StringVar(value="No transfer running. Originals are retained.")
        self.progress_bar=ttk.Progressbar(self.files,maximum=100,mode="determinate");self.progress_bar.pack(fill="x",pady=(5,0))
        ttk.Label(self.files,textvariable=self.progress_text,wraplength=980).pack(fill="x")
        self.file_drop=bind_file_drop(self.tree,self.review_dropped_sources,self.status.set)
        self.tree.bind("<Button-3>",self.context);self.tree.bind("<Control-c>",lambda _:self.copy(False));self.tree.bind("<Control-x>",lambda _:self.copy(True));self.tree.bind("<Control-v>",lambda _:self.paste())
        self.tree.bind("<ButtonPress-1>",self.drag_start,add=True);self.tree.bind("<ButtonRelease-1>",self.drag_end,add=True)
        ttk.Label(self.files,text="Folders organize archive items. Folder backups keep their archived contents together. Uploads retain your originals; library deletion retains encrypted payload bytes and does not reclaim quota.",wraplength=980).pack(fill="x",pady=8)
        drives=ttk.LabelFrame(self.files,text="Read-only workspace drives",padding=6);drives.pack(fill="x")
        actions=ttk.Frame(drives);actions.pack(fill="x")
        for title,command in (("Mount selected MachineNote",self.mount_drive),("Open drive",self.open_drive),("Unmount selected drive",self.unmount_drive),("Choose mount helper…",self.choose_rclone)):
            ttk.Button(actions,text=title,command=command).pack(side="left",padx=3)
        self.drive_list=ttk.Treeview(drives,columns=("state","path"),height=3,selectmode="browse")
        self.drive_list.heading("#0",text="MachineNote");self.drive_list.heading("state",text="Status");self.drive_list.heading("path",text="Actual mount path")
        self.drive_list.column("#0",width=240);self.drive_list.column("state",width=120);self.drive_list.column("path",width=550);self.drive_list.pack(fill="x",pady=5)
        ttk.Label(drives,text="Windows requires the separately distributed open-source GenDragoon Mount Host and existing WinFsp; Linux requires existing rclone and FUSE. Files are verified in a private local cache before reading; opening a folder backup can restore its complete archive. Make changes in GenDragoon. Unmount every drive before disconnecting, changing accounts, or quitting because the OS may cache file data.",wraplength=980).pack(fill="x")
        self.refresh_drives()
    def clear_transfer_view(self):
        self.artifact_choice.current(0);self.source_choice["values"]=("All source devices",);self.source_choice.current(0);self.source_choices={"All source devices":"all"}
        self.visible_items={};self.visible_note=None;self.active_job=None;self.transfer_presentations.clear();self.transfer_rows.clear();self.last_transfer=None
        self.tree.delete(*self.tree.get_children());self.jobs_tree.delete(*self.jobs_tree.get_children())
        self.progress_bar['value']=0;self.transfer_bar['value']=0;self.progress_text.set("No transfer running. Originals are retained.");self.transfer_detail.set("No transfer running.")
    def _transfers(self):
        self.transfers_window=self.tk.Toplevel(self.root);self.transfers_window.title("GenDragoon transfers")
        self.transfers_window.geometry("1000x500");self.transfers_window.protocol("WM_DELETE_WINDOW",self.hide_transfers)
        self.transfers_window.withdraw()
        self.ttk.Label(self.transfers_window,text="Most recent 200 jobs. Uploads finish only after encrypted cloud readback and verification. Closing this panel keeps work running.",wraplength=950,padding=10).pack(fill="x")
        self.transfer_detail=self.tk.StringVar(value="No transfer running.")
        self.transfer_bar=self.ttk.Progressbar(self.transfers_window,maximum=100,mode="determinate");self.transfer_bar.pack(fill="x",padx=10)
        self.ttk.Label(self.transfers_window,textvariable=self.transfer_detail,wraplength=950,padding=10).pack(fill="x")
        self.jobs_tree=self.ttk.Treeview(self.transfers_window,columns=("note","sources","state","progress"),selectmode="browse")
        for column,label,width in (("#0","Selection",220),("note","MachineNote",220),("sources","Verified sources",110),("state","State",180),("progress","Overall estimate",130)):
            self.jobs_tree.heading(column,text=label);self.jobs_tree.column(column,width=width)
        self.jobs_tree.pack(fill="both",expand=True,padx=10)
        actions=self.ttk.Frame(self.transfers_window,padding=10);actions.pack(fill="x")
        for label,command in (("Resume queued / retry failed",self.resume_queue),("Hide transfers",self.hide_transfers),("Minimize · keep running",self.minimize_background)):
            self.ttk.Button(actions,text=label,command=command).pack(side="left",padx=4)
        self.ttk.Label(self.transfers_window,text="Queued jobs keep their original account and destination. Quit still waits for active transfers and mounted drives; hiding or minimizing never stops a writer.",wraplength=950,padding=10).pack(fill="x")
    def show_transfers(self):
        self.transfers_window.deiconify();self.transfers_window.lift();self.refresh_jobs()
    def hide_transfers(self):self.transfers_window.withdraw()
    def minimize_background(self):self.hide_transfers();self.root.iconify()
    def refresh_jobs(self):
        try:jobs=self.model.jobs()
        except Exception as error:self.status.set(self._error(error));return
        self.transfer_rows={j['id']:j for j in jobs}
        visible=list(reversed(jobs))[:200]
        retained={j['id'] for j in visible}|({self.active_job} if self.active_job else set());self.transfer_presentations={k:v for k,v in self.transfer_presentations.items() if k in retained}
        existing=set(self.jobs_tree.get_children());notes={n['id']:n.get('name','MachineNote') for n in self.model.notes}
        for index,job in enumerate(visible):
            key=job['id'];state=job['state'];completed=len(job.get('completedSources') or []);count=len(job['sources'])
            if state=='running' and key!=self.active_job:state='Interrupted · resume required'
            percent=100 if job['state']=='completed' else self.transfer_presentations.get(key).percent if key in self.transfer_presentations else min(99,100*completed/max(1,count))
            values=(notes.get(job['workspaceId'],job['workspaceId'][:8]),f'{completed} / {count}',state,f'{percent:.1f}%')
            title=Path(job['sources'][0]).name or 'Root folder'
            if count>1:title+=f' (+{count-1})'
            if key in existing:self.jobs_tree.item(key,text=title,values=values);existing.remove(key)
            else:self.jobs_tree.insert('', 'end',iid=key,text=title,values=values)
            self.jobs_tree.move(key,'',index)
        for key in existing:self.jobs_tree.delete(key)
    def update_transfer_progress(self,*,finished=None):
        progress=self.model.progress
        if progress is None:return
        if not self.busy and finished is None:return
        job=self.transfer_rows.get(self.active_job) if self.active_job else None
        if job is None:job=self.operation_job or {'sources':[''],'state':'running','completedSources':[]}
        presenter=self.transfer_presentations.get(self.active_job) if self.active_job else getattr(self,'operation_progress',None)
        if presenter is None:return
        value=presenter.snapshot(job,progress.snapshot(),finished=finished);self.last_transfer=value
        summary=f"{value['percent']:.1f}% overall estimate · source {value['sourceIndex']} / {value['sourceCount']} · {value['phase']}"
        counters=f"Phase work {format_bytes(value['completedBytes'])} / {format_bytes(value['totalBytes']) if value['totalBytes'] else 'measuring'} · source carrier sent {format_bytes(value['uploadedBytes'])} · received {format_bytes(value['downloadedBytes'])}"
        eta=f"Estimated remaining: {format_eta(value['overallETA'])} overall · {format_eta(value['phaseETA'])} current phase"
        if value['objectsTotal']:counters+=f" · carrier chunks {value['objectsDone']} / {value['objectsTotal']}"
        self.progress_bar['value']=value['percent'];self.transfer_bar['value']=value['percent'];self.progress_text.set(summary);self.transfer_detail.set(summary+'\n'+counters+'\n'+eta)
        if self.busy:self.status.set(value['phase']+' · '+counters)
    def finish_transfer(self,success):
        self.refresh_jobs();self.update_transfer_progress(finished=success);self.active_job=None;self.operation_job=None
    def _teams(self):
        from tkinter import ttk
        ttk.Label(self.teams,text="TEAMS SETUP: Create a team or join with an invitation. Team subscriptions may be required; "
                  "each shared MachineNote needs its own storage and performance plan. Personal files remain private unless explicitly shared.",
                  wraplength=940,padding=10).pack(fill="x")
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
        ttk.Label(self.settings,text="Windows/Linux supports portable files and folder archives. Read-only drives need existing GenDragoon Mount Host with WinFsp on Windows, or rclone with FUSE on Linux. Backups containing macOS apps, extended attributes, or symbolic links must be restored on their original platform. Drives do not provide writeback or managed app launch.",wraplength=900).pack(fill="x",pady=12)
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
        self.model.session.logout();self.model=model;self.clear_transfer_view();self.clipboard=None;self.team=None;self.team_values=[];self.companion_grants.clear();self.companion_completed.clear()
        self.team_list["values"]=[];self.team_list.set("");self.display_notes()
        self.refresh_drives();self.tabs.select(self.home)
        if model.selected_note and update_navigation(self):self.refresh_tree()
    def disconnect(self):
        from tkinter import messagebox
        if not self.can_switch():return
        if self.model.keys and not self.model.vault_exported:
            messagebox.showwarning("Export your vault","Export your new vault before disconnecting, so its storage key is not lost.",parent=self.root);return
        self.model.session.logout();self.model=MachineNotesClient();self.clear_transfer_view();self.note["values"]=[];self.note.set("");self.tree.delete(*self.tree.get_children());self.clipboard=None;self.team=None;self.companion_grants.clear();self.status.set("Disconnected. Account credentials are no longer held in this session.")
        self.display_notes();self.refresh_drives();self.tabs.select(self.home)
    def can_switch(self):
        from tkinter import messagebox
        if self.busy:return False
        if self.mounts.has_mounts:
            messagebox.showwarning("Unmount workspace drives","Unmount all drives before disconnecting, changing accounts, or quitting. Retained or uncertain drives also need review; the current session was preserved.",parent=self.root);return False
        try:self.model.portable_apps.assert_safe("disconnect or change accounts")
        except PortableAppError as error:
            messagebox.showwarning("Portable app lease active",str(error),parent=self.root);return False
        if self.model.keys and not self.model.vault_exported:
            messagebox.showwarning("Export your vault","Export your new vault before changing accounts, so its storage key is not lost.",parent=self.root);return False
        return True
    def display_notes(self):
        names=[str(n.get("name") or "MachineNote")+(" · read only" if not n.get("active") or n.get("readOnly") else "") for n in self.model.notes]
        self.note["values"]=names;self.home_note["values"]=names
        for i,n in enumerate(self.model.notes):
            if n["id"]==(self.visible_note if self.busy and self.visible_note else self.model.selected_note):
                self.note.current(i);self.home_note.current(i)
        update_navigation(self)
    def note_changed(self,_=None):
        index=self.note.current()
        if self.busy:self.display_notes();return
        if index>=0:
            self.model.selected_note=self.model.notes[index]["id"];self.visible_note=self.model.selected_note;self.visible_items={};self.tree.delete(*self.tree.get_children());self.model.selected_parent=None;self.refresh_tree()
    def refresh(self):
        self.run("Refreshing owned MachineNotes…",self.model.refresh_notes,lambda _:(self.display_notes(),self.refresh_tree() if self.model.selected_note else None))
    def create_free_workspace(self):
        from tkinter import simpledialog
        if self.busy or not self.model.session.receiver or self.model.session.integration_mode:
            self.status.set("Connect your account before creating a workspace.");return
        name=simpledialog.askstring("Create free workspace","Name your first 2 GB workspace (3–80 characters):",parent=self.root,initialvalue="My Free Cloud")
        if name is None:return
        name=name.strip()
        if not 3<=len(name)<=80:self.status.set("Choose a name with 3–80 characters.");return
        self.run("Creating your free 2 GB workspace…",lambda:self.model.session.request(
            "/gendragoon/v2/machinenotes","POST",{"name":name,"storageTier":"free2GB","performanceTier":"free"}),
            lambda _:self.refresh())
    def refresh_tree(self):self.run("Loading the current library…",self.model.refresh_tree,lambda _:self.display_tree())
    def display_tree(self,*,refresh_snapshot=True):
        if refresh_snapshot:
            self.visible_note=self.model.selected_note;self.visible_items={i['key']:dict(i,applicationPlatform=application_platform(i.get('name'),i.get('kind'),i.get('applicationPlatform'))) for i in self.model.items}
        choice=self.source_choice.get();self.source_choices={'All source devices':'all'}
        for item in self.visible_items.values():
            label=source_label(item);key=source_key(item)
            if label in self.source_choices and self.source_choices[label]!=key:label+=' ['+key+']'
            self.source_choices[label]=key
        self.source_choice['values']=tuple(self.source_choices)
        self.source_choice.set(choice if choice in self.source_choices else 'All source devices')
        artifact={'All items':'all','Documents / folders':'documents',**{v:k for k,v in PLATFORM_LABELS.items() if k!='unknown'}}.get(self.artifact_choice.get(),'all')
        filtered=filter_library(list(self.visible_items.values()),artifact=artifact,source=self.source_choices[self.source_choice.get()])
        self.tree.delete(*self.tree.get_children());pending={i['key']:i for i in filtered};inserted=set()
        while pending:
            progressed=False
            for key,item in list(pending.items()):
                parent=item.get('parentKey')
                if parent is None or parent in inserted:
                    target=item.get('applicationPlatform')
                    kind='Folder' if item.get('virtualFolder') else PLATFORM_LABELS.get(target,'Unknown')+' app/installer backup' if target else 'Folder backup' if item['kind']=='folder' else 'File'
                    self.tree.insert(parent or '', 'end',iid=key,text=item.get('displayName',item['name']),values=(kind,source_label(item),item.get('archiveBytes',0),self.app_label(item)),open=True)
                    inserted.add(key);del pending[key];progressed=True
            if not progressed:self.status.set('The library hierarchy needs review. Refresh before changing it.');break
    def selected(self):return list(self.tree.selection())
    def refresh_drives(self):
        records=self.mounts.refresh()
        for listing in (self.drive_list,self.home_drive_list):
            listing.delete(*listing.get_children())
            for record in records:
                listing.insert("","end",iid=record["id"],text=record.get("name","MachineNote"),values=(record["state"],record["mountPath"]))
        if hasattr(self,"account_summary"):update_navigation(self,records)
        if self.mounts.unknown:self.status.set("The private drive registry needs review. Account switching and Quit remain blocked.")
    def choose_rclone(self):
        from tkinter import filedialog
        if self.busy:return
        label="GenDragoon Mount Host" if sys.platform=="win32" else "rclone"
        chosen=filedialog.askopenfilename(parent=self.root,title="Select an existing trusted "+label+" executable")
        if chosen:self.rclone_path=chosen;self.status.set("Selected "+label+". The executable and filesystem prerequisites will be checked before mounting.")
    def mount_drive(self):
        if self.busy or not self.model.selected_note:return
        model=self.model;note=model.selected_note;binary=self.rclone_path
        self.run("Preparing an authenticated read-only filesystem drive…",lambda:self.mounts.mount(model,note,binary),lambda _:(self.refresh_drives(),self.status.set("Read-only filesystem drive mounted. Unmount every drive before changing accounts or quitting.")),lambda _:self.refresh_drives())
    def unmount_drive(self):
        selected=drive_selection(self)
        if self.busy or len(selected)!=1:return
        key=selected[0]
        self.run("Requesting normal filesystem unmount…",lambda:self.mounts.unmount(key),lambda _:(self.refresh_drives(),self.status.set("The drive was normally unmounted. Its verified private cache was retained.")),lambda _:self.refresh_drives())
    def open_drive(self):
        import os,subprocess
        selected=drive_selection(self)
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
        for title,command in (("New folder",self.new_folder),("Rename",self.rename),("Copy",lambda:self.copy(False)),("Cut / move",lambda:self.copy(True)),("Paste here",self.paste),("Download…",self.download),("Play / Stop app",self.toggle_app),("Delete",self.delete)):
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
    def upload_context(self):
        index=self.note.current()
        if index<0 or index>=len(self.model.notes):raise ValueError("Choose a MachineNote before selecting sources.")
        note=self.model.notes[index];parent=None;folder_name="MachineNote root"
        if note.get('active') is not True or note.get('readOnly'):raise ValueError('This MachineNote is read only. Choose an active writable MachineNote for uploads.')
        selected=self.selected()
        if len(selected)==1:
            item=self.visible_items.get(selected[0])
            if item:
                parent=item['key'] if item.get('virtualFolder') else item.get('parentKey')
                folder_name=self.visible_items.get(parent,{}).get('displayName',self.visible_items.get(parent,{}).get('name','MachineNote root'))
        return destination(self.model.session.receiver,note['id'],parent,note_name=note.get('name','MachineNote'),folder_name=folder_name)
    def queue_sources(self,context,paths):
        if context['receiverId']!=self.model.session.receiver:raise ValueError("The account changed. Select the destination again.")
        paths=validate_sources(paths)
        from tkinter import messagebox
        from verified_offload import running_sources,request_close
        running=running_sources(paths)
        if running:
            if not messagebox.askyesno("Close selected running apps?","Save your work first. GenDragoon must close the selected running apps before uploading them.",parent=self.root):return None
            remaining=request_close(running,approved=True)
            if remaining:
                if not messagebox.askyesno("Force quit selected apps?","Some selected apps did not close. Force quit can discard unsaved changes. Force quit and continue?",parent=self.root):return None
                if request_close(remaining,force=True,approved=True):raise ValueError("A selected app is still running; no upload was queued.")
        offload=self.upload_offload.get()
        if offload and not messagebox.askyesno("Verified offload to Trash?","After full cloud upload and restore verification, move only these selected originals to OS Trash? Other files and cloud backups are unchanged.",parent=self.root):return None
        mode={"Standard encrypted":"standard","Fast encrypted":"fast","Off — not encrypted":"off"}[self.upload_mode.get()]
        if mode=="off":
            from tkinter import messagebox
            if not messagebox.askyesno("Upload without encryption?","Server storage access can reveal these files. Continue without encryption?",parent=self.root):
                return None
        job=self.model.enqueue_selection(context['workspaceId'],context['parentKey'],paths,encryption_mode=mode,offload=offload)
        self.status.set(str(len(paths))+(" source(s) queued for verified offload to Trash." if offload else " source(s) queued. Originals are retained."));self.refresh_jobs();self.show_transfers();self.drain_queue()
        if self.model.keys is None or not self.model.vault_exported:self.status.set("Sources queued. Import or export this account’s portable vault in Storage keys before transfers can start.")
        return job
    def review_dropped_sources(self,paths):
        # Native-drop integration calls this only after its COPY-only path guard.
        # The dialog's explicit Upload selected action remains the only enqueue.
        try:
            paths=validate_sources(paths)
            if self.source_picker is not None and not self.source_picker.closed:
                self.source_picker.stage_paths(paths);self.source_picker.window.lift();return
            self.source_picker=MixedSourcePicker(self,self.upload_context(),self.queue_sources,initial_paths=paths)
        except Exception as error:self.status.set(self._error(error));return False
    def upload(self):
        try:
            if self.source_picker is not None and not self.source_picker.closed:self.source_picker.window.lift();return
            self.source_picker=MixedSourcePicker(self,self.upload_context(),self.queue_sources)
        except Exception as error:self.status.set(self._error(error))
    def drain_queue(self):
        if self.busy or self.model.keys is None or not self.model.vault_exported:return
        try:
            queued=next((j for j in self.model.jobs() if j["state"]=="queued"),None)
            if queued is None:return
            self.active_job=queued["id"];self.transfer_presentations[self.active_job]=TransferPresentation();self.show_transfers()
        except Exception as error:self.status.set(self._error(error));return
        def completed(_):
            self.finish_transfer(True)
            if any(j["state"]=="queued" for j in self.model.jobs()):self.drain_queue()
            else:self.refresh_tree()
        self.run("Encrypting queued files, uploading, and verifying readback…",self.model.run_next_job,completed,lambda _:self.finish_transfer(False))
    def resume_queue(self):
        if self.busy:return
        try:self.model.retry_jobs();self.drain_queue()
        except Exception as error:self.status.set(self._error(error))
    def owned_app_sessions(self,key=None):
        values=public_sessions(self.model.portable_apps.leases(),self.model.session.receiver)
        return [v for v in values if key is None or v["key"]==key and v["workspaceId"]==self.model.selected_note]
    def app_label(self,item):
        running=any(v.get("key")==item.get("key") and v.get("workspaceId")==self.model.selected_note for v in self.app_sessions)
        return "■ Stop" if running else "▶ Play" if playable(item) else ""
    def app_cell(self,event):
        if self.tree.identify_column(event.x)!="#4":return
        key=self.tree.identify_row(event.y)
        if key:self.tree.selection_set(key);self.drag=None;self.toggle_app()
    def toggle_app(self):
        from tkinter import messagebox
        keys=self.selected()
        if self.busy or len(keys)!=1:return
        try:
            sessions=self.owned_app_sessions(keys[0])
            if sessions:
                self.stop_app_keys(keys)
                return
            item=self.visible_items.get(keys[0],{})
            if not playable(item):
                self.status.set("Choose a matching portable Windows/Linux app. Installers must be installed through the operating system.");return
            self.launch_portable()
        except Exception as error:self.status.set(self._error(error))
    def stop_app_keys(self,keys):
        targets=[v for v in self.owned_app_sessions() if v["key"] in keys and v["workspaceId"]==self.model.selected_note]
        if not targets:return
        for target in targets:
            self.model.portable_apps.request_stop(target["id"],approved=True)
        self.status.set("Stop requested. Save any open work in the app. Cloud copies are unchanged.")
        def offer_force():
            from tkinter import messagebox
            try:
                live={v["id"] for v in self.owned_app_sessions()}
                remaining=[v for v in targets if v["id"] in live]
                if remaining and messagebox.askyesno("Force quit cloud app?", "The app is still running. Force quitting discards unsaved changes. Force quit only these selected managed app sessions?",parent=self.root):
                    for value in remaining:self.model.portable_apps.request_stop(value["id"],force=True,approved=True)
                    self.status.set("Force stop requested; waiting for the managed app and its children to exit.")
            except Exception as error:self.status.set(self._error(error))
        self.root.after(4000,offer_force)
    def launch_portable(self):
        selected=self.selected()
        if self.busy or len(selected)!=1:
            self.status.set("Select one portable application archive to prepare.");return
        item=self.visible_items.get(selected[0],{})
        if not playable(item):self.status.set("That app does not match this OS or is an installer, not a portable app.");return
        if self.owned_app_sessions(selected[0]):self.status.set("This app already has a managed session. Use Stop first.");return
        owner=self.model.session.receiver;note=self.model.selected_note
        record=next((r for r in self.mounts.refresh() if r.get("receiverId")==owner and r.get("workspaceId")==note and r.get("state")=="mounted"),None)
        if not record:
            self.status.set("Mount the selected workspace on Home first. No local app copy was downloaded.");return
        self.run("Verifying the application on its Kamatera-backed drive…",lambda:self.model.prepare_portable_app(selected[0],mount_record=record),self.review_portable)
    def review_portable(self,prepared):
        from tkinter import messagebox
        window=self.tk.Toplevel(self.root);window.title("Choose a verified portable executable");window.geometry("720x430");window.transient(self.root)
        self.ttk.Label(window,text="Select the app's executable. Only verified native binaries matching this computer are listed. Choose an application you know is portable; installation packages and scripts are unsupported.",wraplength=670,padding=12).pack(fill="x")
        choices=self.tk.Listbox(window,exportselection=False)
        for relative in prepared.candidates:choices.insert("end",prepared.payload.name if relative=="." else relative)
        choices.pack(fill="both",expand=True,padx=12);approved=self.tk.BooleanVar(value=False)
        self.ttk.Checkbutton(window,text="I recognize this app and confirm it is portable, with no installation required.",variable=approved).pack(anchor="w",padx=12,pady=8)
        self.ttk.Label(window,text="App files are read from the Kamatera-backed mount without a full local copy. Execution uses this computer. Apps and children keep running until stopped.",wraplength=670,padding=12).pack(fill="x")
        def launch():
            selection=choices.curselection()
            if not selection or not approved.get():
                messagebox.showinfo("Choose and approve an app","Select one executable and confirm that you recognize it as a portable app.",parent=window);return
            relative=prepared.candidates[selection[0]]
            if not messagebox.askyesno("Launch selected portable app?","Launch "+(prepared.payload.name if relative=="." else relative)+" with your local permissions? Its files stay on Kamatera and are read through the mounted drive; CPU and memory execution is on this device.",parent=window):return
            others=self.owned_app_sessions()
            stopping=[]
            if others:
                if not messagebox.askyesno("Run multiple cloud apps?", "You have "+str(len(others))+" other managed app session(s). More apps share CPU, memory and cloud bandwidth, reducing performance. Continue?",parent=window):return
                choice=messagebox.askyesnocancel("Close other cloud apps?", "Force quit the other GenDragoon app sessions before playing this app? Yes force-quits them and may lose unsaved work. No keeps them running. Cancel opens nothing.",parent=window)
                if choice is None:return
                if choice:stopping=others
            window.destroy()
            def start():
                for value in stopping:self.model.portable_apps.request_stop(value["id"],force=True,approved=True)
                if stopping:
                    ids={v["id"] for v in stopping};deadline=time.monotonic()+10
                    while any(v["id"] in ids for v in self.owned_app_sessions()):
                        if time.monotonic()>deadline:raise PortableAppError("Other apps have not stopped; the new app was not launched.")
                        time.sleep(.1)
                return self.model.launch_portable_app(prepared,relative,approved=True)
            self.run("Starting the approved portable app…",start,self.portable_launched)
        self.ttk.Button(window,text="Launch selected app",command=launch).pack(side="right",padx=12,pady=10)
        self.ttk.Button(window,text="Keep cache and close",command=window.destroy).pack(side="right",pady=10)
    def portable_launched(self,receipt):
        self.portable_lease_id=receipt['id'];self.portable_lease_state=None;self.show_portable_status(receipt)
    def show_portable_status(self,receipt):
        current=(receipt['state'],receipt.get('mainExitCode'))
        if current==self.portable_lease_state:return
        self.portable_lease_state=current;state,code=current
        if state=='uncertain':message="Portable app process tracking needs review. The app was not stopped; cache, deletion and account changes remain protected."
        elif state=='complete':message="Portable app exited with code "+str(code)+"; every tracked child has exited. Cached copies and originals are retained."
        elif code is not None:message="The selected app exited with code "+str(code)+". Its children are still tracked; cached copies and this account remain protected."
        else:message="Portable app started; its exit outcome is pending. Close the app and every child before changing accounts or deleting library items. Cached copies are retained."
        self.status.set(message)
    def refresh_portable_status(self):
        if self.busy:return
        try:
            all_leases=self.model.portable_apps.leases()
            self.app_sessions=public_sessions(all_leases,self.model.session.receiver)
            for key,item in self.visible_items.items():
                if self.tree.exists(key):self.tree.set(key,"action",self.app_label(item))
            if self.portable_lease_id:
                receipt=next((row for row in all_leases if row.get('id')==self.portable_lease_id),None)
                self.show_portable_status(receipt or dict(state='uncertain'))
        except Exception:self.app_sessions=[]
    def download(self):
        from tkinter import filedialog
        selected=self.selected()
        if self.busy or not selected:return
        try:self.model.check_restore_compatible(selected,items=self.visible_items.values())
        except Exception as error:self.status.set(self._error(error));return
        destination=filedialog.askdirectory(parent=self.root,title="Restore verified copies into this folder")
        if not destination:return
        operation={'sources':list(selected),'completedSources':[],'state':'running'}
        def work():
            results=[]
            for index,key in enumerate(selected):
                results.append(self.model.download(key,Path(destination)));operation['completedSources'].append(index)
            return results
        self.run("Downloading, decrypting, and verifying selected items…",work,transfer_job=operation)
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
                if method=="status":return done({"connected":bool(self.model.session.receiver),"version":"0.22.0","capabilities":app_capabilities()})
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
                if method in ("appSessions","playApp","stopApp"):
                    note=params.get("workspaceId");appkey=params.get("key")
                    if note not in {n["id"] for n in self.model.notes}:return reject("workspace_denied")
                    if method=="appSessions":
                        return done({"sessions":public_sessions(self.model.portable_apps.leases(),self.model.session.receiver,note)})
                    if self.busy or note!=self.model.selected_note:return reject("select_workspace_in_native_app")
                    if not update_navigation(self):return reject("mount_required")
                    if not isinstance(appkey,str) or not re.fullmatch(r"[a-f0-9]{18}",appkey):return reject("request_invalid")
                    if not self.tree.exists(appkey):return reject("refresh_native_library")
                    self.tree.selection_set(appkey)
                    if method=="playApp":
                        if not playable(self.visible_items.get(appkey,{})):return reject("platform_mismatch")
                        if not messagebox.askyesno("Play cloud application?",label[:100]+" requested Play. Restore and review the matching app in GenDragoon?",parent=self.root):return reject("user_cancelled")
                        self.launch_portable()
                        return respond({"requested":True,"reviewRequired":True,"state":"preparing"})
                    if not messagebox.askyesno("Stop cloud application?",label[:100]+" requested Stop for this app. Ask the selected managed session to quit?",parent=self.root):return reject("user_cancelled")
                    self.stop_app_keys([appkey])
                    return respond({"requested":True,"state":"stop-requested"})
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
                    if not team_route_allowed(path) or verb not in ("GET","POST","PUT","DELETE","PATCH"):raise ValueError("Unsupported companion service request.")
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
        if self.source_picker is not None and not self.source_picker.closed:self.source_picker.close()
        self.transfers_window.destroy()
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
            root=create_root();root.withdraw()
            app=GenDragoonGUI(root,companion_directory=directory/"ipc")
            root.update_idletasks();root.update()
            if ([app.tabs.tab(tab,"text") for tab in app.tabs.tabs()]!=["Home","Files","Teams","Storage keys","Account"]
                    or app.tabs.select()!=str(app.home)
                    or any(app.tabs.tab(p,"state")!="disabled" for p in (app.files,app.teams,app.settings))
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
    parser.add_argument("--portable-broker",type=Path,help=argparse.SUPPRESS)
    arguments=parser.parse_args(argv)
    if arguments.portable_broker:raise SystemExit(portable_broker(arguments.portable_broker))
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
    root=create_root();GenDragoonGUI(root);root.mainloop()

if __name__=="__main__":main()
