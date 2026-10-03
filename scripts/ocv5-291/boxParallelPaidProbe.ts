/** One-shot, synthetic, signed two-session Box acceptance. Never auto-replay. */
import { createHash, randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { Redis } from "ioredis";
import { PricingCache, type ModelPricing } from
  "../../packages/commercial/src/billing/pricing.js";
import { multiplierToScaled } from
  "../../packages/commercial/src/billing/calculator.js";
import { BoxDurableJournal, type BoxJournalAdmission } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxInvocationRegistry } from
  "../../packages/commercial/src/http/proxy/boxInvocationRegistry.js";
import { BoxTextFetch } from
  "../../packages/commercial/src/http/proxy/boxTextFetch.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { createBoxReplayWriter } from
  "../../packages/commercial/src/egress/boxReplaySetup.js";
import type { ProxyBody } from
  "../../packages/commercial/src/http/proxy/shared.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { getPool, closePool } from "../../packages/commercial/src/db/index.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import { startSignedLoopback, readEvents, assistantContent } from
  "../ocv5-289/boxSignedToolLiveProbe.js";

const UID = 3n, ACCOUNT = 20n;
const MODEL = "box-api-claude-opus-5-5", UPSTREAM = "claude-opus-5-5";
const EVIDENCE_DIR = "/var/lib/openclaude/ocv5-291-parallel-operator";
const LEGACY_MUTEX = "/var/lib/openclaude/ocv5-289-box-operator/account-20.mutex";
const ACTIVE = ["reserved", "starting", "running", "unknown", "handoff", "resuming", "linked"];

