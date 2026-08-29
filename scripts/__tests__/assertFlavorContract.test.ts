import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(root, "packages/commercial/src/flavor/fixtures");
const shLib = path.join(root, "scripts/lib/assert-flavor.sh");
const shCopy = path.join(root, "packages/commercial/agent-sandbox/platform-runtime/bin/assert-flavor.sh");

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
  ]) {
    if (!(key in item.env)) delete env[key];
  }
  env.OC_FLAVOR_MANIFEST = manifestPath;
  env.OC_FLAVOR_HOSTNAME = item.hostname;
  env.OC_FLAVOR_INSTALL_ROOT = item.installRoot;
  env.OC_FLAVOR_DB_NAME = item.dbName;
  env.OC_FLAVOR_DOCKERENV = "0";
  env.OC_FLAVOR_SIDECAR_18992 = item.sidecar18992 ? "1" : "0";
  const result = spawnSync("bash", [shLib, "identity"], { encoding: "utf8", env });
  return { status: result.status ?? 99, stderr: `${result.stderr}${result.stdout}` };
}

describe("assert-flavor.sh matches TS fixtures", () => {
  test("canonical sh and platform-runtime copy are identical", () => {
    assert.equal(readFileSync(shLib, "utf8"), readFileSync(shCopy, "utf8"));
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

  test("sh write refuses cross-flavor from deploy-v5.sh caller", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-write-"));
    const result = spawnSync(
      "bash",
      ["-c", `source ${JSON.stringify(shLib)}; write_flavor_manifest ${JSON.stringify(dir)} selfhost ${"a".repeat(40)}`],
      { encoding: "utf8", env: { ...process.env, FLAVOR_WRITE_BUILDER: "deploy-v5.sh" } },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}${result.stdout}`, /cross-write/);
  });

  test("sh write selfhost manifest and identity passes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-write-ok-"));
    const sha = "e".repeat(40);
    const write = spawnSync("bash", [shLib, "write", dir, "selfhost", sha], { encoding: "utf8" });
    assert.equal(write.status, 0, write.stderr);
    const ident = spawnSync("bash", [shLib, "identity"], {
      encoding: "utf8",
      env: {
        ...process.env,
        OC_FLAVOR_MANIFEST: path.join(dir, "flavor.manifest.json"),
        OC_FLAVOR_HOSTNAME: "v3-dev-sg",
        OC_FLAVOR_INSTALL_ROOT: "/opt/openclaude/openclaude-v5-selfhost",
        OC_FLAVOR_DB_NAME: "openclaude_v5_selfhost",
        OC_FLAVOR_DOCKERENV: "0",
      },
    });
    assert.equal(ident.status, 0, ident.stderr);
  });

  test("commercial cutover skips without manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "flavor-cutover-"));
    const got = spawnSync("bash", [shLib, "cutover-commercial"], {
      encoding: "utf8",
      env: { ...process.env, OC_FLAVOR_CUTOVER_ROOT: dir },
    });
    assert.equal(got.status, 0, got.stderr);
    assert.match(`${got.stderr}${got.stdout}`, /cutover skip/);
  });
});
