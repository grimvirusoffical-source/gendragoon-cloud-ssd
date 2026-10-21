/* global process, console */
/**
 * Bundles the Electron main + preload. GENDRAGOON_DISTRIBUTION (direct | rotten-apple | mas) is baked in
 * as __GD_DISTRIBUTION__ so a store build cannot be turned into a self-updating one at runtime.
 * GENDRAGOON_REDXAI_ISSUER (the Red-XAI Accounts URL) is baked in as __GD_REDXAI_ISSUER__.
 */
import { build } from "esbuild";

const distribution = process.env.GENDRAGOON_DISTRIBUTION || "direct";
if (!["direct", "rotten-apple", "mas"].includes(distribution)) {
  console.error(`Unknown GENDRAGOON_DISTRIBUTION "${distribution}" (use direct, rotten-apple or mas)`);
  process.exit(1);
}
const common = { bundle: true, platform: "node", format: "cjs", external: ["electron"] };
await build({ ...common, entryPoints: ["src/main/main.ts"], outfile: "dist/main.js", define: { __GD_DISTRIBUTION__: JSON.stringify(distribution), __GD_REDXAI_ISSUER__: JSON.stringify(process.env.GENDRAGOON_REDXAI_ISSUER || "") } });
await build({ ...common, entryPoints: ["src/main/preload.ts"], outfile: "dist/preload.js" });
console.log(`built main (distribution=${distribution})`);
