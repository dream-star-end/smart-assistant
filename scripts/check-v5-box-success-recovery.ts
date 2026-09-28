#!/usr/bin/env tsx
/**
 * Pre-cutover behavioral gate for Box tool success recovery.
 * Loads worker, journal, catalog, decoder and replay from this candidate tree.
 * The Box exec transport is a fixture: only the candidate's own catalog read
 * and cleanup commands are executed, and only with a hard timeout.
 * PostgreSQL must be passed explicitly. This file does not default a DSN.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { createBoxReplayReader, createBoxReplayRecoveryWriter } from "../packages/commercial/src/egress/boxReplaySetup.ts";
import { makeBoxDetachedRunAccess } from "../packages/commercial/src/http/proxy/boxDetachedRunAccess.ts";
import { BoxDurableJournal } from "../packages/commercial/src/http/proxy/boxDurableJournal.ts";
import { BoxRemoteCleanupWorker } from "../packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts";
import { makeBoxRunCleanup } from "../packages/commercial/src/http/proxy/boxRunCleanup.ts";
import { makeBoxStagedCatalogRead } from "../packages/commercial/src/http/proxy/boxStagedCatalogRead.ts";
import { makeBoxTerminalRead } from "../packages/commercial/src/http/proxy/boxTerminalProof.ts";
import { compileBoxToolCatalog } from "../packages/commercial/src/http/proxy/boxToolCatalog.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTIVE = new Set(["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"]);
const DEADLINE_MS = 90_000;
const PY_TIMEOUT_MS = 5_000;
const GIT_TIMEOUT_MS = 5_000;
const SHADOW_TABLES = ["request_finalize_journal", "usage_records", "pending_usage_patches",
  "users", "user_subscriptions", "org_memberships", "orgs", "org_subscriptions",
  "turn_waivers", "client_sessions", "chat_projects", "credit_ledger"];
const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
const toolName = "mcp__ocbridge__t0";
const runnerHash = "d".repeat(64);
const event = (value: unknown) => ({ type: "stream_event", event: value });

type ExecRequest = { command: string; args: string[]; cwd?: string;
  environment?: Record<string, string> };

function provePythonBound(): void {
  const child = spawnSync("/bin/sleep", ["30"], { timeout: 1_000, killSignal: "SIGKILL" });
  if ((child.error as NodeJS.ErrnoException | undefined)?.code !== "ETIMEDOUT") {
    throw new Error("BOX_SUCCESS_GATE_BOUND_UNPROVEN");
  }
}

function testDatabase(): PoolConfig & { database: string } {
  const raw = process.env.OC_V5_PROOF_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
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
  };
}

function candidateSha(): string {
  const flavor = join(root, "flavor.manifest.json");
  let sha = "";
  if (existsSync(flavor)) {
    const parsed = JSON.parse(readFileSync(flavor, "utf8")) as { sourceCommit?: unknown };
    if (typeof parsed.sourceCommit === "string") sha = parsed.sourceCommit;
  }
  if (!sha) {
    sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root, encoding: "utf8", timeout: GIT_TIMEOUT_MS, killSignal: "SIGKILL",
    }).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("BOX_SUCCESS_GATE_SHA");
  return sha;
}

function assertPinnedModules(): void {
  const base = realpathSync(root);
  for (const name of ["commercial", "gateway", "protocol", "storage", "pg", "tsx"]) {
    const linked = realpathSync(join(root, "node_modules", name === "pg" || name === "tsx"
      ? name : join("@openclaude", name)));
    const owned = name === "pg" || name === "tsx"
      ? linked
      : realpathSync(join(root, "packages", name));
    if (name !== "pg" && name !== "tsx" && linked !== owned) {
      throw new Error(`BOX_SUCCESS_GATE_MODULE_ESCAPED ${name}`);
    }
    if (!linked.startsWith(base + "/")) throw new Error(`BOX_SUCCESS_GATE_MODULE_ESCAPED ${name}`);
  }
}

function sameRequest(actual: ExecRequest, expected: ExecRequest): boolean {
  return actual.command === expected.command
    && actual.cwd === expected.cwd
    && actual.args.length === expected.args.length
    && actual.args.every((arg, index) => arg === expected.args[index])
    && JSON.stringify(actual.environment ?? {}) === JSON.stringify(expected.environment ?? {});
}

function classify(req: ExecRequest, nonces: string[]): { kind: "catalog" | "cleanup" | "proof" | "spool";
  nonce: string; offset: number } | null {
  for (const nonce of nonces) {
    const access = makeBoxDetachedRunAccess({ runNonce: nonce, detachedRunnerHash: runnerHash });
    const offset = Number(req.args.at(-2));
    const limit = Number(req.args.at(-1));
    if (Number.isSafeInteger(offset) && Number.isSafeInteger(limit)) {
      try {
        if (sameRequest(req, access.readSpool(offset, limit))) return { kind: "spool", nonce, offset };
      } catch { /* not this spool shape */ }
      try {
        if (sameRequest(req, makeBoxStagedCatalogRead(nonce, offset, limit))) {
          return { kind: "catalog", nonce, offset };
        }
      } catch { /* not this catalog window */ }
    }
    try {
      if (sameRequest(req, makeBoxTerminalRead(`/tmp/ocv5-289-proof-${nonce}`))) {
        return { kind: "proof", nonce, offset: 0 };
      }
    } catch { /* not this proof */ }
    for (const keep of [false, true]) {
      try {
        if (sameRequest(req, makeBoxRunCleanup(nonce, keep))) return { kind: "cleanup", nonce, offset: 0 };
      } catch { /* not this cleanup */ }
    }
  }
  return null;
}

