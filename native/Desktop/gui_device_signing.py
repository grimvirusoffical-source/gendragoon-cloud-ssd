"""Windows/Linux device signing with strict Mount -> Sign -> Unlock ordering."""
from tkinter import ttk,messagebox
from gui_access import selected_mount_ready

def build(app):
    app.signing_verified=False;app.signing_receiver=None;app.signing_workspace=None
    panel=ttk.LabelFrame(app.account,text="Step 2 - Signed devices - GDGSigned",padding=12);panel.pack(fill="x",pady=12)
    ttk.Label(panel,text="Mount the selected MachineNote SSD first. Then sign this PC. The account-scoped device fingerprint is encrypted with your existing Red-SecretsXAI vault and the live server must confirm it before cloud pages unlock.",
              style="Panel.TLabel",wraplength=880).pack(fill="x")
    listing=ttk.Treeview(panel,columns=("platform","state"),height=4,selectmode="browse")
    listing.heading("#0",text="Device");listing.heading("platform",text="Platform");listing.heading("state",text="Status")
    listing.column("#0",width=320);listing.column("platform",width=120);listing.column("state",width=220);listing.pack(fill="x",pady=8)
    def client():
        from signed_devices import SignedDevices
        return SignedDevices(app.model,app.mounts)
    def mounted():
        return selected_mount_ready(app.mounts.refresh(),app.model.session.receiver,app.model.selected_note,app.model.notes)
    def relock():
        app.signing_verified=False;app.signing_receiver=None;app.signing_workspace=None
        from gui_onboarding import update_navigation
        update_navigation(app)
    def display(result):
        listing.delete(*listing.get_children());local=result.get("local");confirmed=False
        for row in result["devices"]:
            is_local=row["id"]==local;signed=row.get("signed") is True
            if is_local and signed:confirmed=True
            listing.insert("","end",iid=row["id"],text=row["name"],
                           values=(row["platform"],"This PC - signed" if is_local and signed else "Signed" if signed else "Legacy registration"))
        app.signing_receiver=app.model.session.receiver;app.signing_workspace=result["workspace"]
        app.signing_verified=confirmed and mounted()
        from gui_onboarding import update_navigation
        update_navigation(app)
        app.status.set("Step 2 complete. This PC is server-confirmed as signed." if app.signing_verified else "No server-confirmed local signing exists for the mounted MachineNote.")
        if app.signing_verified and hasattr(app,"refresh_after_setup"):
            app.root.after(25,app.refresh_after_setup)
    def begin_check():
        relock()
        if not mounted():
            app.status.set("Step 1: mount the selected MachineNote SSD before signing or checking this PC.");return False
        return True
    def refresh():
        if app.busy or not begin_check():return
        app.run("Checking live signing service...",lambda:client().list(),display)
    def sign():
        if app.busy or not begin_check():return
        app.run("Encrypting and registering this PC...",lambda:client().sign(),display)
    def selected():
        values=listing.selection()
        if len(values)!=1:
            messagebox.showinfo("Choose a device","Refresh the list and select one device.",parent=app.root);return None
        return values[0]
    def unsign():
        if app.busy:return
        device=selected()
        if not device or not messagebox.askyesno("Unsign this device?","Revoke its credential and remove its encrypted Red-X receipt and live device record? Workspace files will not be deleted.",parent=app.root):return
        relock();app.run("Removing signed-device registration...",lambda:client().unsign(device),lambda _:refresh())
    def show(raw):
        from PIL import Image,ImageTk
        import io
        with Image.open(io.BytesIO(raw)) as source:
            if source.format!="PNG" or source.width*source.height>4_000_000:raise ValueError("Invalid receipt image.")
            source.load();image=source.resize((320,320),Image.Resampling.NEAREST)
        window=app.tk.Toplevel(app.root);window.title("Your encrypted Red-X device code");window.transient(app.root)
        photo=ImageTk.PhotoImage(image,master=window);label=ttk.Label(window,image=photo);label.image=photo;label.pack(padx=22,pady=22)
        ttk.Label(window,text="Encrypted registration receipt - not a login password or API key.",wraplength=360).pack(padx=18)
        ttk.Button(window,text="Close",command=window.destroy).pack(pady=12)
    def receipt():
        if app.busy:return
        device=selected()
        if device:app.run("Loading your encrypted Red-X receipt...",lambda:client().image(device),show)
    bar=ttk.Frame(panel,style="Panel.TFrame");bar.pack(fill="x")
    app.sign_refresh_button=ttk.Button(bar,text="Check signing service",command=refresh,state="disabled");app.sign_refresh_button.pack(side="left",padx=4)
    app.sign_button=ttk.Button(bar,text="2. Sign this PC",style="Primary.TButton",command=sign,state="disabled");app.sign_button.pack(side="left",padx=4)
    ttk.Button(bar,text="Show Red-X code",command=receipt).pack(side="left",padx=4)
    ttk.Button(bar,text="Unsign selected",command=unsign).pack(side="left",padx=4)
    app.refresh_signing=refresh;app.sign_current_device=sign