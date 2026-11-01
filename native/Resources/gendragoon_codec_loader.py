"""Resolve the pinned library's sibling imports in its compiled Mac runtime.

The unchanged library names a .py sibling in a dynamic import. A narrowly
rooted redirect lets it use the verified adjacent .pyc without bundling source.
Python bytecode is a distribution format, not a secrecy or encryption boundary.
"""
import sys
sys.dont_write_bytecode = True
import importlib.util
from pathlib import Path
import threading

_lock = threading.Lock()
_roots = set()
_original = None


def install_sourceless_runtime(runtime):
    global _original
    runtime = Path(runtime).resolve()
    with _lock:
        _roots.update((runtime / "redxai", runtime / "redsecretsxai"))
        if _original is not None:
            return
        _original = importlib.util.spec_from_file_location

        def spec(name, location, *args, **kwargs):
            if location is not None:
                path = Path(location)
                if path.suffix == ".py" and path.parent.resolve() in _roots and not path.exists():
                    compiled = path.with_suffix(".pyc")
                    if compiled.is_file() and not compiled.is_symlink():
                        location = compiled
            return _original(name, location, *args, **kwargs)

        importlib.util.spec_from_file_location = spec


if __name__ == "__main__":
    import argparse
    argparse.ArgumentParser(description=__doc__).parse_args()
