"""Opt-in original offload: verified backup first, operating-system Trash only.

No recursive deletion and no permanent-delete fallback. This module never runs
from the browser: the native uploader supplies the verified source snapshot.
"""
from dataclasses import dataclass
import os
from pathlib import Path
import sys

class OffloadError(ValueError):pass

@dataclass(frozen=True)
class RunningSource:
    pid:int
    started:float
    executable:str
    name:str


def checked_source(value):
    path=Path(value).absolute()
    if not path.exists() or any(p.is_symlink() for p in (path,*path.parents)):
        raise OffloadError('Original path changed or contains a link; it was not offloaded.')
    if path==Path(path.anchor) or path==Path.home() or path in Path.home().parents:
        raise OffloadError('Home and filesystem roots cannot be offloaded.')
    runtime=Path(sys.executable).absolute()
    app=Path(__file__).absolute()
    if path in (runtime,app) or path in runtime.parents or path in app.parents:
        raise OffloadError('GenDragoon and its runtime cannot be offloaded while in use.')
    if getattr(path.lstat(),'st_file_attributes',0)&0x400:
        raise OffloadError('Linked/reparse originals cannot be offloaded.')
    return path


def _key(path):return os.path.normcase(os.path.normpath(str(path)))


def running_sources(paths):
    import psutil
    roots=[Path(p).absolute() for p in paths]
    found=[]
    for process in psutil.process_iter(['pid','exe','create_time','name']):
        info=process.info
        exe=info.get('exe')
        if not exe:continue
        target=Path(exe).absolute()
        if any(_key(target)==_key(root) or root.is_dir() and _key(root) in {_key(p) for p in target.parents} for root in roots):
            if process.pid==os.getpid():raise OffloadError('The selected source contains GenDragoon itself.')
            found.append(RunningSource(process.pid,float(info['create_time']),str(target),str(info.get('name') or target.name)))
    return found


def _same_process(reference):
    import psutil
    try:
        process=psutil.Process(reference.pid)
        if process.create_time()!=reference.started or _key(process.exe())!=_key(reference.executable):return None
        return process
    except (psutil.NoSuchProcess,psutil.AccessDenied):return None


def request_close(references,*,force=False,approved=False):
    import psutil
    if approved is not True:raise OffloadError('Native confirmation is required before closing selected applications.')
    targets=[]
    for reference in references:
        process=_same_process(reference)
        if process is None:continue
        if force:process.kill()
        elif os.name=='nt':
            # psutil.terminate is a force kill on Windows. Post WM_CLOSE instead.
            import ctypes
            from ctypes import wintypes
            user=ctypes.WinDLL('user32',use_last_error=True)
            callback_type=ctypes.WINFUNCTYPE(wintypes.BOOL,wintypes.HWND,wintypes.LPARAM)
            user.GetWindowThreadProcessId.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.DWORD)]
            user.PostMessageW.argtypes=[wintypes.HWND,wintypes.UINT,wintypes.WPARAM,wintypes.LPARAM]
            def close_window(window,_):
                pid=wintypes.DWORD()
                user.GetWindowThreadProcessId(window,ctypes.byref(pid))
                if pid.value==reference.pid and _same_process(reference) is not None:
                    user.PostMessageW(window,0x0010,0,0)
                return True
            callback=callback_type(close_window)
            user.EnumWindows.argtypes=[callback_type,wintypes.LPARAM]
            user.EnumWindows(callback,0)
        else:process.terminate()
        targets.append(process)
    psutil.wait_procs(targets,timeout=4)
    return [reference for reference in references if _same_process(reference) is not None]


def trash_verified(source,baseline,snapshot,*,approved=False,trash=None,process_check=None):
    if approved is not True:raise OffloadError('Original offload must be explicitly selected before upload.')
    path=checked_source(source)
    if (process_check or running_sources)([path]):
        raise OffloadError('A selected application restarted. The verified cloud copy is kept; original retained.')
    if snapshot(path)!=baseline:
        raise OffloadError('The original changed after verification; it was not moved to Trash.')
    if trash is None:
        from send2trash import send2trash
        trash=send2trash
    try:trash(str(path))
    except Exception as error:
        # Never substitute unlink/rmtree when OS Trash is unavailable.
        if path.exists():raise OffloadError('The verified backup is safe, but OS Trash was unavailable. Original retained.') from error
        raise OffloadError('OS Trash did not return a confirmed result. Check Trash; no permanent deletion was attempted.') from error
    if path.exists() or path.is_symlink():
        raise OffloadError('OS Trash did not remove the selected path. Original retained.')
    return {'offloaded':True,'originalRetained':False,'offloadMethod':'os-trash'}
