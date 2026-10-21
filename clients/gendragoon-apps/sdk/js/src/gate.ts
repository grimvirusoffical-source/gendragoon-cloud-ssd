/** Rotten Apple developer unlock levels (SPEC §9.2). data.storage is an L2 service. */
export type Level = "L0" | "L1" | "L2" | "L3" | "L4";
export type Risk = "read" | "write" | "credential" | "destructive" | "bulk-destructive" | "key" | "key-export" | "sharing" | "billing";

export interface Operation {
  readonly id: string;
  readonly level: Level;
  /** Rotten Apple service id the call belongs to ("data.storage" or "gendragoon"). */
  readonly service: "data.storage" | "gendragoon";
  readonly risk: Risk;
  /** "app" (API key), "user" (signed-in account) or "local" (no network). */
  readonly context: "app" | "user" | "local";
  readonly method: string;
  readonly path: string;
  readonly scope: string;
  readonly summary: string;
}

/** Called before every operation. Throw to refuse it. */
export type Gate = (op: Operation) => void;

export const DEFAULT_MAX_LEVEL: Level = "L3";
/** A host (the Rotten Apple launcher) sets this to cap the level. It can only lower the cap. */
export const MAX_LEVEL_ENV = "GENDRAGOON_SDK_MAX_LEVEL";

export function parseLevel(value: string): Level {
  const t = value.trim().toUpperCase().replace(/^L/, "");
  if (/^[0-4]$/.test(t)) return `L${t}` as Level;
  throw new Error(`gendragoon: unknown level "${value}"`);
}

const rank = (l: Level) => Number(l.slice(1));

export class LevelError extends Error {
  constructor(readonly op: Operation, readonly allowed: Level) {
    super(`gendragoon: ${op.id} needs ${op.level} (${op.risk}); this client allows up to ${allowed}`);
    this.name = "LevelError";
  }
}

function envCap(): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  return g.process?.env?.[MAX_LEVEL_ENV];
}

/** Allows operations at or below max, lowered further by GENDRAGOON_SDK_MAX_LEVEL. An unreadable value locks to L0. */
export function levelGate(max: Level = DEFAULT_MAX_LEVEL): Gate {
  let eff = max;
  const env = envCap();
  if (env !== undefined) {
    try {
      const l = parseLevel(env);
      if (rank(l) < rank(eff)) eff = l;
    } catch {
      eff = "L0";
    }
  }
  return (op) => {
    if (rank(op.level) > rank(eff)) throw new LevelError(op, eff);
  };
}
