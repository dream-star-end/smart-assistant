/**
 * Outer regression: default unit discovery must stay green. Spawns the inner
 * worker (not named *.test.ts) and asserts it exits 1 with shared-collector JSON.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  MISSING_RECORD_ACTUAL,
  parseDiagnosticReport,
} from "./helpers/cursorExternalApiDiagnostics.js";

const WORKER = fileURLToPath(
  new URL("./helpers/cursorExternalApiPrerecordFail.worker.ts", import.meta.url),
);

test("shared diagnostics capture a pre-record throw; inner worker exits 1, outer stays green", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => {
    stdout += String(c);
  });
  child.stderr.on("data", (c) => {
    stderr += String(c);
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const code: number | null = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  const report = parseDiagnosticReport(stdout, "cursorExternalApiPrerecordFail");
  assert.equal(code, 1, `inner exit expected 1 actual ${code} stderr=${stderr.slice(0, 300)}`);
  assert.equal(report.passed, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.skipped, 0);
  assert.deepEqual(report.registered, ["pre-record-control"]);
  assert.deepEqual(report.recorded, ["pre-record-control"]);
  assert.equal(report.scenarios[0]?.id, "pre-record-control");
  assert.equal(report.scenarios[0]?.pass, false);
  assert.equal(report.scenarios[0]?.actual, MISSING_RECORD_ACTUAL);
  assert.match(stderr + stdout, /controlled pre-record failure/);
});
