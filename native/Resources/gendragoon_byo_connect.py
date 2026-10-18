#!/usr/bin/env python3
"""Bring-your-own storage for launch.

Only S3-compatible stores connect: Amazon S3, Cloudflare R2, Backblaze B2,
Wasabi, MinIO, and Google Cloud through its S3/HMAC keys. SFTP, Azure, and
WebDAV stay visible as "Coming soon" and have no connect flow.

The Mac writes `.gendragoon-challenge/<nonce>` with the Keychain keys, sends a
presigned GET for that object, and deletes it only after the server confirms.
The nonce is not echoed back. The server fetches the URL, checks the host
against the registered endpoint, and derives the fingerprint itself. Changing
the endpoint or registering again must run a new challenge.

Registration of an unsupported provider, including SFTP, is 422
byo_provider_unsupported. 409 byo_unverifiable is only the fallback when the
server did not name that provider error.
The customer sees the monthly price the server returns for that workspace.
"""
import argparse
import datetime
import hashlib
import hmac
import os
import re
import sys
import urllib.parse

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

LAUNCH = {
    "aws": "Amazon S3",
    "s3": "Amazon S3",
    "r2": "Cloudflare R2",
    "b2": "Backblaze B2",
    "backblaze": "Backblaze B2",
    "wasabi": "Wasabi",
    "minio": "MinIO",
    "gcs": "Google Cloud via S3/HMAC keys",
}
COMING_SOON = {
    "sftp": "SFTP",
    "azure": "Azure",
    "webdav": "WebDAV",
}
MONTHLY_CENTS = 500
SECRET_FIELDS = {"accessKey", "secretAccessKey", "password", "privateKey", "secret", "token", "readBack", "nonce"}
ENDPOINT = re.compile(r"https://[A-Za-z0-9.-]{1,200}(?::[0-9]{2,5})?(?:/[A-Za-z0-9._~/-]{0,200})?")
NONCE = re.compile(r"[A-Za-z0-9_-]{16,128}")


class ConnectError(RuntimeError):
    def __init__(self, message, code=""):
        super().__init__(message)
        self.code = code


def catalog():
    rows = [{"id": key, "title": title, "available": True} for key, title in (
        ("s3", "Amazon S3"), ("r2", "Cloudflare R2"), ("b2", "Backblaze B2"),
        ("wasabi", "Wasabi"), ("minio", "MinIO"), ("gcs", "Google Cloud via S3/HMAC keys"),
    )]
    rows.extend({"id": key, "title": title, "available": False, "note": "Coming soon"}
                for key, title in COMING_SOON.items())
    return rows


def billing_provider(provider):
    key = str(provider or "").strip().lower()
    if key in COMING_SOON:
        raise ConnectError(coming_soon_message(key), "coming_soon")
    if key not in LAUNCH:
        raise ConnectError(unsupported_message(), "byo_provider_unsupported")
    return "s3"


def coming_soon_message(provider=""):
    title = COMING_SOON.get(str(provider or "").strip().lower(), "That provider")
    return f"{title} is coming soon. There is no connect flow for it yet."


def unsupported_message():
    return ("This provider is not supported. Choose Amazon S3, Cloudflare R2, "
            "Backblaze B2, Wasabi, MinIO, or Google Cloud with an S3/HMAC key.")


def unverifiable_message():
    return ("GenDragoon could not verify the challenge object from your bucket. "
            "Check the endpoint and keys, then run the challenge again.")


def explain_server(status, body):
    """Name a 422 provider error. Leave 409 for the verification fallback."""
    code = ""
    if isinstance(body, dict):
        code = str(body.get("error") or body.get("code") or "")
    if status == 422 or code == "byo_provider_unsupported":
        return {"code": "byo_provider_unsupported", "message": unsupported_message()}
    return None


def object_key(nonce):
    if not isinstance(nonce, str) or not NONCE.fullmatch(nonce):
        raise ConnectError("The activation challenge is invalid.")
    return ".gendragoon-challenge/" + nonce


def needs_challenge(saved, endpoint, bucket):
    """A new registration or a changed endpoint clears verification on the server."""
    if not isinstance(saved, dict) or saved.get("verified") is not True:
        return True
    return saved.get("endpoint") != endpoint or saved.get("bucket") != bucket


def register_body(provider, endpoint):
    billing_provider(provider)
    if not isinstance(endpoint, str) or not ENDPOINT.fullmatch(endpoint):
        raise ConnectError("Enter the https endpoint for this S3-compatible store.")
    body = {"provider": "s3", "endpoint": endpoint}
    if SECRET_FIELDS.intersection(body):
        raise ConnectError("Provider secrets are not sent to GenDragoon.")
    return body


