#!/usr/bin/env node
// Controlled collector failure. Filename is NOT *.test.mjs so node --test does
// not discover it. Uses the same finalizeRows as the find suite.
import { writeFileSync } from "node:fs";
import { finalizeRows, record } from "./find-in-session-collector.mjs";

const resultPath = process.env.OC_FIND_COLLECTOR_PROBE || new URL("./find-collector-failure-probe.json", import.meta.url).pathname;
const rows = [];
record(rows, "tail-320-m0", { key: "m0" }, { key: "m0", visible: true, findPin: "" }, { clicks: 1 }, true, "", { mode: "probe" });
// Simulate L2: assert-before-record throws, so touchmove-cancel is never recorded.
const catalog = finalizeRows(rows, { mode: "probe" });
const payload = {
  probe: "assert-before-record-missing-scene",
  ...catalog,
  rows,
};
writeFileSync(resultPath, JSON.stringify(payload, null, 2));
const touch = rows.find((r) => r.contractId === "touchmove-cancel");
const ok = catalog.failed > 0 && touch && touch.pass === false && touch.actual?.missing === true;
console.log(`COLLECTOR_PROBE ${resultPath} failed=${catalog.failed} missing=${catalog.missingScenes.length} touchmove=${touch?.pass}`);
process.exit(ok ? 1 : 2);
