import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "../..");

function trustedBaseFromEvent(): string | null {
  const eventPath = process.env.GITHUB_EVENT_PATH?.trim();
  if (!eventPath) return null;
  try {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      before?: string;
      pull_request?: { base?: { sha?: string } };
    };
    const base = event.pull_request?.base?.sha ?? event.before;
    return base && !/^0+$/.test(base) ? base : null;
  } catch {
    return null;
  }
}

describe("immutable regression-contract gate wiring", () => {
  test("the real repository runs structural checks and red-green proof", { timeout: 240_000 }, () => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    if (!env.REGRESSION_CONTRACT_BASE_REF) {
      const base = trustedBaseFromEvent();
      if (base) env.REGRESSION_CONTRACT_BASE_REF = base;
    }
    const result = spawnSync(
      join(ROOT, "node_modules/.bin/tsx"),
      [join(ROOT, "scripts/check-v5-regression-contracts.ts"), "--prove"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env,
        timeout: 220_000,
      },
    );
    const output = String(result.stdout ?? "") + String(result.stderr ?? "");
    assert.equal(result.status, 0, output || String(result.error ?? "regression proof failed"));
  });
});
