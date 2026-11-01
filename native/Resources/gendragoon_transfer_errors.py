"""Allowlisted transfer diagnostics. Never copy exception text or request data."""
import os,sys
sys.dont_write_bytecode=True
os.environ["PYTHONDONTWRITEBYTECODE"]="1"
MESSAGES = {
    "session_expired": "The Red-XAI session expired. Reconnect and retry; verified chunks can be reused.",
    "session_renewal_failed": "The native app could not renew this Red-XAI session. Reconnect and retry.",
    "transport_unavailable": "The Receiver connection could not recover. Retry resumes verified chunks; originals were retained.",
    "receiver_unavailable": "The Receiver is temporarily unavailable. Retry resumes verified chunks; originals were retained.",
    "receiver_busy": "The transfer allowance stayed busy. Retry resumes verified chunks.",
    "storage_full": "The MachineNote storage quota is full. Originals were retained.",
    "item_not_found": "A required cloud item was not found. Originals were retained.",
    "request_rejected": "The Receiver rejected the operation. Originals were retained.",
    "transfer_invalid": "The encrypted transfer could not be verified. Originals were retained.",
    "helper_failed": "The cloud helper did not return a verified result; the selection and job were retained",
    "upload_failed": "Upload could not finish; the selection and job were retained",
    "offload_incomplete": "Cloud backup verified, but OS Trash did not confirm the offload. Check your cloud library and original before retrying.",
    "source_in_use": "Quit the selected application before moving it to Trash, or turn off Move originals to Trash to upload a backup while keeping it on this Mac.",
    "worker_interrupted": "The upload worker stopped. Its job and original files were retained.",
}
STATUSES = frozenset((400,401,402,403,404,408,409,422,425,429,500,502,503,504,507))


class TransferError(RuntimeError):
    def __init__(self, message, status=None, code=None):
        super().__init__(message)
        self.status = status
        self.failure_code = code or {401:"session_expired",404:"item_not_found",429:"receiver_busy",507:"storage_full"}.get(
            status, "receiver_unavailable" if status in (408,425,500,502,503,504) else "request_rejected" if status else "transfer_invalid")


def validate_failure(value):
    if not isinstance(value, dict) or value.get("code") not in MESSAGES:
        return None
    status = value.get("status")
    if status is not None and (type(status) is not int or status not in STATUSES):
        return None
    return {"code":value["code"], **({"status":status} if status is not None else {})}


def failure_for(error):
    return validate_failure({"code":error.failure_code,"status":error.status}) if isinstance(error, TransferError) else None


if __name__=="__main__":
    import argparse
    argparse.ArgumentParser(description="Allowlisted GenDragoon transfer diagnostics; imported by native helpers.").parse_args()
