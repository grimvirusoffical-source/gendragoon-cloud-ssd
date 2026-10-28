"""Native account settings for GDGSigned; uses the desktop model's private vault."""
from tkinter import ttk,messagebox

def build(app):
    panel=ttk.LabelFrame(app.account,text='Signed devices · GDGSigned',padding=12)
    panel.pack(fill='x',pady=12)
    ttk.Label(panel,text='Choose a MachineNote on Home, then sign this device. Its account-scoped ID is encrypted with your Red-SecretsXAI vault. Hardware and OS IDs can change; they do not replace account authorization.',wraplength=880).pack(fill='x')
    listing=ttk.Treeview(panel,columns=('platform','state'),height=4,selectmode='browse')
    listing.heading('#0',text='Device');listing.heading('platform',text='Platform');listing.heading('state',text='Status')
    listing.column('#0',width=320);listing.column('platform',width=120);listing.column('state',width=220)
    listing.pack(fill='x',pady=8)
    def client():
        from signed_devices import SignedDevices
        return SignedDevices(app.model)
    def display(result):
        listing.delete(*listing.get_children())
        for row in result['devices']:
            listing.insert('','end',iid=row['id'],text=row['name'],values=(row['platform'],'This device' if row['id']==result['local'] else 'Signed' if row.get('signed') else 'Legacy registration'))
        app.status.set('Signed devices verified for the selected MachineNote.')
    def refresh():
        if not app.busy:app.run('Loading signed devices…',lambda:client().list(),display)
    def sign():
        if app.busy:return
        app.run('Encrypting and registering this device…',lambda:client().sign(),display)
    def selected():
        values=listing.selection()
        if len(values)!=1:messagebox.showinfo('Choose a device','Refresh the list and select one device.',parent=app.root);return None
        return values[0]
    def unsign():
        if app.busy:return
        device=selected()
        if not device or not messagebox.askyesno('Unsign this device?','Revoke its credential and remove its encrypted Red-X receipt and device record from the live database? Workspace files will not be deleted.',parent=app.root):return
        app.run('Removing signed-device registration…',lambda:client().unsign(device),lambda _:refresh())
    def show(raw):
        from PIL import Image,ImageTk
        import io
        with Image.open(io.BytesIO(raw)) as source:
            if source.format!='PNG' or source.width*source.height>4_000_000:raise ValueError('Invalid receipt image.')
            source.load();image=source.resize((320,320),Image.Resampling.NEAREST)
        window=app.tk.Toplevel(app.root);window.title('Your encrypted Red-X device code');window.transient(app.root)
        photo=ImageTk.PhotoImage(image,master=window)
        label=ttk.Label(window,image=photo);label.image=photo;label.pack(padx=22,pady=22)
        ttk.Label(window,text='Encrypted registration receipt — not a login password or API key.',wraplength=360).pack(padx=18)
        ttk.Button(window,text='Close',command=window.destroy).pack(pady=12)
    def receipt():
        if app.busy:return
        device=selected()
        if device:app.run('Loading your encrypted Red-X receipt…',lambda:client().image(device),show)
    bar=ttk.Frame(panel);bar.pack(fill='x')
    for label,action in [('Refresh devices',refresh),('Sign this device',sign),('Show Red-X code',receipt),('Unsign selected',unsign)]:
        ttk.Button(bar,text=label,command=action).pack(side='left',padx=4)
