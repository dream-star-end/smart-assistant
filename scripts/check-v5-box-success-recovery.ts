#!/usr/bin/env tsx
/**
 * Pre-seal behavioral gate for Box tool success recovery.
 * The supervisor process does not import product modules. It validates the
 * explicit test DSN, then spawns one worker with a fresh HOME and a whitelist
 * environment. The worker loads this candidate only after that scrub.
 * PostgreSQL is never defaulted. Identity is the caller-supplied full SHA
 * plus hashes of the candidate files, not a handwritten flavor manifest.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SCRIPT));
const TEMP = "/tmp";
const DEADLINE_MS = 90_000;
const SENTINEL_KEY = "OC_V5_BOX_GATE_SENTINEL";
const HOLD_KEY = "OC_V5_BOX_GATE_HOLD_MARKER";
const HOLD_SIGNALS_KEY = "OC_V5_BOX_GATE_HOLD_SIGNALS";
const FAULT_KEY = "OC_V5_BOX_GATE_FAULT";
const ALLOWED_ENV = ["HOME", "NODE_ENV", "OPENCLAUDE_HOME", "PATH", "TEST_DATABASE_URL"];
const EXTRA_ENV = new Set([HOLD_KEY, HOLD_SIGNALS_KEY, FAULT_KEY]);
const FORBIDDEN_KEYS = [
  "DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE",
  "PGSERVICE", "PGOPTIONS", "PGSSLMODE", "REDIS_URL", "NODE_OPTIONS", "NODE_PATH",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
  "all_proxy", "no_proxy", SENTINEL_KEY,
];

const ACTIVE = new Set(["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"]);
const PY_TIMEOUT_MS = 5_000;
const SHADOW_TABLES = ["request_finalize_journal", "usage_records", "pending_usage_patches",
  "users", "user_subscriptions", "org_memberships", "orgs", "org_subscriptions",
  "turn_waivers", "client_sessions", "chat_projects", "credit_ledger"];
const MODEL = "claude-opus-5-5";
const TOOL_NAME = "mcp__ocbridge__t0";
const RUNNER_HASH = "d".repeat(64);
const BEHAVIOR = [
  "unknown worker_complete closed through reconcileBatch to a readable capsule and this-round usage",
  "intermediate handoff stayed pending without capsule or CAS",
];
const HOLD_PY = [
  "import os, signal, sys, time",
  "path, mode = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else 'default')",
  "if mode == 'ignore-term':",
  "    signal.signal(signal.SIGTERM, signal.SIG_IGN)",
  "stat = open('/proc/self/stat').read()",
  "rest = stat[stat.rfind(')') + 2:].split()",
  "fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)",
  "os.write(fd, (str(os.getpid()) + chr(10) + rest[19] + chr(10) + str(os.getpgid(0)) + chr(10)).encode())",
  "os.fsync(fd)",
  "os.close(fd)",
  "while True:",
  "    time.sleep(30)",
].join("\n");

type ExecRequest = { command: string; args: string[]; cwd?: string; environment?: Record<string, string> };
type DbConfig = {
  host: string; port: number; database: string; user: string; password: string;
  ssl: false; connectionTimeoutMillis: number; statement_timeout: number;
  query_timeout: number; max: number;
};
type QueryClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  release: () => void;
};

export type SuperviseOptions = {
  deadlineMs?: number;
  databaseUrl?: string;
  candidateSha: string;
  extraWorkerEnv?: Record<string, string>;
  root?: string;
};

export class GateFailure extends Error {
  readonly stdout: string;
  readonly stderr: string;
  readonly sentinel: string;
  readonly home: string;
  readonly owned: string[];
  constructor(message: string, info: { stdout: string; stderr: string; sentinel: string; home: string; owned: string[] }) {
    super(message);
    this.name = "GateFailure";
    this.stdout = info.stdout;
    this.stderr = info.stderr;
    this.sentinel = info.sentinel;
    this.home = info.home;
    this.owned = info.owned;
  }
}

function emit(msg: string): void {
  writeSync(1, msg + "\n");
}
function emitErr(msg: string): void {
  writeSync(2, msg + "\n");
}
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function isDirect(): boolean {
  try { return realpathSync(process.argv[1] ?? "") === realpathSync(SCRIPT); }
  catch { return false; }
}

export function parseTestDatabase(raw: string | undefined): { raw: string; config: DbConfig } {
  if (!raw) throw new Error("BOX_SUCCESS_GATE_DSN_MISSING");
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === raw) {
    throw new Error("BOX_SUCCESS_GATE_PRODUCTION_DSN");
  }
  const url = new URL(raw);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("BOX_SUCCESS_GATE_DSN_SCHEME");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("BOX_SUCCESS_GATE_DSN_NOT_LOOPBACK");
  }
  if (url.search || url.hash) throw new Error("BOX_SUCCESS_GATE_DSN_OPTIONS");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!/^[A-Za-z0-9_]+_test$/.test(database)) throw new Error("BOX_SUCCESS_GATE_DSN_NOT_TEST");
  if (!url.username || !url.password) throw new Error("BOX_SUCCESS_GATE_DSN_INCOMPLETE");
  return {
    raw,
    config: {
      host: url.hostname === "[::1]" ? "::1" : "127.0.0.1",
      port: Number(url.port || 5432),
      database,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: false,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 8_000,
      query_timeout: 8_000,
      max: 1,
    },
  };
}

function assertOwnedPath(path: string): void {
  if (path.includes("\0") || path.includes("..")) throw new Error("BOX_SUCCESS_GATE_RM");
  const run = /^\/tmp\/ocv5-289-run-[0-9a-f]{24}$/;
  const capsule = /^\/tmp\/ocv5-gate-capsule-[0-9a-f]{12}$/;
  const home = /^\/tmp\/ocv5-box-gate-[A-Za-z0-9_-]{1,40}$/;
  if (!run.test(path) && !capsule.test(path) && !home.test(path)) {
    throw new Error("BOX_SUCCESS_GATE_RM");
  }
}

function safeRm(path: string): void {
  assertOwnedPath(path);
  let st: ReturnType<typeof lstatSync>;
  try { st = lstatSync(path); } catch { return; }
  if (st.isSymbolicLink()) throw new Error("BOX_SUCCESS_GATE_RM_SYMLINK");
  rmSync(path, { recursive: true, force: true });
}

function readLedger(ledger: string): string[] {
  try {
    return readFileSync(ledger, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  } catch { return []; }
}

function runningMembers(pgid: number): number[] {
  const found: number[] = [];
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return found; }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const state = rest[0] ?? "";
      if (Number(rest[2]) !== pgid) continue;
      if (state.startsWith("Z") || state.startsWith("X")) continue;
      found.push(Number(name));
    } catch { /* process exited while scanning */ }
  }
  return found;
}

