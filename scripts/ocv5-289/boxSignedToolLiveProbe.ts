/** Operator-only signed /v1/messages -> real Box two-HTTP acceptance.
 * This uses the existing selfhost billing wallet at the live Opus 5.5 price,
 * never commercial production; all prompts/results are synthetic. Ambiguous
 * paid or side-effecting work is never replayed. */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import type { Pool } from "pg";
import { Redis } from "ioredis";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import type { BoxJournalAdmission } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxToolFetch } from
  "../../packages/commercial/src/http/proxy/boxToolFetch.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { makeAnthropicProxyHandler } from
  "../../packages/commercial/src/http/anthropicProxy.js";
import type { AnthropicProxyDeps } from
  "../../packages/commercial/src/http/anthropicProxy.js";
import { makeContainerIdentityStrategy } from
  "../../packages/commercial/src/auth/proxyIdentity.js";
import { PricingCache, type ModelPricing } from
  "../../packages/commercial/src/billing/pricing.js";
import { multiplierToScaled } from
  "../../packages/commercial/src/billing/calculator.js";
import { ModelCatalogSnapshot, type ModelCatalogEntry, type ModelCatalogPricing } from
  "../../packages/commercial/src/billing/modelCatalog.js";
import { LOCAL_CATALOG_HEADER, encodeLocalCatalogToken } from
  "../../packages/commercial/src/http/proxy/modelAuthorityGate.js";
import { wrapIoredisForPreCheck } from
  "../../packages/commercial/src/billing/preCheck.js";
import { wrapIoredis } from
  "../../packages/commercial/src/middleware/rateLimit.js";
import { createLogger } from
  "../../packages/commercial/src/logging/logger.js";
import { loadConfig } from "../../packages/commercial/src/config.js";
import { getPool, closePool } from "../../packages/commercial/src/db/index.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import type { ProxyBody } from
  "../../packages/commercial/src/http/proxy/shared.js";

const UID = 3n, ACCOUNT_ID = 20n;
const MODEL = "box-api-claude-opus-5-5", UPSTREAM = "claude-opus-5-5";
const EVIDENCE_PARENT = "/var/lib/openclaude";
const EVIDENCE_DIR = `${EVIDENCE_PARENT}/ocv5-289-box-operator`;
const EVIDENCE_PATH = `${EVIDENCE_DIR}/account-20.json`;
const OPERATOR_MUTEX = `${EVIDENCE_DIR}/account-20.mutex`;
type Event = { event: string; data: Record<string, unknown> };
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
async function readEvents(response: Response): Promise<Event[]> {
  assertion(response.status === 200 && response.body, "BOX_TOOL_PROBE_HTTP_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      raw += decoder.decode(next.value, { stream: true });
      assertion(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "BOX_TOOL_PROBE_SSE_TOO_LARGE");
    }
  } finally { if (!ended) await reader.cancel().catch(() => {}); }
  raw += decoder.decode();
  const events = [...raw.matchAll(/^event: ([a-z_]+)\ndata: ([^\n]+)$/gm)]
    .map((match) => ({ event: match[1]!,
      data: JSON.parse(match[2]!) as Record<string, unknown> }));
  assertion(events.length > 0 && events.some((item) => item.event === "message_stop"),
    "BOX_TOOL_PROBE_SSE_INCOMPLETE");
  return events;
}
function assistantContent(events: Event[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const partial = new Map<number, string>();
  for (const { event, data } of events) {
    if (event === "content_block_start") {
      const index = data.index;
      const block = data.content_block;
      assertion(Number.isSafeInteger(index) && Number(index) >= 0
        && block && typeof block === "object" && !Array.isArray(block),
      "BOX_TOOL_PROBE_BLOCK_INVALID");
      blocks[index as number] = { ...block as Record<string, unknown> };
    } else if (event === "content_block_delta") {
      const index = data.index;
      const delta = data.delta as Record<string, unknown> | undefined;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number] && !!delta,
        "BOX_TOOL_PROBE_DELTA_INVALID");
      const block = blocks[index as number]!;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = String(block.text ?? "") + delta.text;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = String(block.thinking ?? "") + delta.thinking;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partial.set(index as number, (partial.get(index as number) ?? "") + delta.partial_json);
      } else throw new Error("BOX_TOOL_PROBE_DELTA_UNSUPPORTED");
    } else if (event === "content_block_stop") {
      const index = data.index;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number],
        "BOX_TOOL_PROBE_BLOCK_STOP_INVALID");
      const input = partial.get(index as number);
      if (input !== undefined) blocks[index as number]!.input = JSON.parse(input);
    }
  }
  assertion(blocks.length > 0 && blocks.length <= 64
    && Array.from({ length: blocks.length }, (_, index) => index)
      .every((index) => Object.hasOwn(blocks, index) && !!blocks[index]),
    "BOX_TOOL_PROBE_CONTENT_INVALID");
  return blocks;
}

