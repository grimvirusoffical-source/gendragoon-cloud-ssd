"""Tk onboarding screens for workspace mount-first access."""
from gui_access import mount_ready
from tkinter import ttk


def build_home(app):
    ttk.Label(app.home, text="Your GenDragoon workspaces",
              font=("TkDefaultFont", 19, "bold")).pack(anchor="w")
    ttk.Label(app.home, text="Sign in, choose one or more MachineNotes, and mount a real workspace drive. "
              "Only Home and Account are available until a mount is confirmed.",
              wraplength=910, padding=10).pack(fill="x")
    app.home_note = ttk.Combobox(app.home, state="readonly")
    app.home_note.pack(fill="x", pady=8)
    app.home_note.bind("<<ComboboxSelected>>", lambda _: choose_note(app))
    bar = ttk.Frame(app.home)
    bar.pack(fill="x", pady=8)
    for label, action in (("Refresh", app.refresh), ("Mount selected", app.mount_drive),
                          ("Open drive", app.open_drive), ("Unmount", app.unmount_drive)):
        ttk.Button(bar, text=label, command=action).pack(side="left", padx=4)
    ttk.Button(app.home,text="Choose mount helper…",command=app.choose_rclone).pack(anchor="w",pady=6)
    ttk.Label(app.home, text="Your first workspace includes 2 GB and the slowest free performance tier. Paid "
              "upgrades are optional. Additional workspaces and billing "
              "eligibility are enforced by the server.", wraplength=910, padding=10).pack(fill="x")
    ttk.Button(app.home,text="Create my free 2 GB workspace",command=app.create_free_workspace).pack(anchor="w",pady=8)
    ttk.Label(app.home, text="Mounted drives", font=("TkDefaultFont", 13, "bold")).pack(anchor="w")
    app.home_drive_list = ttk.Treeview(app.home, columns=("state", "path"), height=5, selectmode="browse")
    for name, width in (("state", 140), ("path", 560)):
        app.home_drive_list.heading(name, text=name.title())
        app.home_drive_list.column(name, width=width)
    app.home_drive_list.heading("#0", text="MachineNote")
    app.home_drive_list.column("#0", width=230)
    app.home_drive_list.pack(fill="x", pady=8)
    app.home_access = ttk.Label(app.home, text="Sign in and mount a workspace to continue.",
                                wraplength=900)
    app.home_access.pack(fill="x", pady=10)


def build_account(app):
    ttk.Label(app.account, text="Account and device access",
              font=("TkDefaultFont", 18, "bold")).pack(anchor="w")
    ttk.Label(app.account, text="Sign in with Red-XAI, then choose a workspace on Home. "
              "Unmount every drive before changing accounts. Account tokens never belong in "
              "a browser extension.", wraplength=900, padding=14).pack(fill="x")
    bar = ttk.Frame(app.account)
    bar.pack(anchor="w")
    for label, action in (("Connect Red-XAI", app.login), ("Disconnect", app.disconnect),
                          ("Go Home", lambda: app.tabs.select(app.home))):
        ttk.Button(bar, text=label, command=action).pack(side="left", padx=4)
    setup=ttk.LabelFrame(app.account,text="Storage vault setup — available before mounting",padding=12)
    setup.pack(fill="x",pady=16)
    ttk.Label(setup,text="Import your existing portable vault, or initialize and export one for an empty account. "
              "Signing in alone does not recover encryption keys.",wraplength=880).pack(fill="x")
    for title,action in (("Import encrypted vault…",app.import_vault),
                         ("Export encrypted vault…",app.export_vault),
                         ("Initialize empty account…",app.initialize_vault)):
        ttk.Button(setup,text=title,command=action).pack(anchor="w",pady=4)
    app.account_summary = ttk.Label(app.account, text="Not signed in.", wraplength=900)
    app.account_summary.pack(fill="x", pady=15)


def choose_note(app):
    if app.busy:
        return
    index = app.home_note.current()
    if 0 <= index < len(app.model.notes):
        app.note.current(index)
        app.note_changed()


def drive_selection(app):
    listing = app.home_drive_list if app.tabs.select() == str(app.home) else app.drive_list
    return listing.selection()


def update_navigation(app, records=None):
    records = app.mounts.refresh() if records is None else records
    ready = mount_ready(records, app.model.session.receiver, app.model.notes)
    if not ready and app.tabs.select() not in (str(app.home), str(app.account)):
        app.tabs.select(app.home)
    for panel in (app.files, app.teams, app.settings):
        app.tabs.tab(panel, state="normal" if ready else "disabled")
    app.home_access.configure(text=("Workspace mounted. Files, Teams, and storage settings are unlocked."
                              if ready else "Mount an owned workspace drive on Home to unlock cloud pages."))
    receiver = app.model.session.receiver
    app.account_summary.configure(text=(("Connected: " + receiver[:12] + "...")
                                    if isinstance(receiver, str) and receiver else "Not signed in.")
                                   + (" · mounted" if ready else " · no confirmed mount"))
    return ready
