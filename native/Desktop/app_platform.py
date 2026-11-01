"""Display capabilities only; the launch broker still verifies PE/ELF + architecture."""
from pathlib import Path
import platform
import sys

INSTALLERS = {'.msi', '.msix', '.msixbundle', '.appx', '.appxbundle', '.deb', '.rpm', '.dmg', '.pkg', '.apk', '.ipa', '.aab'}


def host_platform():
    return 'windows' if sys.platform == 'win32' else 'linux' if sys.platform.startswith('linux') else 'macos' if sys.platform == 'darwin' else 'unknown'


def capabilities():
    system = host_platform()
    arch = {'amd64': 'x86_64', 'aarch64': 'arm64'}.get(platform.machine().lower(), platform.machine().lower())
    return {'platform': system, 'architecture': arch, 'deviceType': 'desktop',
            'nativeAppControl': system in ('windows', 'linux'), 'launchMode': 'kamatera-mounted'}


def playable(item, system=None):
    system = system or host_platform()
    if system not in ('windows', 'linux') or not isinstance(item, dict) or item.get('virtualFolder'):
        return False
    name = str(item.get('name', ''))
    suffix = Path(name).suffix.lower()
    if suffix in INSTALLERS or item.get('kind') == 'app':
        return False
    target = item.get('applicationPlatform')
    if target and target != system:
        return False
    if suffix == '.exe':
        return system == 'windows'
    if suffix == '.appimage':
        return system == 'linux'
    # Folder backups may contain a native portable binary; show a review action,
    # but never accept metadata alone as authority to execute it.
    return item.get('kind') == 'folder' or target == system or system == 'linux' and not suffix


def public_sessions(leases, receiver, workspace=None):
    result = []
    for row in leases:
        binding = row.get('identity', {})
        if (binding.get('receiverId') != receiver
                or workspace is not None and binding.get('workspaceId') != workspace):
            continue
        if row.get('state') not in ('running', 'pending', 'uncertain'):
            continue
        result.append({'id': row.get('id'), 'key': binding.get('key'),
                       'workspaceId': binding.get('workspaceId'), 'state': row['state']})
    return result
