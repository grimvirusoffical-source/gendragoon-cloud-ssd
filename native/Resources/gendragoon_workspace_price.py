"""Workspace price labels and lock scope.

Free wins, then Included, then the formatted server monthly price.
A 423 locks only the workspace the request addressed.
"""


def cents(value):
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return None


def format_cents(value):
    amount = int(value)
    sign = "-" if amount < 0 else ""
    whole = abs(amount)
    if whole % 100 == 0:
        return f"{sign}${whole // 100}/mo"
    return f"{sign}${whole / 100:.2f}/month"


def label(is_free, grandfathered, fee_waived, monthly_price_cents):
    if is_free:
        return "Free"
    if grandfathered or fee_waived:
        return "Included"
    if monthly_price_cents is None:
        return "Price pending"
    return format_cents(monthly_price_cents)


def is_zero_price(is_free, grandfathered, fee_waived):
    return bool(is_free) or bool(grandfathered) or bool(fee_waived)


def require_fee_waived(item):
    """feeWaived is always present. Missing or non-boolean values are rejected."""
    if not isinstance(item, dict) or not isinstance(item.get("feeWaived"), bool):
        raise ValueError("feeWaived is required")
    return item["feeWaived"]


def requires_grandfathered_byo_confirmation(is_free, grandfathered):
    return bool(grandfathered) and not bool(is_free)


def byo_confirmation_allows_submit(is_free, grandfathered, acknowledged):
    if requires_grandfathered_byo_confirmation(is_free, grandfathered):
        return bool(acknowledged)
    return True


def byo_register_price(body):
    if not isinstance(body, dict):
        return None
    if body.get("grandfatheringEnded") is not True or body.get("grandfathered") is not False:
        return None
    return cents(body.get("monthlyPriceCents"))


def grandfathered_byo_notice(response):
    price = byo_register_price(response)
    if price is None:
        return None
    return f"This workspace will no longer be Included. It will cost {format_cents(price)}."


def byo_registered_status(body):
    price = label(
        bool(body.get("isFree")),
        bool(body.get("grandfathered")),
        require_fee_waived(body),
        cents(body.get("monthlyPriceCents")),
    )
    status = body.get("projectStatus") or "active"
    payment = " Payment is required for this workspace." if body.get("lapsed") is True else ""
    return f"Bring-your-own storage registered. This workspace is {price}. Status: {status}.{payment}"


def workspace_id(path):
    parts = [part for part in str(path).split("/") if part]
    for marker in ("workspaces", "projects", "cloud"):
        if marker in parts:
            index = parts.index(marker)
            if index + 1 < len(parts):
                identifier = parts[index + 1]
                if identifier == "free" or len(identifier) == 36:
                    return identifier
    return None


def locked_workspace_ids(request_workspace_id, reason, unpaid):
    if request_workspace_id:
        return [request_workspace_id]
    if reason in {"lapsed", "over_cap_and_lapsed"}:
        return list(unpaid or [])
    return []


DELETING_TITLE = "Deleting…"
THREE_DAY_MS = 3 * 24 * 60 * 60 * 1000


def actions_enabled(project_status):
    return project_status != "deleting"


def demoted_workspace(body):
    """Grace banner for the workspace a merge or make-hosted demoted from free."""
    if not isinstance(body, dict) or not isinstance(body.get("demoted"), dict):
        return None
    demoted = body["demoted"]
    workspace_id = demoted.get("workspaceId")
    grace = demoted.get("graceEndsAt")
    paid = demoted.get("paidThroughMs")
    if not isinstance(workspace_id, str) or not workspace_id:
        return None
    if isinstance(grace, bool) or not isinstance(grace, (int, float)):
        return None
    if isinstance(paid, bool) or not isinstance(paid, (int, float)):
        paid = None
    return {
        "workspaceId": workspace_id,
        "graceEndsAt": int(grace),
        "paidThroughMs": None if paid is None else int(paid),
        "blocksTransfers": False,
        "banner": "Payment due",
        "otherWorkspacesLocked": False,
    }


def deletion_blocked(status, body):
    if status != 409 or not isinstance(body, dict):
        return None
    code = str(body.get("error") or body.get("code") or "").upper()
    if code == "WORKSPACE_BUSY":
        return "This workspace is busy, try again."
    if code == "MERGE_IN_PROGRESS":
        return "Finish or cancel the merge first."
    if code in {"PROJECT_HAS_PENDING_UPLOADS", "UPLOAD_IN_PROGRESS"}:
        return "Finish or cancel the upload first."
    if code in {"CHECKOUT_BUSY", "PAYMENT_PENDING", "CHECKOUT_IN_PROGRESS"}:
        return "Finish or cancel checkout first."
    activity = str(body.get("blocking") or body.get("inProgress") or "").lower()
    if activity == "merge":
        return "Finish or cancel the merge first."
    if activity == "upload":
        return "Finish or cancel the upload first."
    if activity == "checkout":
        return "Finish or cancel checkout first."
    return None