async function killGroup(pid: number): Promise<void> {
  const running = (): number[] => runningMembers(pid);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const untilQuiet = async (limitMs: number): Promise<void> => {
    const started = Date.now();
    while (running().length > 0 && Date.now() - started < limitMs) await pause(50);
  };
  if (running().length === 0) return;
  try { process.kill(-pid, "SIGTERM"); } catch { /* already gone */ }
  await untilQuiet(1_000);
  if (running().length > 0) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    await untilQuiet(1_000);
  }
  const left = running();
  if (left.length > 0) throw new Error(`BOX_SUCCESS_GATE_KILL_GROUP ${left.join(",")}`);
}

function assertPinnedModules(root: string): void {
  const base = realpathSync(root);
  for (const name of ["commercial", "gateway", "protocol", "storage", "pg", "tsx"]) {
    const linked = realpathSync(join(root, "node_modules", name === "pg" || name === "tsx"
      ? name : join("@openclaude", name)));
    const owned = name === "pg" || name === "tsx" ? linked : realpathSync(join(root, "packages", name));
    if (name !== "pg" && name !== "tsx" && linked !== owned) {
      throw new Error(`BOX_SUCCESS_GATE_MODULE_ESCAPED ${name}`);
    }
    if (!linked.startsWith(base + "/")) throw new Error(`BOX_SUCCESS_GATE_MODULE_ESCAPED ${name}`);
  }
}

function checkFlavor(root: string, sha: string): void {
  const flavor = join(root, "flavor.manifest.json");
  if (!existsSync(flavor)) return;
  const parsed = JSON.parse(readFileSync(flavor, "utf8")) as { sourceCommit?: unknown };
  if (parsed.sourceCommit !== sha) throw new Error("BOX_SUCCESS_GATE_FLAVOR_MISMATCH");
}

