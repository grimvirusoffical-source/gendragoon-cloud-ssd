#!/usr/bin/env python3
"""Build browser ZIPs, a VSIX and reviewed source without publishing anywhere."""
from __future__ import annotations
import os
import sys
sys.dont_write_bytecode = True
import argparse
import binascii
import hashlib
import json
import shutil
import struct
import tempfile
import zipfile
import zlib
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent
NATIVE = ROOT.parent
VERSION = json.loads((ROOT / "vscode/package.json").read_text())["version"]


def png_icon(size):
    # Deterministic local artwork: a red X on the application's dark palette.
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            inset = size * .20 <= x <= size * .80 and size * .20 <= y <= size * .80
            red = inset and min(abs(x-y), abs(x+y-size+1)) < size * .09
            rows.extend((255, 72, 104, 255) if red else (13, 17, 30, 255))
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", binascii.crc32(kind + data) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">2I5B", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b"")


def icons(directory):
    target = directory / "icons"
    target.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        (target / f"{size}.png").write_bytes(png_icon(size))


def archive(directory, target, prefix=""):
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for item in sorted(directory.rglob("*")):
            if not item.is_file() or item.is_symlink():
                continue
            name = prefix + item.relative_to(directory).as_posix()
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, item.read_bytes())


def teams(directory, mode):
    target = directory / "teams"
    target.mkdir()
    for name in ("index.html", "teams.css", "dev-peer.js", "teams-ui.js"):
        shutil.copyfile(NATIVE / "Collaboration" / name, target / name)
    shutil.copyfile(ROOT / "shared/rpc.js", target / "rpc.js")
    shutil.copyfile(ROOT / mode / "teams-adapter.js", target / "teams-adapter.js")
    scripts = '<script src="rpc.js"></script>'
    if mode == "browser":
        shutil.copyfile(ROOT / "browser/native-client.js", target / "native-client.js")
        scripts += '<script src="native-client.js"></script>'
    scripts += '<script src="teams-adapter.js"></script>'
    html = (target / "index.html").read_text()
    if '<script src="dev-peer.js">' not in html:
        raise ValueError("Teams source no longer has the expected packaged script entry")
    (target / "index.html").write_text(html.replace('<script src="dev-peer.js">', scripts + '<script src="dev-peer.js">'))


def vsix_metadata(directory, package):
    publisher, name, version = (escape(package[key]) for key in ("publisher", "name", "version"))
    display = escape(package["displayName"])
    manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
<Metadata><Identity Language="en-US" Id="{publisher}.{name}" Version="{version}" Publisher="{publisher}"/><DisplayName>{display}</DisplayName><Description xml:space="preserve">{escape(package['description'])}</Description><Tags>MachineNotes,GenDragoon,Teams</Tags><Categories>Other</Categories><GalleryFlags>Public</GalleryFlags><Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(package['engines']['vscode'])}"/><Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value=""/><Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui"/></Properties><Icon>extension/icons/128.png</Icon></Metadata>
<Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true"/><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icons/128.png" Addressable="true"/></Assets></PackageManifest>'''
    (directory / "extension.vsixmanifest").write_text(manifest)
    (directory / "[Content_Types].xml").write_text('''<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="js" ContentType="application/javascript"/><Default Extension="html" ContentType="text/html"/><Default Extension="css" ContentType="text/css"/><Default Extension="md" ContentType="text/markdown"/><Default Extension="png" ContentType="image/png"/><Default Extension="vsixmanifest" ContentType="text/xml"/></Types>''')


def package_all(output):
    if output.resolve().is_relative_to(ROOT):
        raise ValueError("Build outputs must be outside the reviewed extension source directory")
    if output.exists():
        raise ValueError("Choose a new empty output path; existing release artifacts are preserved")
    output.mkdir(parents=True)
    with tempfile.TemporaryDirectory(prefix="gendragoon-extension-build-") as temporary:
        stage = Path(temporary)
        for browser in ("chrome", "edge", "firefox", "opera"):
            directory = stage / browser
            directory.mkdir()
            for name in ("dashboard.html", "dashboard.css", "dashboard.js", "native-client.js"):
                shutil.copyfile(ROOT / "browser" / name, directory / name)
            shutil.copyfile(ROOT / "shared/rpc.js", directory / "rpc.js")
            shutil.copyfile(ROOT / "shared/platform.js", directory / "platform.js")
            shutil.copyfile(ROOT / "browser" / f"manifest.{browser}.json", directory / "manifest.json")
            shutil.copyfile(ROOT / "PRIVACY.md", directory / "PRIVACY.md")
            icons(directory)
            teams(directory, "browser")
            archive(directory, output / f"gendragoon-{browser}-{VERSION}.zip")
        vsix = stage / "vsix"
        extension = vsix / "extension"
        (extension / "vscode").mkdir(parents=True)
        (extension / "shared").mkdir()
        package = json.loads((ROOT / "vscode/package.json").read_text())
        (extension / "package.json").write_text(json.dumps(package, indent=2) + "\n")
        for name in ("extension.cjs", "native-client.cjs"):
            shutil.copyfile(ROOT / "vscode" / name, extension / "vscode" / name)
        shutil.copyfile(ROOT / "shared/rpc.js", extension / "shared/rpc.js")
        for name in ("README.md", "PRIVACY.md"):
            shutil.copyfile(ROOT / name, extension / name)
        icons(extension)
        teams(extension, "vscode")
        vsix_metadata(vsix, package)
        archive(vsix, output / f"gendragoon-{VERSION}.vsix")
        source = stage / "source"
        for folder in (ROOT, NATIVE / "Collaboration"):
            for item in sorted(folder.rglob("*")):
                if item.is_file() and not item.is_symlink() and "__pycache__" not in item.parts and item.suffix != ".pyc":
                    target = source / item.relative_to(NATIVE.parent)
                    target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(item, target)
        helper = source / "native/Resources/gendragoon_native_bridge.py"
        helper.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(NATIVE / "Resources/gendragoon_native_bridge.py", helper)
        shutil.copyfile(NATIVE / "Resources/gendragoon_platform_ipc.py",helper.with_name("gendragoon_platform_ipc.py"))
        archive(source, output / f"gendragoon-extension-source-{VERSION}.zip")
    files = sorted(output.iterdir())
    (output / "SHA256SUMS").write_text("".join(hashlib.sha256(item.read_bytes()).hexdigest() + "  " + item.name + "\n" for item in files))
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    try:
        files = package_all(options.output.resolve())
    except (ValueError, OSError) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps({"version": VERSION, "artifacts": [str(item) for item in files], "checksums": str(options.output / "SHA256SUMS"), "published": False}, indent=2))


if __name__ == "__main__":
    main()
