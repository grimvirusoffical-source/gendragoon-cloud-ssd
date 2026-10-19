export interface DownloadProgress {
  receivedBytes: number;
  /** null when the server sent no Content-Length. */
  totalBytes: number | null;
}

/**
 * Download a URL into memory, reporting progress as chunks arrive. Throws on a
 * non-2xx status, a network failure, a short body (Content-Length mismatch), or abort.
 */
export async function downloadWithProgress(
  url: string,
  onProgress: (progress: DownloadProgress) => void,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: options.signal, headers: { "User-Agent": "gendragoon-updater" } });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error("Download failed: network error");
  }
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length"));
  const totalBytes = Number.isFinite(declared) && declared > 0 ? declared : null;
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;
  onProgress({ receivedBytes, totalBytes });
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    onProgress({ receivedBytes: whole.byteLength, totalBytes: totalBytes ?? whole.byteLength });
    return whole;
  }
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    receivedBytes += value.byteLength;
    onProgress({ receivedBytes, totalBytes });
  }
  if (totalBytes !== null && receivedBytes !== totalBytes) throw new Error("Download failed: incomplete file");
  const out = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