function digestLine(root: string): string {
  const files = {
    worker: join(root, "packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts"),
    schema: join(root, "packages/commercial/src/billing/boxBillingRecoveryTempSchema.sql"),
    pg: join(root, "node_modules/pg/package.json"),
    tsx: join(root, "node_modules/tsx/package.json"),
  };
  for (const path of Object.values(files)) {
    if (!existsSync(path)) throw new Error("BOX_SUCCESS_GATE_DIGEST");
  }
  return `box success recovery gate: digest worker=${sha256(files.worker)} schema=${sha256(files.schema)} pg=${sha256(files.pg)} tsx=${sha256(files.tsx)}`;
}

function assertWorkerEnv(home: string): void {
  const allowed = new Set<string>(ALLOWED_ENV);
  if (process.env[HOLD_KEY]) allowed.add(HOLD_KEY);
  if (process.env[HOLD_SIGNALS_KEY]) allowed.add(HOLD_SIGNALS_KEY);
  if (process.env[FAULT_KEY]) allowed.add(FAULT_KEY);
  const keys = Object.keys(process.env).sort();
  for (const key of keys) {
    if (!allowed.has(key)) throw new Error(`BOX_SUCCESS_GATE_ENV_LEAK ${key}`);
  }
  if (process.env[SENTINEL_KEY]) throw new Error("BOX_SUCCESS_GATE_SENTINEL_LEAK");
  for (const key of FORBIDDEN_KEYS) {
    if (process.env[key]) throw new Error(`BOX_SUCCESS_GATE_ENV_LEAK ${key}`);
  }
  if (process.env.HOME !== home || process.env.OPENCLAUDE_HOME !== home) {
    throw new Error("BOX_SUCCESS_GATE_HOME");
  }
  if (process.env.NODE_ENV !== "test") throw new Error("BOX_SUCCESS_GATE_NODE_ENV");
  const fault = process.env[FAULT_KEY];
  if (fault && fault !== "second-write") throw new Error("BOX_SUCCESS_GATE_FAULT");
  const signals = process.env[HOLD_SIGNALS_KEY];
  if (signals && signals !== "default" && signals !== "ignore-term") {
    throw new Error("BOX_SUCCESS_GATE_HOLD_SIGNALS");
  }
  emit("box success recovery gate: env-isolated sentinel=absent");
  emit(`box success recovery gate: env-keys ${keys.join(",")}`);
}

function holdGrandchild(marker: string): never {
  if (!/^\/tmp\/ocv5-hold-[A-Za-z0-9_-]{1,40}$/.test(marker)) {
    throw new Error("BOX_SUCCESS_GATE_HOLD_MARKER");
  }
  const mode = process.env[HOLD_SIGNALS_KEY] === "ignore-term" ? "ignore-term" : "default";
  const child = spawn("/usr/bin/python3", ["-c", HOLD_PY, marker, mode], { stdio: "ignore" });
  const started = Date.now();
  while (!existsSync(marker)) {
    if (child.exitCode !== null || Date.now() - started > 2_000) {
      throw new Error("BOX_SUCCESS_GATE_HOLD_MARKER");
    }
    sleepMs(20);
  }
  emit("box success recovery gate: hold-grandchild-up");
  const i32 = new Int32Array(new SharedArrayBuffer(4));
  while (true) Atomics.wait(i32, 0, 0, 60_000);
}

