"""Dark GenDragoon Windows/Linux shell. UI text is ASCII-safe by design."""
from pathlib import Path
import sys

BG="#0E0C17"
SIDEBAR="#12101D"
SURFACE="#191626"
SURFACE_2="#211B35"
BORDER="#332B4A"
ACCENT="#9C6BFA"
ACCENT_DARK="#5637B5"
ACCENT_SOFT="#2B2046"
TEXT="#F6F3FF"
MUTED="#A9A1B8"
WARNING="#F2A65A"
SUCCESS="#5BD6A2"

NAV=("Home","Files","Teams","Storage keys","Account")

def apply(app,root):
    tk,ttk=app.tk,app.ttk
    root.configure(bg=BG)
    root.option_add("*Font",("Segoe UI",10))
    root.option_add("*insertBackground",TEXT)
    root.option_add("*selectBackground",ACCENT_DARK)
    root.option_add("*selectForeground",TEXT)
    style=ttk.Style(root)
    try:style.theme_use("clam")
    except tk.TclError:pass
    style.configure(".",font=("Segoe UI",10))
    style.configure("TFrame",background=BG)
    style.configure("Panel.TFrame",background=SURFACE)
    style.configure("TLabel",background=BG,foreground=TEXT)
    style.configure("Panel.TLabel",background=SURFACE,foreground=TEXT)
    style.configure("Muted.TLabel",background=BG,foreground=MUTED)
    style.configure("Kicker.TLabel",background=BG,foreground=ACCENT,font=("Consolas",9,"bold"))
    style.configure("Title.TLabel",background=BG,foreground=TEXT,font=("Segoe UI",23,"bold"))
    style.configure("TButton",background=SURFACE_2,foreground=TEXT,bordercolor=BORDER,
                    lightcolor=SURFACE_2,darkcolor=SURFACE_2,padding=(12,8),relief="flat")
    style.map("TButton",background=[("active","#2D2543"),("pressed",ACCENT_DARK),("disabled","#181622")],
              foreground=[("disabled","#615B6B")])
    style.configure("Primary.TButton",background=ACCENT_DARK,foreground="white",bordercolor=ACCENT,
                    lightcolor=ACCENT_DARK,darkcolor=ACCENT_DARK,padding=(14,9),relief="flat")
    style.map("Primary.TButton",background=[("active","#6847CE"),("pressed","#472C99")])
    style.configure("TNotebook",background=BG,borderwidth=0,tabmargins=0)
    try:style.layout("TNotebook.Tab",[])
    except tk.TclError:pass
    style.configure("TLabelframe",background=SURFACE,foreground=TEXT,bordercolor=BORDER,
                    lightcolor=BORDER,darkcolor=BORDER,relief="flat")
    style.configure("TLabelframe.Label",background=SURFACE,foreground=TEXT,font=("Segoe UI",10,"bold"))
    style.configure("Treeview",background=SURFACE,fieldbackground=SURFACE,foreground=TEXT,
                    bordercolor=BORDER,rowheight=29)
    style.map("Treeview",background=[("selected",ACCENT_DARK)],foreground=[("selected","white")])
    style.configure("Treeview.Heading",background="#201B2D",foreground=TEXT,bordercolor=BORDER,
                    font=("Segoe UI",9,"bold"),relief="flat")
    style.map("Treeview.Heading",background=[("active","#2A2340")])
    style.configure("TEntry",fieldbackground=SURFACE_2,foreground=TEXT,insertcolor=TEXT,bordercolor=BORDER,padding=6)
    style.configure("TCombobox",fieldbackground=SURFACE_2,background=SURFACE_2,foreground=TEXT,
                    arrowcolor=TEXT,bordercolor=BORDER,padding=6)
    style.map("TCombobox",fieldbackground=[("readonly",SURFACE_2)],foreground=[("readonly",TEXT)],
              selectbackground=[("readonly",SURFACE_2)],selectforeground=[("readonly",TEXT)])
    style.configure("TCheckbutton",background=BG,foreground=TEXT)
    style.map("TCheckbutton",background=[("active",BG)],foreground=[("disabled","#615B6B")])
    style.configure("Horizontal.TProgressbar",troughcolor=SURFACE_2,background=ACCENT,
                    bordercolor=BORDER,lightcolor=ACCENT,darkcolor=ACCENT)
    style.configure("Vertical.TScrollbar",background=SURFACE_2,troughcolor=BG,arrowcolor=TEXT,bordercolor=BORDER)
    if sys.platform=="win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("RedXAI.GenDragoon.CloudSSD")
        except Exception:pass
    icon=Path(__file__).with_name("GenDragoonAppIcon.png")
    if icon.is_file():
        try:
            app._gd_icon=tk.PhotoImage(file=str(icon));root.iconphoto(True,app._gd_icon)
        except tk.TclError:app._gd_icon=None

