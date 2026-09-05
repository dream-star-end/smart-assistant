import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanText } from "../check-v5-test-retries.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "check-v5-test-retries.ts");

const retriesKey = "re" + "tries";
const retryKey = "re" + "try";
const testRetryCall = "test." + retryKey + "(";
const dotRetryCall = "." + retryKey + "(";

describe("check-v5-test-retries", () => {
  test("numeric retry count is a hit; zero and max_retries are not", () => {
    const hits = scanText(
      "foo.test.ts",
      [
        `${retriesKey}: 2,`,
        `${retriesKey}: 0,`,
        `${retryKey}: 1`,
        "max_retries: 10,",
        `${testRetryCall}2)`,
        `queue${dotRetryCall}1)`,
      ].join("\n"),
    );
    const kinds = hits.map((h) => h.kind).sort();
    assert.deepEqual(
      kinds,
      [dotRetryCall, retriesKey + ":", retryKey + ":", testRetryCall].sort(),
    );
  });

  test("transport annotation on same or previous line allows", () => {
    const hits = scanText(
      "playwright.config.ts",
      [
        "// oc-retry: transport github artifact download",
        `${retriesKey}: 2,`,
        `${retriesKey}: 3, // oc-retry: transport runner shutdown`,
      ].join("\n"),
    );
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.allowed));
  });

  test("e2e retry env default zero is clean; default one is a hit", () => {
    const envName = "OC_E2E_" + "RETRIES";
    assert.equal(scanText("e2e/x.ts", `${retriesKey}: Number(process.env.${envName} ?? 0),\n`).length, 0);
    const hits = scanText("e2e/x.ts", `${retriesKey}: Number(process.env.${envName} ?? 1),\n`);
    assert.equal(hits[0]?.kind, envName + "-default");
  });

  test("CLI enforce reds a fixture; observe mode warns and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-retries-"));
    try {
      writeFileSync(join(dir, "playwright.config.ts"), `export default { ${retriesKey}: 2 }\n`);
      mkdirSync(join(dir, "e2e"), { recursive: true });
      const tsx = join(REPO_ROOT, "node_modules", ".bin", "tsx");
      const red = spawnSync(tsx, [SCRIPT, "--root", dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, OC_TEST_RETRY_ENFORCE: "1" },
      });
      assert.notEqual(red.status, 0, red.stdout + red.stderr);
      assert.match(red.stderr, /playwright\.config/);
      const warn = spawnSync(tsx, [SCRIPT, "--root", dir], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, OC_TEST_RETRY_ENFORCE: "0" },
      });
      assert.equal(warn.status, 0, warn.stderr);
      assert.match(warn.stderr, /WARN/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