export async function supervise(opts: SuperviseOptions): Promise<{ stdout: string; stderr: string; sentinel: string; home: string; owned: string[] }> {
  const sentinel = `production-must-not-leak-${randomBytes(8).toString("hex")}`;
  process.env[SENTINEL_KEY] = sentinel;
  if (!/^[0-9a-f]{40}$/.test(opts.candidateSha)) throw new Error("BOX_SUCCESS_GATE_SHA");
  const deadline = opts.deadlineMs ?? DEADLINE_MS;
  if (!Number.isInteger(deadline) || deadline < 1_000 || deadline > 120_000) {
    throw new Error("BOX_SUCCESS_GATE_DEADLINE_RANGE");
  }
  const db = parseTestDatabase(opts.databaseUrl ?? process.env.OC_V5_PROOF_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL);
  const root = opts.root ?? ROOT;
  const script = root === ROOT ? SCRIPT : join(root, "scripts/check-v5-box-success-recovery.ts");
  const loader = join(root, "node_modules/tsx/dist/esm/index.mjs");
  if (!existsSync(loader) || !existsSync(script)) throw new Error("BOX_SUCCESS_GATE_TSX_LOADER");
  if (!process.env.PATH) throw new Error("BOX_SUCCESS_GATE_PATH");
  const extra = opts.extraWorkerEnv ?? {};
  for (const key of Object.keys(extra)) {
    if (!EXTRA_ENV.has(key)) throw new Error(`BOX_SUCCESS_GATE_EXTRA_ENV ${key}`);
  }
  const home = join(TEMP, `ocv5-box-gate-${randomBytes(6).toString("hex")}`);
  mkdirSync(home, { mode: 0o700 });
  chmodSync(home, 0o700);
  const ledger = join(home, "owned");
  writeFileSync(ledger, "", { mode: 0o600 });
  let stdout = "";
  let stderr = "";
  let cleaned = false;
  const snapshot = (): string[] => readLedger(ledger);
  const cleanupOnce = (): string[] => {
    if (cleaned) return snapshot();
    const owned = snapshot();
    cleaned = true;
    for (const path of owned) safeRm(path);
    safeRm(home);
    return owned;
  };
  const info = (owned: string[]) => ({ stdout, stderr, sentinel, home, owned });
  emit(`box success recovery gate: supervisor home ${home}`);
  emit("box success recovery gate: supervisor sentinel-held");
  const child: ChildProcess = spawn(process.execPath, [
    "--import", loader, script, "--worker", home, ledger, opts.candidateSha,
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      HOME: home,
      OPENCLAUDE_HOME: home,
      TEST_DATABASE_URL: db.raw,
      NODE_ENV: "test",
      ...extra,
    },
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    writeSync(1, text);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stderr += text;
    writeSync(2, text);
  });
  // close/error/deadline/signal all join this drain. A close event must not
  // settle, or process.exit, before SIGKILL and the running-member check finish.
  let stopReason = "";
  let killFailure = "";
  let spawnError: Error | undefined;
  let closed: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let drainTask: Promise<void> | undefined;
  let releaseWait: (() => void) | undefined;
  const childClosed = new Promise<void>((resolve) => {
    child.once("close", (code, signal) => {
      closed = { code, signal };
      resolve();
      if (!stopReason) {
        stopReason = "close";
        releaseWait?.();
      }
    });
  });
  child.once("error", (error: Error) => {
    spawnError = error;
    if (!stopReason) {
      stopReason = "error";
      releaseWait?.();
    }
  });
  const timer = setTimeout(() => {
    if (stopReason) return;
    stopReason = "deadline";
    emitErr("box success recovery gate: DEADLINE");
    releaseWait?.();
  }, deadline);
  const drain = (): Promise<void> => {
    if (!drainTask) {
      drainTask = (async () => {
        clearTimeout(timer);
        try {
          if (child.pid) await killGroup(child.pid);
        } catch (error) {
          killFailure = error instanceof Error ? error.message : String(error);
        }
        await Promise.race([childClosed, new Promise((resolve) => setTimeout(resolve, 500))]);
      })();
    }
    return drainTask;
  };
  const onSignal = (sig: NodeJS.Signals): void => {
    if (!stopReason) stopReason = "signal";
    void (async () => {
      await drain();
      cleanupOnce();
      emitErr(`box success recovery gate: signal ${sig}`);
      process.exit(1);
    })();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    await new Promise<void>((resolve) => {
      releaseWait = () => { void drain().then(resolve); };
      if (stopReason) releaseWait();
    });
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  const owned = cleanupOnce();
  let failure = killFailure;
  if (!failure && stopReason === "deadline") failure = "BOX_SUCCESS_GATE_DEADLINE";
  else if (!failure && spawnError) failure = spawnError.message;
  else if (!failure && !(closed && closed.code === 0 && closed.signal === null)) {
    failure = `BOX_SUCCESS_GATE_WORKER code=${closed?.code ?? "null"} signal=${closed?.signal ?? "none"}`;
  }
  if (failure) throw new GateFailure(failure, info(owned));
  if (!stdout.includes("box success recovery gate: env-isolated sentinel=absent")) {
    throw new GateFailure("BOX_SUCCESS_GATE_ENV_UNPROVEN", info(owned));
  }
  const keys = /box success recovery gate: env-keys (\S+)/.exec(stdout)?.[1]?.split(",") ?? [];
  if (FORBIDDEN_KEYS.some((key) => keys.includes(key))) {
    throw new GateFailure("BOX_SUCCESS_GATE_ENV_LEAK", info(owned));
  }
  if (!/box success recovery gate: digest worker=[0-9a-f]{64} schema=[0-9a-f]{64} pg=[0-9a-f]{64} tsx=[0-9a-f]{64}/.test(stdout)) {
    throw new GateFailure("BOX_SUCCESS_GATE_DIGEST_MISSING", info(owned));
  }
  for (const line of BEHAVIOR) {
    if (!stdout.includes(line)) throw new GateFailure("BOX_SUCCESS_GATE_RESULT", info(owned));
  }
  for (const path of owned) {
    if (existsSync(path)) throw new GateFailure(`BOX_SUCCESS_GATE_RESIDUE ${path}`, info(owned));
  }
  if (existsSync(home)) throw new GateFailure("BOX_SUCCESS_GATE_RESIDUE_HOME", info(owned));
  emit(`box success recovery gate: PASS candidate ${opts.candidateSha}`);
  return info(owned);
}

