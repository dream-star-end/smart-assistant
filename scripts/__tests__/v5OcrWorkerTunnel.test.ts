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

test("OCR supervisor census excludes its own query shell instead of self-matching", () => {
  const fixture = [
    " 4242 4100 4242 /bin/bash /opt/openclaude-ocr-worker/current/run-supervisor.sh",
    " 4244 4242 4242 /bin/bash /opt/openclaude-ocr-worker/current/run-supervisor.sh",
    " 4243 4100 4243 bash -c ps -eo pid=,ppid=,pgid=,args= | awk $0~run-supervisor.sh",
    " 4245    1 4245 /bin/bash /root/unrelated/run-supervisor.sh",
  ].join("\n");
  const program = '$1 == $3 && $4 == "/bin/bash" && $5 ~ /^\\/opt\\/openclaude-ocr-worker\\/(current|releases\\/[^/]+)\\/run-supervisor\\.sh$/ && NF == 5 { total++; if ($2 == 1) orphan++ } END { print total+0, orphan+0 }';
  const result = spawnSync("awk", [program], { input: fixture, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "1 0");

  const orphan = spawnSync("awk", [program], {
    input: " 5252 1 5252 /bin/bash /opt/openclaude-ocr-worker/releases/release-a/run-supervisor.sh\n",
    encoding: "utf8",
  });
  assert.equal(orphan.status, 0, orphan.stderr);
  assert.equal(orphan.stdout.trim(), "1 1");

  const smoke = readFileSync(path.join(root, "scripts/v5-ocr-worker-smoke.sh"), "utf8");
  assert.match(smoke, /\\\$1 == \\\$3/);
  assert.match(smoke, /\\\$4 == \\"\/bin\/bash\\"/);
  assert.match(smoke, /\\\$5 ~ \/\^\\\\\/opt/);
  assert.match(smoke, /&& NF == 5/);
});
