import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "packages/commercial/src/flavor/fixtures");
const shLib = path.join(root, "scripts/lib/assert-flavor.sh");
const shCopy = path.join(root, "packages/commercial/agent-sandbox/platform-runtime/bin/assert-flavor.sh");
const rules = path.join(root, "packages/commercial/src/flavor/flavor-rules.json");
const rulesLib = path.join(root, "scripts/lib/flavor-rules.json");
const rulesBin = path.join(root, "packages/commercial/agent-sandbox/platform-runtime/bin/flavor-rules.json");

type Case = {
  name: string;
  manifest: string;
  hostname: string;
  installRoot: string;
  dbName: string;
  env: Record<string, string>;
  sidecar18992?: boolean;
  expect: "pass" | "fail";
  errorContains?: string;
};

const cases = JSON.parse(readFileSync(path.join(fixtures, "cases.json"), "utf8")) as Case[];

function runSh(item: Case): { status: number; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "flavor-sh-"));
  const manifestPath = path.join(dir, "flavor.manifest.json");
  writeFileSync(manifestPath, readFileSync(path.join(fixtures, item.manifest)));
  const env: NodeJS.ProcessEnv = { ...process.env, ...item.env };
  for (const key of [
    "OC_SELFHOST_ENGINE_LOCAL_TURNS",
    "SELFHOST_CURSOR_EGRESS",
    "OC_SELFHOST_CURSOR_EGRESS",
    "PGOPTIONS",
    "OC_FLAVOR_GUARD_REQUIRED",
    "OC_FLAVOR_MANIFEST",
    "OC_FLAVOR_HOSTNAME",
    "OC_FLAVOR_INSTALL_ROOT",
    "OC_FLAVOR_DOCKERENV",
  ]) {
    if (!(key in item.env)) delete env[key];
  }
  const args = [
    shLib, "identity",
    "--manifest", manifestPath,
    "--hostname", item.hostname,
    "--root", item.installRoot,
    "--db", item.dbName,
    "--dockerenv", "0",
    "--sidecar", item.sidecar18992 ? "1" : "0",
  ];
  const result = spawnSync("bash", args, { encoding: "utf8", env });
  return { status: result.status ?? 99, stderr: `${result.stderr}${result.stdout}` };
}

