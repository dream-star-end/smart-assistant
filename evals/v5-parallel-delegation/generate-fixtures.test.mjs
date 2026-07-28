import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

const GENERATOR = new URL("./generate-fixtures.py", import.meta.url).pathname;
const BINDER = new URL("./bind-manifest.mjs", import.meta.url).pathname;
const FREEZER = new URL("./freeze-production-manifest.mjs", import.meta.url).pathname;
const RULE = new URL("./candidate-rule.md", import.meta.url).pathname;
const PROBE = new URL("./remote-probe.sh", import.meta.url).pathname;
const FORMAL_PROMPT = new URL(
  "../../packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md",
  import.meta.url,
).pathname;
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function generate() {
  const parent = mkdtempSync(join(tmpdir(), "v5-parallel-fixtures-"));
  const out = join(parent, "fixture");
  execFileSync("python3", [GENERATOR, "--out", out], { timeout: 30_000 });
  return out;
}

function inputHashes(root) {
  return Object.fromEntries(
    readdirSync(join(root, "input")).sort().map((name) => [name, sha(join(root, "input", name))]),
  );
}

function binderArgs(manifestPath, basePersona, overrides = {}) {
  const values = {
    rule: RULE,
    "candidate-prompt-file": FORMAL_PROMPT,
    probe: PROBE,
    ...overrides,
  };
  return [
    BINDER,
    "--manifest", manifestPath,
    "--ccb-base-persona", basePersona,
    "--codex-base-persona", values["codex-base-persona"] ?? basePersona,
    "--rule", values.rule,
    "--baseline-prompt-rev", "0".repeat(64),
    "--candidate-prompt-file", values["candidate-prompt-file"],
    "--probe", values.probe,
    "--ccb-user-id", "247",
    "--ccb-container", "oc-v5-u247",
    "--codex-user-id", "626",
    "--codex-container", "oc-v5-u626",
    "--baseline-generation", "70",
    "--baseline-active-slot", "A",
    "--baseline-active-release", "baseline-release",
    "--baseline-image", "baseline-image",
    "--baseline-image-id", `sha256:${"1".repeat(64)}`,
    "--baseline-runtime-release", "baseline-runtime-release",
    "--baseline-platform-bundle", "baseline-platform-bundle",
  ];
}

