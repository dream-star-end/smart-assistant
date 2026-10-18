import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../test-mutex.sh", import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const env = (seconds = "10") => ({ PATH: process.env.PATH ?? "/usr/bin:/bin", OC_TEST_MUTEX_TIMEOUT: seconds });

function fixture(t: { after(fn: () => void): void }) {
  const name = `devflow-497-${process.pid}-${randomUUID()}`;
  const lock = `/var/lock/oc-test-${name}.lock`;
  const dir = mkdtempSync(path.join(tmpdir(), "oc-test-mutex-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(lock, { force: true });
    rmSync(`${lock}.holder`, { force: true });
  });
  return { name, lock, dir };
}

function run(name: string, command: string, seconds = "10") {
  return spawnSync("bash", [script, name, command], { env: env(seconds), encoding: "utf8", timeout: 15_000 });
}

async function until(check: () => boolean) {
  const deadline = Date.now() + 8_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "expected child event within 8 seconds");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("test mutex preserves separate child stderr and nonzero exit status", (t) => {
  const { name, lock } = fixture(t);
  const result = run(name, "printf stdout-marker; printf stderr-marker >&2; exit 23");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 23);
  assert.equal(result.stdout, "stdout-marker");
  assert.match(result.stderr, /stderr-marker/);
  assert.equal(existsSync(`${lock}.holder`), false);
});

test("contenders report the holder and execute serially", async (t) => {
  const { name, lock, dir } = fixture(t);
  const release = path.join(dir, "release");
  const first = spawn("bash", [script, name, `printf first-running >&2; while [ ! -f ${quote(release)} ]; do sleep 0.02; done`], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let firstError = "";
  first.stderr.on("data", (chunk) => { firstError += chunk; });
  const firstDone = new Promise((resolve) => first.on("close", resolve));
  t.after(() => { first.kill("SIGTERM"); });
  await until(() => firstError.includes("first-running"));
  const second = spawn("bash", [script, name, "printf second-running"], { env: env(), stdio: ["ignore", "pipe", "pipe"] });
  let secondError = "";
  let secondOutput = "";
  second.stderr.on("data", (chunk) => { secondError += chunk; });
  second.stdout.on("data", (chunk) => { secondOutput += chunk; });
  const secondDone = new Promise((resolve) => second.on("close", resolve));
  t.after(() => { second.kill("SIGTERM"); });
  await until(() => secondError.includes("被占"));
  assert.match(secondError, /pid=.*tree=.*started=.*cmd=/);
  assert.equal(secondOutput, "");
  writeFileSync(release, "release");
  assert.equal(await firstDone, 0);
  assert.equal(await secondDone, 0);
  assert.equal(secondOutput, "second-running");
  assert.equal(existsSync(`${lock}.holder`), false);
});

test("execution timeout reports 124 and releases the lock after cleaning its child", (t) => {
  const { name, lock, dir } = fixture(t);
  const pidFile = path.join(dir, "child.pid");
  const result = run(name, `echo $$ > ${quote(pidFile)}; sleep 30`, "1");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 124);
  assert.match(result.stderr, /命令超 1s 未结束/);
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.equal(existsSync(`${lock}.holder`), false);
  assert.equal(run(name, "printf reacquired").stdout, "reacquired");
});

test("lock-open failure reports fallback and retains child stderr and exit code", (t) => {
  const { name } = fixture(t);
  // An absent parent forces open failure even when CI runs the ops tests as root.
  const result = run(`${name}/missing`, "printf fallback-stderr >&2; exit 17");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 17);
  assert.match(result.stderr, /无法打开/);
  assert.match(result.stderr, /fallback-stderr/);
});
