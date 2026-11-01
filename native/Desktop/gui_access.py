"""UI navigation policy; backend authentication and permissions stay authoritative."""
import re

_RECEIVER = re.compile(r"[a-f0-9]{64}\Z")
_NOTE = re.compile(r"[a-f0-9]{32}\Z")


def mount_ready(records, receiver, notes):
    """Require a confirmed mount for a note listed under the signed-in account."""
    if not isinstance(receiver, str) or not _RECEIVER.fullmatch(receiver):
        return False
    permitted = {
        item["id"] for item in notes
        if isinstance(item, dict) and isinstance(item.get("id"), str)
        and _NOTE.fullmatch(item["id"])
    }
    return any(
        isinstance(item, dict) and item.get("receiverId") == receiver
        and item.get("workspaceId") in permitted and item.get("state") == "mounted"
        for item in records
    ) if isinstance(records, (list, tuple)) else False


def selected_mount_ready(records, receiver, workspace, notes):
    """A mounted drive counts only for the currently selected owned MachineNote."""
    if not isinstance(workspace, str) or not _NOTE.fullmatch(workspace):
        return False
    permitted = {
        item["id"] for item in notes
        if isinstance(item, dict) and isinstance(item.get("id"), str)
        and _NOTE.fullmatch(item["id"])
    }
    if workspace not in permitted or not isinstance(receiver, str) or not _RECEIVER.fullmatch(receiver):
        return False
    return any(
        isinstance(item, dict) and item.get("receiverId") == receiver
        and item.get("workspaceId") == workspace and item.get("state") == "mounted"
        for item in records
    ) if isinstance(records, (list, tuple)) else False


def workspace_ready(records, receiver, workspace, notes, signed_receiver, signed_workspace, signed):
    return (selected_mount_ready(records, receiver, workspace, notes)
            and signed is True and signed_receiver == receiver and signed_workspace == workspace)


def visible_pages(is_mounted, is_signed=True):
    return ("Home", "Files", "Teams", "Storage keys", "Account") if is_mounted and is_signed else ("Home", "Account")
