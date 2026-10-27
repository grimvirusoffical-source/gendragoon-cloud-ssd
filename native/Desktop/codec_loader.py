"""Resolve frozen sibling imports inside the verified compiled codec packages.

The pinned library is unchanged. Its dynamic imports name .py siblings; public
desktop packages carry only their hash-verified adjacent Python3.13 bytecode.
"""
import importlib.util
from pathlib import Path
import threading

_lock=threading.Lock()
_roots=set()
_original=None

def install_sourceless_runtime(runtime):
    global _original
    runtime=Path(runtime).resolve()
    with _lock:
        _roots.update((runtime/"redxai",runtime/"redsecretsxai"))
        if _original is not None:return
        _original=importlib.util.spec_from_file_location
        def spec(name,location,*args,**kwargs):
            if location is not None:
                path=Path(location)
                if path.suffix==".py" and path.parent.resolve() in _roots and not path.exists():
                    compiled=path.with_suffix(".pyc")
                    if compiled.is_file() and not compiled.is_symlink():location=compiled
            return _original(name,location,*args,**kwargs)
        importlib.util.spec_from_file_location=spec
