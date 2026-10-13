/**
 * Regenerate the GNSS-X market plugin blueprint (OCV5-401) from the committed tools/list snapshot.
 *
 *   npx tsx scripts/gen-gnss-x-blueprint.ts           # write gnss-x.blueprint.json
 *   npx tsx scripts/gen-gnss-x-blueprint.ts --check   # exit 1 if the committed file is stale
 *
 * Refreshing the snapshot itself is a deliberate review step: fetch
 * `{"jsonrpc":"2.0","id":1,"method":"tools/list"}` from https://mcp.gnss-x.ac.cn/rpc (no auth),
 * replace `tools` in gnssXToolsSnapshot.json, regenerate, and bump GNSS_X_VERSION.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type GnssXSnapshot,
  buildGnssXBlueprint,
} from "../packages/commercial/src/marketplace/gnssX/gnssXBlueprint.ts";

const DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/commercial/src/marketplace/gnssX",
);
const SNAPSHOT = join(DIR, "gnssXToolsSnapshot.json");
const OUT = join(DIR, "gnss-x.blueprint.json");

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as GnssXSnapshot;
const text = `${JSON.stringify(buildGnssXBlueprint(snapshot), null, 2)}\n`;

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    // missing file is stale
  }
  if (current !== text) {
    console.error("gnss-x.blueprint.json is stale; run npx tsx scripts/gen-gnss-x-blueprint.ts");
    process.exit(1);
  }
  console.log("gnss-x.blueprint.json is up to date");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