describe("v5 parallel delegation deterministic fixtures", () => {
  it("refuses to erase a non-empty evaluation root", () => {
    const root = mkdtempSync(join(tmpdir(), "v5-parallel-nonempty-"));
    writeFileSync(join(root, "keep.json"), "{}");
    assert.throws(
      () => execFileSync("python3", [GENERATOR, "--out", root], { timeout: 30_000 }),
      /Command failed/,
    );
    assert.equal(readFileSync(join(root, "keep.json"), "utf8"), "{}");
  });

  it("repeats byte-identical inputs and freezes complete semantic gold", () => {
    const first = generate();
    const second = generate();
    assert.deepEqual(inputHashes(first), inputHashes(second));
    assert.equal(sha(join(first, "manifest.json")), sha(join(second, "manifest.json")));
    assert.equal(sha(join(first, "gold", "gold.json")), sha(join(second, "gold", "gold.json")));

    const manifest = JSON.parse(readFileSync(join(first, "manifest.json"), "utf8"));
    assert.equal(manifest.max_pair_gap_ms, 120_000);
    assert.equal(manifest.max_container_age_before_pair_ms, 300_000);
    assert.equal(manifest.fixture_revs.generator_rev, sha(GENERATOR));
    assert.equal(manifest.fixture_revs.scenarios_rev, sha(join(first, "scenarios.json")));
    assert.equal(manifest.fixture_revs.gold_rev, sha(join(first, "gold", "gold.json")));
    assert.deepEqual(
      manifest.pairs.map((pair) => pair.order),
      ["A_FIRST", "B_FIRST", "A_FIRST", "B_FIRST"],
    );
    assert.deepEqual(Object.keys(manifest.input_hashes), manifest.scenarios);
    const probeSource = readFileSync(PROBE, "utf8");
    assert.doesNotMatch(probeSource, /agent_id='main'/);
    assert.match(probeSource, /runtime_channel='v5'/);
    assert.match(probeSource, /container_internal_id=:'docker_id'/);
    assert.match(probeSource, /'model',model/);
    assert.match(probeSource, /'delegate_agent_id',delegate_agent_id/);
    assert.match(probeSource, /'dispatch_id',dispatch_id::text/);

    const gold = JSON.parse(readFileSync(join(first, "gold", "gold.json"), "utf8"));
    assert.deepEqual(gold.pages.map((page) => page.page), Array.from({ length: 12 }, (_, index) => index + 1));
    assert.equal(gold.dependent.trace.length, 31);
    assert.deepEqual(Object.keys(gold.code_hidden_tests), [
      "parse_csv",
      "apply_patch",
      "dependency_batches",
    ]);
    for (const sheet of gold.workbook.sheets) {
      assert.ok(Array.isArray(gold.workbook.merges[sheet]), `missing merges for ${sheet}`);
      assert.ok(Object.keys(gold.workbook.cells[sheet]).length > 0, `missing cells for ${sheet}`);
    }
    assert.equal(gold.workbook.cells.数据.A4.value, "TOTAL");
    assert.equal(gold.workbook.cells.数据.C4.formula, "SUM(C2:C3)");
    assert.equal(gold.workbook.cells.数据.C4.value, 20);

    const tampered = generate();
    const tamperedGoldPath = join(tampered, "gold", "gold.json");
    const tamperedGold = JSON.parse(readFileSync(tamperedGoldPath, "utf8"));
    tamperedGold.simple.answer = 0;
    writeFileSync(tamperedGoldPath, JSON.stringify(tamperedGold, null, 2));
    const tamperedManifestPath = join(tampered, "manifest.json");
    const tamperedManifest = JSON.parse(readFileSync(tamperedManifestPath, "utf8"));
    tamperedManifest.fixture_revs.gold_rev = sha(tamperedGoldPath);
    writeFileSync(tamperedManifestPath, JSON.stringify(tamperedManifest, null, 2));
    const tamperedPersona = join(tampered, "base-persona.md");
    writeFileSync(tamperedPersona, "synthetic base persona\n");
    assert.throws(
      () => execFileSync(
        process.execPath,
        binderArgs(tamperedManifestPath, tamperedPersona),
        { stdio: "ignore" },
      ),
      /Command failed/,
    );

    const basePersona = join(first, "base-persona.md");
    const codexPersona = join(first, "codex-base-persona.md");
    writeFileSync(basePersona, "synthetic base persona\n");
    writeFileSync(codexPersona, "different codex synthetic persona\n");
    const alternate = {
      rule: join(first, "alternate-rule.md"),
      prompt: join(first, "alternate-prompt.md"),
      probe: join(first, "alternate-probe.sh"),
    };
    writeFileSync(alternate.rule, `${readFileSync(RULE, "utf8")}\nweaker replacement\n`);
    writeFileSync(alternate.prompt, `${readFileSync(FORMAL_PROMPT, "utf8")}\nreplacement\n`);
    writeFileSync(alternate.probe, "#!/bin/sh\necho '{}'\n");
    for (const [field, path] of [
      ["rule", alternate.rule],
      ["candidate-prompt-file", alternate.prompt],
      ["probe", alternate.probe],
    ]) {
      assert.throws(
        () => execFileSync(
          process.execPath,
          binderArgs(join(first, "manifest.json"), basePersona, { [field]: path }),
          { stdio: "ignore" },
        ),
        /Command failed/,
        `binder must reject a substituted ${field}`,
      );
    }
    execFileSync(
      process.execPath,
      binderArgs(join(first, "manifest.json"), basePersona, {
        "codex-base-persona": codexPersona,
      }),
    );
    const boundBytes = readFileSync(join(first, "manifest.json"));
    const bound = JSON.parse(boundBytes);
    assert.deepEqual(bound.baseline_runtime_tuple, {
      image: "baseline-image",
      image_id: `sha256:${"1".repeat(64)}`,
      runtime_release: "baseline-runtime-release",
      platform_bundle: "baseline-platform-bundle",
    });
    assert.equal(bound.policy.personas.ccb.base_persona_rev, sha(basePersona));
    assert.equal(bound.policy.personas.codex.base_persona_rev, sha(codexPersona));
    assert.notEqual(
      bound.policy.personas.ccb.candidate_persona_rev,
      bound.policy.personas.codex.candidate_persona_rev,
    );
    const boundSha = createHash("sha256").update(boundBytes).digest("hex");
    const runsDir = join(first, "isolated-runs");
    mkdirSync(runsDir);
    for (const engine of Object.keys(bound.engines)) {
      for (const scenario of bound.scenarios) {
        for (const pair of bound.pairs) {
          const run = {
            run_id: `${engine}-${scenario}-${pair.pair_id}-A`,
            arm: "A",
            engine,
            scenario,
            manifest_sha256: boundSha,
            prompt_rev: bound.policy.baseline_prompt_rev,
            persona: { rev: bound.policy.personas[engine].base_persona_rev },
            wall_ms: scenario === "document_batch" ? 100_000 : 50_000,
          };
          writeFileSync(join(runsDir, `${run.run_id}.json`), JSON.stringify(run));
        }
      }
    }
    const reportPath = join(first, "isolated-report.json");
    writeFileSync(reportPath, JSON.stringify({
      passed: true,
      mode: "isolated-ab",
      manifest_sha256: boundSha,
    }));
    const productionManifest = join(first, "production-manifest.json");
    assert.throws(() => execFileSync(process.execPath, [
      FREEZER,
      "--isolated-manifest", join(first, "manifest.json"),
      "--isolated-report", reportPath,
      "--isolated-runs", runsDir,
      "--gold", join(first, "gold", "gold.json"),
      "--out", productionManifest,
      "--candidate-bundle-rev", "bundle",
      "--candidate-runtime-release", "release",
      "--candidate-image", "image",
      "--candidate-image-id", "image-id",
      "--candidate-master-release", "candidate-release",
      "--candidate-generation", "71",
      "--candidate-slot", "B",
    ], { stdio: "ignore" }), /Command failed/);
  });
});
