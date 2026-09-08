#!/usr/bin/env node
// Outer meta for official find catalog. Filename is NOT *.test.mjs.
// Inner workers are expected non-zero; this process exits 0 only when those
// rejections are observed. Does not launch Chromium.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EXPECTED_SCENES } from "./find-in-session-collector.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const summaryPath = process.env.OC_FIND_META_SUMMARY
  || join(tmpdir(), "ocv5-188-find-catalog-meta.json");

function runNode(args, env, timeoutMs) {
  return spawnSync(process.execPath, args, {
    cwd: join(here, ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: timeoutMs,
  });
}

const work = mkdtempSync(join(tmpdir(), "oc-find-meta-"));
const cases = [];
try {
  const emptyJson = join(work, "empty-selection.json");
  const empty = runNode(
    ["--test", join(here, "find-in-session.node-test.mjs")],
    { OC_FIND_ONLY: "no-such-business-case", OC_FIND_RESULT: emptyJson },
    15_000,
  );
  let emptyPayload = null;
  try { emptyPayload = JSON.parse(readFileSync(emptyJson, "utf8")); } catch { emptyPayload = { parseError: true }; }
  const emptyOk = empty.status !== 0
    && empty.status !== null
    && (emptyPayload.failed ?? 0) > 0
    && (emptyPayload.expectedSceneCount ?? 0) === EXPECTED_SCENES.length
    && Array.isArray(emptyPayload.missingScenes)
    && emptyPayload.missingScenes.length > 0;
  cases.push({
    name: "official-cli-empty-OC_FIND_ONLY",
    innerExit: empty.status,
    expectedInnerNonZero: true,
    jsonFailed: emptyPayload.failed ?? null,
    jsonMissing: emptyPayload.missingScenes?.length ?? null,
    pass: emptyOk,
    stderr: (empty.stderr || "").slice(0, 400),
  });

  const probeJson = join(work, "collector-probe.json");
  const probe = runNode(
    [join(here, "find-collector-failure-probe.mjs")],
    { OC_FIND_COLLECTOR_PROBE: probeJson },
    5_000,
  );
  let probePayload = null;
  try { probePayload = JSON.parse(readFileSync(probeJson, "utf8")); } catch { probePayload = { parseError: true }; }
  const touch = probePayload.rows?.find((r) => r.contractId === "touchmove-cancel");
  const probeOk = probe.status === 1
    && (probePayload.failed ?? 0) > 0
    && touch?.pass === false
    && touch?.actual?.missing === true;
  cases.push({
    name: "collector-missing-record-probe",
    innerExit: probe.status,
    expectedInnerNonZero: true,
    jsonFailed: probePayload.failed ?? null,
    touchMissing: touch?.actual?.missing ?? null,
    pass: probeOk,
  });
} finally {
  rmSync(work, { recursive: true, force: true });
}

const allPass = cases.every((c) => c.pass);
const summary = { outerPass: allPass, cases };
writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
console.log(`FIND_CATALOG_META ${summaryPath} outerPass=${allPass}`);
for (const c of cases) {
  console.log(`  ${c.name} pass=${c.pass} innerExit=${c.innerExit}`);
}
process.exit(allPass ? 0 : 1);
