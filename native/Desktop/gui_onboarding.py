"""Mount-first onboarding for the Windows/Linux GenDragoon desktop."""
from gui_access import selected_mount_ready, workspace_ready
from tkinter import ttk

def build_home(app):
    from gui_theme import TEXT,ACCENT,scroll_page
    tk=app.tk
    body=scroll_page(app.home);app.home_body=body
    hero=tk.Frame(body,bg="#281A49",highlightthickness=1,highlightbackground="#4B3476")
    hero.pack(fill="x",pady=(0,18))
    copy=tk.Frame(hero,bg="#281A49");copy.pack(side="left",fill="both",expand=True,padx=24,pady=20)
    tk.Label(copy,text="YOUR CLOUD. YOUR RULES.",bg="#281A49",fg="#D0B8FF",font=("Consolas",9,"bold")).pack(anchor="w")
    tk.Label(copy,text="A home for everything you create.",bg="#281A49",fg=TEXT,font=("Segoe UI",24,"bold")).pack(anchor="w",pady=(6,4))
    tk.Label(copy,text="Private Kamatera-backed storage, mounted as a real read-only SSD. Cloud files stay remote until you explicitly download them.",
             bg="#281A49",fg="#D8D1E8",font=("Segoe UI",10),wraplength=720,justify="left").pack(anchor="w")
    tk.Label(hero,text="CLOUD",bg="#281A49",fg=ACCENT,font=("Consolas",16,"bold")).pack(side="right",padx=28)
    ttk.Label(body,text="SETUP IN ORDER",style="Kicker.TLabel").pack(anchor="w")
    ttk.Label(body,text="Mount your SSD, then sign this PC",style="Title.TLabel").pack(anchor="w",pady=(4,5))
    ttk.Label(body,text="Home and Account remain available. Files, Teams, and storage controls unlock only after this MachineNote is mounted and the live server confirms this PC is signed.",
              style="Muted.TLabel",wraplength=900).pack(fill="x",pady=(0,14))
    setup=ttk.LabelFrame(body,text="Workspace setup",padding=14);setup.pack(fill="x",pady=(0,14))
    ttk.Label(setup,text="Active MachineNote",style="Panel.TLabel").pack(anchor="w")
    app.home_note=ttk.Combobox(setup,state="readonly");app.home_note.pack(fill="x",pady=(5,10))
    app.home_note.bind("<<ComboboxSelected>>",lambda _:choose_note(app))
    bar=ttk.Frame(setup,style="Panel.TFrame");bar.pack(fill="x")
    ttk.Button(bar,text="Refresh",command=app.refresh).pack(side="left",padx=(0,6))
    app.mount_button=ttk.Button(bar,text="1. Mount SSD",style="Primary.TButton",command=app.mount_drive);app.mount_button.pack(side="left",padx=6)
    app.open_button=ttk.Button(bar,text="Open drive",command=app.open_drive,state="disabled");app.open_button.pack(side="left",padx=6)
    app.unmount_button=ttk.Button(bar,text="Unmount",command=app.unmount_drive,state="disabled");app.unmount_button.pack(side="left",padx=6)
    ttk.Button(bar,text="Mount helper",command=app.choose_rclone).pack(side="right",padx=(6,0))
    plan=ttk.Frame(body,style="Panel.TFrame",padding=14);plan.pack(fill="x",pady=(0,14))
    ttk.Button(plan,text="Create free 2 GB workspace",command=app.create_free_workspace).pack(side="right",padx=(16,0))
    copy_plan=ttk.Frame(plan,style="Panel.TFrame");copy_plan.pack(side="left",fill="x",expand=True)
    ttk.Label(copy_plan,text="MachineNote storage",style="Panel.TLabel",font=("Segoe UI",11,"bold")).pack(anchor="w")
    ttk.Label(copy_plan,text="Your server-enforced workspace plan controls quota and transfer workers. Owner benefits remain server-side.",
              style="Panel.TLabel",wraplength=700).pack(anchor="w",fill="x",pady=(4,0))
    ttk.Label(body,text="MOUNTED DRIVES",style="Kicker.TLabel").pack(anchor="w",pady=(2,5))
    app.home_drive_list=ttk.Treeview(body,columns=("state","path"),height=5,selectmode="browse")
    for name,width in (("state",140),("path",560)):
        app.home_drive_list.heading(name,text=name.title());app.home_drive_list.column(name,width=width)
    app.home_drive_list.heading("#0",text="MachineNote");app.home_drive_list.column("#0",width=230)
    app.home_drive_list.pack(fill="x",pady=(0,8))
    app.home_access=ttk.Label(body,text="Step 1: mount the selected MachineNote SSD.",style="Muted.TLabel",wraplength=900)
    app.home_access.pack(fill="x",pady=(8,22))