function remember(ledger: string, owned: string[], path: string): void {
  if (!owned.includes(path)) owned.push(path);
  const fd = openSync(ledger, "a");
  try {
    writeSync(fd, path + "\n");
    fsyncSync(fd);
  } finally { closeSync(fd); }
  emit(`box success recovery gate: owned ${path}`);
  mkdirSync(path, { mode: 0o700 });
  chmodSync(path, 0o700);
}

async function runBusiness(root: string, ledger: string, db: DbConfig): Promise<void> {
  const product = await Promise.all([
    import("../packages/commercial/src/egress/boxReplaySetup.ts"),
    import("../packages/commercial/src/http/proxy/boxDetachedRunAccess.ts"),
    import("../packages/commercial/src/http/proxy/boxDurableJournal.ts"),
    import("../packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts"),
    import("../packages/commercial/src/http/proxy/boxRunCleanup.ts"),
    import("../packages/commercial/src/http/proxy/boxStagedCatalogRead.ts"),
    import("../packages/commercial/src/http/proxy/boxTerminalProof.ts"),
    import("../packages/commercial/src/http/proxy/boxToolCatalog.ts"),
    import("pg"),
  ]);
  const replay = product[0] as { createBoxReplayReader: (root: string) => unknown; createBoxReplayRecoveryWriter: (root: string) => unknown };
  const accessMod = product[1] as { makeBoxDetachedRunAccess: (input: { runNonce: string; detachedRunnerHash: string }) => { readSpool: (offset: number, limit: number) => ExecRequest } };
  const journalMod = product[2] as { BoxDurableJournal: new (pool: unknown) => unknown };
  const workerMod = product[3] as { BoxRemoteCleanupWorker: new (input: unknown) => { reconcileBatch: () => Promise<void> } };
  const cleanupMod = product[4] as { makeBoxRunCleanup: (nonce: string, keep: boolean) => ExecRequest };
  const catalogReadMod = product[5] as { makeBoxStagedCatalogRead: (nonce: string, offset: number, limit: number) => ExecRequest };
  const proofMod = product[6] as { makeBoxTerminalRead: (path: string) => ExecRequest };
  const toolMod = product[7] as { compileBoxToolCatalog: (tools: unknown[]) => { json: string; bindingSha256: string } };
  const pg = product[8] as { Pool: new (config: DbConfig) => { connect: () => Promise<QueryClient>; end: () => Promise<void> } };
  const catalog = toolMod.compileBoxToolCatalog([{ name: "local_echo", description: "synthetic",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const owned: string[] = [];
  let pool: { end: () => Promise<void> } | undefined;
  let client: QueryClient | undefined;
  const sameRequest = (actual: ExecRequest, expected: ExecRequest): boolean => actual.command === expected.command
    && actual.cwd === expected.cwd
    && actual.args.length === expected.args.length
    && actual.args.every((arg, index) => arg === expected.args[index])
    && JSON.stringify(actual.environment ?? {}) === JSON.stringify(expected.environment ?? {});
  const classify = (req: ExecRequest, nonces: string[]): { kind: "catalog" | "cleanup" | "proof" | "spool"; nonce: string; offset: number } | null => {
    for (const nonce of nonces) {
      const access = accessMod.makeBoxDetachedRunAccess({ runNonce: nonce, detachedRunnerHash: RUNNER_HASH });
      const offset = Number(req.args.at(-2));
      const limit = Number(req.args.at(-1));
      if (Number.isSafeInteger(offset) && Number.isSafeInteger(limit)) {
        try { if (sameRequest(req, access.readSpool(offset, limit))) return { kind: "spool", nonce, offset }; }
        catch { /* not this spool shape */ }
        try {
          if (sameRequest(req, catalogReadMod.makeBoxStagedCatalogRead(nonce, offset, limit))) {
            return { kind: "catalog", nonce, offset };
          }
        } catch { /* not this catalog window */ }
      }
      try {
        if (sameRequest(req, proofMod.makeBoxTerminalRead(`/tmp/ocv5-289-proof-${nonce}`))) {
          return { kind: "proof", nonce, offset: 0 };
        }
      } catch { /* not this proof */ }
      for (const keep of [false, true]) {
        try {
          if (sameRequest(req, cleanupMod.makeBoxRunCleanup(nonce, keep))) return { kind: "cleanup", nonce, offset: 0 };
        } catch { /* not this cleanup */ }
      }
    }
    return null;
  };
  const spawnBounded = (req: ExecRequest): { stdout: string; stderrBytes: number; exitCode: 0 } => {
    const child = spawnSync(req.command, req.args, {
      encoding: "utf8", cwd: req.cwd, env: req.environment, timeout: PY_TIMEOUT_MS, killSignal: "SIGKILL",
    });
    if ((child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error("BOX_SUCCESS_GATE_PYTHON_TIMEOUT");
    }
    if (child.error) throw new Error("BOX_SUCCESS_GATE_PYTHON_SPAWN");
    if (child.status !== 0) throw new Error(`BOX_SUCCESS_GATE_PYTHON_${child.status ?? "signal"}`);
    return { stdout: child.stdout ?? "", stderrBytes: Buffer.byteLength(child.stderr ?? ""), exitCode: 0 };
  };
  let staged = 0;
  const stage = (nonce: string): string => {
    const run = `/tmp/ocv5-289-run-${nonce}`;
    remember(ledger, owned, run);
    staged += 1;
    const catalogPath = `${run}/tool-catalog.json`;
    if (process.env[FAULT_KEY] === "second-write" && staged === 2) mkdirSync(catalogPath, { mode: 0o700 });
    try {
      writeFileSync(catalogPath, catalog.json);
      chmodSync(catalogPath, 0o600);
    } catch (error) {
      if (process.env[FAULT_KEY] === "second-write" && staged === 2) {
        throw new Error("BOX_SUCCESS_GATE_STAGE_WRITE");
      }
      throw error;
    }
    emit(`box success recovery gate: staged ${run}`);
    return run;
  };
  try {
    const successNonce = randomBytes(12).toString("hex");
    const handoffNonce = randomBytes(12).toString("hex");
    stage(successNonce);
    stage(handoffNonce);
    const capsuleParent = join(TEMP, `ocv5-gate-capsule-${randomBytes(6).toString("hex")}`);
    remember(ledger, owned, capsuleParent);
    mkdirSync(join(capsuleParent, "box-replay-messages"), { mode: 0o700 });
    const platformRoot = join(capsuleParent, "state");
    const proofs = new Map<string, unknown>([
      [successNonce, { runNonce: successNonce, leaseEpoch: "b".repeat(32), keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 }],
      [handoffNonce, { runNonce: handoffNonce, leaseEpoch: "c".repeat(32), keeperPid: 101,
        cliPid: 102, reason: "worker_complete", revision: 1 }],
    ]);
    const linesOf = (records: unknown[]): Buffer => Buffer.from(records.map((item) => JSON.stringify(item) + "\n").join(""));
    const finalSpool = (): Buffer => linesOf([
      { type: "system", subtype: "init", tools: [TOOL_NAME], mcp_servers: [{}] },
      event({ type: "message_start", message: { id: "msg_gate", model: MODEL, role: "assistant",
        content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2 } } }),
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
      { type: "assistant", message: { id: "msg_gate", model: MODEL, role: "assistant",
        content: [{ type: "text", text: "done" }] } },
      event({ type: "content_block_stop", index: 0 }),
      event({ type: "message_delta", delta: { stop_reason: "end_turn" },
        usage: { input_tokens: 3, output_tokens: 4 } }),
      event({ type: "message_stop" }),
      { type: "result", subtype: "success", is_error: false,
        usage: { input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 1,
          cache_creation_input_tokens: 2 } },
    ]);
    const handoffSpool = (): Buffer => {
      const use = { type: "tool_use", id: "toolu_gate_handoff", name: TOOL_NAME, input: { value: "x" } };
      return linesOf([
        { type: "system", subtype: "init", tools: [TOOL_NAME], mcp_servers: [{}] },
        event({ type: "message_start", message: { id: "msg_hand", model: MODEL, role: "assistant",
          content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
        event({ type: "content_block_start", index: 0,
          content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } }),
        event({ type: "content_block_delta", index: 0,
          delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
        { type: "assistant", message: { id: "msg_hand", model: MODEL, role: "assistant", content: [use] } },
        event({ type: "content_block_stop", index: 0 }),
        event({ type: "message_delta", delta: { stop_reason: "tool_use" },
          usage: { input_tokens: 2, output_tokens: 4 } }),
        event({ type: "message_stop" }),
      ]);
    };
    const spools = new Map<string, Buffer>([[successNonce, finalSpool()], [handoffNonce, handoffSpool()]]);
    const nonces = [...spools.keys()];
    const remote = async (req: ExecRequest) => {
      const kind = classify(req, nonces);
      if (!kind) throw new Error("BOX_SUCCESS_GATE_EXEC");
      if (kind.kind === "spool") {
        const raw = spools.get(kind.nonce);
        if (!raw) throw new Error("BOX_SUCCESS_GATE_SPOOL");
        const bytes = raw.subarray(kind.offset);
        return { stdout: JSON.stringify({ data: bytes.toString("base64"), offset: kind.offset + bytes.length }),
          stderrBytes: 0, exitCode: 0 as const };
      }
      if (kind.kind === "proof") {
        return { stdout: JSON.stringify(proofs.get(kind.nonce)) + "\n", stderrBytes: 0, exitCode: 0 as const };
      }
      return spawnBounded(req);
    };
    emit("box success recovery gate: connect-start");
    pool = new pg.Pool(db);
    client = await pool.connect();
    const source = await client.query(
      `SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) AS ready FROM unnest($1::text[]) AS name`,
      [SHADOW_TABLES]);
    if (source.rows[0]?.ready === true) {
      for (const name of SHADOW_TABLES) {
        await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
      }
    } else {
      const ddl = readFileSync(join(root, "packages/commercial/src/billing/boxBillingRecoveryTempSchema.sql"), "utf8");
      for (const statement of ddl.split(/;\s*(?:\r?\n|$)/)) {
        const trimmed = statement.trim();
        if (!trimmed || !/create\s+temp\s+table/i.test(trimmed)) continue;
        await client.query(trimmed);
      }
    }
    const check = await client.query(
      `SELECT name, n.nspname AS schema, current_database() AS db
         FROM unnest($1::text[]) AS name
         JOIN pg_class c ON c.oid = to_regclass(name)
         JOIN pg_namespace n ON n.oid = c.relnamespace`, [SHADOW_TABLES]);
    if (check.rows.length !== SHADOW_TABLES.length
      || check.rows.some((row) => !/^pg_temp(?:_\d+)?$/.test(String(row.schema)) || !/_test$/.test(String(row.db)))) {
      throw new Error("BOX_SUCCESS_GATE_SHADOW");
    }
    const insertLeaf = async (requestId: string, uid: bigint, nonce: string, epoch: string): Promise<void> => {
      await client!.query(`INSERT INTO request_finalize_journal
        (request_id,user_id,state,ctx,precheck_credits) VALUES ($1,$2,'inflight',$3::jsonb,0)`,
      [requestId, uid.toString(), JSON.stringify({
        model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
        boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
        boxLeaseEpoch: epoch, boxSessionId: requestId, boxTurnKey: "a".repeat(64),
        boxCatalogHash: catalog.bindingSha256, boxDetachedRunnerHash: RUNNER_HASH,
        boxState: "unknown", boxLaunchPermit: true,
        billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
          inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1",
          multiplier: "1" } })]);
    };
    await insertLeaf("gate-ok", 900_000_230n, successNonce, "b".repeat(32));
    await insertLeaf("gate-handoff", 900_000_231n, handoffNonce, "c".repeat(32));
    const writer = replay.createBoxReplayRecoveryWriter(platformRoot) as ((id: unknown, message: unknown) => Promise<unknown>) | null;
    const reader = replay.createBoxReplayReader(platformRoot) as ((id: unknown) => Promise<{ id?: string }>) | null;
    if (!writer || !reader) throw new Error("BOX_SUCCESS_GATE_REPLAY");
    const writes: string[] = [];
    const same = { connect: async () => ({ query: client!.query.bind(client), release: () => {} }),
      query: client.query.bind(client) };
    const worker = new workerMod.BoxRemoteCleanupWorker({
      journal: new journalMod.BoxDurableJournal(same),
      writeRecoveryMessage: async (id: { requestId: string }, message: unknown) => {
        writes.push(id.requestId);
        return writer(id, message);
      },
      resolver: { resolve: async () => ({ accountId: 20n, exec: { run: remote }, dispose: async () => {} }) },
    });
    await worker.reconcileBatch();
    const rows = await client.query(
      `SELECT request_id AS id, ctx->>'boxState' AS box, ctx->'boxUsage' AS usage, ctx->'boxReplayMessage' AS replay
         FROM request_finalize_journal WHERE request_id IN ('gate-ok','gate-handoff')`);
    const ok = rows.rows.find((row) => row.id === "gate-ok");
    const held = rows.rows.find((row) => row.id === "gate-handoff");
    assert.equal(ok?.box, "terminal");
    assert.equal(ACTIVE.has(String(ok?.box ?? "")), false);
    assert.deepEqual(ok?.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 2 });
    assert.ok(ok?.replay);
    const message = await reader(ok?.replay);
    assert.equal(message.id, "msg_gate");
    assert.equal(held?.box, "unknown");
    assert.equal(held?.replay ?? null, null);
    assert.deepEqual(writes, ["gate-ok"]);
    emit(BEHAVIOR[0]!);
    emit(BEHAVIOR[1]!);
  } finally {
    try { client?.release(); } catch { /* already released */ }
    if (pool) await pool.end();
    for (const path of owned) safeRm(path);
  }
}

async function runWorker(argv: string[]): Promise<void> {
  if (argv.length !== 3) throw new Error("BOX_SUCCESS_GATE_UNKNOWN_ARG");
  const home = argv[0] ?? "";
  const ledger = argv[1] ?? "";
  const sha = argv[2] ?? "";
  if (ledger !== join(home, "owned")) throw new Error("BOX_SUCCESS_GATE_LEDGER");
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("BOX_SUCCESS_GATE_SHA");
  assertWorkerEnv(home);
  if (process.env[HOLD_KEY]) holdGrandchild(process.env[HOLD_KEY] ?? "");
  const db = parseTestDatabase(process.env.TEST_DATABASE_URL);
  checkFlavor(ROOT, sha);
  emit(digestLine(ROOT));
  assertPinnedModules(ROOT);
  emit(`box success recovery gate: candidate ${sha} database ${db.config.database} host ${db.config.host}`);
  await runBusiness(ROOT, ledger, db.config);
}

function parseFormal(argv: string[]): string {
  if (argv.length === 0) throw new Error("BOX_SUCCESS_GATE_SHA_MISSING");
  if (argv.length === 2 && argv[0] === "--candidate-sha" && /^[0-9a-f]{40}$/.test(argv[1] ?? "")) {
    return argv[1] ?? "";
  }
  throw new Error("BOX_SUCCESS_GATE_UNKNOWN_ARG");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--worker") {
    await runWorker(argv.slice(1));
    return;
  }
  const sha = parseFormal(argv);
  await supervise({ candidateSha: sha });
}

if (isDirect()) {
  main().catch((error: unknown) => {
    emitErr(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
