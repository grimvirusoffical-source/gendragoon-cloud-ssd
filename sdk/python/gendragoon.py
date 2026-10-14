"""GenDragoonSSD free workspace SDK — Python 3.10+, standard library only.
Store GENDRAGOON_API_KEY in an environment variable or secret manager.
Never embed API keys in public web/mobile client code.
"""
import json
import os
import ssl
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError

DEFAULT_URL = "https://gendragoon-free-10068843866.us-central1.run.app"
CHUNK_SIZE = 8388608
TLS_CONTEXT = ssl.create_default_context(cafile='/etc/ssl/cert.pem') if os.path.isfile('/etc/ssl/cert.pem') else ssl.create_default_context()

class GenDragoon:
    def __init__(self, api_key=None, base_url=DEFAULT_URL):
        self.key = api_key or os.environ["GENDRAGOON_API_KEY"]
        if not self.key.startswith("gdsk_"):
            raise ValueError("Expected a GenDragoon API key")
        if not base_url.startswith("https://"):
            raise ValueError("HTTPS is required")
        self.base = base_url.rstrip("/")

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
            with urlopen(req, timeout=240, context=TLS_CONTEXT) as response:
                data = response.read()
                if response.headers.get("Content-Type", "").startswith("application/json"):
                    return json.loads(data)
                return data
        except HTTPError as err:
            explanation = err.read(1000).decode("utf-8", "replace")
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
        from uuid import UUID
        fid = str(UUID(str(file_id)))
        out = Path(destination)
        headers = {"Authorization": "Bearer " + self.key}
        req = Request(self.base + "/v1/files/" + fid + "/download", headers=headers)
        # Never overwrite existing paths or hold the entire download in memory.
        with out.open("xb") as fd:
            try:
                with urlopen(req, timeout=240, context=TLS_CONTEXT) as response:
                    while True:
                        block = response.read(1024 * 1024)
                        if not block:
                            break
                        fd.write(block)
            except Exception:
                fd.close()
                out.unlink(missing_ok=True)
                raise
        return out

    def delete(self, file_id):
        return self._request("DELETE", "/v1/files/%s" % file_id)

if __name__ == "__main__":
    client = GenDragoon()
    for entry in client.list_files()["files"]:
        print(entry["id"], entry["name"], entry["sizeBytes"])