def build_account(app):
    from gui_theme import scroll_page
    body=scroll_page(app.account);app.account_body=body
    ttk.Label(body,text="ACCOUNT",style="Kicker.TLabel").pack(anchor="w")
    ttk.Label(body,text="Account and device access",style="Title.TLabel").pack(anchor="w",pady=(3,4))
    ttk.Label(body,text="Red-XAI Quick Login uses browser approval and OS-protected trusted-session storage. Mount first, then finish device signing here.",
              style="Muted.TLabel",wraplength=900).pack(fill="x",pady=(0,14))
    bar=ttk.Frame(body);bar.pack(anchor="w")
    for label,action in (("Connect Red-XAI",app.login),("Disconnect",app.disconnect),("Go Home",lambda:app.tabs.select(app.home))):
        ttk.Button(bar,text=label,command=action).pack(side="left",padx=4)
    setup=ttk.LabelFrame(body,text="Storage vault setup - available before mounting",padding=12);setup.pack(fill="x",pady=16)
    ttk.Label(setup,text="This PC securely keeps the local storage secret in Windows DPAPI or Linux Secret Service. Export a portable vault before uploading so another device can recover encrypted data.",
              style="Panel.TLabel",wraplength=880).pack(fill="x",pady=(0,8))
    actions=ttk.Frame(setup,style="Panel.TFrame");actions.pack(fill="x")
    for title,action in (("Import encrypted vault",app.import_vault),("Export encrypted vault",app.export_vault),("Initialize empty account",app.initialize_vault)):
        ttk.Button(actions,text=title,command=action).pack(side="left",padx=(0,7))
    app.account_summary=ttk.Label(body,text="Not signed in.",style="Muted.TLabel",wraplength=900);app.account_summary.pack(fill="x",pady=15)
    from gui_device_signing import build
    original=app.account;app.account=body
    try:build(app)
    finally:app.account=original

def choose_note(app):
    if app.busy:return
    index=app.home_note.current()
    if 0<=index<len(app.model.notes):
        app.note.current(index);app.note_changed()

def drive_selection(app):
    listing=app.home_drive_list if app.tabs.select()==str(app.home) else app.drive_list
    return listing.selection()

def update_navigation(app,records=None):
    records=app.mounts.refresh() if records is None else records
    receiver=app.model.session.receiver;workspace=app.model.selected_note
    mounted=selected_mount_ready(records,receiver,workspace,app.model.notes)
    if not mounted:app.signing_verified=False
    ready=workspace_ready(records,receiver,workspace,app.model.notes,
                          getattr(app,"signing_receiver",None),getattr(app,"signing_workspace",None),
                          getattr(app,"signing_verified",False))
    if not ready and app.tabs.select() not in (str(app.home),str(app.account)):app.tabs.select(app.home)
    for panel in (app.files,app.teams,app.settings):app.tabs.tab(panel,state="normal" if ready else "disabled")
    for name in ("sign_button","sign_refresh_button"):
        button=getattr(app,name,None)
        if button is not None:button.configure(state="normal" if mounted and not app.busy else "disabled")
    if hasattr(app,"open_button"):app.open_button.configure(state="normal" if ready and not app.busy else "disabled")
    if hasattr(app,"unmount_button"):app.unmount_button.configure(state="normal" if mounted and not app.busy else "disabled")
    if ready:text="Step 1 mounted and Step 2 signed. Files, Teams, and storage settings are unlocked."
    elif mounted:text="Step 1 complete. Open Account and sign this PC to unlock the workspace."
    else:text="Step 1: mount the selected MachineNote SSD. Signing stays disabled until the mount is confirmed."
    app.home_access.configure(text=text)
    app.account_summary.configure(text=(("Connected: "+receiver[:12]+"...") if isinstance(receiver,str) and receiver else "Not signed in.")
                                  +(" | mounted + signed" if ready else " | mounted, signing required" if mounted else " | no confirmed mount"))
    from gui_theme import set_setup_message
    set_setup_message(app,text,ready)
    return ready
