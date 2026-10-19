export type ServiceStatus = { state: "online"; ms: number } | { state: "offline"; reason: string };

/** Public health probe. Sends no credentials and no user data. */
export async function probeService(apiBase: string, fetchImpl: typeof fetch = fetch, timeoutMs = 6000): Promise<ServiceStatus> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${apiBase.replace(/\/+$/, "")}/health`, { signal: controller.signal, credentials: "omit", cache: "no-store" });
    if (!response.ok) return { state: "offline", reason: `Service answered ${response.status}` };
    const body = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    if (body?.ok !== true) return { state: "offline", reason: "Service is not ready" };
    return { state: "online", ms: Date.now() - started };
  } catch (error) {
    return { state: "offline", reason: (error as Error)?.name === "AbortError" ? "Timed out" : "Can't reach the service" };
  } finally {
    clearTimeout(timer);
  }
}
