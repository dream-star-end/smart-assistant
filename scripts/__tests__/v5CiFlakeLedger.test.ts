/**
 * scripts/v5-ci-flake-ledger.sh — observe-only flake candidate ledger.
 *
 * Fake `gh` on PATH. Never talks to GitHub or writes the host ledger.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(REPO_ROOT, "scripts", "v5-ci-flake-ledger.sh");
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function writeFakeGh(binDir: string, fixtureDir: string, scenario: "flake" | "green" | "red") {
  const gh = join(binDir, "gh");
  writeFileSync(
    gh,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
fix=${JSON.stringify(fixtureDir)}
scenario=${JSON.stringify(scenario)}
if [[ "\$args" == *"/actions/workflows/v5-ci.yml/runs?head_sha="* ]]; then
  cat "\$fix/runs.json"
  exit 0
fi
if [[ "\$args" == *"/attempts/1/jobs"* ]]; then
  cat "\$fix/\${scenario}-attempt1-jobs.json"
  exit 0
fi
if [[ "\$args" == *"/attempts/2/jobs"* ]]; then
  cat "\$fix/\${scenario}-attempt2-jobs.json"
  exit 0
fi
if [[ "\$args" == *"/actions/runs/"*"/jobs"* ]]; then
  cat "\$fix/\${scenario}-attempt2-jobs.json"
  exit 0
fi
if [[ "\$args" == *"run download"* ]]; then
  exit 1
fi
echo "unexpected gh: \$args" >&2
exit 1
`,
  );
  chmodSync(gh, 0o755);
}

function jobsPayload(jobs: unknown) {
  return `${JSON.stringify({ jobs }, null, 2)}\n`;
}

function failJob(name: string, step: string) {
  return {
    name,
    conclusion: "failure",
    steps: [
      { name: "Checkout", conclusion: "success" },
      { name: step, conclusion: "failure" },
    ],
  };
}

function okJob(name: string) {
  return { name, conclusion: "success", steps: [{ name: "Checkout", conclusion: "success" }] };
}

function setupScenario(root: string, scenario: "flake" | "green" | "red") {
  const fixture = join(root, "fix");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(
    join(fixture, "runs.json"),
    JSON.stringify({
      workflow_runs: [{ id: 111, run_attempt: scenario === "green" ? 1 : 2, path: ".github/workflows/v5-ci.yml" }],
    }),
  );
  if (scenario === "flake") {
    writeFileSync(
      join(fixture, "flake-attempt1-jobs.json"),
      jobsPayload([failJob("gateway", "Run gateway")]),
    );
    writeFileSync(join(fixture, "flake-attempt2-jobs.json"), jobsPayload([okJob("gateway")]));
  } else if (scenario === "green") {
    writeFileSync(join(fixture, "green-attempt1-jobs.json"), jobsPayload([okJob("gateway")]));
    writeFileSync(join(fixture, "green-attempt2-jobs.json"), jobsPayload([okJob("gateway")]));
  } else {
    writeFileSync(
      join(fixture, "red-attempt1-jobs.json"),
      jobsPayload([failJob("gateway", "Run gateway")]),
    );
    writeFileSync(
      join(fixture, "red-attempt2-jobs.json"),
      jobsPayload([failJob("gateway", "Run gateway")]),
    );
  }
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFakeGh(bin, fixture, scenario);
  return bin;
}

function runRecord(bin: string, ledger: string) {
  return spawnSync("bash", [SCRIPT, "record", SHA], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OC_V5_FLAKE_LEDGER: ledger,
    },
  });
}

describe("v5-ci-flake-ledger", () => {
  test("first-attempt fail + last-attempt pass → candidate", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    try {
      const bin = setupScenario(dir, "flake");
      const ledger = join(dir, "ledger.jsonl");
      const r = runRecord(bin, ledger);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const lines = readFileSync(ledger, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      const row = JSON.parse(lines[0]!);
      assert.equal(row.sha, SHA);
      assert.equal(row.status, "candidate");
      assert.equal(row.owner, null);
      assert.equal(row.expires, null);
      assert.equal(row.class_at_first, "failed");
      assert.match(row.signature, /^gateway::Run gateway::/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("always green → no ledger rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    try {
      const bin = setupScenario(dir, "green");
      const ledger = join(dir, "ledger.jsonl");
      const r = runRecord(bin, ledger);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(ledger, "utf8").trim(), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("both attempts red → no ledger rows (failed, not flaky)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    try {
      const bin = setupScenario(dir, "red");
      const ledger = join(dir, "ledger.jsonl");
      const r = runRecord(bin, ledger);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.equal(readFileSync(ledger, "utf8").trim(), "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("same sha+signature is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    try {
      const bin = setupScenario(dir, "flake");
      const ledger = join(dir, "ledger.jsonl");
      assert.equal(runRecord(bin, ledger).status, 0);
      assert.equal(runRecord(bin, ledger).status, 0);
      const lines = readFileSync(ledger, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("report always exits 0 and flags 7-day unowned", () => {
    const dir = mkdtempSync(join(tmpdir(), "flake-ledger-"));
    try {
      const ledger = join(dir, "ledger.jsonl");
      writeFileSync(
        ledger,
        `${JSON.stringify({
          ts: "2026-01-01T00:00:00Z",
          sha: SHA,
          run_id: 1,
          attempt: 1,
          signature: "gateway::Run gateway::unknown",
          class_at_first: "failed",
          owner: null,
          expires: null,
          status: "candidate",
        })}\n`,
      );
      const r = spawnSync("bash", [SCRIPT, "report", "--days", "7"], {
        encoding: "utf8",
        env: { ...process.env, OC_V5_FLAKE_LEDGER: ledger },
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stdout, /gateway::Run gateway::unknown/);
      assert.match(r.stdout, /YES/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deploy-v5.sh hooks record non-fatally and dry-run only echoes", () => {
    const source = readFileSync(join(REPO_ROOT, "scripts", "deploy-v5.sh"), "utf8");
    const fn = source.slice(
      source.indexOf("\nassert_ci_green_for_source_commit() {"),
      source.indexOf("\nrun_ci_green_gate_before_lease() {"),
    );
    assert.match(fn, /v5-ci-flake-ledger\.sh" record/);
    assert.match(fn, /\|\| echo "⚠ flake ledger record failed \(non-fatal\)"/);
    assert.match(fn, /\[dry-run\] flake ledger record/);
    assert.equal(
      (fn.match(/2>\/dev\/null \|\| true/g) || []).length,
      0,
      "must not swallow GitHub API failures with || true",
    );
  });
});
