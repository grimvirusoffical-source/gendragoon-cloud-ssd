/**
 * Pure pieces of macos/Resources/gendragoon_upload_workspace.py from
 * gendragoon-cloud-ssd @ 4cb71b5. The Windows client uploads through the
 * v3 workspace API; these checks remain for clients that still pick a
 * library prefix. They do not grant ownership.
 */

export interface LibraryDestination {
  project: string;
  bucket: string;
  remote: string;
  prefix: string;
}

const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/;
const REMOTE = /^[A-Za-z][A-Za-z0-9_-]{0,49}$/;
const IPV4 = /^[0-9]+(?:\.[0-9]+){3}$/;

export function libraryDestination(
  project: string,
  bucket: string,
  remote: string,
  prefix = "GenDragoon-App-Library",
): LibraryDestination {
  if (!PROJECT.test(project)) throw new Error("Choose an explicit Google Cloud project ID");
  if (!BUCKET.test(bucket) || bucket.includes("..") || IPV4.test(bucket)) {
    throw new Error("Choose an explicit bucket name");
  }
  if (!REMOTE.test(remote)) throw new Error("Choose an explicit configured cloud remote");
  if (prefix.includes("\\") || prefix.includes(":") || [...prefix].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error("Cloud prefix must be a relative folder path");
  }
  if (prefix && prefix.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("Cloud prefix must be a relative folder path");
  }
  return { project, bucket, remote, prefix };
}

/** Same construction as gendragoon_upload_workspace.library_key (sha256 hex, 18 chars). */
export async function libraryKey(destination: LibraryDestination, sourceName: string): Promise<string> {
  const folder = destination.prefix ? `${destination.bucket}/${destination.prefix}` : destination.bucket;
  const value = [destination.project, destination.bucket, destination.remote, folder, sourceName].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 18);
}
