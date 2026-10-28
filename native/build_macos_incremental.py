#!/usr/bin/env python3
"""Rebuild GenDragoon code while reusing an unchanged, verified vendor runtime.

Only a stopped, Developer-ID-signed, notarized base with the exact pinned codec
manifest is accepted. APFS copy-on-write avoids a second full runtime download.
No files in the installed base or in another repository are changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import sys

sys.dont_write_bytecode = True
import build_macos as build
import package_macos as package

REQUIREMENT = ('anchor apple generic and identifier "app.gendragoon.cloudssd"'
    ' and certificate leaf[subject.OU] = "NZPU8H843J"'
    ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')

def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()

def stage(base, output):
    if sys.platform != 'darwin':
        raise RuntimeError('This target requires macOS and the installed Xcode toolchain')
    for path in (base, *base.parents, output, *output.parents):
        if path.is_symlink():
            raise RuntimeError('Build paths must not traverse symbolic links')
    if not base.is_absolute() or not output.is_absolute() or base.name != build.NAME:
        raise RuntimeError('Absolute paths and the expected application name are required')
    if output == base or base in output.parents or output in base.parents:
        raise RuntimeError('The staging folder must be separate from the installed bundle')
    build.run(['/usr/bin/codesign', '--verify', '--deep', '--strict', '-R', '='+REQUIREMENT, base])
    build.run(['/usr/sbin/spctl', '--assess', '--type', 'execute', base])
    build.run(['/usr/bin/xcrun', 'stapler', 'validate', base])
    package.validate_compiled_runtime(base/"Contents/Resources")
    for name in (*package.REQUIRED_RESOURCES, *package.RED_SECRETS_RESOURCES):
        if name == "gendragoon_signed_device.py": continue  # Added by this build.
        resource=base/"Contents/Resources"/name
        if resource.is_symlink() or not resource.is_file() or resource.stat().st_size == 0:
            raise RuntimeError("Base runtime resource missing: "+name)
    package.reject_python_caches(base)
    source_resources = base/'Contents/Resources'
    manifest = json.loads((source_resources/'gendragoon_python_runtime.json').read_text())
    if manifest.get('pinnedLibrary') != build.RED_SECRETS_COMMIT:
        raise RuntimeError('Pinned Red-SecretsXAI runtime mismatch')
    vendor_files = [p for parent in ('redxai','redsecretsxai','numpy','PIL')
                    for p in (source_resources/parent).rglob('*') if p.is_file()]
    vendor_hashes = {str(p.relative_to(source_resources)):digest(p) for p in vendor_files}
    info = plistlib.loads((base/'Contents/Info.plist').read_bytes())
    if info.get('CFBundleIdentifier') != 'app.gendragoon.cloudssd':
        raise RuntimeError('Incorrect base bundle identifier')
    if int(build.BUILD) <= int(info['CFBundleVersion']):
        raise RuntimeError('The test build must have a newer build number')
    if build.run([source_resources/'rclone','version']).splitlines()[0] != 'rclone v1.75.2':
        raise RuntimeError('Unexpected base rclone runtime')
    if shutil.disk_usage(base.parent).free < 256*1024**2:
        raise RuntimeError('Insufficient disk headroom for the incremental build')
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    if output.stat().st_uid != os.getuid() or output.stat().st_mode & 0o022:
        raise RuntimeError('Use a private current-user staging folder')
    app = output/build.NAME
    if app.exists():
        raise RuntimeError('Staged bundle already exists; use a fresh folder')
    print('Verified notarized base and pinned vendor runtime; staging a separate copy.',flush=True)
    build.run(['/bin/cp','-cR',base,app])
    resources = app/'Contents/Resources'
    for source in (build.ROOT/'Resources').iterdir():
        if source.is_file() and not source.is_symlink() and source.suffix in ('.py','.js','.json','.txt','.html','.css'):
            if source.name == 'gendragoon_python_runtime.json':
                raise RuntimeError('Generated vendor manifest must not come from unverified source')
            shutil.copy2(source,resources/source.name)
    collaboration = resources/'GenDragoonTeams'
    if collaboration.is_symlink():
        raise RuntimeError('Linked collaboration resources')
    if collaboration.exists():
        shutil.rmtree(collaboration)
    collaboration.mkdir()
    for name in ('index.html','teams.css','teams-ui.js','dev-peer.js'):
        source = build.ROOT/'Collaboration'/name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Missing collaboration resource')
        shutil.copy2(source,collaboration/name)
    shutil.copy2(build.ROOT/'Backend/performance_profiles.json',resources/'gendragoon_performance_profiles.json')
    for retired in ('gendragoon_updates.py','release-repo.json'):
        (resources/retired).unlink(missing_ok=True)
    package.require_runtime_resources(app)
    package.reject_python_caches(app)
    for relative,expected in vendor_hashes.items():
        if digest(resources/relative) != expected:
            raise RuntimeError('Vendor runtime changed during staging: '+relative)
    binary = app/'Contents/MacOS/GenDragoon Cloud SSD'
    sources = sorted((build.ROOT/'Sources').glob('*.swift'))
    print('Compiling the complete native app from current GenDragoon source.',flush=True)
    build.run(['/usr/bin/xcrun','swiftc','-parse-as-library','-O','-whole-module-optimization',
               '-sdk',build.swift_sdk(),'-target','arm64-apple-macosx14.0',
               '-framework','SwiftUI','-framework','AppKit','-o',binary,*sources],timeout=900)
    base_version=info.get('CFBundleShortVersionString')
    info.update(CFBundleShortVersionString=build.VERSION,CFBundleVersion=build.BUILD,LSMinimumSystemVersion='14.0')
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    build.run(['/usr/bin/xattr','-cr',app])
    build.run(['/usr/bin/codesign','--force','--options','runtime','--timestamp','--sign',build.IDENTITY,app])
    build.run(['/usr/bin/codesign','--verify','--deep','--strict','-R','='+REQUIREMENT,app])
    package.require_runtime_resources(app)
    package.reject_python_caches(app)
    # Signing the outer bundle must not alter the reused, pinned crypto/runtime.
    for relative,expected in vendor_hashes.items():
        if digest(resources/relative) != expected:
            raise RuntimeError('Unchanged vendor hash verification failed: '+relative)
    receipt={'version':build.VERSION,'build':build.BUILD,'baseVersion':base_version,
             'baseApp':str(base),'app':str(app),'vendorFilesVerifiedUnchanged':len(vendor_hashes),
             'pinnedLibrary':build.RED_SECRETS_COMMIT,'developerIDVerified':True,'notarized':False}
    (output/'incremental-build-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps(receipt),flush=True)

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base-app',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    stage(args.base_app.absolute(),args.output.absolute())
