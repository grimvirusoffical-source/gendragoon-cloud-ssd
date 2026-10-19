// Change events by polling. The server has no webhook or stream (capabilities.events): watch() polls /usage
// for changeSeq and lists manifests only when it moved (or every resyncEveryMs).
import { isUnauthorized, type Client, type Usage } from "./client.js";

export type EventType = "manifest.created" | "manifest.updated" | "manifest.deleted" | "usage.changed" | "binding.revoked";
export interface ChangeEvent { type: EventType; key?: string; generation?: string | null; usage?: Usage }
export interface WatchOptions {
  /** Between /usage polls. Default 5000, minimum 1000. */
  intervalMs?: number;
  /** Full manifest listing even when changeSeq did not move. Default 10 minutes. */
  resyncEveryMs?: number;
  /** Only manifest events for these keys (for example one drive's manifestKey). */
  keys?: string[];
  signal?: AbortSignal;
}

/**
 * Yields changes until the signal aborts or the binding is revoked. The first poll records the current
 * state and yields nothing. Level L2, risk read.
 */
export async function* watch(c: Client, opts: WatchOptions = {}): AsyncGenerator<ChangeEvent> {
  c.check("events.watch");
  const interval = Math.max(opts.intervalMs ?? 5000, 1000);
  const resync = opts.resyncEveryMs ?? 600_000;
  const filter = opts.keys?.length ? new Set(opts.keys) : null;
  let seen: Map<string, string | null> | null = null;
  let last: Usage | null = null;
  let lastList = 0;
  while (!opts.signal?.aborted) {
    let u: Usage | null = null;
    try {
      u = await c.usage();
    } catch (e) {
      if (isUnauthorized(e)) { yield { type: "binding.revoked" }; return; }
    }
    if (u) {
      if (last && (u.usedBytes !== last.usedBytes || u.objectCount !== last.objectCount || u.quotaBytes !== last.quotaBytes)) yield { type: "usage.changed", usage: u };
      if (!last || u.changeSeq !== last.changeSeq || Date.now() - lastList >= resync) {
        try {
          const now = new Map<string, string | null>();
          for (const it of await c.allManifests()) if (!filter || filter.has(it.id)) now.set(it.id, it.generation);
          lastList = Date.now();
          if (seen) {
            for (const k of [...now.keys()].sort()) {
              if (!seen.has(k)) yield { type: "manifest.created", key: k, generation: now.get(k) };
              else if (seen.get(k) !== now.get(k)) yield { type: "manifest.updated", key: k, generation: now.get(k) };
            }
            for (const k of [...seen.keys()].sort()) if (!now.has(k)) yield { type: "manifest.deleted", key: k };
          }
          seen = now;
        } catch { /* retried on the next poll */ }
      }
      last = u;
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, interval);
      opts.signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}
