// GenDragoonSSD free workspace SDK — Node.js 20+ (server-side ONLY).
// Never put gdsk_ API keys into front-end/browser JavaScript or a public repo.
import fs from "node:fs";
import {link, lstat, mkdtemp, open, rm} from "node:fs/promises";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {pipeline} from "node:stream/promises";
import {Readable, Transform} from "node:stream";

const BASE = "https://gendragoon-free-10068843866.us-central1.run.app";
export class GenDragoon {
  constructor(key = process.env.GENDRAGOON_API_KEY, base = BASE) {
    if (typeof key !== "string" || !key.startsWith("gdsk_")) throw Error("Set GENDRAGOON_API_KEY");
    const endpoint = new URL(base);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw Error("A credential-free HTTPS endpoint is required");
    this.key = key;
    this.base = base.replace(/\/$/, "");
  }
  async request(method, path, body, contentType) {
    const response = await this._response(method, path, body, contentType);
    if (response.headers.get("content-type")?.includes("application/json"))
      return response.json();
    return response;
  }
  async _response(method, path, body, contentType, extraHeaders = {}) {
    const headers = {...extraHeaders, Authorization: "Bearer " + this.key};
    if (body != null) {
      headers["Content-Type"] = contentType || (Buffer.isBuffer(body) ?
        "application/octet-stream" : "application/json");
    }
    const response = await fetch(this.base + path, {
      method, headers, body: body == null ? undefined :
        (Buffer.isBuffer(body) ? body : JSON.stringify(body)),
      signal: AbortSignal.timeout(240_000),
      // Reject redirects before following them, including same-origin redirects.
      // API credentials must never reach another origin or an HTTP endpoint.
      redirect: "error"
    });
    if (!response.ok) {
      const reader = response.body?.getReader();
      const chunks = [];
      let remaining = 800;
      try {
        while (reader && remaining > 0) {
          const {done, value} = await reader.read();
          if (done) break;
          const chunk = Buffer.from(value).subarray(0, remaining);
          chunks.push(chunk);
          remaining -= chunk.length;
        }
      } finally {
        if (reader) await reader.cancel().catch(() => {});
      }
      let explanation = Buffer.concat(chunks).toString("utf8").replaceAll(this.key, "[REDACTED]").slice(0, 800);
      // A bounded read may cut an echoed token in half. Also scrub a trailing
      // token prefix, including after earlier replacements shortened the body.
      for (let length = Math.min(this.key.length - 1, explanation.length); length > 0; length--) {
        if (explanation.endsWith(this.key.slice(0, length))) {
          explanation = explanation.slice(0, -length) + "[REDACTED]";
          break;
        }
      }
      throw Error("GenDragoon HTTP " + response.status + ": " + explanation);
    }
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
    const target = resolve(destination instanceof URL ? fileURLToPath(destination) : destination);
    try {
      await lstat(target);
      throw Object.assign(Error("Download destination already exists"), {code: "EEXIST"});
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    const staging = await mkdtemp(join(dirname(target), ".gendragoon-download-"));
    const partial = join(staging, "payload");
    let response;
    try {
      response = await this._response("GET",
        "/v1/files/" + encodeURIComponent(id) + "/download", undefined, undefined,
        {"Accept-Encoding": "identity"});
      if (!response.body) throw Error("Download response has no body");
      const encoding = response.headers.get("content-encoding");
      if (encoding && encoding.toLowerCase().trim() !== "identity")
        throw Error("Encoded download response is not supported");
      const lengthHeader = response.headers.get("content-length");
      let expected;
      if (lengthHeader !== null) {
        if (!/^\d+$/.test(lengthHeader) || !Number.isSafeInteger(Number(lengthHeader)))
          throw Error("Invalid download Content-Length");
        expected = Number(lengthHeader);
      }
      let received = 0;
      const counter = new Transform({
        transform(chunk, encoding, callback) {
          received += chunk.length;
          if (!Number.isSafeInteger(received) || (expected !== undefined && received > expected))
            callback(Error("Download exceeds its Content-Length"));
          else callback(null, chunk);
        },
        flush(callback) {
          callback(expected !== undefined && received !== expected ? Error("Incomplete download") : null);
        }
      });
      // Attach stream error handlers immediately; creating a stream and then
      // awaiting a network request can otherwise emit an unhandled fs error.
      const output = fs.createWriteStream(partial, {flags: "wx", mode: 0o600});
      await pipeline(Readable.fromWeb(response.body), counter, output);
      // Atomic no-overwrite publication also protects against a destination
      // created while this request was running. Never unlink a caller's path.
      await link(partial, target);
      return destination;
    } finally {
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
      await rm(staging, {recursive: true, force: true});
    }
  }
  delete(id) {
    return this.request("DELETE", "/v1/files/" + encodeURIComponent(id));
  }
}
