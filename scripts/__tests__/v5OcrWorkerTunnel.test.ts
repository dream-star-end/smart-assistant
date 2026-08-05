import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("OCR tunnel heartbeat exits on broken stdout and cleans every worker child", () => {
  const worker = path.join(root, "packages/commercial/ocr-worker");
  const result = spawnSync(
    "python3",
    ["-m", "unittest", "-v", "test_worker.WorkerTest.test_ssh_stdout_disconnect_stops_supervisor_and_all_children"],
    { cwd: worker, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("official deploy smoke proves exact OCR readiness, stable tunnel identity, and no orphan supervisor", () => {
  const deploy = readFileSync(path.join(root, "scripts/deploy-v5.sh"), "utf8");
  const smoke = readFileSync(path.join(root, "scripts/v5-ocr-worker-smoke.sh"), "utf8");
  assert.match(deploy, /v5-ocr-worker-smoke\.sh/);
  assert.match(smoke, /before_restarts=.*NRestarts/);
  assert.match(smoke, /after_restarts=.*NRestarts/);
  assert.match(smoke, /after_pid.*before_pid/);
  assert.match(smoke, /\.ready == true and \.protocol_major == 1 and \.release == \$release/);
  assert.match(smoke, /orphan.*== 0/);
  assert.match(smoke, /OCR worker tunnel stability drifted during smoke/);
});