def _sign(key, message):
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def presign_get(*, endpoint, bucket, nonce, access_key, secret_key, region, now=None, expires=300):
    """Query-signed GET. The secret stays out of the URL; the host is the registered endpoint."""
    billing_key_ok = isinstance(access_key, str) and access_key and isinstance(secret_key, str) and secret_key
    if not billing_key_ok:
        raise ConnectError("Save the access keys in the macOS Keychain first.")
    if secret_key == access_key:
        raise ConnectError("The Keychain secret is not usable.")
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        raise ConnectError("Enter the https endpoint for this S3-compatible store.")
    host = parsed.hostname if parsed.port in (None, 443) else f"{parsed.hostname}:{parsed.port}"
    key = object_key(nonce)
    if not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", bucket):
        raise ConnectError("Enter the bucket name.")
    now = now or datetime.datetime.now(datetime.timezone.utc)
    stamp = now.strftime("%Y%m%dT%H%M%SZ")
    day = stamp[:8]
    scope = f"{day}/{region}/s3/aws4_request"
    credential = f"{access_key}/{scope}"
    canonical_uri = "/" + "/".join(urllib.parse.quote(part, safe="") for part in (bucket, *key.split("/")))
    params = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": credential,
        "X-Amz-Date": stamp,
        "X-Amz-Expires": str(int(expires)),
        "X-Amz-SignedHeaders": "host",
    }
    query = "&".join(f"{urllib.parse.quote(name, safe='')}={urllib.parse.quote(params[name], safe='')}"
                     for name in sorted(params))
    canonical = "\n".join(("GET", canonical_uri, query, f"host:{host}\n", "host", "UNSIGNED-PAYLOAD"))
    to_sign = "\n".join(("AWS4-HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()))
    signing = _sign(_sign(_sign(_sign(("AWS4" + secret_key).encode("utf-8"), day), region), "s3"), "aws4_request")
    signature = hmac.new(signing, to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    url = f"{endpoint.rstrip('/')}{canonical_uri}?{query}&X-Amz-Signature={signature}"
    if secret_key in url:
        raise ConnectError("The Keychain secret must not appear in the challenge link.")
    return url


def verify_payload(presigned_url, nonce):
    """Send the link, not the nonce."""
    if not isinstance(presigned_url, str) or not presigned_url.startswith("https://"):
        raise ConnectError("The challenge link is missing.")
    if presigned_url.strip() == nonce or "readBack" in presigned_url:
        raise ConnectError("The challenge nonce is not sent back to GenDragoon.")
    if "/.gendragoon-challenge/" not in urllib.parse.urlsplit(presigned_url).path:
        raise ConnectError("The challenge link does not point at the challenge object.")
    body = {"presignedUrl": presigned_url}
    if SECRET_FIELDS.intersection(body) or "nonce" in body or "readBack" in body:
        raise ConnectError("The challenge nonce is not sent back to GenDragoon.")
    return body


def activate(provider, *, nonce, endpoint, bucket, access_key, secret_key, region,
             write, confirm, delete, now=None):
    """Write the object, send the presigned GET, delete only after the server confirms."""
    billing_provider(provider)
    key = object_key(nonce)
    write(key, nonce, {"accessKey": access_key, "secretKey": secret_key})
    url = presign_get(endpoint=endpoint, bucket=bucket, nonce=nonce, access_key=access_key,
                      secret_key=secret_key, region=region, now=now)
    payload = verify_payload(url, nonce)
    try:
        result = confirm(payload)
    except ConnectError:
        raise
    if not isinstance(result, dict) or result.get("verified") is not True:
        status = int(result.get("status") or 0) if isinstance(result, dict) else 0
        explained = explain_server(status, result if isinstance(result, dict) else {})
        if explained:
            raise ConnectError(explained["message"], explained["code"])
        # 409 byo_unverifiable, and any other failed check, use this fallback.
        raise ConnectError(unverifiable_message(), "byo_unverifiable")
    delete(key)
    return {"verified": True, "deleted": key, "presignedUrl": url, "monthlyCents": MONTHLY_CENTS}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Activate S3-compatible bring-your-own storage.")
    parser.add_argument("action", nargs="?", choices=("show",), default="show")
    parser.parse_args(argv)
    print("S3-compatible bring-your-own storage uses the monthly price returned for that workspace. SFTP, Azure, and WebDAV are coming soon.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
