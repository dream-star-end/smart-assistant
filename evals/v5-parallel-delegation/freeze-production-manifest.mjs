#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

function parseArgs(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 2) {
    out[argv[index].replace(/^--/, "")] = argv[index + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const name of [
  "isolated-manifest", "isolated-report", "isolated-runs", "out",
  "gold",
  "candidate-bundle-rev", "candidate-runtime-release", "candidate-image", "candidate-image-id",
  "candidate-master-release", "candidate-generation", "candidate-slot",
]) {
  if (!args[name]) throw new Error(`missing --${name}`);
}
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestBytes = readFileSync(args["isolated-manifest"]);
const manifest = JSON.parse(manifestBytes);
const manifestSha = sha(manifestBytes);
const reportBytes = readFileSync(args["isolated-report"]);
const report = JSON.parse(reportBytes);
if (
  report.passed !== true ||
  report.mode !== "isolated-ab" ||
  report.manifest_sha256 !== manifestSha
) {
  throw new Error("isolated A/B report is not a PASS for the supplied manifest");
}
if (!manifest.policy) throw new Error("isolated manifest policy is not bound");
const recomputedReport = execFileSync(process.execPath, [
  new URL("./score.mjs", import.meta.url).pathname,
  "--runs", args["isolated-runs"],
  "--gold", args.gold,
  "--manifest", args["isolated-manifest"],
  "--mode", "isolated-ab",
], { maxBuffer: 64 * 1024 * 1024 });
if (!recomputedReport.equals(reportBytes)) {
  throw new Error("isolated report bytes differ from a fresh full evidence rescore");
}

const runFiles = readdirSync(args["isolated-runs"])
  .filter((name) => name.endsWith(".json") && !name.endsWith(".frames.json") && !name.endsWith(".failed.json"))
  .sort();
const runs = runFiles.map((name) => {
  const bytes = readFileSync(join(args["isolated-runs"], name));
  return { name, bytes, run: JSON.parse(bytes) };
});
if (readdirSync(args["isolated-runs"]).some((name) => name.endsWith(".failed.json"))) {
  throw new Error("isolated run directory contains failed attempt evidence");
}
const baseline = runs.filter(({ run }) => run.arm === "A");
const candidates = runs.filter(({ run }) => run.arm === "B");
const expectedBaselineCount =
  Object.keys(manifest.engines).length * manifest.scenarios.length * manifest.pairs.length;
if (baseline.length !== expectedBaselineCount || candidates.length !== expectedBaselineCount) {
  throw new Error(
    `expected ${expectedBaselineCount} runs per arm, got A=${baseline.length} B=${candidates.length}`,
  );
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const maxWallMs = {};
for (const engine of Object.keys(manifest.engines)) {
  maxWallMs[engine] = {};
  for (const scenario of ["code_batch"]) {
    const group = baseline.filter(({ run }) => run.engine === engine && run.scenario === scenario);
    if (group.length !== manifest.pairs.length) {
      throw new Error(`baseline group ${engine}/${scenario} is incomplete`);
    }
    for (const { run } of group) {
      if (
        run.manifest_sha256 !== manifestSha ||
        run.prompt_rev !== manifest.policy.baseline_prompt_rev ||
        run.persona?.rev !== manifest.policy.base_persona_rev
      ) {
        throw new Error(`baseline run ${run.run_id} does not match frozen isolated policy`);
      }
    }
    maxWallMs[engine][scenario] = Math.floor(median(group.map(({ run }) => run.wall_ms)) * 1.25);
  }
}
const baselineRunSet = baseline.map(({ name, bytes }) => ({ name: basename(name), sha256: sha(bytes) }));
const isolatedRunSet = runs.map(({ name, bytes }) => ({ name: basename(name), sha256: sha(bytes) }));
if (!/^[1-9][0-9]*$/.test(args["candidate-generation"])) {
  throw new Error("--candidate-generation must be positive");
}
if (!["A", "B"].includes(args["candidate-slot"])) throw new Error("--candidate-slot must be A or B");
manifest.production = {
  candidate_bundle_rev: args["candidate-bundle-rev"],
  candidate_runtime_release: args["candidate-runtime-release"],
  candidate_image: args["candidate-image"],
  candidate_image_id: args["candidate-image-id"],
  isolated_manifest_sha256: manifestSha,
  isolated_report_sha256: sha(reportBytes),
  baseline_run_set_sha256: sha(JSON.stringify(baselineRunSet)),
  isolated_run_set_sha256: sha(JSON.stringify(isolatedRunSet)),
  smoke_scenarios: ["code_batch", "dependent"],
  smoke_pair_id: manifest.pairs[0].pair_id,
  max_wall_ms: maxWallMs,
  lane: {
    phase: "stable",
    generation: args["candidate-generation"],
    active_slot: args["candidate-slot"],
    active_release: args["candidate-master-release"],
    candidate_slot: null,
    candidate_release: null,
    cohort_percent: 0,
  },
};
writeFileSync(resolve(args.out), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ out: resolve(args.out), production: manifest.production }));
