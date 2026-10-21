// The JS participant of the cross-language interop check (sdk/contract/run.sh): opens the shared encrypted
// drive "interop", verifies every file the other SDKs wrote, and writes its own.
// Environment: GD_SDK_BASE, GD_SDK_KEY, GD_SDK_PASSPHRASE, GD_SDK_LANG (default "js"). --init creates the master key.
import * as gd from "../src/index.js";

const lang = process.env.GD_SDK_LANG || "js";
const c = new gd.Client(process.env.GD_SDK_BASE!, process.env.GD_SDK_KEY!);
const keys = new gd.Keyring(c);
if (process.argv.includes("--init")) await keys.create(process.env.GD_SDK_PASSPHRASE!);
else await keys.unlock(process.env.GD_SDK_PASSPHRASE!);
const d = await gd.Drive.open(c, "interop", keys);
const verified: string[] = [];
for (const e of await d.list("")) {
  if (e.folder || !e.name.startsWith("from-")) continue;
  const who = e.name.slice(5).replace(/\.txt$/, "");
  const got = new TextDecoder().decode(await d.readFile(e.path));
  if (got !== `hello from ${who}\n`) throw new Error(`${e.path}: unexpected content ${JSON.stringify(got)}`);
  verified.push(who);
}
await d.writeFile(`from-${lang}.txt`, new TextEncoder().encode(`hello from ${lang}\n`));
console.log(JSON.stringify({ lang, verified }));
