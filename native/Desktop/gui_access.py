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


def visible_pages(is_mounted):
    return ("Home", "Files", "Teams", "Storage keys", "Account") if is_mounted else ("Home", "Account")
