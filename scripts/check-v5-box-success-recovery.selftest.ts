#!/usr/bin/env tsx
/**
 * Independent self-test for the Box success recovery supervisor.
 * Not a deploy proof. The formal CLI rejects these modes.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GateFailure, supervise } from "./check-v5-box-success-recovery.ts";

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const GATE = join(ROOT, "scripts/check-v5-box-success-recovery.ts");
const LOADER = join(ROOT, "node_modules/tsx/dist/esm/index.mjs");
const DUMMY = "postgres://test:test@127.0.0.1:1/openclaude_test";
const SHA = "c".repeat(40);
const SUCCESS = "unknown worker_complete closed through reconcileBatch to a readable capsule and this-round usage";
const HOLD_KEYS = "HOME,NODE_ENV,OC_V5_BOX_GATE_HOLD_MARKER,OPENCLAUDE_HOME,PATH,TEST_DATABASE_URL";
const PY = [
  "import os, sys, socket",
  "port_path, acc_path = sys.argv[1], sys.argv[2]",
  "server = socket.socket()",
  "server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
  "server.bind(('127.0.0.1', 0))",
  "server.listen(16)",
  "port = server.getsockname()[1]",
  "fd = os.open(port_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)",
  "os.write(fd, str(port).encode()); os.fsync(fd); os.close(fd)",
  "held = []",
  "while True:",
  "    conn, _ = server.accept()",
  "    held.append(conn)",
  "    af = os.open(acc_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)",
  "    os.write(af, b'accepted\\n'); os.fsync(af); os.close(af)",
].join("\n");

function fail(message: string): never {
  process.stderr.write(`box success recovery selftest: FAIL ${message}\n`);
  process.exit(1);
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function procIds(pid: number): { ppid: number; pgrp: number } {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return { ppid: Number(rest[1]), pgrp: Number(rest[2]) };
}
function baseEnv(): NodeJS.ProcessEnv {
  // NODE_OPTIONS is applied by node before user code, so a spawned supervisor
  // cannot be given a missing preload. The hold child plants it after start.
  return {
    PATH: process.env.PATH,
    HOME: "/tmp",
    NODE_ENV: "test",
    DATABASE_URL: "postgres://gate-sentinel:not-a-secret@127.0.0.1:9/not_the_test",
    NODE_PATH: "/tmp/ocv5-not-a-node-path",
    REDIS_URL: "redis://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
  };
}
function plantParentLeak(): void {
  process.env.DATABASE_URL = "postgres://gate-sentinel:not-a-secret@127.0.0.1:9/not_the_test";
  process.env.NODE_OPTIONS = "--require /tmp/ocv5-not-a-real-preload.js";
  process.env.NODE_PATH = "/tmp/ocv5-not-a-node-path";
  process.env.REDIS_URL = "redis://127.0.0.1:9";
  process.env.HTTP_PROXY = "http://127.0.0.1:9";
}
function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", LOADER, GATE, ...args], {
    encoding: "utf8", env, timeout: 20_000,
  });
}
function ownedPaths(text: string): string[] {
  return [...text.matchAll(/box success recovery gate: owned (\/tmp\/ocv5-\S+)/g)].map((match) => match[1] ?? "");
}
function homeOf(text: string): string {
  return /box success recovery gate: supervisor home (\/tmp\/ocv5-box-gate-\S+)/.exec(text)?.[1] ?? "";
}
async function waitFor(path: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!existsSync(path)) {
    if (Date.now() - started > timeoutMs) fail(`timeout waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function holdAndSignal(): Promise<void> {
  const marker = `/tmp/ocv5-hold-${randomBytes(4).toString("hex")}`;
  let out = "";
  let err = "";
  const child = spawn(process.execPath, ["--import", LOADER, SELF, "--supervise-hold", "60000", marker], {
    detached: true,
    env: { ...baseEnv(), TEST_DATABASE_URL: DUMMY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
  const started = Date.now();
  while (!out.includes("hold-grandchild-up")) {
    if (Date.now() - started > 15_000 || child.exitCode !== null) {
      fail(`grandchild did not start out=${out} err=${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pid = Number(readFileSync(marker, "utf8"));
  const ids = procIds(pid);
  if (!alive(pid) || !alive(ids.ppid)) fail("grandchild or its parent was not running");
  if (ids.ppid === child.pid || ids.pgrp !== ids.ppid) fail(`expected worker-group grandchild ppid=${ids.ppid} pgrp=${ids.pgrp} supervisor=${child.pid}`);
  process.kill(child.pid!, "SIGTERM");
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 8_000);
    child.once("close", (status) => { clearTimeout(timer); resolve(status); });
  });
  const deadline = Date.now() + 2_000;
  while ((alive(pid) || alive(ids.ppid)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const home = homeOf(out);
  if (code === 0 || code === null) fail(`signal exit ${code}`);
  if (alive(pid) || alive(ids.ppid)) fail("grandchild or worker still running after SIGTERM");
  if (!home || existsSync(home)) fail(`home residue ${home}`);
  if (out.includes("PASS candidate") || out.includes(SUCCESS)) fail("signal path printed a proof success");
  if (!out.includes("env-isolated sentinel=absent") || !out.includes(`env-keys ${HOLD_KEYS}`)) {
    fail(`signal env isolation missing: ${out}`);
  }
  if (out.includes("not-a-secret") || out.includes("ocv5-not-a-real-preload") || out.includes("production-must-not-leak")) {
    fail("supervisor forwarded a parent sentinel");
  }
  process.stdout.write("box success recovery selftest: PASS signal-grandchild\n");
}

async function holdDeadline(): Promise<void> {
  const marker = `/tmp/ocv5-hold-${randomBytes(4).toString("hex")}`;
  const saved = {
    DATABASE_URL: process.env.DATABASE_URL,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    NODE_PATH: process.env.NODE_PATH,
    REDIS_URL: process.env.REDIS_URL,
    HTTP_PROXY: process.env.HTTP_PROXY,
  };
  plantParentLeak();
  const started = Date.now();
  const pending = supervise({
    deadlineMs: 8_000, candidateSha: SHA, databaseUrl: DUMMY,
    extraWorkerEnv: { OC_V5_BOX_GATE_HOLD_MARKER: marker },
  });
  try {
    await waitFor(marker, 10_000);
    const pid = Number(readFileSync(marker, "utf8"));
    const ids = procIds(pid);
    if (ids.ppid === process.pid || ids.pgrp !== ids.ppid) fail("deadline grandchild is not in the worker group");
    let caught: GateFailure | undefined;
    try { await pending; } catch (error) {
      if (!(error instanceof GateFailure)) fail(`deadline threw ${error instanceof Error ? error.message : error}`);
      caught = error;
    }
    const elapsed = Date.now() - started;
    if (!caught) fail("deadline hold returned success");
    if (!caught.message.includes("BOX_SUCCESS_GATE_DEADLINE")) fail(`deadline message ${caught.message}`);
    if (elapsed < 7_000 || elapsed > 20_000) fail(`deadline elapsed ${elapsed}`);
    const until = Date.now() + 2_000;
    while ((alive(pid) || alive(ids.ppid)) && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (alive(pid) || alive(ids.ppid)) fail("deadline left grandchild or worker running");
    if (existsSync(caught.home)) fail("deadline left HOME");
    if (!caught.stdout.includes("hold-grandchild-up") || !caught.stdout.includes(`env-keys ${HOLD_KEYS}`)) {
      fail("deadline output missing hold proof");
    }
    if (caught.stdout.includes("PASS candidate") || caught.stdout.includes(SUCCESS) || caught.stdout.includes("not-a-secret")) {
      fail("deadline output leaked success or parent env");
    }
    process.stdout.write(`box success recovery selftest: PASS deadline-grandchild elapsed=${elapsed}\n`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function formalRejects(): void {
  const proved = runCli(["--prove-python-bound"], { ...baseEnv(), TEST_DATABASE_URL: DUMMY });
  if (proved.status === 0 || !proved.stderr.includes("BOX_SUCCESS_GATE_UNKNOWN_ARG")) {
    fail(`--prove-python-bound status=${proved.status} stderr=${proved.stderr}`);
  }
  if ((proved.stdout ?? "").includes("PASS candidate") || (proved.stdout ?? "").includes("python bound")) {
    fail("formal CLI printed a bypass success");
  }
  const missing = runCli([], baseEnv());
  if (missing.status === 0 || !missing.stderr.includes("BOX_SUCCESS_GATE_SHA_MISSING")) fail("missing sha was not rejected");
  const bad = runCli(["--candidate-sha", "abcd"], { ...baseEnv(), TEST_DATABASE_URL: DUMMY });
  if (bad.status === 0 || !bad.stderr.includes("BOX_SUCCESS_GATE_UNKNOWN_ARG")) fail("bad sha was not rejected");
  const nodsn = runCli(["--candidate-sha", SHA], baseEnv());
  if (nodsn.status === 0 || !nodsn.stderr.includes("BOX_SUCCESS_GATE_DSN_MISSING")) fail("missing DSN was not rejected");
  if ((nodsn.stdout ?? "").includes("supervisor home")) fail("missing DSN created a supervisor home");
  process.stdout.write("box success recovery selftest: PASS formal-rejects\n");
}

async function stageFault(): Promise<void> {
  let caught: GateFailure | undefined;
  try {
    await supervise({
      deadlineMs: 60_000, candidateSha: "d".repeat(40), databaseUrl: DUMMY,
      extraWorkerEnv: { OC_V5_BOX_GATE_FAULT: "second-write" },
    });
  } catch (error) {
    if (!(error instanceof GateFailure)) fail(`stage fault threw ${error instanceof Error ? error.message : error}`);
    caught = error;
  }
  if (!caught) fail("stage fault returned success");
  const owned = caught.owned.length ? caught.owned : ownedPaths(caught.stdout);
  const staged = [...caught.stdout.matchAll(/box success recovery gate: staged /g)].length;
  if (owned.length < 2 || staged !== 1 || !caught.stderr.includes("BOX_SUCCESS_GATE_STAGE_WRITE")) {
    fail(`stage fault shape owned=${owned.length} staged=${staged} stderr=${caught.stderr}`);
  }
  if (owned.some((path) => existsSync(path)) || existsSync(caught.home)) fail("stage fault left a path");
  if (caught.stdout.includes(SUCCESS) || caught.stdout.includes("PASS candidate")) fail("stage fault printed proof success");
  process.stdout.write("box success recovery selftest: PASS stage-fault\n");
}

async function pgHang(): Promise<void> {
  const portPath = `/tmp/ocv5-pghang-port-${randomBytes(4).toString("hex")}`;
  const accPath = `/tmp/ocv5-pghang-acc-${randomBytes(4).toString("hex")}`;
  const python = spawn("/usr/bin/python3", ["-c", PY, portPath, accPath], { stdio: "ignore" });
  try {
    await waitFor(portPath, 5_000);
    const port = Number(readFileSync(portPath, "utf8"));
    const dsn = `postgres://test:test@127.0.0.1:${port}/openclaude_test`;
    let out = "";
    let err = "";
    const child = spawn(process.execPath, ["--import", LOADER, SELF, "--supervise-pg", "90000", "e".repeat(40), dsn], {
      detached: true, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { err += chunk.toString("utf8"); });
    const started = Date.now();
    while (!out.includes("connect-start")) {
      if (Date.now() - started > 60_000 || child.exitCode !== null) {
        fail(`pg hang did not reach connect out=${out} err=${err}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await waitFor(accPath, 2_500);
    process.kill(child.pid!, "SIGTERM");
    const code = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 8_000);
      child.once("close", (status) => { clearTimeout(timer); resolve(status); });
    });
    const home = homeOf(out);
    const owned = ownedPaths(out);
    if (code === 0 || code === null) fail(`pg hang exit ${code}`);
    if (!alive(python.pid!)) fail("hang server died; the accept loop did not keep the socket");
    if (!readFileSync(accPath, "utf8").includes("accepted")) fail("server did not accept");
    if (err.includes("ECONNREFUSED") || out.includes("PASS candidate") || out.includes(SUCCESS)) {
      fail("pg hang was a refusal or a proof success");
    }
    if (!home || existsSync(home) || owned.length < 2 || owned.some((path) => existsSync(path))) {
      fail(`pg hang residue home=${home} owned=${owned.join(",")}`);
    }
    process.stdout.write("box success recovery selftest: PASS pg-hang\n");
  } finally {
    if (python.pid && alive(python.pid)) process.kill(python.pid, "SIGKILL");
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "--local";
  if (mode === "--supervise-hold") {
    plantParentLeak();
    try {
      await supervise({
        deadlineMs: Number(process.argv[3]), candidateSha: SHA, databaseUrl: DUMMY,
        extraWorkerEnv: { OC_V5_BOX_GATE_HOLD_MARKER: process.argv[4] ?? "" },
      });
      fail("hold supervisor returned");
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  }
  if (mode === "--supervise-pg") {
    try {
      await supervise({
        deadlineMs: Number(process.argv[3]), candidateSha: process.argv[4] ?? "",
        databaseUrl: process.argv[5] ?? "",
      });
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
      process.exit(1);
    }
  }
  if (mode === "--stage-fault") {
    await stageFault();
    return;
  }
  if (mode === "--pg-hang") {
    await pgHang();
    return;
  }
  if (mode !== "--local") fail(`unknown selftest mode ${mode}`);
  formalRejects();
  await holdDeadline();
  await holdAndSignal();
  process.stdout.write("box success recovery selftest: PASS local cases=3\n");
}

main().catch((error: unknown) => {
  process.stderr.write(`box success recovery selftest: FAIL ${error instanceof Error ? error.stack ?? error.message : error}\n`);
  process.exit(1);
});
