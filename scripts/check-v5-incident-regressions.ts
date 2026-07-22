#!/usr/bin/env tsx
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const MANIFEST = join(ROOT, "e2e/session-display/incidents.json");
const FIXED_MATRIX = [
  { engine: "codex", model: "gpt-5.6-luna" },
  { engine: "ccb", model: "deepseek-v4-flash" },
];
const PROOF_LAYERS = new Set(["browser", "live-e2e", "deploy-gate"]);
const ALL_LAYERS = new Set(["unit", "integration", ...PROOF_LAYERS]);

type Regression = { layer: string; path: string };
type Incident = {
  id: string;
  occurredAt: string;
  severity: string;
  symptom: string;
  rootFixCommit: string;
  regressions: Regression[];
};
type Manifest = {
  schema: number;
  scope: string;
  fixedLiveMatrix: Array<{ engine: string; model: string }>;
  incidents: Incident[];
};

function fail(message: string): never {
  throw new Error(`[incident-regressions] ${message}`);
}
function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as Manifest;
if (manifest.schema !== 1) fail(`schema must be 1, got ${manifest.schema}`);
if (JSON.stringify(manifest.fixedLiveMatrix) !== JSON.stringify(FIXED_MATRIX)) {
  fail("fixedLiveMatrix must be exactly Codex/gpt-5.6-luna + CCB/deepseek-v4-flash");
}
if (!Array.isArray(manifest.incidents) || manifest.incidents.length === 0) fail("incidents must not be empty");

const ids = new Set<string>();
const linked = new Set<string>();
for (const incident of manifest.incidents) {
  if (!/^INC-[0-9]{8}-[A-Z0-9-]{3,40}$/.test(incident.id)) fail(`invalid id ${incident.id}`);
  if (ids.has(incident.id)) fail(`duplicate id ${incident.id}`);
  ids.add(incident.id);
  if (!/^2026-[0-9]{2}-[0-9]{2}$/.test(incident.occurredAt)) fail(`${incident.id}: invalid occurredAt`);
  if (incident.severity !== "P0" && incident.severity !== "P1") fail(`${incident.id}: severity must be P0/P1`);
  if (!incident.symptom?.trim()) fail(`${incident.id}: symptom is required`);
  if (!/^[0-9a-f]{8}$/.test(incident.rootFixCommit)) fail(`${incident.id}: rootFixCommit must be 8 hex`);
  try {
    git("cat-file", "-e", `${incident.rootFixCommit}^{commit}`);
    execFileSync("git", ["merge-base", "--is-ancestor", incident.rootFixCommit, "HEAD"], { cwd: ROOT });
  } catch {
    fail(`${incident.id}: root fix ${incident.rootFixCommit} is not an ancestor of HEAD`);
  }
  if (!Array.isArray(incident.regressions) || incident.regressions.length === 0) {
    fail(`${incident.id}: no automated regression`);
  }
  if (!incident.regressions.some((item) => PROOF_LAYERS.has(item.layer))) {
    fail(`${incident.id}: must have browser/live-e2e/deploy-gate proof`);
  }
  for (const regression of incident.regressions) {
    if (!ALL_LAYERS.has(regression.layer)) fail(`${incident.id}: invalid layer ${regression.layer}`);
    if (regression.path.startsWith("/") || regression.path.includes("..")) fail(`${incident.id}: unsafe path`);
    if (!existsSync(join(ROOT, regression.path))) fail(`${incident.id}: missing ${regression.path}`);
    linked.add(regression.path);
  }
}

const specsDir = join(ROOT, "e2e/session-display/tests");
for (const name of readdirSync(specsDir).filter((name) => name.endsWith(".spec.ts"))) {
  const path = relative(ROOT, join(specsDir, name)).replaceAll("\\", "/");
  if (!linked.has(path)) fail(`live spec is not linked to an incident: ${path}`);
}

const runner = readFileSync(join(ROOT, "e2e/session-display/run.sh"), "utf8");
if (!/MATRIX=\(gpt-5\.6-luna deepseek-v4-flash\)/.test(runner)) fail("run.sh fixed matrix drifted");
if (!runner.includes("OC_E2E_REQUIRE_DIRECT_TIMELINE=1")) fail("run.sh must fail closed on direct-timeline skips");
if (!runner.includes('OC_E2E_EMAIL="v5-evals@claudeai.chat"')) fail("run.sh must use v5-evals");
if (!runner.includes("export CI=1")) fail("run.sh must forbid focused test subsets");

process.stdout.write(`[incident-regressions] PASS: ${manifest.incidents.length} P0/P1 incidents, ${linked.size} regression artifacts, fixed live matrix locked\n`);
