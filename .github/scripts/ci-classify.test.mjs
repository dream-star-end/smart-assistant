import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  classifyRun,
  extractTapFirstNotOk,
  extractVitestFirstFail,
  isInfraStepName,
  main,
} from "./ci-classify.mjs";

function job({ name, conclusion, steps }) {
  return { name, conclusion, steps: steps || [] };
}

function failStep(name) {
  return [
    { name: "Checkout", conclusion: "success" },
    { name, conclusion: "failure" },
  ];
}

describe("ci-classify", () => {
  test("all success/skipped → passed, first_pass, not rerun_green", () => {
    const r = classifyRun({
      jobs: [
        job({ name: "typecheck", conclusion: "success" }),
        job({ name: "lint", conclusion: "skipped" }),
        job({ name: "ci-classify", conclusion: "in_progress" }),
      ],
      sha: "abc",
      runId: 1,
      runAttempt: 1,
      event: "push",
    });
    assert.equal(r.class, "passed");
    assert.equal(r.first_pass, true);
    assert.equal(r.rerun_green, false);
    assert.equal(r.jobs.some((j) => j.name === "ci-classify"), false);
  });

  test("attempt>1 all green → rerun_green", () => {
    const r = classifyRun({
      jobs: [job({ name: "gateway", conclusion: "success" })],
      runAttempt: 2,
    });
    assert.equal(r.class, "passed");
    assert.equal(r.first_pass, false);
    assert.equal(r.rerun_green, true);
  });

  test("Install dependencies failure → infra-error", () => {
    const r = classifyRun({
      jobs: [
        job({
          name: "commercial-unit (known-failures diff gate)",
          conclusion: "failure",
          steps: failStep("Install dependencies"),
        }),
      ],
      runAttempt: 1,
    });
    assert.equal(r.class, "infra-error");
    assert.equal(r.jobs[0].failed_step, "Install dependencies");
    assert.match(r.jobs[0].signature, /Install dependencies::unknown$/);
  });

  test("Upload * step name is infra", () => {
    assert.equal(isInfraStepName("Upload TAP output"), true);
    assert.equal(isInfraStepName("Run gateway"), false);
    const r = classifyRun({
      jobs: [
        job({
          name: "commercial-integ (pr-1)",
          conclusion: "failure",
          steps: failStep("Upload TAP output"),
        }),
      ],
    });
    assert.equal(r.class, "infra-error");
  });

  test("ECONNRESET in logs of a test step → infra-error", () => {
    const r = classifyRun({
      jobs: [
        job({
          name: "gateway",
          conclusion: "failure",
          steps: failStep("Run gateway"),
        }),
      ],
      logsText: "gateway\tRun gateway\nError: ECONNRESET reading from socket\n",
    });
    assert.equal(r.class, "infra-error");
  });

  test("test failure with TAP not ok → failed + signature from TAP, not invented", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-classify-"));
    try {
      const tapDir = join(dir, "commercial-unit-tap");
      mkdirSync(tapDir);
      writeFileSync(
        join(tapDir, "commercial-unit.tap"),
        "TAP version 13\nnot ok 1 - billing.settle — refuses negative amount\nok 2 - other\n1..2\n",
      );
      const r = classifyRun({
        jobs: [
          job({
            name: "commercial-unit (known-failures diff gate)",
            conclusion: "failure",
            steps: failStep("Run commercial unit tests (baseline diff gate)"),
          }),
        ],
        artifactsDir: dir,
      });
      assert.equal(r.class, "failed");
      assert.equal(
        r.jobs[0].signature,
        "commercial-unit (known-failures diff gate)::Run commercial unit tests (baseline diff gate)::billing.settle — refuses negative amount",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing TAP/logs → signature detail unknown (does not invent)", () => {
    const r = classifyRun({
      jobs: [
        job({
          name: "storage",
          conclusion: "failure",
          steps: failStep("Run storage"),
        }),
      ],
    });
    assert.equal(r.class, "failed");
    assert.equal(r.jobs[0].signature, "storage::Run storage::unknown");
  });

  test("mixed infra + assertion failure → failed (test failure wins)", () => {
    const r = classifyRun({
      jobs: [
        job({
          name: "lint",
          conclusion: "failure",
          steps: failStep("Install dependencies"),
        }),
        job({
          name: "gateway",
          conclusion: "failure",
          steps: failStep("Run gateway"),
        }),
      ],
    });
    assert.equal(r.class, "failed");
  });

  test("vitest FAIL line becomes file::case", () => {
    assert.equal(
      extractVitestFirstFail("FAIL  src/foo.test.ts > gate > refuses skip\n"),
      "src/foo.test.ts::gate::refuses skip",
    );
    assert.equal(extractTapFirstNotOk("not ok 3 - alpha — beta\n"), "alpha — beta");
  });

  test("CLI writes json + summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-classify-cli-"));
    try {
      const jobsPath = join(dir, "jobs.json");
      const outPath = join(dir, "ci-classification.json");
      const summaryPath = join(dir, "summary.md");
      writeFileSync(
        jobsPath,
        JSON.stringify({
          jobs: [job({ name: "typecheck", conclusion: "success" })],
        }),
      );
      const rc = main([
        "--jobs",
        jobsPath,
        "--out",
        outPath,
        "--sha",
        "deadbeef",
        "--run-id",
        "99",
        "--run-attempt",
        "1",
        "--event",
        "push",
        "--summary",
        summaryPath,
      ]);
      assert.equal(rc, 0);
      const json = JSON.parse(readFileSync(outPath, "utf8"));
      assert.equal(json.schemaVersion, 1);
      assert.equal(json.class, "passed");
      assert.equal(json.sha, "deadbeef");
      assert.match(readFileSync(summaryPath, "utf8"), /class: \*\*passed\*\*/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