def scroll_page(parent):
    import tkinter as tk
    from tkinter import ttk
    canvas=tk.Canvas(parent,bg=BG,highlightthickness=0,bd=0)
    scroll=ttk.Scrollbar(parent,orient="vertical",command=canvas.yview)
    inner=ttk.Frame(canvas)
    window=canvas.create_window((0,0),window=inner,anchor="nw")
    def inner_changed(_=None):
        box=canvas.bbox("all")
        if box:canvas.configure(scrollregion=box)
    def canvas_changed(event):canvas.itemconfigure(window,width=max(1,event.width))
    inner.bind("<Configure>",inner_changed);canvas.bind("<Configure>",canvas_changed)
    canvas.configure(yscrollcommand=scroll.set)
    canvas.pack(side="left",fill="both",expand=True);scroll.pack(side="right",fill="y")
    def wheel(event):
        delta=getattr(event,"delta",0)
        if delta:canvas.yview_scroll(-3 if delta>0 else 3,"units")
    canvas.bind("<Enter>",lambda _:canvas.bind_all("<MouseWheel>",wheel))
    canvas.bind("<Leave>",lambda _:canvas.unbind_all("<MouseWheel>"))
    return inner

def status_card(parent,title,variable,detail):
    import tkinter as tk
    card=tk.Frame(parent,bg=SURFACE,highlightthickness=1,highlightbackground=BORDER)
    tk.Label(card,text=title.upper(),bg=SURFACE,fg=ACCENT,font=("Consolas",8,"bold")).pack(anchor="w",padx=14,pady=(12,2))
    tk.Label(card,textvariable=variable,bg=SURFACE,fg=TEXT,font=("Segoe UI",13,"bold"),
             wraplength=250,justify="left").pack(anchor="w",padx=14)
    tk.Label(card,text=detail,bg=SURFACE,fg=MUTED,font=("Segoe UI",8),
             wraplength=250,justify="left").pack(anchor="w",padx=14,pady=(3,12))
    return card

def _select(app,name,panel):
    try:
        if str(app.tabs.tab(panel,"state"))=="disabled":return
        app.tabs.select(panel)
    except app.tk.TclError:return
    app.page_title.set(name);refresh_navigation(app)

def refresh_navigation(app):
    if not hasattr(app,"sidebar_buttons"):return
    selected=str(app.tabs.select())
    for name,panel in app.sidebar_pages.items():
        button=app.sidebar_buttons[name]
        try:enabled=str(app.tabs.tab(panel,"state"))!="disabled"
        except app.tk.TclError:enabled=False
        active=str(panel)==selected
        button.configure(state="normal" if enabled else "disabled",
                         bg=ACCENT_SOFT if active else SIDEBAR,
                         fg=TEXT if active else MUTED,
                         activebackground=ACCENT_SOFT if active else "#1A1725",
                         activeforeground=TEXT,disabledforeground="#4E4859",
                         highlightbackground=ACCENT if active else SIDEBAR,
                         highlightcolor=ACCENT if active else SIDEBAR,
                         highlightthickness=1 if active else 0)

