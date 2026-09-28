#!/usr/bin/env tsx
/**
 * Pre-cutover behavioral gate for Box tool success recovery.
 * Loads worker, journal, catalog, decoder and replay from this candidate tree.
 * The only stand-in is the Box exec transport. No launch, tool publish, or WAN.
 * PostgreSQL must be an explicit loopback *_test database. DATABASE_URL is ignored.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { createBoxReplayReader, createBoxReplayRecoveryWriter } from "../packages/commercial/src/egress/boxReplaySetup.ts";
import { BoxDurableJournal } from "../packages/commercial/src/http/proxy/boxDurableJournal.ts";
import { BoxRemoteCleanupWorker } from "../packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts";
import { compileBoxToolCatalog } from "../packages/commercial/src/http/proxy/boxToolCatalog.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ACTIVE = new Set(["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"]);
const DEADLINE_MS = 90_000;
const model = "claude-opus-5-5";
const catalog = compileBoxToolCatalog([{ name: "local_echo", description: "synthetic",
  input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
const toolName = "mcp__ocbridge__t0";
const event = (value: unknown) => ({ type: "stream_event", event: value });

function testDatabase(): PoolConfig & { database: string } {
  const raw = process.env.OC_V5_PROOF_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL
    ?? "postgres://test:test@127.0.0.1:55432/openclaude_test";
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
    sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  }
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("BOX_SUCCESS_GATE_SHA");
  return sha;
}

function assertPinnedModules(): void {
  for (const name of ["commercial", "gateway", "protocol", "storage"]) {
    const linked = realpathSync(join(root, "node_modules/@openclaude", name));
    const owned = realpathSync(join(root, "packages", name));
    if (linked !== owned) throw new Error(`BOX_SUCCESS_GATE_MODULE_ESCAPED ${name}`);
  }
  const worker = realpathSync(join(root, "packages/commercial/src/http/proxy/boxRemoteCleanupWorker.ts"));
  if (!worker.startsWith(realpathSync(root) + "/")) throw new Error("BOX_SUCCESS_GATE_WORKER_ESCAPED");
}

async function shadow(client: PoolClient): Promise<void> {
  const names = ["request_finalize_journal", "usage_records", "pending_usage_patches",
    "users", "user_subscriptions", "org_memberships", "orgs", "org_subscriptions",
    "turn_waivers", "client_sessions", "chat_projects", "credit_ledger"];
  const source = await client.query<{ ready: boolean }>(
    `SELECT bool_and(to_regclass('public.' || name) IS NOT NULL) AS ready
       FROM unnest($1::text[]) AS name`, [names]);
  if (source.rows[0]?.ready === true) {
    for (const name of names) {
      await client.query(`CREATE TEMP TABLE ${name} (LIKE public.${name} INCLUDING ALL)`);
    }
  } else {
    await client.query(readFileSync(join(root,
      "packages/commercial/src/billing/boxBillingRecoveryTempSchema.sql"), "utf8"));
  }
  const check = await client.query<{ only_temp: boolean; db: string }>(
    `SELECT current_database() AS db,
            'request_finalize_journal'::regclass = 'pg_temp.request_finalize_journal'::regclass
              AS only_temp`);
  if (check.rows[0]?.only_temp !== true || !/_test$/.test(check.rows[0]?.db ?? "")) {
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

function remote(spools: Map<string, Buffer>, proofs: Map<string, unknown>) {
  return async (req: { command: string; args: string[] }) => {
    const blob = req.args.join(" ");
    if (req.args[5] === "--read") {
      const cwd = req.args[6] ?? "";
      const nonce = cwd.split("/tmp/ocv5-289-run-")[1] ?? "";
      const raw = spools.get(nonce);
      if (!raw) throw new Error("BOX_SUCCESS_GATE_SPOOL");
      const offset = Number(req.args[7]);
      const bytes = raw.subarray(Number.isSafeInteger(offset) ? offset : raw.length);
      const start = Number.isSafeInteger(offset) ? offset : raw.length;
      return { stdout: JSON.stringify({ data: bytes.toString("base64"), offset: start + bytes.length }),
        stderrBytes: 0, exitCode: 0 as const };
    }
    const nonce = [...proofs.keys()].find((item) => blob.includes(item));
    if (!nonce) throw new Error("BOX_SUCCESS_GATE_EXEC");
    if (blob.includes("terminal.json")) {
      return { stdout: JSON.stringify(proofs.get(nonce)) + "\n", stderrBytes: 0, exitCode: 0 as const };
    }
    if (blob.includes("launch") || blob.includes("claude ")) throw new Error("BOX_SUCCESS_GATE_LAUNCH");
    const child = spawnSync(req.command, req.args, { encoding: "utf8" });
    if (child.status !== 0) throw new Error(`BOX_SUCCESS_GATE_PYTHON_${child.status ?? "signal"}`);
    return { stdout: child.stdout, stderrBytes: Buffer.byteLength(child.stderr ?? ""), exitCode: 0 as const };
  };
}

async function insertLeaf(client: PoolClient, requestId: string, uid: bigint, nonce: string,
  epoch: string): Promise<void> {
  await client.query(`INSERT INTO request_finalize_journal
    (request_id,user_id,state,ctx,precheck_credits) VALUES ($1,$2,'inflight',$3::jsonb,0)`,
  [requestId, uid.toString(), JSON.stringify({
    model: "box-api-claude-opus-5-5", boxInvocationRecovery: "v1",
    boxInvocationMode: "detached_tool", boxAccountId: "20", boxRunNonce: nonce,
    boxLeaseEpoch: epoch, boxSessionId: requestId, boxTurnKey: "a".repeat(64),
    boxCatalogHash: catalog.bindingSha256, boxDetachedRunnerHash: "d".repeat(64),
    boxState: "unknown", boxLaunchPermit: true,
    billingPricing: { v: 1, modelId: "box-api-claude-opus-5-5", displayName: "Opus",
      inputPerMtok: "1", outputPerMtok: "1", cacheReadPerMtok: "1", cacheWritePerMtok: "1",
      multiplier: "1" } })]);
}

async function main(): Promise<void> {
  const started = Date.now();
  const sha = candidateSha();
  assertPinnedModules();
  const db = testDatabase();
  console.log(`box success recovery gate: candidate ${sha} database ${db.database} host ${db.host}`);
  const pool = new Pool(db);
  const client = await pool.connect();
  const successNonce = randomBytes(12).toString("hex");
  const handoffNonce = randomBytes(12).toString("hex");
  const runs = [stage(successNonce), stage(handoffNonce)];
  const capsuleParent = mkdtempSync(join(tmpdir(), "ocv5-gate-capsule-"));
  const platformRoot = join(capsuleParent, "state");
  mkdirSync(join(capsuleParent, "box-replay-messages"), { mode: 0o700 });
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
  try {
    if (Date.now() - started > DEADLINE_MS) throw new Error("BOX_SUCCESS_GATE_DEADLINE");
    await shadow(client);
    const same = { connect: async () => ({ query: client.query.bind(client), release: () => {} }),
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
  } finally {
    client.release();
    await pool.end();
    for (const run of runs) rmSync(run, { recursive: true, force: true });
    rmSync(capsuleParent, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