async function startSignedLoopback(args: { pool: Pool; redis: Redis;
  boxModel: AnthropicProxyDeps["boxModel"]; price: ModelPricing;
  containerId: number }) {
  const diagnostics: Array<{ msg: string; code?: string; detail?: string }> = [];
  const pricing = new PricingCache();
  pricing._setForTests([args.price]);
  const entry: ModelCatalogEntry = {
    entryId: 289, modelId: MODEL, engine: "ccb", providerId: "box_cli",
    upstreamModelId: UPSTREAM, contextWindow: 200_000,
    capabilityProfile: { supportsVision: false,
      reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: true, supportsThinking: false } },
    capabilitySchemaVersion: 1, state: "active", lockVersion: 0,
  };
  const catalogPrice: ModelCatalogPricing = {
    modelId: MODEL, displayName: args.price.display_name,
    inputPerMtok: args.price.input_per_mtok,
    outputPerMtok: args.price.output_per_mtok,
    cacheReadPerMtok: args.price.cache_read_per_mtok,
    cacheWritePerMtok: args.price.cache_write_per_mtok,
    multiplier: args.price.multiplier, visibility: "public", sortOrder: 289,
    defaultEffort: null,
  };
  const snapshot = new ModelCatalogSnapshot({ entries: [entry], aliases: new Map(),
    pricing: new Map([[MODEL, catalogPrice]]), securityEpoch: 7n });
  const loadUserModelAuthz = async () => ({ role: "admin" as const,
    grantedModelIds: new Set<string>() });
  const hostUuid = `ocv5-289-signed-${randomBytes(6).toString("hex")}`;
  const boundIp = "127.0.0.1";
  const containerId = args.containerId;
  const secret = randomBytes(32);
  const secretHex = secret.toString("hex");
  const identity = makeContainerIdentityStrategy({
    repo: { async findActiveByHostAndBoundIp(host, ip) {
      return host === hostUuid && ip === boundIp ? {
        id: containerId, user_id: Number(UID), host_uuid: hostUuid,
        bound_ip: boundIp, secret_hash: createHash("sha256").update(secret).digest(),
      } : null;
    } },
    pricing, loadUserModelAuthz, recordHostRequest: () => {},
  });
  const token = encodeLocalCatalogToken({ v: 1, kind: "local_catalog",
    projectionRevision: snapshot.projectionRevisionFor({ uid: String(UID),
      role: "admin", grantedModelIds: new Set() }),
    securityEpoch: snapshot.securityEpoch.toString() });
  const handler = makeAnthropicProxyHandler({
    pgPool: args.pool, pricing,
    preCheckRedis: wrapIoredisForPreCheck(args.redis),
    rateLimitRedis: wrapIoredis(args.redis),
    scheduler: {} as AnthropicProxyDeps["scheduler"],
    identity, loadUserModelAuthz,
    modelCatalog: { async assertFresh() { return snapshot; },
      peek() { return snapshot; } } as NonNullable<AnthropicProxyDeps["modelCatalog"]>,
    modelAuthorityEnforce: true,
    boxModel: args.boxModel,
    logger: createLogger({ level: "trace", base: { probe: "ocv5-289-signed" },
      out: (line) => {
        try {
          const item = JSON.parse(line) as { msg?: unknown; code?: unknown;
            errcode?: unknown; err?: { message?: unknown } };
          if (typeof item.msg === "string") diagnostics.push({ msg: item.msg,
            ...(typeof item.errcode === "string" ? { code: item.errcode }
              : typeof item.code === "string" ? { code: item.code } : {}),
            ...(item.msg === "proxy_journal_insert_failed"
              && typeof item.err?.message === "string"
              ? { detail: item.err.message.slice(0, 160) } : {}) });
        } catch { /* Only bounded codes, never raw request or credential data. */ }
      } }),
    appendCostCredits: async () => {}, broadcastToUser: () => {},
  });
  const inFlight = new Map<string, Promise<void>>();
  const server = createServer((req, res) => {
    const requestId = req.headers["x-request-id"];
    if (typeof requestId !== "string" || inFlight.has(requestId)) {
      res.writeHead(409); res.end(); return;
    }
    const done = handler(req, res, { hostUuid, boundIp }).catch((error: unknown) => {
      diagnostics.push({ msg: "handler_exception", code: error instanceof Error
        && /^[A-Z][A-Z0-9_]{1,80}$/.test(error.message) ? error.message : "UNKNOWN" });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    inFlight.set(requestId, done);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  assertion(address && typeof address !== "string", "BOX_SIGNED_LISTENER_INVALID");
  return {
    diagnostics,
    async call(body: ProxyBody, requestId: string): Promise<Response> {
      return fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST", headers: { authorization: `Bearer oc-v3.${containerId}.${secretHex}`,
          "content-type": "application/json", "anthropic-version": "2023-06-01",
          "x-request-id": requestId, [LOCAL_CATALOG_HEADER]: token },
        body: JSON.stringify(body), signal: AbortSignal.timeout(180_000),
      });
    },
    async waitHandler(requestId: string): Promise<void> {
      const pending = inFlight.get(requestId);
      assertion(pending, "BOX_SIGNED_HANDLER_UNKNOWN");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("BOX_SIGNED_FINALIZER_TIMEOUT")), 120_000);
        })]);
      } finally { if (timer) clearTimeout(timer); }
    },
    async close(): Promise<void> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([Promise.allSettled([...inFlight.values()]),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); })]);
      } finally { if (timer) clearTimeout(timer); }
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      secret.fill(0);
    },
  };
}

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== String(ACCOUNT_ID)
    || process.env.OCV5_289_ACK_USER_ID !== String(UID)
    || process.env.OCV5_289_SIGNED_LIVE_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_SIGNED_LIVE_ACK_REQUIRED");
  const expectedContainerId = process.env.OCV5_289_EXPECT_CONTAINER_ID;
  assertion(expectedContainerId && /^[1-9][0-9]{0,9}$/.test(expectedContainerId),
    "BOX_SIGNED_CONTAINER_ID_ACK_REQUIRED");
  const cfg = loadConfig();
  const redisUrl = new URL(cfg.REDIS_URL);
  assertion(hostname() === "v3-dev-sg"
    && redisUrl.hostname === "127.0.0.1" && redisUrl.port === "6379"
    && redisUrl.pathname === "/3", "BOX_SIGNED_SELFHOST_BOUNDARY_INVALID");
  const pool = getPool();
  const client = await pool.connect();
  const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: 3,
    enableReadyCheck: true });
  const nonce = randomBytes(12).toString("hex");
  const sessionId = `ocv5-289-signed-${nonce}`;
  const turnKey = randomBytes(32).toString("hex");
  const firstId = `box-signed-a-${nonce}`, secondId = `box-signed-b-${nonce}`;
  const challenge = `probe-${randomBytes(8).toString("hex")}`;
  const localResult = `ocv5-289-local-${randomBytes(12).toString("hex")}`;
  let localExecutions = 0, unknownPhase: string | null = null;
  let terminal = false;
  let identityPersisted = false;
  let lockHeld = false;
  let dbReady = false;
  let loopback: Awaited<ReturnType<typeof startSignedLoopback>> | null = null;
  const oldModelFlag = process.env.OC_BOX_MODEL_API;
  const oldToolFlag = process.env.OC_BOX_TOOL_BRIDGE;
  const syncDirectory = (path = EVIDENCE_DIR): void => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const writeDurable = (path: string, raw: string): void => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(raw);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        assertion(written > 0, "BOX_TOOL_EVIDENCE_WRITE_FAILED");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  const withOperatorMutex = (action: () => void): void => {
    try {
      writeDurable(OPERATOR_MUTEX, JSON.stringify({ pid: process.pid,
        createdAt: new Date().toISOString() }) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("BOX_TOOL_OPERATOR_BUSY");
      }
      throw error;
    }
    syncDirectory();
    try { action(); }
    finally { unlinkSync(OPERATOR_MUTEX); syncDirectory(); }
  };
  const persistIdentity = (input: BoxJournalAdmission): void => {
    assertion(lockHeld && !identityPersisted && input.requestId === firstId && input.uid === UID
      && input.accountId === ACCOUNT_ID, "BOX_TOOL_ATTEMPT_IDENTITY_INVALID");
    const raw = JSON.stringify({ v: 1, pid: process.pid,
      accountId: String(ACCOUNT_ID), uid: String(UID),
      firstId, secondId, sessionId, runNonce: input.runNonce,
      leaseEpoch: input.leaseEpoch, state: "unresolved",
      createdAt: new Date().toISOString() }) + "\n";
    const staged = `${EVIDENCE_PATH}.${nonce}.part`;
    writeDurable(staged, raw);
    renameSync(staged, EVIDENCE_PATH);
    syncDirectory();
    identityPersisted = true;
  };
  try {
    const database = await client.query<{ current_database: string }>(
      "SELECT current_database()");
    assertion(database.rows[0]?.current_database === "openclaude_v5_selfhost",
      "BOX_SIGNED_DATABASE_BOUNDARY_INVALID");
    const parent = lstatSync(EVIDENCE_PARENT);
    assertion(parent.isDirectory() && !parent.isSymbolicLink()
      && parent.uid === process.getuid()
      && (parent.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_PARENT_INVALID");
    try { mkdirSync(EVIDENCE_DIR, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Persist the newly-created child directory entry as well as files in it.
    syncDirectory(EVIDENCE_PARENT);
    const directory = lstatSync(EVIDENCE_DIR);
    assertion(directory.isDirectory() && !directory.isSymbolicLink()
      && directory.uid === process.getuid()
      && (directory.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_DIR_INVALID");
    withOperatorMutex(() => {
      try {
        writeDurable(EVIDENCE_PATH, JSON.stringify({ v: 1, pid: process.pid,
          accountId: String(ACCOUNT_ID), uid: String(UID), firstId, secondId,
          state: "preparing", createdAt: new Date().toISOString() }) + "\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("BOX_TOOL_PRIOR_UNKNOWN_REQUIRES_RECONCILIATION");
        }
        throw error;
      }
      syncDirectory(); lockHeld = true;
    });
    const owners = await client.query<{ id: string }>(
      `SELECT id::text FROM agent_containers
       WHERE user_id=$1 AND state='active' AND runtime_channel='v5'
         AND runtime_kind='docker' AND secret_hash IS NOT NULL`, [UID.toString()]);
    assertion(owners.rows.length === 1 && owners.rows[0]?.id === expectedContainerId,
      "BOX_SIGNED_CONTAINER_NOT_CURRENT");
    const containerId = Number(expectedContainerId);
    assertion(Number.isSafeInteger(containerId), "BOX_SIGNED_CONTAINER_ID_INVALID");
    const livePricing = new PricingCache();
    await livePricing.load();
    const directPrice = livePricing.get(UPSTREAM);
    assertion(directPrice?.enabled && directPrice.input_per_mtok > 0n
      && directPrice.input_per_mtok <= 1000n
      && directPrice.output_per_mtok > 0n
      && directPrice.output_per_mtok <= 5000n
      && directPrice.cache_read_per_mtok <= 1000n
      && directPrice.cache_write_per_mtok <= 5000n
      && multiplierToScaled(directPrice.multiplier) <= 5000n,
    "BOX_SIGNED_PRICE_UNAVAILABLE");
    // This one-off local route inherits the current selfhost Opus rate. It
    // never inserts a catalog/pricing row or exposes a public model entry.
    const price: ModelPricing = { ...directPrice, model_id: MODEL,
      display_name: "Box Claude Opus 5.5 operator canary", default_effort: null };
    const before = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    assertion(before.rows.length === 1 && BigInt(before.rows[0]!.credits) > 0n,
      "BOX_SIGNED_WALLET_UNAVAILABLE");
    const initialCredits = BigInt(before.rows[0]!.credits);
    dbReady = true;
    const baseJournal = new BoxDurableJournal(pool);
    const journal = new Proxy(baseJournal, { get(target, key) {
      if (key === "admit") return async (input: BoxJournalAdmission) => {
        // fsynced before durable admission and paid CLI launch. A crash cannot
        // erase which real wallet and Box invocation need reconciliation.
        persistIdentity(input);
        return target.admit(input);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const resolver = createProductionBoxAccountResolver();
    const service = new BoxToolFetch({
      supervisorAsset: readFileSync(new URL("./box_supervisor.py", import.meta.url)),
      keeperAsset: readFileSync(new URL("./box_keeper.py", import.meta.url)),
      virtualMcpAsset: readFileSync(new URL("./box_virtual_mcp.py", import.meta.url)),
      detachedRunnerAsset: readFileSync(new URL("./box_detached_runner.py", import.meta.url)),
      journal, maxOutputTokensForModel: (model) => model === MODEL ? 128_000 : null,
      resolveTarget: (args) => resolver.resolve({ ...args, requiredAccountId: ACCOUNT_ID }),
      onUnknown: async ({ phase }) => { unknownPhase ??= phase; },
    });
    const preflightOnly = process.env.OCV5_289_SIGNED_PREFLIGHT_ONLY === "1";
    let transportCalls = 0;
    process.env.OC_BOX_MODEL_API = "1";
    process.env.OC_BOX_TOOL_BRIDGE = "1";
    loopback = await startSignedLoopback({ pool, redis, containerId,
      boxModel: { toolBridgeReady: true, fetch: (args) => {
        transportCalls++;
        if (preflightOnly) throw new Error("BOX_PREFLIGHT_TRANSPORT_CALLED");
        return service.fetch(args);
      } }, price });
    if (preflightOnly) {
      const invalid: ProxyBody = { model: MODEL, max_tokens: 128, stream: true,
        messages: [{ role: "user", content: "synthetic preflight" }],
        metadata: { user_id: JSON.stringify({ session_id: sessionId }) } };
      const response = await loopback.call(invalid, firstId);
      const code = (await response.json().catch(() => null)) as
        { error?: { code?: string } } | null;
      await loopback.waitHandler(firstId);
      assertion(response.status === 500 && code?.error?.code === "INTERNAL"
        && loopback.diagnostics.some((item) => item.msg === "proxy_journal_insert_failed"
          && item.detail === "BOX_BILLING_TURN_KEY_INVALID")
        && transportCalls === 0 && !identityPersisted,
      "BOX_SIGNED_PREFLIGHT_INVALID");
      const rows = await client.query("SELECT 1 FROM request_finalize_journal WHERE request_id=$1",
        [firstId]);
      assertion(rows.rowCount === 0, "BOX_SIGNED_PREFLIGHT_JOURNAL_LEAK");
      withOperatorMutex(() => { unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false; });
      process.stdout.write(JSON.stringify({ signedIdentity: true, paidCalls: 0,
        status: response.status, code: code.error.code, accountId: String(ACCOUNT_ID),
        diagnostics: loopback.diagnostics.slice(-8) }) + "\n");
      return;
    }
    const tools = [{ name: "local_echo", description: "Synthetic OpenClaude-local tool",
      input_schema: { type: "object", properties: { value: { type: "string" } },
        required: ["value"] } }];
    // Opus 5.5 adaptive thinking can consume a 128-token ceiling before it
    // reaches tool_use; use the actual CCB-scale request budget for this probe.
    const first: ProxyBody = { model: MODEL, max_tokens: 8192, stream: true,
      system: "Synthetic OpenClaude tool verification. No real user content.",
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content:
        `Call local_echo exactly once with value ${challenge}. Then answer with exactly its result text.` }],
      tools, tool_choice: { type: "auto" } };
    const firstResponse = await loopback.call(first, firstId);
    const firstEvents = await readEvents(firstResponse);
    await loopback.waitHandler(firstId);
    const content = assistantContent(firstEvents);
    const toolUse = content.filter((block) => block.type === "tool_use");
    assertion(toolUse.length === 1 && toolUse[0]?.name === "local_echo"
      && typeof toolUse[0]?.id === "string"
      && JSON.stringify(toolUse[0]?.input) === JSON.stringify({ value: challenge }),
    "BOX_TOOL_PROBE_TOOL_USE_INVALID");
    assertion(firstEvents.some((item) => item.event === "message_delta"
      && (item.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason === "tool_use"),
    "BOX_TOOL_PROBE_HANDOFF_INVALID");
    const firstBilled = await client.query<{ request_id: string }>(
      "SELECT request_id FROM usage_records WHERE request_id=$1 AND user_id=$2",
      [firstId, UID.toString()]);
    assertion(firstBilled.rows.length === 1, "BOX_SIGNED_HANDOFF_NOT_BILLED");
    // The only tool implementation is here in OpenClaude's operator process;
    // Box receives only schema/pending/result via the virtual MCP.
    localExecutions++;
    const second: ProxyBody = { ...first, messages: [
      ...first.messages, { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result",
        tool_use_id: toolUse[0]!.id, content: localResult }] },
    ] };
    const secondResponse = await loopback.call(second, secondId);
    const secondEvents = await readEvents(secondResponse);
    await loopback.waitHandler(secondId);
    const answer = assistantContent(secondEvents)
      .filter((block) => block.type === "text").map((block) => block.text).join("");
    assertion(answer.trim() === localResult && localExecutions === 1
      && unknownPhase === null, "BOX_TOOL_PROBE_FINAL_INVALID");
    const rows = await client.query<{ request_id: string; state: string;
      ctx: Record<string, unknown> }>(
      `SELECT request_id,state,ctx FROM request_finalize_journal
       WHERE request_id IN ($1,$2) ORDER BY request_id`, [firstId, secondId]);
    const ownerRow = rows.rows.find((row) => row.request_id === firstId);
    const finalRow = rows.rows.find((row) => row.request_id === secondId);
    assertion(rows.rows.length === 2 && rows.rows.every((row) => row.ctx.boxState === "terminal"
      && row.state === "committed")
      && !!ownerRow?.ctx.boxToolHandoff && !ownerRow.ctx.boxTerminalProof
      && (finalRow?.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
        === "worker_complete",
    "BOX_TOOL_PROBE_JOURNAL_NOT_TERMINAL");
    const finance = await client.query<{ id: string; request_id: string; model: string;
      cost_credits: string; input_tokens: string; output_tokens: string;
      ledger_id: string | null }>(
      `SELECT ur.id::text,ur.request_id,ur.model,ur.cost_credits::text,
         ur.input_tokens::text,ur.output_tokens::text,ur.ledger_id::text
       FROM usage_records ur
       WHERE ur.request_id IN ($1,$2) AND ur.user_id=$3 ORDER BY ur.request_id`,
      [firstId, secondId, UID.toString()]);
    const usageIds = finance.rows.map((row) => row.id);
    const ledger = await client.query<{ id: string; ref_id: string; delta: string;
      bucket: string; reason: string }>(
      `SELECT id::text,ref_id,delta::text,bucket,reason FROM credit_ledger
        WHERE user_id=$1 AND ref_type='usage_record' AND ref_id=ANY($2::text[])`,
      [UID.toString(), usageIds]);
    assertion(finance.rows.length === 2
      && new Set(finance.rows.map((row) => row.request_id)).size === 2
      && finance.rows.every((row) => {
        const charges = ledger.rows.filter((item) => item.ref_id === row.id);
        return row.model === MODEL
        && BigInt(row.input_tokens) >= 0n && BigInt(row.output_tokens) > 0n
        && BigInt(row.cost_credits) > 0n && row.ledger_id
        && charges.length >= 1 && charges.length <= 4
        && charges.some((item) => item.id === row.ledger_id)
        && charges.every((item) => item.reason === "chat"
          && ["period", "wallet", "org_period", "org_wallet"].includes(item.bucket)
          && BigInt(item.delta) < 0n)
        && charges.reduce((sum, item) => sum - BigInt(item.delta), 0n)
          === BigInt(row.cost_credits);
      })
      && ledger.rows.length <= 8,
    "BOX_SIGNED_REAL_LEDGER_MISMATCH");
    const debited = finance.rows.reduce((sum, row) => sum + BigInt(row.cost_credits), 0n);
    const after = await client.query<{ credits: string }>(
      "SELECT credits::text FROM users WHERE id=$1", [UID.toString()]);
    assertion(after.rows.length === 1 && BigInt(after.rows[0]!.credits) >= 0n
      && initialCredits > 0n, "BOX_SIGNED_WALLET_INVALID");
    terminal = true;
    const pendingCleanup = await service.retryTerminalCleanup();
    const cleanupRow = await client.query<{ cleanup: string | null }>(
      `SELECT ctx->>'boxRemoteCleanup' AS cleanup FROM request_finalize_journal
       WHERE request_id=$1`, [secondId]);
    assertion(pendingCleanup === 0 && cleanupRow.rows[0]?.cleanup === "done",
      "BOX_TOOL_PROBE_CLEANUP_UNPROVEN");
    assertion(identityPersisted, "BOX_TOOL_PROBE_IDENTITY_NOT_DURABLE");
    withOperatorMutex(() => {
      unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
    });
    process.stdout.write(JSON.stringify({ accountId: String(ACCOUNT_ID),
      modelId: UPSTREAM, detachedAcrossHttp: true,
      localToolExecutions: localExecutions,
      exactFinal: true, terminalRows: rows.rows.length,
      signedContainerRoute: true, persistentUsageRows: 2,
      persistentLedgerRows: ledger.rows.length, inheritsDirectOpusPrice: true,
      debitedCredits: debited.toString(),
      firstEventCount: firstEvents.length, secondEventCount: secondEvents.length,
      remoteCleanupDone: true, unknown: false }) + "\n");
  } catch (error) {
    if (lockHeld && !identityPersisted) {
      // The durable admission wrapper has not run, so no paid CLI can have
      // started. Release this prelaunch-only reservation, still fail the probe.
      try { withOperatorMutex(() => {
        unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
      }); }
      catch { /* Keep a conservative unknown lock on cleanup failure. */ }
    }
    const observed = dbReady
      ? await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
         WHERE request_id IN ($1,$2)`, [firstId, secondId]).catch(() => ({ rows: [] }))
      : { rows: [] as Array<{ request_id: string; ctx: Record<string, unknown> }> };
    const evidence = observed.rows.map((row) => ({ requestId: row.request_id,
      state: row.ctx.boxState, runNonce: row.ctx.boxRunNonce,
      leaseEpoch: row.ctx.boxLeaseEpoch }));
    process.stderr.write(JSON.stringify({ code: error instanceof Error
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "BOX_TOOL_PROBE_FAILED",
      terminal, unknownPhase, evidencePath: lockHeld ? EVIDENCE_PATH : null,
      evidence }) + "\n");
    throw error;
  } finally {
    if (oldModelFlag === undefined) delete process.env.OC_BOX_MODEL_API;
    else process.env.OC_BOX_MODEL_API = oldModelFlag;
    if (oldToolFlag === undefined) delete process.env.OC_BOX_TOOL_BRIDGE;
    else process.env.OC_BOX_TOOL_BRIDGE = oldToolFlag;
    await loopback?.close().catch(() => {});
    client.release();
    await redis.quit().catch(() => redis.disconnect());
    await closePool();
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_TOOL_PROBE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
