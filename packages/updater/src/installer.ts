import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { silentInstallPlan } from "./update.js";

type SpawnLike = (file: string, args: string[], options: { detached: boolean; stdio: "ignore"; windowsHide: boolean }) => Pick<ChildProcess, "once" | "unref" | "pid">;

/**
 * Start the installer detached and return once it has really started.
 * It must outlive this process: the NSIS installer waits for the app to exit, replaces
 * it, and (with --force-run) starts the new version. Waiting for it here would deadlock
 * because the app that waits is the app it needs to close.
 */
export function startInstallerDetached(file: string, deps: { spawn?: SpawnLike } = {}): Promise<{ pid: number | undefined; args: readonly string[] }> {
  const plan = silentInstallPlan(file);
  const spawnImpl = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(plan.file, [...plan.args], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve({ pid: child.pid, args: plan.args });
    });
  });
}