function requireTrue(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function saveExclusive(path: string, value: unknown): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
    | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  syncDir(EVIDENCE_DIR);
}
function replaceReceipt(path: string, value: unknown): void {
  const part = `${path}.${randomBytes(6).toString("hex")}.part`;
  saveExclusive(part, value);
  renameSync(part, path);
  syncDir(EVIDENCE_DIR);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function main(): Promise<void> {
  requireTrue(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OC_USER_ID === "3"
    && process.env.OC_INSTANCE_ID === "v5-selfhost-sg"
    && process.env.SELFHOST_CURSOR_EGRESS === "1"
    && process.env.OCV5_291_PARALLEL_PAID_ACK === "1",
  "BOX_PARALLEL_PAID_BOUNDARY_INVALID");
  requireTrue(/^[a-f0-9]{40}$/.test(process.env.OCV5_291_CODE_COMMIT ?? ""),
    "BOX_PARALLEL_CODE_COMMIT_REQUIRED");
  const cfg = loadConfig();
  const redisUrl = new URL(cfg.REDIS_URL);
  requireTrue(redisUrl.hostname === "127.0.0.1" && redisUrl.port === "6379"
    && redisUrl.pathname === "/3", "BOX_PARALLEL_REDIS_BOUNDARY_INVALID");
  const suffix = randomBytes(12).toString("hex");
  const ids = [`parallel-a-${suffix}`, `parallel-b-${suffix}`];
  const sessions = [`ocv5-par-a-${suffix}`, `ocv5-par-b-${suffix}`];
  const turns = [randomBytes(32).toString("hex"), randomBytes(32).toString("hex")];
  const markers = [`PAR_A_${randomBytes(8).toString("hex")}`,
    `PAR_B_${randomBytes(8).toString("hex")}`];
  const receiptPath = join(EVIDENCE_DIR, `account20-${suffix}.json`);
  const mutex = join(EVIDENCE_DIR, "account20.parallel.mutex");
  let receipt = { v: 1, uid: "3", accountId: "20", requestIds: ids,
    sessions, markerSha256: markers.map(digest), codeCommit: process.env.OCV5_291_CODE_COMMIT ?? "",
    state: "preparing", admitted: [] as Array<{ requestId: string;
      runNonce: string; leaseEpoch: string }>, createdAt: new Date().toISOString() };
  const parent = lstatSync("/var/lib/openclaude");
  requireTrue(parent.isDirectory() && !parent.isSymbolicLink()
    && parent.uid === process.getuid() && (parent.mode & 0o777) === 0o700,
  "BOX_PARALLEL_EVIDENCE_PARENT_INVALID");
  try { mkdirSync(EVIDENCE_DIR, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = lstatSync(EVIDENCE_DIR);
  requireTrue(directory.isDirectory() && !directory.isSymbolicLink()
    && directory.uid === process.getuid() && (directory.mode & 0o777) === 0o700,
  "BOX_PARALLEL_EVIDENCE_DIR_INVALID");
  syncDir("/var/lib/openclaude");
  requireTrue(!lstatExists(LEGACY_MUTEX), "BOX_PARALLEL_OTHER_OPERATOR_ACTIVE");
  saveExclusive(mutex, { pid: process.pid, requestIds: ids });
  saveExclusive(receiptPath, receipt);

  const pool = getPool();
  const client = await pool.connect();
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3 });
  let loopback: Awaited<ReturnType<typeof startSignedLoopback>> | null = null;
  try {
    const db = await client.query<{ name: string }>("SELECT current_database() AS name");
    requireTrue(db.rows[0]?.name === "openclaude_v5_selfhost",
      "BOX_PARALLEL_DATABASE_BOUNDARY_INVALID");
    const owners = await client.query<{ id: string }>(
      `SELECT id::text FROM agent_containers WHERE user_id=$1 AND state='active'
         AND runtime_channel='v5' AND runtime_kind='docker' AND secret_hash IS NOT NULL`,
      [UID.toString()]);
    requireTrue(owners.rows.length === 1 && owners.rows[0]?.id ===
      process.env.OCV5_291_EXPECT_CONTAINER_ID, "BOX_PARALLEL_CONTAINER_NOT_CURRENT");
    const active = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM request_finalize_journal
        WHERE ctx->>'boxAccountId'=$1 AND ctx->>'boxState'=ANY($2::text[])`,
      [ACCOUNT.toString(), ACTIVE]);
    requireTrue(active.rows[0]?.count === "0", "BOX_PARALLEL_ACCOUNT_OCCUPIED");
    const resolver = createProductionBoxAccountResolver();
    const check = await resolver.resolve({ uid: UID, sessionId: null,
      requestId: `parallel-precheck-${suffix}`, upstreamModel: UPSTREAM,
      requiredAccountId: ACCOUNT, allowWakeIfHibernated: false,
      signal: AbortSignal.timeout(30_000) });
    try { requireTrue(check.accountId === ACCOUNT, "BOX_PARALLEL_ACCOUNT_INVALID"); }
    finally { await check.dispose?.(); }
    const wallet = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    requireTrue(wallet.rows.length === 1 && BigInt(wallet.rows[0]!.credits) > 100n,
      "BOX_PARALLEL_WALLET_UNAVAILABLE");
    const pricing = new PricingCache();
    await pricing.load();
    const direct = pricing.get(UPSTREAM);
    requireTrue(direct?.enabled && direct.input_per_mtok > 0n
      && direct.input_per_mtok <= 1000n && direct.output_per_mtok > 0n
      && direct.output_per_mtok <= 5000n && multiplierToScaled(direct.multiplier) <= 5000n,
    "BOX_PARALLEL_PRICE_UNAVAILABLE");
    const price: ModelPricing = { ...direct, model_id: MODEL,
      display_name: "Box parallel synthetic acceptance", default_effort: null };
    const baseJournal = new BoxDurableJournal(pool,
      (uid, accountId) => uid === UID && accountId === ACCOUNT ? 2 : 1);
    const journal = new Proxy(baseJournal, { get(target, key) {
      if (key === "admit") return async (input: BoxJournalAdmission) => {
        requireTrue(ids.includes(input.requestId) && input.uid === UID
          && input.accountId === ACCOUNT, "BOX_PARALLEL_ADMISSION_IDENTITY_INVALID");
        receipt = { ...receipt, state: "admitting", admitted: [...receipt.admitted,
          { requestId: input.requestId, runNonce: input.runNonce,
            leaseEpoch: input.leaseEpoch }] };
        replaceReceipt(receiptPath, receipt); // durable before any paid launch
        return target.admit(input);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    let launched = 0;
    const launchCwds = new Map<string, string>();
    const service = new BoxTextFetch({
      supervisorAsset: readAsset("box_supervisor.py"),
      keeperAsset: readAsset("box_keeper.py"),
      detachedRunnerAsset: readAsset("box_detached_runner.py"),
      registry: new BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1,
        leaseMs: 900_000, allowSecond: (uid, accountId) => uid === UID
          && accountId === ACCOUNT }),
      journal, writeMessage: createBoxReplayWriter(true, process.env.OC_PLATFORM_ROOT),
      maxOutputTokensForModel: (model) => model === MODEL ? 128_000 : null,
      resolveTarget: async (args) => {
        const ownerRequestId = args.requestId;
        const target = await resolver.resolve({ ...args, requiredAccountId: ACCOUNT,
          allowWakeIfHibernated: false });
        return { ...target, exec: { run: async (command, options) => {
          const result = await target.exec.run(command, options);
          if (command.args[2]?.includes("sys.argv=[p,*argv]")
            && result.stdout.trim() === "launched") {
            requireTrue(/^\/tmp\/ocv5-289-run-[a-f0-9]{24}$/.test(command.cwd),
              "BOX_PARALLEL_LAUNCH_CWD_INVALID");
            launchCwds.set(ownerRequestId, command.cwd);
            launched++;
          }
          return result;
        } } };
      },
      onUnknown: async () => {},
    });
    loopback = await startSignedLoopback({ pool, redis,
      containerId: Number(owners.rows[0]!.id), price,
      boxModel: { toolBridgeReady: false, fetch: (args) => service.fetch(args) } });
    const bodies = ids.map((_, i): ProxyBody => ({ model: MODEL, stream: true,
      max_tokens: 8192, system: "Synthetic test only. No tools. Reply with the requested marker only.",
      metadata: { user_id: JSON.stringify({ session_id: sessions[i],
        oc_turn_key: turns[i] }) },
      messages: [{ role: "user", content:
        `Reply with exactly ${markers[i]} and nothing else.` }] }));
    receipt = { ...receipt, state: "dispatching" };
    replaceReceipt(receiptPath, receipt);
    // Exactly two paid requests. Never submit a third or retry either one.
    const attempted = await Promise.allSettled(bodies.map((body, i) =>
      loopback!.call(body, ids[i]!)));
    if (!attempted.every((item) => item.status === "fulfilled"
      && item.value.status === 200)) {
      // The peer may already be paid. Let it reach its own terminal rather than
      // closing the signed listener as soon as the other request fails.
      await Promise.allSettled(attempted.filter((item): item is
        PromiseFulfilledResult<Response> => item.status === "fulfilled")
        .map((item) => item.value.text()));
      await Promise.allSettled(ids.map((id) => loopback!.waitHandler(id)));
      throw new Error("BOX_PARALLEL_HTTP_NOT_200");
    }
    const responses = attempted.map((item) =>
      (item as PromiseFulfilledResult<Response>).value);
    const overlap = await client.query<{ request_id: string;
      nonce: string; epoch: string; permit: boolean; proof: boolean }>(
      `SELECT request_id,ctx->>'boxRunNonce' AS nonce,
        ctx->>'boxLeaseEpoch' AS epoch,
        (ctx->>'boxLaunchPermit')::boolean AS permit,
        (ctx ? 'boxTerminalProof') AS proof
       FROM request_finalize_journal WHERE request_id=ANY($1::text[])
         AND ctx->>'boxState'=ANY($2::text[])`, [ids, ACTIVE]);
    const overlapped = overlap.rows.length === 2
      && new Set(overlap.rows.map((row) => `${row.nonce}:${row.epoch}`)).size === 2
      && overlap.rows.every((row) => row.permit && !row.proof);
    const observed = await Promise.allSettled(responses.map(readEvents));
    await Promise.all(ids.map((id) => loopback!.waitHandler(id)));
    requireTrue(observed.every((item) => item.status === "fulfilled"),
      "BOX_PARALLEL_SSE_INCOMPLETE");
    const events = observed.map((item) =>
      (item as PromiseFulfilledResult<Awaited<ReturnType<typeof readEvents>>>).value);
    const answers = events.map((item) => assistantContent(item)
      .filter((block) => block.type === "text").map((block) => String(block.text ?? "")).join("").trim());
    requireTrue(answers[0] === markers[0] && answers[1] === markers[1]
      && !answers[0]?.includes(markers[1]!) && !answers[1]?.includes(markers[0]!),
    "BOX_PARALLEL_ANSWERS_CROSSED");
    const rows = await client.query<{ request_id: string; state: string;
      ctx: Record<string, unknown> }>(
      "SELECT request_id,state,ctx FROM request_finalize_journal WHERE request_id=ANY($1::text[])",
      [ids]);
    requireTrue(rows.rows.length === 2 && rows.rows.every((row) =>
      row.state === "committed" && row.ctx.boxState === "terminal"
      && (row.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
        === "worker_complete" && row.ctx.boxRemoteCleanup === "done"
      && launchCwds.get(row.request_id)
        === `/tmp/ocv5-289-run-${row.ctx.boxRunNonce}`),
    "BOX_PARALLEL_TERMINAL_UNPROVEN");
    const usage = await client.query<{ id: string; request_id: string;
      cost: string; ledger_id: string | null }>(
      `SELECT id::text,request_id,cost_credits::text AS cost,ledger_id::text
         FROM usage_records WHERE user_id=$1 AND request_id=ANY($2::text[])`,
      [UID.toString(), ids]);
    const ledger = await client.query<{ id: string; ref_id: string; delta: string }>(
      `SELECT id::text,ref_id,delta::text FROM credit_ledger WHERE user_id=$1
        AND ref_type='usage_record' AND ref_id=ANY($2::text[])`,
      [UID.toString(), usage.rows.map((row) => row.id)]);
    requireTrue(usage.rows.length === 2 && new Set(usage.rows.map((row) => row.request_id)).size === 2
      && usage.rows.every((row) => {
        const debits = ledger.rows.filter((item) => item.ref_id === row.id);
        return row.ledger_id && BigInt(row.cost) > 0n && debits.length >= 1
          && debits.length <= 4 && debits.some((item) => item.id === row.ledger_id)
          && debits.every((item) => BigInt(item.delta) < 0n)
          && debits.reduce((sum, item) => sum - BigInt(item.delta), 0n)
            === BigInt(row.cost);
      }) && launched === 2 && overlapped, "BOX_PARALLEL_PAID_PROOF_INCOMPLETE");
    const after = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    requireTrue(after.rows.length === 1 && BigInt(after.rows[0]!.credits) >= 0n,
      "BOX_PARALLEL_WALLET_NEGATIVE");
    receipt = { ...receipt, state: "terminal" };
    replaceReceipt(receiptPath, receipt);
    unlinkSync(mutex); syncDir(EVIDENCE_DIR);
    process.stdout.write(JSON.stringify({ twoSessions: true, overlapped: true,
      paidLaunches: launched, terminalProofs: 2, usageRows: usage.rows.length,
      ledgerRows: ledger.rows.length, cleanupDone: true, crossContent: false,
      requestIds: ids }) + "\n");
  } finally {
    await loopback?.close().catch(() => {});
    client.release();
    await redis.quit().catch(() => redis.disconnect());
    await closePool();
  }
}

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error; }
}
function readAsset(name: string): Buffer {
  return readFileSync(new URL(`../ocv5-289/${name}`, import.meta.url));
}

void main().catch((error: unknown) => {
  const code = error instanceof Error && /^BOX_[A-Z0-9_]{1,80}$/.test(error.message)
    ? error.message : "BOX_PARALLEL_PAID_PROBE_FAILED";
  process.stderr.write(code + "\n");
  process.exitCode = 1;
});