describe("assert-flavor.sh matches TS fixtures", () => {
  test("canonical sh, runtime copy, and flavor-rules.json stay identical", () => {
    assert.equal(readFileSync(shLib, "utf8"), readFileSync(shCopy, "utf8"));
    assert.equal(readFileSync(rules, "utf8"), readFileSync(rulesLib, "utf8"));
    assert.equal(readFileSync(rules, "utf8"), readFileSync(rulesBin, "utf8"));
  });

  for (const item of cases) {
    test(`sh ${item.name}`, () => {
      const got = runSh(item);
      if (item.expect === "pass") {
        assert.equal(got.status, 0, got.stderr);
      } else {
        assert.notEqual(got.status, 0, `${item.name} should fail\n${got.stderr}`);
        if (item.errorContains) {
          assert.match(got.stderr, new RegExp(item.errorContains));
        }
      }
    });
  }

  test("B1: public write CLI cannot mint a flavor", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-write-cli-"));
    const result = spawnSync("bash", [shLib, "write", dir, "selfhost", "a".repeat(40)], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /not a public command|builder-only/);
  });

  test("B1: env spoof of hostname/root/manifest does not grant selfhost", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-spoof-"));
    writeFileSync(path.join(dir, "flavor.manifest.json"), readFileSync(path.join(fixtures, "valid-selfhost.json")));
    const result = spawnSync("bash", [shLib, "allows", "selfhost-cursor-egress"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OC_FLAVOR_MANIFEST: path.join(dir, "flavor.manifest.json"),
        OC_FLAVOR_HOSTNAME: "v3-dev-sg",
        OC_FLAVOR_INSTALL_ROOT: "/opt/openclaude/openclaude-v5-selfhost",
        OC_FLAVOR_DOCKERENV: "0",
        SELFHOST_CURSOR_EGRESS: "1",
      },
    });
    assert.doesNotMatch(`${result.stderr}${result.stdout}`, /ok flavor=selfhost/);
  });

  test("B1: same-basename temp wrapper cannot mint; official deploy scripts can", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-write-ok-"));
    const sha = "e".repeat(40);
    const wrapper = path.join(dir, "deploy-v5-selfhost.sh");
    writeFileSync(wrapper, `#!/usr/bin/env bash\nsource ${JSON.stringify(shLib)}\nwrite_flavor_manifest ${JSON.stringify(dir)} selfhost ${sha}\n`);
    const fake = spawnSync("bash", [wrapper], { encoding: "utf8" });
    assert.notEqual(fake.status, 0, fake.stderr);
    assert.match(`${fake.stderr}${fake.stdout}`, /builder-only|unofficial/);

    const officialSelf = spawnSync("bash", [
      path.join(root, "scripts/deploy-v5-selfhost.sh"),
      "--mint-flavor-manifest", dir, "selfhost", sha,
    ], { encoding: "utf8" });
    assert.equal(officialSelf.status, 0, `${officialSelf.stderr}${officialSelf.stdout}`);
    const ident = spawnSync("bash", [
      shLib, "identity",
      "--manifest", path.join(dir, "flavor.manifest.json"),
      "--hostname", "v3-dev-sg",
      "--root", "/opt/openclaude/openclaude-v5-selfhost",
      "--db", "openclaude_v5_selfhost",
      "--dockerenv", "0",
    ], { encoding: "utf8" });
    assert.equal(ident.status, 0, ident.stderr);

    const commercialDir = mkdtempSync(path.join(tmpdir(), "flavor-write-commercial-"));
    const officialCommercial = spawnSync("bash", [
      path.join(root, "scripts/deploy-v5.sh"),
      "--mint-flavor-manifest", commercialDir, "commercial", sha,
    ], { encoding: "utf8" });
    assert.equal(officialCommercial.status, 0, `${officialCommercial.stderr}${officialCommercial.stdout}`);

    const cross = spawnSync("bash", [
      path.join(root, "scripts/deploy-v5.sh"),
      "--mint-flavor-manifest", dir, "selfhost", sha,
    ], { encoding: "utf8" });
    assert.notEqual(cross.status, 0);
    assert.match(`${cross.stderr}${cross.stdout}`, /cross-write|builder-only/);
  });

  test("B2: missing manifest with --generation 1 is fail-closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-gen-"));
    const got = spawnSync("bash", [
      shLib, "identity",
      "--manifest", path.join(dir, "nope.json"),
      "--hostname", "kl-mirror",
      "--root", "/opt/openclaude/openclaude-v5",
      "--generation", "1",
    ], { encoding: "utf8" });
    assert.notEqual(got.status, 0);
    assert.match(`${got.stderr}${got.stdout}`, /guardGeneration/);
  });

  test("legacy skip still works without generation", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-legacy-"));
    const got = spawnSync("bash", [shLib, "identity", "--root", dir, "--generation", "0"], { encoding: "utf8" });
    assert.equal(got.status, 0, got.stderr);
    assert.match(`${got.stderr}${got.stdout}`, /skip: no flavor.manifest.json/);
  });

  test("commercial cutover skips unguarded candidate", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-cutover-"));
    const got = spawnSync("bash", [shLib, "cutover-commercial", "--root", dir, "--skip-live-probes"], { encoding: "utf8" });
    assert.equal(got.status, 0, got.stderr);
    assert.match(`${got.stderr}${got.stdout}`, /cutover skip/);
  });

  test("B5: activate_release and activate_runtime_tuple call the commercial assertion", () => {
    const src = readFileSync(path.join(root, "scripts/deploy-v5.sh"), "utf8");
    assert.match(src, /assert_commercial_flavor_on_target "\$reldir"/);
    assert.match(src, /assert_commercial_flavor_on_target "\$BUILT_RELEASE"/);
    assert.match(src, /flavorGuardGeneration:\$flavorGuardGeneration/);
    assert.match(src, /write_flavor_manifest "\$flavor_tmpd" commercial/);
    const runtimeIdx = src.indexOf("build_runtime_release()");
    const mintIdx = src.indexOf("write commercial runtime flavor.manifest.json");
    const finalizeIdx = src.indexOf("oc_hotcfg_finalize_release \"$staging\"");
    assert.ok(runtimeIdx > 0 && mintIdx > runtimeIdx && finalizeIdx > mintIdx, "hotcfg mints before finalize");
    const activateIdx = src.indexOf("activate_release()");
    const tupleIdx = src.indexOf("activate_runtime_tuple()");
    const distIdx = src.indexOf("activate_release \"$BUILT_RELEASE\"");
    const rbIdx = src.indexOf("activate_release \"$target\"");
    assert.ok(activateIdx > 0 && tupleIdx > 0);
    assert.ok(distIdx > tupleIdx, "--dist uses activate_release");
    assert.ok(rbIdx > tupleIdx, "rollback uses activate_release");
  });

  test("B2: commercial generation seal fail-closes stripped manifest identity and cutover", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-commercial-stripped-"));
    writeFileSync(path.join(dir, ".complete"), JSON.stringify({
      schemaVersion: 2,
      sourceCommit: "a".repeat(40),
      builtAt: "20260829-000000",
      metadataSha256: "b".repeat(64),
      artifactSha256: "c".repeat(64),
      flavorGuardGeneration: 1,
    }));
    const ident = spawnSync("bash", [shLib, "identity", "--root", dir, "--hostname", "kl-mirror"], { encoding: "utf8" });
    assert.notEqual(ident.status, 0);
    assert.match(`${ident.stderr}${ident.stdout}`, /guardGeneration/);
    const cut = spawnSync("bash", [shLib, "cutover-commercial", "--root", dir, "--skip-live-probes"], { encoding: "utf8" });
    assert.notEqual(cut.status, 0);
    assert.doesNotMatch(`${cut.stderr}${cut.stdout}`, /cutover skip/);
  });

  test("B5: probe execution failure is fail-closed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-probe-fail-"));
    writeFileSync(path.join(dir, "flavor.manifest.json"), readFileSync(path.join(fixtures, "valid-commercial.json")));
    writeFileSync(path.join(dir, ".complete"), JSON.stringify({ flavorGuardGeneration: 1 }));
    const bin = mkdtempSync(path.join(tmpdir(), "flavor-probe-bin-"));
    for (const name of ["systemctl", "ss", "iptables"]) {
      writeFileSync(path.join(bin, name), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? "/usr/bin"}`,
      V5_ENV: path.join(dir, "missing-commercial.env"),
    };
    for (const key of [
      "OC_SELFHOST_ENGINE_LOCAL_TURNS",
      "SELFHOST_CURSOR_EGRESS",
      "OC_SELFHOST_CURSOR_EGRESS",
      "PGOPTIONS",
    ]) {
      delete env[key];
    }
    const got = spawnSync("bash", [shLib, "cutover-commercial", "--root", dir, "--hostname", "kl-mirror"], {
      encoding: "utf8",
      env,
    });
    assert.notEqual(got.status, 0, `${got.stderr}${got.stdout}`);
    assert.match(`${got.stderr}${got.stdout}`, /probe failed/);
    assert.doesNotMatch(`${got.stderr}${got.stdout}`, /commercial cutover ok/);
  });
});
