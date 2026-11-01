"""Required native OS file drops: review local backups, never move originals.

The TkDND wrapper/binaries are a separately pinned permissive dependency.
Drop data is a Tcl list, never a shell command, URI, or Python expression.
The caller stages a frozen destination and asks for Upload separately.
"""
import hashlib
from importlib import metadata, util
import json
import ntpath
import os
from pathlib import Path
import platform
import re
import sys

from desktop_transfer_ui import MAX_SOURCES, validate_sources

WRAPPER_VERSION = "0.7.0"
NATIVE_VERSION = "2.10.3"
MAX_DROP_BYTES = 512 * 1024
MAX_PATH_BYTES = 16 * 1024
COPY = "copy"
REFUSE_DROP = "refuse_drop"
RUNTIME_ERROR = "GenDragoon's required native file-drop runtime is missing, altered, or incompatible. Reinstall the verified desktop package."
DROP_ERROR = "Drop between 1 and 100 actual local files or folders. URLs, links, reparse paths, overlapping sources and special files are not accepted."


class DropError(ValueError):
    pass


def verify_dependency():
    """Check exact wheel data before Tcl can load its native library."""
    try:
        if metadata.version("tkinterdnd2") != WRAPPER_VERSION:
            raise ValueError("version")
        pin_path = Path(__file__).with_name("tkdnd-runtime.json")
        if pin_path.is_symlink() or not 0 < pin_path.stat().st_size < 128 * 1024:
            raise ValueError("manifest")
        pin = json.loads(pin_path.read_text(encoding="utf-8"))
        if pin.get("wrapperVersion") != WRAPPER_VERSION or pin.get("nativeVersion") != NATIVE_VERSION:
            raise ValueError("manifest")
        import tkinter
        system = platform.system()
        machine = os.environ.get("PROCESSOR_ARCHITECTURE", platform.machine()) if system == "Windows" else platform.machine()
        folder = {("Windows", "AMD64"): "win-x64", ("Linux", "x86_64"): "linux-x64"}.get((system, machine))
        if folder is None:
            raise ValueError("platform")
        if int(str(tkinter.TclVersion).split(".")[0]) >= 9:
            folder += "-tcl9"
        expected = pin["runtimeFiles"][folder]
        if not isinstance(expected, dict) or not 2 <= len(expected) <= 32:
            raise ValueError("files")
        package = util.find_spec("tkinterdnd2")
        root = Path(package.origin).parent / "tkdnd" / folder
        if root.is_symlink() or root.parent.is_symlink() or root.parent.parent.is_symlink():
            raise ValueError("linked runtime")
        for name, value in expected.items():
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", name) or not isinstance(value, dict):
                raise ValueError("files")
            path = root / name
            if path.is_symlink() or not path.is_file() or path.stat().st_size != value["bytes"]:
                raise ValueError("runtime file")
            if hashlib.sha256(path.read_bytes()).hexdigest() != value["sha256"]:
                raise ValueError("runtime digest")
        return {"wrapper": WRAPPER_VERSION, "native": NATIVE_VERSION, "platformFolder": folder}
    except Exception:
        raise RuntimeError(RUNTIME_ERROR) from None


def require_native_drop(root):
    info = verify_dependency()
    try:
        from tkinterdnd2 import TkinterDnD
        root.tk.call("set", "::TKDND_DEBUG_LEVEL", 0)
        actual = str(TkinterDnD.require(root))
        if actual != NATIVE_VERSION or str(root.tk.call("package", "present", "tkdnd")) != NATIVE_VERSION:
            raise ValueError("native version")
        windowing = str(root.tk.call("tk", "windowingsystem"))
        if windowing != {"Windows": "win32", "Linux": "x11"}.get(platform.system()):
            raise ValueError("windowing system")
        return {**info, "windowingSystem": windowing}
    except Exception:
        raise RuntimeError(RUNTIME_ERROR) from None


def create_root(**kwargs):
    """The shipping desktop root requires native drop support, with no fallback."""
    verify_dependency()
    from tkinterdnd2 import TkinterDnD
    # Suppress native debug output before the root constructor loads Tcl code.
    os.environ.pop("TKDND_DEBUG_LEVEL", None)
    root = TkinterDnD.Tk(**kwargs)
    try:
        require_native_drop(root)
        return root
    except Exception:
        root.destroy()
        raise


def _windows_local_drive(path):
    import ctypes
    function = ctypes.WinDLL("kernel32", use_last_error=True).GetDriveTypeW
    function.argtypes = [ctypes.c_wchar_p]
    function.restype = ctypes.c_uint
    return function(ntpath.splitdrive(path)[0] + "\\") in (2, 3, 5, 6)


def parse_dropped_files(tcl, data):
    """Parse the actual Tcl list, then run the same validation as the picker."""
    try:
        if not isinstance(data, str) or not data or len(data.encode("utf-8")) > MAX_DROP_BYTES:
            raise DropError(DROP_ERROR)
        names = tcl.splitlist(data)
        if not 1 <= len(names) <= MAX_SOURCES:
            raise DropError(DROP_ERROR)
        for name in names:
            if (not isinstance(name, str) or not name or len(name.encode("utf-8")) > MAX_PATH_BYTES
                    or any(ord(c) < 32 or ord(c) == 127 for c in name)
                    or name.startswith(("\\\\", "//"))):
                raise DropError(DROP_ERROR)
            if sys.platform == "win32":
                if (not re.match(r"^[A-Za-z]:[\\/]", name) or ":" in name[2:]
                        or any(p in (".", "..") for p in re.split(r"[\\/]", name))
                        or not _windows_local_drive(name)):
                    raise DropError(DROP_ERROR)
            elif (not name.startswith("/") or any(p in (".", "..") for p in name.split("/"))):
                raise DropError(DROP_ERROR)
        return validate_sources(list(names))
    except Exception:
        raise DropError(DROP_ERROR) from None


class FileDropBinding:
    def __init__(self, widget, on_paths, on_error):
        require_native_drop(widget)
        from tkinterdnd2 import DND_FILES
        self.widget, self.on_paths, self.on_error = widget, on_paths, on_error
        widget.drop_target_register(DND_FILES)
        self.commands = {
            "enter": widget.dnd_bind("<<DropEnter>>", self.negotiate),
            "position": widget.dnd_bind("<<DropPosition>>", self.negotiate),
            "drop": widget.dnd_bind("<<Drop>>", self.drop),
        }

    @staticmethod
    def negotiate(event):
        actions = getattr(event, "actions", ())
        if isinstance(actions, str):
            actions = (actions,)
        if not isinstance(actions, (tuple, list)) or len(actions) > 16:
            return REFUSE_DROP
        return COPY if COPY in actions else REFUSE_DROP

    def drop(self, event):
        if self.negotiate(event) != COPY:
            return REFUSE_DROP
        try:
            paths = parse_dropped_files(self.widget.tk, event.data)
            # This callback reviews/stages only. Upload is a separate GUI action.
            if self.on_paths(paths) is False:
                return REFUSE_DROP
            return COPY
        except Exception:
            try:
                self.on_error(DROP_ERROR)
            except Exception:
                pass
            return REFUSE_DROP


def bind_file_drop(widget, on_paths, on_error):
    return FileDropBinding(widget, on_paths, on_error)
