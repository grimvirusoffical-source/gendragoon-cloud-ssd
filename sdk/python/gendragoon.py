"""GenDragoonSSD free workspace SDK — Python 3.10+, standard library only.
Store GENDRAGOON_API_KEY in an environment variable or secret manager.
Never embed API keys in public web/mobile client code.
"""
import json
import errno
import os
import shutil
import ssl
import tempfile
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import Request, HTTPRedirectHandler, HTTPSHandler, build_opener
from urllib.error import HTTPError
from uuid import UUID

DEFAULT_URL = "https://gendragoon-free-10068843866.us-central1.run.app"
CHUNK_SIZE = 8388608
TLS_CONTEXT = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.isfile('/etc/ssl/cert.pem') else ssl.create_default_context()


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never replay Authorization to another host or a downgraded endpoint.
        # The documented API streams bytes directly and needs no redirects.
        fp.close()
        raise HTTPError(req.full_url, code, "Redirects are not allowed", headers, None)


class GenDragoon:
    def __init__(self, api_key=None, base_url=DEFAULT_URL):
        self.key = api_key or os.environ["GENDRAGOON_API_KEY"]
        if not self.key.startswith("gdsk_"):
            raise ValueError("Expected a GenDragoon API key")
        endpoint = urlsplit(base_url)
        if (endpoint.scheme != "https" or not endpoint.hostname or endpoint.username is not None or
                endpoint.password is not None or endpoint.query or endpoint.fragment):
            raise ValueError("A credential-free HTTPS endpoint is required")
        self.base = base_url.rstrip("/")
        self._opener = build_opener(HTTPSHandler(context=TLS_CONTEXT), _NoRedirect())

    def _request(self, method, path, payload=None, content_type=None):
        headers = {"Authorization": "Bearer " + self.key}
        body = None
        if payload is not None:
            if isinstance(payload, bytes):
                body = payload
                headers["Content-Type"] = content_type or "application/octet-stream"
            else:
                body = json.dumps(payload).encode("utf-8")
                headers["Content-Type"] = "application/json"
        req = Request(self.base + path, data=body, headers=headers, method=method)
        try:
            with self._opener.open(req, timeout=240) as response:
                data = response.read()
                if response.headers.get("Content-Type", "").startswith("application/json"):
                    return json.loads(data)
                return data
        except HTTPError as err:
            with err:
                explanation = err.read(1000).decode("utf-8", "replace")
                explanation = explanation.replace(self.key, "[REDACTED]")[:1000]
                for length in range(min(len(self.key) - 1, len(explanation)), 0, -1):
                    if explanation.endswith(self.key[:length]):
                        explanation = explanation[:-length] + "[REDACTED]"
                        break
            raise RuntimeError("GenDragoon HTTP %s: %s" % (err.code, explanation)) from err

    def status(self):
        return self._request("GET", "/v1/me")

    def list_files(self):
        return self._request("GET", "/v1/files")

    def upload(self, filename):
        path = Path(filename)
        size = path.stat().st_size
        info = self._request("POST", "/v1/uploads",
                             {"name": path.name, "sizeBytes": size})
        uid = info["uploadId"]
        block = info["chunkBytes"]
        with path.open("rb") as fd:
            for index in range(info["totalChunks"]):
                chunk = fd.read(block)
                self._request("PUT", "/v1/uploads/%s/chunks/%s" % (uid, index),
                              chunk, "application/octet-stream")
        return self._request("POST", "/v1/uploads/%s/finalize" % uid, {})

    def download(self, file_id, destination):
        fid = str(UUID(str(file_id)))
        out = Path(destination)
        headers = {"Authorization": "Bearer " + self.key, "Accept-Encoding": "identity"}
        req = Request(self.base + "/v1/files/" + fid + "/download", headers=headers)
        try:
            out.lstat()
        except FileNotFoundError:
            pass
        else:
            raise FileExistsError(errno.EEXIST, "Download destination already exists", str(out))
        staging = Path(tempfile.mkdtemp(prefix=".gendragoon-download-", dir=out.absolute().parent))
        partial = staging / "payload"
        try:
            descriptor = os.open(partial, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as fd:
                try:
                    response = self._opener.open(req, timeout=240)
                except HTTPError as error:
                    error.close()
                    raise
                with response:
                    encodings = response.headers.get_all("Content-Encoding", [])
                    if len(encodings) > 1 or (encodings and encodings[0].strip().lower() != "identity"):
                        raise RuntimeError("Encoded download response is not supported")
                    lengths = response.headers.get_all("Content-Length", [])
                    if lengths and (len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit()):
                        raise RuntimeError("Invalid download Content-Length")
                    expected = int(lengths[0]) if lengths else None
                    received = 0
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        received += len(block)
                        if expected is not None and received > expected:
                            raise RuntimeError("Download exceeds its Content-Length")
                        fd.write(block)
                    if expected is not None and received != expected:
                        raise RuntimeError("Incomplete download")
                fd.flush()
                os.fsync(fd.fileno())
            # Hard-link publication fails atomically if another operation has
            # created the destination. Partial bytes never become the output.
            os.link(partial, out)
        finally:
            shutil.rmtree(staging)
        return out

    def delete(self, file_id):
        fid = str(UUID(str(file_id)))
        return self._request("DELETE", "/v1/files/%s" % fid)

if __name__ == "__main__":
    client = GenDragoon()
    for entry in client.list_files()["files"]:
        print(entry["id"], entry["name"], entry["sizeBytes"])
