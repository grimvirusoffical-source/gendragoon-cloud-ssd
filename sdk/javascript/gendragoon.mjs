// GenDragoonSSD free workspace SDK — Node.js 20+ (server-side ONLY).
// Never put gdsk_ API keys into front-end/browser JavaScript or a public repo.
import fs from "node:fs";
import {open} from "node:fs/promises";
import {basename} from "node:path";
import {pipeline} from "node:stream/promises";
import {Readable} from "node:stream";

const BASE = "https://gendragoon-free-10068843866.us-central1.run.app";
export class GenDragoon {
  constructor(key = process.env.GENDRAGOON_API_KEY, base = BASE) {
    if (!key?.startsWith("gdsk_")) throw Error("Set GENDRAGOON_API_KEY");
    if (!base.startsWith("https://")) throw Error("HTTPS endpoint required");
    this.key = key;
    this.base = base.replace(/\/$/, "");
  }
  async request(method, path, body, contentType) {
    const headers = {Authorization: "Bearer " + this.key};
    if (body != null) {
      headers["Content-Type"] = contentType || (Buffer.isBuffer(body) ?
        "application/octet-stream" : "application/json");
    }
    const response = await fetch(this.base + path, {
      method, headers, body: body == null ? undefined :
        (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(240_000)
    });
    if (!response.ok) throw Error("GenDragoon HTTP " + response.status +
      ": " + (await response.text()).slice(0, 800));
    if (response.headers.get("content-type")?.includes("application/json"))
      return response.json();
    return response;
  }
  status() {return this.request("GET", "/v1/me");}
  listFiles() {return this.request("GET", "/v1/files");}
  async upload(filename) {
    const file = await open(filename, "r");
    try {
      const size = (await file.stat()).size;
      const session = await this.request("POST", "/v1/uploads",
        {name: basename(filename), sizeBytes: size});
      for (let i=0; i < session.totalChunks; i++) {
        const len = Math.min(session.chunkBytes, size - i * session.chunkBytes);
        const part = Buffer.allocUnsafe(len);
        const {bytesRead} = await file.read(part, 0, len, i * session.chunkBytes);
        if (bytesRead !== len) throw Error("Source file changed during upload");
        await this.request("PUT",
          "/v1/uploads/" + session.uploadId + "/chunks/" + i, part);
      }
      return this.request("POST",
        "/v1/uploads/" + session.uploadId + "/finalize", {});
    } finally {await file.close();}
  }
  async download(id, destination) {
    // Exclusive creation prevents overwriting the caller's existing files.
    const output = fs.createWriteStream(destination, {flags:"wx",mode:0o600});
    try {
      const response = await this.request("GET",
        "/v1/files/" + encodeURIComponent(id) + "/download");
      await pipeline(Readable.fromWeb(response.body), output);
      return destination;
    } catch(err) {
      output.destroy();
      try {await fs.promises.unlink(destination);} catch (_) {}
      throw err;
    }
  }
  delete(id) {
    return this.request("DELETE", "/v1/files/" + encodeURIComponent(id));
  }
}
