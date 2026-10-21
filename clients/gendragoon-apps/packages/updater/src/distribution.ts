/**
 * Distribution channel = HOW the user got the app (not the stable/beta release channel).
 *  - direct:       GitHub install. Self-updates from the GitHub release feed and relaunches.
 *  - rotten-apple: installed from the Rotten Apple store (.rarxai) through its launcher. The launcher updates it; the app never self-updates.
 *  - mas:          Mac App Store. Apple forbids self-update, so update code never runs and the UI is hidden.
 */
export type Distribution = "direct" | "rotten-apple" | "mas";

export type UpdateUiMode = "full" | "managed" | "hidden";

export interface UpdatePolicy {
  distribution: Distribution;
  /** May the app download and install a new version itself? */
  selfUpdate: boolean;
  /** full = Check button + progress; managed = read-only note; hidden = nothing at all. */
  ui: UpdateUiMode;
  /** Shown for "managed" mode. */
  note?: string;
}

export interface DetectInput {
  /** Baked in at build time (GENDRAGOON_DISTRIBUTION). */
  buildFlag?: string;
  /** Electron sets process.mas in a Mac App Store build. */
  mas?: boolean;
  env?: Record<string, string | undefined>;
  /** app.isPackaged. The env override below is ignored for packaged apps. */
  packaged?: boolean;
}

const KNOWN: readonly Distribution[] = ["direct", "rotten-apple", "mas"];
const asDistribution = (value: string | undefined): Distribution | null =>
  value && (KNOWN as readonly string[]).includes(value) ? (value as Distribution) : null;

/**
 * Precedence: Mac App Store always wins (a store build must never self-update, whatever the env says),
 * then an explicit non-direct build flag, then a launcher marker, then an env override for unpackaged
 * (development/test) runs only, then "direct".
 */
export function detectDistribution(input: DetectInput = {}): Distribution {
  const env = input.env ?? {};
  const flag = asDistribution(input.buildFlag);
  if (input.mas === true || flag === "mas") return "mas";
  if (flag === "rotten-apple") return "rotten-apple";
  if (env.ROTTEN_APPLE_LAUNCHER === "1") return "rotten-apple";
  if (input.packaged !== true) {
    const override = asDistribution(env.GENDRAGOON_DISTRIBUTION);
    if (override) return override;
  }
  return "direct";
}

export function updatePolicy(distribution: Distribution): UpdatePolicy {
  switch (distribution) {
    case "direct":
      return { distribution, selfUpdate: true, ui: "full" };
    case "rotten-apple":
      return { distribution, selfUpdate: false, ui: "managed", note: "Updates are handled by the Rotten Apple launcher." };
    case "mas":
      return { distribution, selfUpdate: false, ui: "hidden" };
  }
}