function spawnBounded(req: ExecRequest): { stdout: string; stderrBytes: number; exitCode: 0 } {
  const child = spawnSync(req.command, req.args, {
    encoding: "utf8", cwd: req.cwd, env: req.environment,
    timeout: PY_TIMEOUT_MS, killSignal: "SIGKILL",
  });
  if ((child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
    throw new Error("BOX_SUCCESS_GATE_PYTHON_TIMEOUT");
  }
  if (child.error) throw new Error("BOX_SUCCESS_GATE_PYTHON_SPAWN");
  if (child.status !== 0) throw new Error(`BOX_SUCCESS_GATE_PYTHON_${child.status ?? "signal"}`);
  return { stdout: child.stdout, stderrBytes: Buffer.byteLength(child.stderr ?? ""), exitCode: 0 };
}

function remote(spools: Map<string, Buffer>, proofs: Map<string, unknown>) {
  const nonces = [...spools.keys()];
  return async (req: ExecRequest) => {
    const kind = classify(req, nonces);
    if (!kind) throw new Error("BOX_SUCCESS_GATE_EXEC");
    if (kind.kind === "spool") {
      const raw = spools.get(kind.nonce);
      if (!raw) throw new Error("BOX_SUCCESS_GATE_SPOOL");
      const bytes = raw.subarray(kind.offset);
      return { stdout: JSON.stringify({ data: bytes.toString("base64"),
        offset: kind.offset + bytes.length }), stderrBytes: 0, exitCode: 0 as const };
    }
    if (kind.kind === "proof") {
      return { stdout: JSON.stringify(proofs.get(kind.nonce)) + "\n",
        stderrBytes: 0, exitCode: 0 as const };
    }
    return spawnBounded(req);
  };
}

async function shadow(client: PoolClient): Promise<void> {
  const source = await client.query<{ ready: boolean }>(
    `SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS name`, [SHADOW_TABLES]);
  if (source.rows[0]?.ready === true) {
    for (const name of SHADOW_TABLES) {
      await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
    }
  } else {
    const ddl = readFileSync(join(root,
      "packages/commercial/src/billing/boxBillingRecoveryTempSchema.sql"), "utf8");
    for (const statement of ddl.split(/;\s*(?:\r?\n|$)/)) {
      const trimmed = statement.trim();
      if (!trimmed || !/create\s+temp\s+table/i.test(trimmed)) continue;
      await client.query(trimmed);
    }
  }
  const check = await client.query<{ name: string; schema: string; db: string }>(
    `SELECT name, n.nspname AS schema, current_database() AS db
       FROM unnest($1::text[]) AS name
       JOIN pg_class c ON c.oid = to_regclass(name)
       JOIN pg_namespace n ON n.oid = c.relnamespace`, [SHADOW_TABLES]);
  if (check.rows.length !== SHADOW_TABLES.length
    || check.rows.some((row) => !/^pg_temp(?:_\d+)?$/.test(row.schema) || !/_test$/.test(row.db))) {
    throw new Error("BOX_SUCCESS_GATE_SHADOW");
  }
}

function stage(nonce: string): string {
  const run = `/tmp/ocv5-289-run-${nonce}`;
  mkdirSync(run, { mode: 0o700 });
  chmodSync(run, 0o700);
  writeFileSync(`${run}/tool-catalog.json`, catalog.json);
  chmodSync(`${run}/tool-catalog.json`, 0o600);
  return run;
}

function lines(records: unknown[]): Buffer {
  return Buffer.from(records.map((item) => JSON.stringify(item) + "\n").join(""));
}

function finalSpool(): Buffer {
  return lines([
    { type: "system", subtype: "init", tools: [toolName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_gate", model, role: "assistant",
      content: [], usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } }),
    { type: "assistant", message: { id: "msg_gate", model, role: "assistant",
      content: [{ type: "text", text: "done" }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" },
      usage: { input_tokens: 3, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false,
      usage: { input_tokens: 9, output_tokens: 8, cache_read_input_tokens: 1,
        cache_creation_input_tokens: 2 } },
  ]);
}

function handoffSpool(): Buffer {
  const use = { type: "tool_use", id: "toolu_gate_handoff", name: toolName, input: { value: "x" } };
  return lines([
    { type: "system", subtype: "init", tools: [toolName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_hand", model, role: "assistant",
      content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id: use.id, name: use.name, input: {} } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"value":"x"}' } }),
    { type: "assistant", message: { id: "msg_hand", model, role: "assistant", content: [use] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 2, output_tokens: 4 } }),
    event({ type: "message_stop" }),
  ]);
}

async function insertLeaf(client: PoolClient, requestId: string, uid: bigint, nonce: string,
  epoch: string): Promise<void> {
  await client.query(`INSERT INTO request_finalize_journal
    (request_id,user_id,state,ctx,precheck_credits) VALUES ($1,$2,'inflight',$3::jsonb,0)`,
  [requestId, uid.toString(), JSON.stringify({
    model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
    boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
    boxLeaseEpoch: epoch, boxSessionId: requestId, boxTurnKey: "a".repeat(64),
    boxCatalogHash: catalog.bindingSha256, boxDetachedRunnerHash: runnerHash,
    boxState: "unknown", boxLaunchPermit: true,
    billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
      inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1",
      multiplier: "1" } })]);
}

async function withDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("BOX_SUCCESS_GATE_DEADLINE")), DEADLINE_MS);
  });
  try { return await Promise.race([work, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--prove-python-bound") {
    provePythonBound();
    console.log("box success recovery gate: python bound killed a stuck sleep");
    return;
  }
  const db = testDatabase();
  const sha = candidateSha();
  assertPinnedModules();
  console.log(`box success recovery gate: candidate ${sha} database ${db.database} host ${db.host}`);
  const runs: string[] = [];
  let capsuleParent = "";
  let pool: Pool | undefined;
  let client: PoolClient | undefined;
  try {
    await withDeadline((async () => {
      const successNonce = randomBytes(12).toString("hex");
      const handoffNonce = randomBytes(12).toString("hex");
      runs.push(stage(successNonce), stage(handoffNonce));
      capsuleParent = mkdtempSync(join(tmpdir(), "ocv5-gate-capsule-"));
      console.log(`box success recovery gate: cleanup-root ${capsuleParent}`);
      for (const run of runs) console.log(`box success recovery gate: run ${run}`);
      const platformRoot = join(capsuleParent, "state");
      mkdirSync(join(capsuleParent, "box-replay-messages"), { mode: 0o700 });
      pool = new Pool(db);
      client = await pool.connect();
      const proofs = new Map<string, unknown>([
        [successNonce, { runNonce: successNonce, leaseEpoch: "b".repeat(32), keeperPid: 101,
          cliPid: 102, reason: "worker_complete", revision: 1 }],
        [handoffNonce, { runNonce: handoffNonce, leaseEpoch: "c".repeat(32), keeperPid: 101,
          cliPid: 102, reason: "worker_complete", revision: 1 }],
      ]);
      const spools = new Map<string, Buffer>([
        [successNonce, finalSpool()],
        [handoffNonce, handoffSpool()],
      ]);
      const writes: string[] = [];
      await shadow(client);
      const same = { connect: async () => ({ query: client!.query.bind(client), release: () => {} }),
        query: client.query.bind(client) } as unknown as Pool;
      await insertLeaf(client, "gate-ok", 900_000_230n, successNonce, "b".repeat(32));
      await insertLeaf(client, "gate-handoff", 900_000_231n, handoffNonce, "c".repeat(32));
      const writer = createBoxReplayRecoveryWriter(platformRoot);
      const reader = createBoxReplayReader(platformRoot);
      if (!writer || !reader) throw new Error("BOX_SUCCESS_GATE_REPLAY");
      const worker = new BoxRemoteCleanupWorker({
        journal: new BoxDurableJournal(same),
        writeRecoveryMessage: async (id, message) => {
          writes.push(id.requestId);
          return writer(id, message);
        },
        resolver: { resolve: async () => ({ accountId: 20n, exec: { run: remote(spools, proofs) },
          dispose: async () => {} }) as never },
      });
      await worker.reconcileBatch();
      const rows = await client.query<{ id: string; box: string; usage: unknown; replay: unknown }>(
        `SELECT request_id AS id, ctx->>'boxState' AS box, ctx->'boxUsage' AS usage,
                ctx->'boxReplayMessage' AS replay
           FROM request_finalize_journal WHERE request_id IN ('gate-ok','gate-handoff')`);
      const ok = rows.rows.find((row) => row.id === "gate-ok");
      const held = rows.rows.find((row) => row.id === "gate-handoff");
      assert.equal(ok?.box, "terminal");
      assert.equal(ACTIVE.has(ok?.box ?? ""), false);
      assert.deepEqual(ok?.usage, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 1,
        cacheWriteTokens: 2 });
      assert.ok(ok?.replay);
      const message = await reader(ok!.replay as never) as { id?: string };
      assert.equal(message.id, "msg_gate");
      assert.equal(held?.box, "unknown");
      assert.equal(held?.replay ?? null, null);
      assert.deepEqual(writes, ["gate-ok"]);
      console.log("unknown worker_complete closed through reconcileBatch to a readable capsule and this-round usage");
      console.log("intermediate handoff stayed pending without capsule or CAS");
    })());
  } finally {
    try { client?.release(); } catch { /* already released */ }
    if (pool) await Promise.race([pool.end(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    for (const run of runs) rmSync(run, { recursive: true, force: true });
    if (capsuleParent) rmSync(capsuleParent, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
