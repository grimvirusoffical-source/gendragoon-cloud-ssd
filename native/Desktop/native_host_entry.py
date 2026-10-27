"""Build as GenDragoonNativeHost.exe with PyInstaller --console on Windows."""
import sys
from pathlib import Path
sys.dont_write_bytecode = True
resources = Path(__file__).resolve().parents[1] / "Resources"
if str(resources) not in sys.path:
    sys.path.insert(0, str(resources))
import gendragoon_native_bridge
if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] != "--vscode-bridge":
        sys.argv.insert(1, "--native-messaging")
    raise SystemExit(gendragoon_native_bridge.main())