def build_shell(app,root):
    tk,ttk=app.tk,app.ttk
    apply(app,root)
    shell=tk.Frame(root,bg=BG);shell.pack(fill="both",expand=True)
    sidebar=tk.Frame(shell,bg=SIDEBAR,width=228);sidebar.pack(side="left",fill="y");sidebar.pack_propagate(False)
    brand=tk.Frame(sidebar,bg=SIDEBAR);brand.pack(fill="x",padx=18,pady=(20,24))
    titles=tk.Frame(brand,bg=SIDEBAR);titles.pack(side="left",fill="x")
    tk.Label(titles,text="GENDRAGOON",bg=SIDEBAR,fg=TEXT,font=("Segoe UI",14,"bold")).pack(anchor="w")
    tk.Label(titles,text="CLOUD SSD",bg=SIDEBAR,fg=MUTED,font=("Consolas",8,"bold")).pack(anchor="w")
    main=tk.Frame(shell,bg=BG);main.pack(side="left",fill="both",expand=True)
    top=tk.Frame(main,bg=BG,height=72);top.pack(fill="x",padx=24,pady=(10,0));top.pack_propagate(False)
    app.page_title=tk.StringVar(value="Home")
    tk.Label(top,textvariable=app.page_title,bg=BG,fg=TEXT,font=("Segoe UI",17,"bold")).pack(side="left",pady=17)
    ttk.Button(top,text="Connect Red-XAI",style="Primary.TButton",command=app.login).pack(side="right",padx=(6,0),pady=11)
    ttk.Button(top,text="Integration key",command=app.integration_login).pack(side="right",padx=6,pady=11)
    ttk.Button(top,text="Disconnect",command=app.disconnect).pack(side="right",padx=6,pady=11)
    content=tk.Frame(main,bg=BG);content.pack(fill="both",expand=True,padx=22,pady=(2,0))
    app.tabs=ttk.Notebook(content);app.tabs.pack(fill="both",expand=True)
    app.home=ttk.Frame(app.tabs,padding=18);app.files=ttk.Frame(app.tabs,padding=14)
    app.teams=ttk.Frame(app.tabs,padding=14);app.settings=ttk.Frame(app.tabs,padding=14)
    app.account=ttk.Frame(app.tabs,padding=18)
    for name,panel in (("Home",app.home),("Files",app.files),("Teams",app.teams),("Storage keys",app.settings),("Account",app.account)):
        app.tabs.add(panel,text=name)
    app.sidebar_pages={"Home":app.home,"Files":app.files,"Teams":app.teams,"Storage keys":app.settings,"Account":app.account}
    app.sidebar_buttons={}
    for name in NAV:
        panel=app.sidebar_pages[name]
        button=tk.Button(sidebar,text=name.upper(),command=lambda n=name,p=panel:_select(app,n,p),
                         anchor="w",padx=16,pady=11,relief="flat",bd=0,bg=SIDEBAR,fg=MUTED,
                         activebackground="#1A1725",activeforeground=TEXT,disabledforeground="#4E4859",
                         font=("Segoe UI",10,"bold"),cursor="hand2")
        button.pack(fill="x",padx=12,pady=2);app.sidebar_buttons[name]=button
    app.sidebar_lock=tk.StringVar(value="SETUP LOCKED\n1. Mount SSD\n2. Sign this PC")
    tk.Label(sidebar,textvariable=app.sidebar_lock,bg=SIDEBAR,fg=WARNING,justify="left",
             wraplength=190,font=("Segoe UI",9)).pack(side="bottom",fill="x",padx=18,pady=(8,22))
    tk.Label(sidebar,text="WINDOWS | RED-XAI",bg=SIDEBAR,fg="#6F687B",font=("Consolas",8)).pack(side="bottom",anchor="w",padx=18,pady=(0,4))
    status_frame=tk.Frame(main,bg="#11101A",height=48,highlightthickness=1,highlightbackground=BORDER)
    status_frame.pack(fill="x",side="bottom");status_frame.pack_propagate(False)
    tk.Label(status_frame,textvariable=app.status,bg="#11101A",fg=MUTED,anchor="w",justify="left",
             wraplength=900,font=("Segoe UI",9)).pack(fill="both",padx=18,pady=9)
    app.tabs.bind("<<NotebookTabChanged>>",lambda _:refresh_navigation(app))
    refresh_navigation(app)

def set_setup_message(app,text,ready=False):
    if hasattr(app,"sidebar_lock"):
        app.sidebar_lock.set(("READY" if ready else "SETUP LOCKED")+"\n"+text)
    refresh_navigation(app)