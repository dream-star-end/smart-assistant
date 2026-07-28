#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = Object.fromEntries(
  Array.from({ length: Math.ceil(process.argv.slice(2).length / 2) }, (_, index) => {
    const argv = process.argv.slice(2);
    return [argv[index * 2]?.replace(/^--/, ""), argv[index * 2 + 1]];
  }),
);
for (const name of [
  "manifest", "ccb-base-persona", "codex-base-persona", "rule",
  "baseline-prompt-rev", "candidate-prompt-file",
  "probe", "ccb-user-id", "ccb-container", "codex-user-id", "codex-container",
  "baseline-generation", "baseline-active-slot", "baseline-active-release",
  "baseline-image", "baseline-image-id", "baseline-runtime-release", "baseline-platform-bundle",
]) {
  if (!args[name]) throw new Error(`missing --${name}`);
}
const sha = (value) => createHash("sha256").update(value).digest("hex");
const requireSha = (name, value) => {
  if (!/^[0-9a-f]{64}$/.test(value ?? "")) throw new Error(`${name} must be a lowercase SHA-256`);
  return value;
};
const manifest = JSON.parse(readFileSync(args.manifest, "utf8"));
if (manifest.policy) throw new Error("manifest policy is already bound; generate a fresh manifest");
const fixtureRoot = dirname(args.manifest);
const evalDir = dirname(fileURLToPath(import.meta.url));
const generatorPath = join(evalDir, "generate-fixtures.py");
const canonicalRulePath = join(evalDir, "candidate-rule.md");
const canonicalProbePath = join(evalDir, "remote-probe.sh");
const canonicalPromptPath = join(
  evalDir,
  "..",
  "..",
  "packages",
  "commercial",
  "agent-sandbox",
  "platform-runtime",
  "prompts",
  "platform-capabilities.md",
);
const requireCanonicalFile = (label, suppliedPath, canonicalPath) => {
  const supplied = readFileSync(suppliedPath);
  const canonical = readFileSync(canonicalPath);
  if (!supplied.equals(canonical)) {
    throw new Error(`${label} must be byte-identical to reviewed canonical file ${canonicalPath}`);
  }
  return canonical;
};
const ruleBytes = requireCanonicalFile("--rule", args.rule, canonicalRulePath);
const candidatePrompt = requireCanonicalFile(
  "--candidate-prompt-file",
  args["candidate-prompt-file"],
  canonicalPromptPath,
);
const probe = requireCanonicalFile("--probe", args.probe, canonicalProbePath);
const rule = ruleBytes.toString("utf8").trim();
if (!candidatePrompt.toString("utf8").includes(rule)) {
  throw new Error("canonical candidate prompt does not contain the reviewed candidate rule");
}
const regenerationRoot = mkdtempSync(join(tmpdir(), "v5-parallel-bind-"));
const regenerated = join(regenerationRoot, "fixture");
try {
  execFileSync("python3", [generatorPath, "--out", regenerated], {
    timeout: 30_000,
    stdio: "ignore",
  });
  for (const relative of ["manifest.json", "scenarios.json", join("gold", "gold.json")]) {
    if (!readFileSync(join(fixtureRoot, relative)).equals(readFileSync(join(regenerated, relative)))) {
      throw new Error(`fixture ${relative} is not byte-identical to a fresh generator run`);
    }
  }
  const actualInputs = readdirSync(join(fixtureRoot, "input")).sort();
  const expectedInputs = readdirSync(join(regenerated, "input")).sort();
  if (JSON.stringify(actualInputs) !== JSON.stringify(expectedInputs)) {
    throw new Error("fixture input file set differs from a fresh generator run");
  }
  for (const name of expectedInputs) {
    if (!readFileSync(join(fixtureRoot, "input", name)).equals(
      readFileSync(join(regenerated, "input", name)),
    )) {
      throw new Error(`fixture input/${name} differs from a fresh generator run`);
    }
  }
} finally {
  rmSync(regenerationRoot, { recursive: true, force: true });
}
for (const [field, path] of [
  ["generator_rev", generatorPath],
  ["scenarios_rev", join(fixtureRoot, "scenarios.json")],
  ["gold_rev", join(fixtureRoot, "gold", "gold.json")],
]) {
  const actual = sha(readFileSync(path));
  if (manifest.fixture_revs?.[field] !== actual) {
    throw new Error(`fixture ${field} differs from the generated manifest`);
  }
}
manifest.policy = {
  rule_rev: sha(rule),
  baseline_prompt_rev: requireSha("--baseline-prompt-rev", args["baseline-prompt-rev"]),
  candidate_prompt_rev: sha(candidatePrompt),
  probe_rev: sha(probe),
  personas: {},
};
manifest.targets = {};
for (const engine of ["ccb", "codex"]) {
  const base = readFileSync(args[`${engine}-base-persona`], "utf8");
  const candidate = `${base.replace(/\s+$/, "")}\n\n${rule}\n`;
  manifest.policy.personas[engine] = {
    base_persona_rev: sha(base),
    candidate_persona_rev: sha(candidate),
  };
  const userId = Number(args[`${engine}-user-id`]);
  const container = args[`${engine}-container`];
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error(`--${engine}-user-id must be positive`);
  if (!/^oc-v5-u[1-9][0-9]*$/.test(container)) throw new Error(`--${engine}-container is invalid`);
  manifest.targets[engine] = { user_id: userId, container };
}
if (!/^[1-9][0-9]*$/.test(args["baseline-generation"])) {
  throw new Error("--baseline-generation must be positive");
}
if (!["A", "B"].includes(args["baseline-active-slot"])) {
  throw new Error("--baseline-active-slot must be A or B");
}
manifest.baseline_lane = {
  phase: "stable",
  generation: args["baseline-generation"],
  active_slot: args["baseline-active-slot"],
  active_release: args["baseline-active-release"],
  candidate_slot: null,
  candidate_release: null,
  cohort_percent: 0,
};
manifest.baseline_runtime_tuple = {
  image: args["baseline-image"],
  image_id: args["baseline-image-id"],
  runtime_release: args["baseline-runtime-release"],
  platform_bundle: args["baseline-platform-bundle"],
};
const temp = `${args.manifest}.tmp`;
writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
renameSync(temp, args.manifest);
console.log(JSON.stringify({ manifest: args.manifest, policy: manifest.policy }));
