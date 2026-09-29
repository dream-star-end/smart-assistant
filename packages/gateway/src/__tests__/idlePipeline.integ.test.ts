/**
 * OCV5-296 idle chain. Real SessionManager.submit, real CcbAdapter,
 * real SubprocessRunner, and this checkout's claude-code-best entry.
 * The proxy is a git-archive candidate with only route-ready flipped true.
 * Synthetic bytes are the model SSE after the real plan/stage/journal.
 * The node -e header adapter is not this test.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = mkdtempSync(join(tmpdir(), "ocv5-296-idle-home-"));
process.env.OPENCLAUDE_HOME = HOME;
process.env.OC_USER_ID = "3";
process.env.OC_CCB_OFFICIAL_CC = "";
process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
process.env.CLAUDE_CODE_MAX_RETRIES = "0";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-not-a-real-key";
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
delete process.env.OPENCLAUDE_V3_MASTER_BASE_URL;
delete process.env.OPENCLAUDE_V3_CONTAINER_TOKEN;
for (const key of Object.keys(process.env)) {
  if (/(_API_KEY|_SECRET|_PASSWORD|_DSN|DATABASE_URL)$/i.test(key)) delete process.env[key];
}

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const MODEL = "box-api-claude-opus-5-5";
const READY_FALSE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = false;";
const READY_TRUE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = true;";
const SUMMARY_MARK = "preserve the user goal, decisions, constraints";
const MAX_HTTP = 80;
const GROW_CHARS = 180_000;
const GROW_TARGET = 8_860_467;
let summaryRequested = false;
let growthActive = false;
let growthRound = 0;
let spoolBuf = Buffer.alloc(0);
let pendingStdout: string | null = null;
const growthBodies: string[] = [];
const TEST_DB = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const SCHEMA = `ocv5_296_idle_${randomBytes(3).toString("hex")}`;
const REDIS_URL = "redis://127.0.0.1:56379/12";

test("real submit reaches a short idle no-op without a summary HTTP", { timeout: 900_000 }, async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const keyId = "mak1_testkey00000001";
  const keyring = new Map<string, Uint8Array>([[keyId, new Uint8Array(publicRaw)]]);
  const hits: Array<{ url: string; status: number; bytes: number; summary: boolean; body?: string; keptPrefix?: boolean; shape?: unknown; digest?: unknown; kind?: string; reasons?: string[]; requestId?: string }> = [];
  let wantSummary = false;
  const events: string[] = [];
  let candidate = "";
  let schemaOwned = false;
  const cleanupErrors: string[] = [];
  let serverClose: (() => Promise<void>) | undefined;
  let adapterShutdown: (() => Promise<void>) | undefined;
  let adminEnd: (() => Promise<void>) | undefined;
  let poolEnd: (() => Promise<void>) | undefined;
  let redisQuit: (() => Promise<void>) | undefined;
  const report: Record<string, unknown> = { schema: SCHEMA, redis: REDIS_URL, checkout: CHECKOUT };
  let holdNextSettlement = false;
  const heldCommits: Array<() => void> = [];
  const releaseHeldCommits = () => {
    const pending = heldCommits.splice(0);
    for (const resume of pending) resume();
  };
  try {
    candidate = mkdtempSync(join(tmpdir(), "ocv5-296-idle-cand-"));
    const archived = spawnSync("git", [
      "-c", `safe.directory=${CHECKOUT}`, "-C", CHECKOUT, "archive", "--format=tar", "HEAD",
    ], { maxBuffer: 256 * 1024 * 1024 });
    assert.equal(archived.status, 0, archived.stderr?.toString("utf8").slice(0, 400));
    const unpacked = spawnSync("tar", ["-x", "-C", candidate], { input: archived.stdout });
    assert.equal(unpacked.status, 0, unpacked.stderr?.toString("utf8").slice(0, 400));
    const ownerRel = "packages/commercial/src/http/proxy/boxNativeContextOwner.ts";
    const planRel = "packages/commercial/src/http/proxy/boxTextPlan.ts";
    const productOwner = readFileSync(join(CHECKOUT, ownerRel), "utf8");
    const copied = readFileSync(join(candidate, ownerRel), "utf8");
    assert.equal(copied, productOwner);
    assert.equal(copied.split(READY_FALSE).length, 2);
    writeFileSync(join(candidate, ownerRel), copied.replace(READY_FALSE, READY_TRUE));
    assert.equal(readFileSync(join(candidate, planRel), "utf8"), readFileSync(join(CHECKOUT, planRel), "utf8"));
    const ccbModules = join(CHECKOUT, "claude-code-best/node_modules");
    assert.equal(readFileSync(join(ccbModules, "@anthropic-ai/sdk/package.json"), "utf8").includes("0.81.0"), true);
    symlinkSync(ccbModules, join(candidate, "claude-code-best/node_modules"));
    symlinkSync(join(CHECKOUT, "node_modules"), join(candidate, "node_modules"));
    report.candidate = candidate;
    report.readyFlipOnly = true;
    report.autoCompactSourceUnchanged = true;
    report.cli = join(candidate, "claude-code-best/src/entrypoints/cli.tsx");

    const pg = (await import("pg")).default;
    const Redis = (await import("ioredis")).default;
    const admin = new pg.Pool({ connectionString: TEST_DB, max: 1, application_name: "ocv5-296-idle-admin" });
    const pool = new pg.Pool({
      connectionString: TEST_DB, max: 4, applicationName: "ocv5-296-idle",
      options: `-c search_path=${SCHEMA}`,
    });
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
    adminEnd = () => admin.end();
    poolEnd = () => pool.end();
    const connect = pool.connect.bind(pool);
    const wrapClient = (client: { query: (...args: never[]) => unknown }) => {
      const query = client.query.bind(client);
      let sawUsageInsert = false;
      client.query = ((a: unknown, b?: unknown, c?: unknown) => {
        const text = typeof a === "string"
          ? a
          : a && typeof a === "object" && "text" in a ? String((a as { text?: unknown }).text ?? "") : "";
        const verb = text.trim().toUpperCase();
        if (verb.startsWith("BEGIN")) sawUsageInsert = false;
        if (/INSERT\s+INTO\s+usage_records/i.test(text)) sawUsageInsert = true;
        const run = () => c !== undefined ? query(a as never, b as never, c as never)
          : b !== undefined ? query(a as never, b as never)
          : query(a as never);
        if (verb === "COMMIT" && sawUsageInsert && holdNextSettlement) {
          holdNextSettlement = false;
          return new Promise((resolve, reject) => {
            heldCommits.push(() => { Promise.resolve(run()).then(resolve, reject); });
          });
        }
        return run();
      }) as typeof client.query;
      return client;
    };
    pool.connect = ((cb?: unknown) => {
      if (typeof cb === "function") return connect(cb as never);
      return connect().then((client) => wrapClient(client as { query: (...args: never[]) => unknown }));
    }) as typeof pool.connect;
    redisQuit = () => redis.quit().then(() => undefined);
    const ident = await admin.query("SELECT current_database() AS db, inet_server_port() AS port");
    assert.equal(ident.rows[0].db, "openclaude_test");
    assert.equal(Number(ident.rows[0].port), 55432);
    const publicUsers = await admin.query("SELECT to_regclass('public.users') AS reg");
    assert.equal(publicUsers.rows[0].reg, null);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    schemaOwned = true;
    await admin.query(`
      CREATE TABLE ${SCHEMA}.users (id bigint PRIMARY KEY, credits bigint NOT NULL);
      CREATE TABLE ${SCHEMA}.user_subscriptions (
        id bigint PRIMARY KEY, user_id bigint NOT NULL, period_credits bigint NOT NULL,
        status text NOT NULL, period_end timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT NOW());
      CREATE TABLE ${SCHEMA}.credit_ledger (
        id bigserial PRIMARY KEY, user_id bigint NOT NULL, delta bigint NOT NULL, balance_after bigint NOT NULL,
        reason text NOT NULL, bucket text, ref_type text, ref_id text, memo text, org_id bigint,
        created_at timestamptz NOT NULL DEFAULT NOW());
      CREATE TABLE ${SCHEMA}.usage_records (
        id bigserial PRIMARY KEY, user_id bigint NOT NULL, mode text, account_id bigint, model text,
        input_tokens bigint, output_tokens bigint, cache_read_tokens bigint, cache_write_tokens bigint,
        price_snapshot jsonb, cost_credits bigint, session_id text, parent_session_id text,
        delegate_agent_id text, request_id text, status text, org_id bigint,
        execution_revision text, projection_revision text, security_epoch bigint, authority_kind text,
        turn_key text, parent_turn_key text, dispatch_id text, attempt_no integer,
        verification_run_id text, would_have_cost_credits bigint,
        board_project_id text, board_project_source text, board_project_captured_at timestamptz,
        api_key_id bigint, ledger_id bigint, UNIQUE (user_id, request_id));
      CREATE TABLE ${SCHEMA}.request_finalize_journal (
        request_id text PRIMARY KEY, user_id bigint NOT NULL, container_id bigint, state text NOT NULL,
        ctx jsonb, precheck_credits bigint, dispatch_id text, attempt_no integer,
        updated_at timestamptz NOT NULL DEFAULT NOW(), final_credits bigint, ledger_id bigint,
        usage_id bigint, failure_code text, error_msg text);
      CREATE TABLE ${SCHEMA}.authority_turn_dispatches (
        authority_turn_id text PRIMARY KEY, user_id bigint, dispatch_model text, canonical_model text,
        session_id text, dispatch_id text, attempt_no integer);
      CREATE TABLE ${SCHEMA}.turn_dispatches (
        dispatch_id text PRIMARY KEY, user_id bigint, session_id text, model text, attempt_no integer,
        status text, owner_id text, lease_epoch bigint, lease_until timestamptz);
      CREATE TABLE ${SCHEMA}.org_memberships (
        org_id bigint, user_id bigint, status text, billing_enabled boolean, monthly_org_budget bigint);
      CREATE TABLE ${SCHEMA}.orgs (id bigint PRIMARY KEY, credits bigint, status text, updated_at timestamptz);
      CREATE TABLE ${SCHEMA}.org_subscriptions (
        id bigint PRIMARY KEY, org_id bigint, period_credits bigint, status text, period_end timestamptz);
      CREATE TABLE ${SCHEMA}.client_sessions (id text PRIMARY KEY, user_id text, project_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.chat_projects (id text PRIMARY KEY, user_id text, board_project_id text, deleted_at timestamptz);
      CREATE TABLE ${SCHEMA}.turn_waivers (user_id bigint, turn_key text);
      CREATE TABLE ${SCHEMA}.pending_usage_patches (
        request_id text, user_id text, session_id text, parent_session_id text, delegate_agent_id text,
        turn_key text, parent_turn_key text, cost_credits bigint, PRIMARY KEY (request_id, user_id));
      CREATE TABLE ${SCHEMA}.turn_upstream_performance (
        request_id text PRIMARY KEY, user_id bigint, dispatch_id text, model text, ttft_ms integer,
        stream_ms integer, outcome text, control_plane_release text, control_plane_commit text,
        observed_at timestamptz);
    `);
    await pool.query("INSERT INTO users (id, credits) VALUES (3, 50000000)");
    const regs = await pool.query<{ name: string; schema: string | null }>(`
      SELECT name, (
        SELECT n.nspname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.oid = to_regclass(name)
      ) AS schema
      FROM unnest(ARRAY[
        'users','user_subscriptions','credit_ledger','usage_records','request_finalize_journal',
        'authority_turn_dispatches','turn_dispatches','org_memberships','orgs','org_subscriptions',
        'client_sessions','chat_projects','turn_waivers','pending_usage_patches','turn_upstream_performance'
      ]) AS name`);
    for (const row of regs.rows) assert.equal(row.schema, SCHEMA, row.name);
    const redisInfo = String(await redis.call("CLIENT", "INFO"));
    assert.equal(redisInfo.includes("db=12"), true, redisInfo);
    assert.equal(redisInfo.includes("db=13"), false);

    const candidateDb = await import(pathToFileURL(join(candidate, "packages/commercial/src/db/index.ts")).href);
    const candidatePre = await import(pathToFileURL(join(candidate, "packages/commercial/src/billing/preCheck.ts")).href);
    const candidateProxy = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/index.ts")).href);
    const candidatePlan = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxTextPlan.ts")).href);
    const candidateJournal = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxDurableJournal.ts")).href);
    const candidateProof = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxIdleProofHandler.ts")).href);
    const candidateOwner = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxNativeContextOwner.ts")).href);
    const productOwnerMod = await import(pathToFileURL(join(CHECKOUT, ownerRel)).href);
    assert.equal(productOwnerMod.BOX_NATIVE_CONTEXT_ROUTE_READY, false);
    assert.equal(candidateOwner.BOX_NATIVE_CONTEXT_ROUTE_READY, true);
    candidateDb.setPoolOverride(pool);
    process.env.OC_BOX_MODEL_API = "1";
    process.env.OC_BOX_TOOL_BRIDGE = "1";
    const billingRedis = candidatePre.wrapIoredisForPreCheck(redis);
    const supervisor = readFileSync(join(CHECKOUT, "scripts/ocv5-289/box_supervisor.py"));
    const keeper = readFileSync(join(CHECKOUT, "scripts/ocv5-289/box_keeper.py"));
    const virtualMcp = readFileSync(join(CHECKOUT, "scripts/ocv5-289/box_virtual_mcp.py"));
    const detachedRunner = readFileSync(join(CHECKOUT, "scripts/ocv5-289/box_detached_runner.py"));
    const descriptor = {
      canonicalModel: MODEL, engine: "ccb", providerId: "box_cli", upstreamModelId: "claude-opus-5-5",
      contextWindow: 200_000,
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: false, contextOwner: "box-native-v1" },
      },
      capabilitySchemaVersion: 1, defaultEffort: null,
    };
    const pricing = {
      model_id: MODEL, display_name: "Box", input_per_mtok: 1_000_000n, output_per_mtok: 400n,
      cache_read_per_mtok: 1n, cache_write_per_mtok: 1n, multiplier: "1.000", enabled: true,
      sort_order: 0, visibility: "public", extra_system_prompt: null, default_effort: null, updated_at: new Date(),
    };
    const catalog = {
      async assertFresh() {
        return {
          securityEpoch: 12n, executionRevision: "b".repeat(64), billingRevision: "c".repeat(64),
          aliasToCanonical: (model: string) => model,
          resolve: (model: string) => (model === MODEL ? descriptor : null),
          canUseModel: () => true,
          billingPricingFor: (model: string) => (model === MODEL ? pricing : null),
          projectionRevisionFor: () => "d".repeat(64),
        };
      },
    };
    const identity = {
      async resolve() { return { uid: 3n, containerId: 7n }; },
      async authorize() {},
    };
    let fetches = 0;
    const journal = new candidateJournal.BoxDurableJournal(pool);
    const replayDir = join(HOME, "box-replay");
    mkdirSync(replayDir, { mode: 0o700 });
    const replayMod = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxReplayMessageFile.ts")).href);
    const writeMessage = (identity: unknown, message: unknown) => replayMod.writeBoxReplayMessage(replayDir, identity, message);
    const toolFetchMod = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxToolFetch.ts")).href);
    const textFetchMod = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxTextFetch.ts")).href);
    const registryMod = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxInvocationRegistry.ts")).href);
    const preparedMod = await import(pathToFileURL(join(candidate, "packages/commercial/src/http/proxy/boxPreparedContinuation.ts")).href);
    const boxProjects = "/home/box/.claude/projects";
    if (!existsSync(boxProjects)) mkdirSync(boxProjects, { recursive: true, mode: 0o755 });
    const boxStat = statSync(boxProjects);
    if (!boxStat.isDirectory() || boxStat.uid !== (process.getuid?.() ?? 0)) {
      throw new Error(`fixture needs ${boxProjects} owned by uid ${process.getuid?.() ?? 0}`);
    }
    report.boxProjects = boxProjects;
    const toolNames: string[] = [];
    const localExec = makeLocalPythonExec(() => toolNames);
    const onUnknown = async () => { localExec.unknowns += 1; };
    const textFetch = new textFetchMod.BoxTextFetch({
      supervisorAsset: supervisor, keeperAsset: keeper, detachedRunnerAsset: detachedRunner,
      registry: new registryMod.BoxInvocationRegistry({ maxPerUser: 1, maxPerAccount: 1, leaseMs: 900_000 }),
      journal, writeMessage, maxOutputTokensForModel: (model: string) => model === MODEL ? 128_000 : null,
      resolveTarget: async () => ({ accountId: 20n, exec: localExec, dispose: async () => {} }),
      onUnknown,
    });
    const toolFetch = new toolFetchMod.BoxToolFetch({
      supervisorAsset: supervisor, keeperAsset: keeper, virtualMcpAsset: virtualMcp,
      detachedRunnerAsset: detachedRunner, journal, writeMessage,
      maxOutputTokensForModel: (model: string) => model === MODEL ? 128_000 : null,
      resolveTarget: async () => ({ accountId: 20n, exec: localExec, dispose: async () => {} }),
      onUnknown,
    });
    report.transport = "BoxTextFetch+BoxToolFetch; python3 -I is local; launch/spool/terminal.json are the synthetic model stream";
    report.capability = { capabilityZero: true, supportsThinking: false, supportsVision: false, contextWindow: 200_000, contextOwner: "box-native-v1", source: "live catalog plus contextOwner only" };
    const handler = candidateProxy.makeAnthropicProxyHandler({
      pgPool: pool,
      pricing: { get: () => null },
      preCheckRedis: billingRedis,
      scheduler: {},
      identity,
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set<string>() }),
      rateLimitRedis: { async incr() { return 1; }, async expire() { return 1; } },
      modelCatalog: catalog,
      modelAuthorityEnforce: true,
      authorityKeyring: () => keyring,
      boxModel: {
        toolBridgeReady: true,
        fetch: (args: { prepared?: { classification: string; rejectCode?: string }; canonicalBody: { tools?: unknown[] } }) => {
          fetches += 1;
          if (fetches > MAX_HTTP) throw new Error("HTTP_CAP");
          const prepared = args.prepared;
          if (!prepared) throw new preparedMod.BoxContinuationDecisionError("reject", "BOX_PREPARED_STALE");
          if (prepared.classification === "reject") {
            throw new preparedMod.BoxContinuationDecisionError("reject", prepared.rejectCode ?? "BOX_PREPARED_REJECT");
          }
          if (prepared.classification === "continuation_candidate" || args.canonicalBody.tools?.length) {
            return toolFetch.fetch(args);
          }
          return textFetch.fetch(args);
        },
      },
    });
    const proof = candidateProof.makeBoxIdleProofHandler({ identity, journal });
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      let responseBody = "";
      let current: (typeof hits)[number] | undefined;
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = ((chunk: string | Uint8Array) => {
        responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        return write(chunk);
      }) as typeof res.write;
      res.end = ((chunk?: string | Uint8Array) => {
        if (chunk != null) responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
        if (current) {
          current.status = res.statusCode || current.status;
          current.body = responseBody.slice(0, 400);
          const requestId = res.getHeader("x-request-id");
          if (typeof requestId === "string" && requestId) current.requestId = requestId;
        }
        return end(chunk as never);
      }) as typeof res.end;
      const replay = Readable.from([raw]) as IncomingMessage;
      replay.method = req.method;
      replay.url = req.url;
      replay.headers = req.headers;
      const path = (req.url ?? "").split("?")[0];
      if (path === "/internal/v3/marketplace/sync") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ identityCompat: { schema: 1, userId: "3", profiles: [] } }));
        return;
      }
      if (path === "/internal/box/idle-proof") {
        await proof(replay, res, { hostUuid: "ocv5-296-idle", boundIp: "127.0.0.1" });
        hits.push({ url: path, status: res.statusCode, bytes: raw.length, summary: false, body: responseBody.slice(0, 300) });
        return;
      }
      if (path !== "/v1/messages") {
        res.writeHead(404);
        res.end();
        hits.push({ url: path, status: 404, bytes: raw.length, summary: false });
        return;
      }
      if (hits.filter((hit) => hit.url === "/v1/messages").length >= MAX_HTTP) {
        res.writeHead(429);
        res.end();
        return;
      }
      let shape: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw.toString("utf8")) as {
          thinking?: unknown; output_config?: unknown; tool_choice?: unknown; tools?: unknown[];
        };
        const count = Array.isArray(parsed.tools) ? parsed.tools.length : 0;
        toolNames.splice(0, toolNames.length, ...Array.from({ length: count }, (_, i) => `mcp__ocbridge__t${i}`));
        shape = {
          thinking: parsed.thinking ?? null,
          output_config: parsed.output_config ?? null,
          tool_choice: parsed.tool_choice ?? null,
          toolCount: count,
        };
      } catch { shape = { parse: false }; }
      summaryRequested = raw.includes(SUMMARY_MARK);
      wantSummary = summaryRequested;
      const digest = messageDigest(raw.toString("utf8"));
      const classified = classifyRequest(raw.toString("utf8"));
      prepareModelSpool(raw.toString("utf8"));
      if (growthActive && growthBodies.length < 3) {
        const text = raw.toString("utf8");
        growthBodies.push(text);
        const rawDir = process.env.OC_V5_296_IDLE_RAW ? dirname(process.env.OC_V5_296_IDLE_RAW) : tmpdir();
        writeFileSync(join(rawDir, `ocv5-296-r17-growth-${growthBodies.length}.json`), text);
      }
      current = {
        url: path, status: 0, bytes: raw.length,
        summary: summaryRequested, keptPrefix: raw.includes("OCV5296_OLD_PREFIX"), shape,
        digest, kind: classified.kind, reasons: classified.reasons,
      };
      hits.push(current);
      await handler(replay, res, { hostUuid: "ocv5-296-idle", boundIp: "127.0.0.1" });
      current.status = res.statusCode || current.status;
      current.body = responseBody.slice(0, 400);
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const base = `http://127.0.0.1:${port}`;
    process.env.ANTHROPIC_BASE_URL = base;
    process.env.OPENCLAUDE_V3_MASTER_BASE_URL = base;
    process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = "oc-v3.idle-fixture";
    process.env.OPENCLAUDE_CLAUDE_CODE_PATH = join(candidate, "claude-code-best");
    process.env.OPENCLAUDE_CLAUDE_CODE_ENTRY = "src/entrypoints/cli.tsx";
    process.env.OPENCLAUDE_CLAUDE_CODE_RUNTIME = "bun";
    process.env.CLAUDE_CONFIG_DIR = join(HOME, "claude-config");
    mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    serverClose = () => new Promise((resolveClose) => server.close(() => resolveClose()));
    report.base = base;
    report.moduleProxy = join(candidate, "packages/commercial/src/http/proxy/index.ts");

    const { SessionManager } = await import("../sessionManager.js");
    const { CcbAdapter } = await import("../engine/ccbAdapter.js");
    const { setV3MasterSinkSingleton } = await import("../v3MasterSink.js");
    const protocol = await import("@openclaude/protocol");
    setV3MasterSinkSingleton({
      persistOrQueue: async () => ({ ok: true }),
      attemptOnce: async () => { throw new Error("unused"); },
    } as never);
    const authority = signAuthority(protocol, privateKey, keyId);
    const work = join(HOME, "work");
    mkdirSync(work);
    const adapter = new CcbAdapter({
      sessionKey: "agent:main:webchat:dm:idle-peer",
      agentId: "main",
      agentBaseDir: work,
      config: {
        version: 1,
        gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
        auth: { mode: "subscription", claudeCodePath: join(candidate, "claude-code-best"), claudeCodeEntry: "src/entrypoints/cli.tsx", claudeCodeRuntime: "bun" },
        terminal: { type: "local" },
        sessions: { dbPath: join(HOME, "sessions.db") },
        defaults: { permissionMode: "bypassPermissions" },
      } as never,
      model: MODEL,
      permissionMode: "bypassPermissions",
      harness: "ccb",
      executionTarget: { kind: "local" },
    });
    adapterShutdown = () => adapter.shutdown();
    const session = {
      sessionKey: "agent:main:webchat:dm:idle-peer",
      agentId: "main",
      channel: "webchat",
      peerId: "idle-peer",
      title: "Idle",
      startedAt: Date.now(),
      runner: adapter,
      model: MODEL,
      lock: Promise.resolve(),
      lastUsedAt: 0,
      totalCostUSD: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      turns: 0,
      _lastCcbCumulativeCost: 0,
      toolUseIdToName: new Map(),
      executionTarget: { kind: "local" },
      providerTag: "ccb",
    } as never;
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
      auth: { mode: "subscription", claudeCodePath: "" },
      sessions: { dbPath: "" },
      defaults: { permissionMode: "bypassPermissions", model: MODEL },
    } as never);
    const onEvent = (event: { kind?: string }) => { events.push(event.kind ?? "unknown"); };
    const modelAuthority = {
      authorityEnvelope: authority.authority,
      leaseEnvelope: authority.lease,
      executionDescriptor: {
        canonicalModel: MODEL, contextWindow: 200_000, capabilityZero: true,
        supportsThinking: false, supportsVision: false, supportedEfforts: [],
        contextOwner: "box-native-v1" as const,
      },
    };
    let firstError: string | undefined;
    try {
      await sm.submit(session, "c".repeat(6000), onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
    } catch (error) {
      firstError = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
    }
    const nativeFiles = listJson(join(HOME, "idle-native"));
    const opFiles = listJson(join(HOME, "idle-ops"));
    report.fetches = fetches;
    report.execLog = localExec.log;
    report.hits = hits;
    report.events = events.slice(0, 40);
    report.firstError = firstError ?? null;
    report.nativeFiles = nativeFiles.map((file) => JSON.parse(readFileSync(file, "utf8")));
    report.opFiles = opFiles.map((file) => JSON.parse(readFileSync(file, "utf8")));
    report.journal = (await pool.query(
      `SELECT request_id, state, ctx->>'boxSessionId' AS box_session, ctx->>'boxTurnKey' AS box_turn,
              ctx->>'boxInvocationRecovery' AS recovery, ctx->>'boxState' AS box_state,
              ctx->'boxTerminalProof'->>'reason' AS proof_reason,
              (ctx ? 'boxReplayMessage') AS has_capsule
         FROM request_finalize_journal ORDER BY updated_at`,
    )).rows;
    const summaryHttp = hits.filter((hit) => hit.url === "/v1/messages" && hit.summary).length;
    report.summaryHttp = summaryHttp;
    if (firstError) throw new Error(`submit failed: ${firstError}`);
    const modelHit = hits.find((hit) => hit.url === "/v1/messages");
    if (!modelHit || modelHit.status !== 200) {
      throw new Error(`FIXTURE_OR_PRODUCT first model HTTP ${modelHit?.status ?? "missing"} ${modelHit?.body ?? ""} fetches=${fetches} exec=${localExec.log.join(",")}`);
    }
    assert.equal(summaryHttp, 0);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const committed = Number((await pool.query("SELECT count(*)::int AS n FROM request_finalize_journal WHERE state = 'committed'")).rows[0].n);
      if (committed >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const beforeSecond = hits.length;
    let secondSubmitError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await sm.submit(session, "ordinary next", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
        secondSubmitError = undefined;
        break;
      } catch (error) {
        secondSubmitError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("IDLE_HISTORY_PENDING")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (secondSubmitError) throw secondSubmitError;
    const short = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8"))) as Array<{ applied?: boolean; summaryText?: string }>;
    report.nativeFiles = short;
    assert.equal(short.some((file) => file.applied && !file.summaryText), true, JSON.stringify(short));
    const added = hits.slice(beforeSecond);
    report.secondHits = added;
    assert.equal(added.some((hit) => hit.summary), false);
    assert.equal(added.some((hit) => hit.url === "/v1/messages" && hit.status === 200), true);
    const ledgers = await pool.query(
      `SELECT u.request_id, u.status AS usage_status, u.cost_credits::text, u.turn_key,
              l.id::text AS ledger_id, l.delta::text, l.ref_id
         FROM usage_records u
         JOIN credit_ledger l ON l.id = u.ledger_id
        ORDER BY u.id`);
    report.ledgers = ledgers.rows;
    const seenRequests = new Set<string>();
    const seenTurns = new Set<string>();
    for (const row of ledgers.rows as Array<{ request_id: string; turn_key: string; delta: string }>) {
      assert.equal(seenRequests.has(row.request_id), false, row.request_id);
      seenRequests.add(row.request_id);
      assert.equal(seenTurns.has(row.turn_key), false, row.turn_key);
      seenTurns.add(row.turn_key);
      assert.ok(BigInt(row.delta) < 0n);
    }

    growthActive = true;
    growthRound = 0;
    const beforeGrowth = hits.length;
    const creditsBeforeGrowth = BigInt((await pool.query("SELECT credits::text AS credits FROM users WHERE id = 3")).rows[0].credits);
    let growthError = "";
    try {
      await sm.submit(session, "grow", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
    } catch (error) {
      growthError = error instanceof Error ? error.message : String(error);
    }
    const growthHits = hits.slice(beforeGrowth).filter((hit) => hit.url === "/v1/messages");
    report.growthError = growthError || null;
    report.growthHits = growthHits.map((hit) => ({
      status: hit.status, bytes: hit.bytes, kind: hit.kind, reasons: hit.reasons,
      requestId: hit.requestId, summary: hit.summary,
      digest: hit.digest,
    }));
    const bashSeen = growthHits.some((hit) => JSON.stringify(hit.shape ?? "").includes("Bash")
      || JSON.stringify(hit.digest ?? "").includes("\"Bash\""));
    report.growthRounds = growthRound;
    const live = growthHits.filter((hit) => hit.kind === "live-continuation" && hit.status === 200);
    const largest = growthHits.reduce((best, hit) => Math.max(best, hit.bytes), 0);
    report.largestGrowthBytes = largest;
    if (!bashSeen && live.length === 0 && largest < GROW_TARGET) {
      throw new Error(`live growth did not start: ${growthError || "no Bash continuation"} hits=${JSON.stringify(report.growthHits).slice(0, 1200)}`);
    }
    const grown = growthHits.some((hit) => {
      const digest = hit.digest as { contentBytes?: number } | undefined;
      return (digest?.contentBytes ?? 0) >= GROW_TARGET || hit.bytes >= GROW_TARGET;
    });
    if (!grown) {
      const last = growthHits.at(-1);
      report.contextDiff = await explainContextMismatch(growthBodies, CHECKOUT);
      throw new Error(`live tool chain stopped at ${largest} bytes before 8.45MiB; rounds=${growthRound}; last=${last?.status ?? "none"} ${last?.kind ?? ""} ${growthError}; diff=${JSON.stringify(report.contextDiff).slice(0, 1500)}`);
    }
    const heldIds = growthHits.map((hit) => hit.requestId).filter((id): id is string => Boolean(id));
    report.growthRequestIds = heldIds;
    const finalId = growthHits.filter((hit) => hit.kind !== "live-continuation").at(-1)?.requestId
      ?? growthHits.at(-1)?.requestId;
    if (finalId) {
      const hidden = await pool.query(
        `SELECT request_id, state FROM request_finalize_journal WHERE request_id = $1`,
        [finalId]);
      const usage = await pool.query(
        `SELECT request_id FROM usage_records WHERE request_id = $1`,
        [finalId]);
      report.heldRequest = { id: finalId, journal: hidden.rows, usageVisible: usage.rows.length };
    }
    const summaryDuringGrowth = growthHits.filter((hit) => hit.kind === "idle-summary" && hit.status === 200);
    if (summaryDuringGrowth.length === 1 && !growthError) {
      report.summaryDuringGrowth = true;
    }
    const beforeNext = hits.length;
    let nextError = "";
    try {
      await sm.submit(session, "ordinary next", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
    } catch (error) {
      nextError = error instanceof Error ? error.message : String(error);
    }
    report.nextError = nextError || null;
    const nextHits = hits.slice(beforeNext).filter((hit) => hit.url === "/v1/messages");
    report.nextHits = nextHits.map((hit) => ({
      status: hit.status, bytes: hit.bytes, kind: hit.kind, reasons: hit.reasons, summary: hit.summary,
    }));
    const summaries = [...growthHits, ...nextHits].filter((hit) => hit.kind === "idle-summary" && hit.status === 200);
    report.idleSummaryCount = summaries.length;
    if (summaries.length !== 1) {
      throw new Error(`idle summary HTTP count ${summaries.length}; growthError=${growthError}; nextError=${nextError}; kinds=${growthHits.map((hit) => hit.kind).join(",")}`);
    }
    const businessNext = nextHits.filter((hit) => hit.kind === "business" && hit.status === 200);
    assert.equal(businessNext.length >= 1, true, JSON.stringify(report.nextHits));
    const finalLedgers = await pool.query(
      `SELECT u.request_id, u.turn_key, u.cost_credits::text, l.id::text AS ledger_id, l.delta::text
         FROM usage_records u JOIN credit_ledger l ON l.id = u.ledger_id ORDER BY u.id`);
    report.ledgers = finalLedgers.rows;
    const ids = new Set<string>();
    const turns = new Set<string>();
    for (const row of finalLedgers.rows as Array<{ request_id: string; turn_key: string; delta: string }>) {
      assert.equal(ids.has(row.request_id), false, row.request_id);
      ids.add(row.request_id);
      assert.equal(turns.has(row.turn_key), false, row.turn_key);
      turns.add(row.turn_key);
      assert.ok(BigInt(row.delta) < 0n);
    }
    const creditsAfter = BigInt((await pool.query("SELECT credits::text AS credits FROM users WHERE id = 3")).rows[0].credits);
    const spent = (finalLedgers.rows as Array<{ delta: string }>).reduce((sum, row) => sum + BigInt(row.delta), 0n);
    report.credits = { beforeGrowth: creditsBeforeGrowth.toString(), after: creditsAfter.toString(), ledgerSum: spent.toString() };
    assert.equal(creditsAfter, 50_000_000n + spent);
  } finally {
    releaseHeldCommits();
    if (adapterShutdown) await adapterShutdown().catch(() => undefined);
    if (serverClose) await serverClose();
    if (poolEnd) await poolEnd().catch(() => undefined);
    if (schemaOwned) {
      const pg = (await import("pg")).default;
      const admin = new pg.Pool({ connectionString: TEST_DB, max: 1 });
      try {
        await admin.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
        const gone = await admin.query("SELECT to_regclass($1) AS rel", [`${SCHEMA}.users`]);
        if (gone.rows[0].rel) cleanupErrors.push("schema users still registered");
      } catch (error) {
        cleanupErrors.push(error instanceof Error ? error.message : String(error));
      }
      await admin.end();
    }
    if (redisQuit) await redisQuit().catch(() => undefined);
    if (candidate) {
      rmSync(join(candidate, "node_modules"), { force: true });
      rmSync(join(candidate, "claude-code-best/node_modules"), { force: true });
      rmSync(candidate, { recursive: true, force: true });
    }
    if (adminEnd) await adminEnd().catch(() => undefined);
    rmSync(HOME, { recursive: true, force: true });
    const path = process.env.OC_V5_296_IDLE_RAW
      ?? join(tmpdir(), `ocv5-296-idle-${randomBytes(3).toString("hex")}.json`);
    report.cleanupErrors = cleanupErrors;
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: "ocv5-296-idle", report: path, summaryHttp: report.summaryHttp, firstError: report.firstError, cleanup: cleanupErrors.length }));
    if (cleanupErrors.length > 0) throw new Error(`cleanup failed: ${cleanupErrors.join(" | ")}`);
  }
});

function messageDigest(raw: string): { messages: number; contentBytes: number; marker: number; toolResults: number } | { parse: false } {
  try {
    const parsed = JSON.parse(raw) as {
      messages?: Array<{ content?: unknown }>;
      tools?: Array<{ name?: string }>;
      context_management?: unknown; stop_sequences?: unknown; temperature?: unknown;
      top_p?: unknown; top_k?: unknown; service_tier?: unknown;
    };
    const messages = parsed.messages ?? [];
    let contentBytes = 0;
    let marker = 0;
    let toolResults = 0;
    for (const message of messages) {
      const text = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      contentBytes += text.length;
      if (text.includes("OCV5296_OLD_PREFIX") || text.includes("OCV5296_SECOND_OP")) marker += 1;
      if (text.includes("tool_result")) toolResults += 1;
    }
    const preview = (message: { content?: unknown } | undefined) => {
      const text = !message ? "" : typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "");
      return text.slice(0, 180);
    };
    return {
      messages: messages.length, contentBytes, marker, toolResults,
      context: parsed.context_management === undefined ? null : typeof parsed.context_management,
      stop: parsed.stop_sequences === undefined ? null : parsed.stop_sequences,
      temperature: parsed.temperature ?? null,
      top_p: parsed.top_p ?? null,
      top_k: parsed.top_k ?? null,
      service_tier: parsed.service_tier ?? null,
      tools: (parsed.tools ?? []).map((tool) => tool.name).slice(0, 24),
      first: preview(messages[0]),
      last: preview(messages[messages.length - 1]),
      small: contentBytes < 5000 ? messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? "")).join("\n---\n") : undefined,
      meta: JSON.stringify(parsed.metadata ?? null).slice(0, 400),
    };
  } catch {
    return { parse: false };
  }
}

function clearReceipt(sessionKey: string): void {
  const folder = join(HOME, "idle-ops", encodeURIComponent(sessionKey));
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);
    const op = JSON.parse(readFileSync(path, "utf8")) as { receiptDigest?: string };
    delete op.receiptDigest;
    writeFileSync(path, JSON.stringify(op));
  }
}

function seedOuterHistory(configDir: string, cwd: string, opts: { sessionId?: string; rounds?: number; marker?: string } = {}): { bytes: number; marker: string; sessionId: string; project: string } {
  const marker = opts.marker ?? "OCV5296_OLD_PREFIX";
  const rounds = opts.rounds ?? 64;
  const sessionId = opts.sessionId ?? randomUUID();
  let canonical = cwd;
  try { canonical = realpathSync(cwd); } catch { /* the spawn cwd is this path */ }
  const project = join(configDir, "projects", canonical.normalize("NFC").replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(project, { recursive: true });
  const lines: string[] = [];
  let parent: string | null = null;
  const origin = Date.parse("2026-09-29T00:00:00.000Z");
  let tick = 0;
  const push = (message: Record<string, unknown>, uuid: string, type: string) => {
    lines.push(JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      type,
      uuid,
      timestamp: new Date(origin + (tick += 1) * 1000).toISOString(),
      sessionId,
      cwd: canonical,
      userType: "external",
      version: "2.8.4",
      message,
    }));
    parent = uuid;
  };
  push({ role: "user", content: "seed-user" }, randomUUID(), "user");
  for (let i = 0; i < rounds; i += 1) {
    const tool = `toolu_${marker}_${i}`;
    push({
      id: `msg_${marker}_${i}`,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "tool_use", id: tool, name: "Read", input: { file_path: `f${i}.txt` } }],
    }, randomUUID(), "assistant");
    const payload = (i === 0 ? marker : "x").padEnd(128 * 1024, "y");
    push({ role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: payload }] }, randomUUID(), "user");
  }

  const file = join(project, `${sessionId}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);
  return { bytes: statSync(file).size, marker, sessionId, project };
}

function clip(value: unknown): unknown {
  if (typeof value === "string") return value.length > 120 ? `${value.slice(0, 120)}…(${value.length})` : value;
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 160)}…(${text.length})` : value;
}

function walkDiff(left: unknown, right: unknown, path: string, out: Array<Record<string, unknown>>, limit: number): void {
  if (out.length >= limit || Object.is(left, right)) return;
  const leftObj = left !== null && typeof left === "object";
  const rightObj = right !== null && typeof right === "object";
  if (!leftObj || !rightObj || Array.isArray(left) !== Array.isArray(right)) {
    out.push({ path, left: clip(left), right: clip(right) });
    return;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) out.push({ path, leftLength: left.length, rightLength: right.length });
    const count = Math.min(left.length, right.length);
    for (let index = 0; index < count && out.length < limit; index += 1) {
      walkDiff(left[index], right[index], `${path}[${index}]`, out, limit);
    }
    return;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])].sort()) {
    if (out.length >= limit) return;
    if (!Object.hasOwn(leftRecord, key)) out.push({ path: `${path}.${key}`, missing: "first" });
    else if (!Object.hasOwn(rightRecord, key)) out.push({ path: `${path}.${key}`, missing: "prefix" });
    else walkDiff(leftRecord[key], rightRecord[key], `${path}.${key}`, out, limit);
  }
}

function messageOutline(body: { messages?: Array<Record<string, unknown>> }): unknown[] {
  return (body.messages ?? []).map((message, index) => {
    const content = message.content;
    const blocks = Array.isArray(content) ? content as Array<Record<string, unknown>> : [];
    return {
      index, role: message.role ?? null, id: message.id ?? null,
      types: Array.isArray(content) ? blocks.map((block) => block.type ?? typeof block) : typeof content,
      ids: blocks.map((block) => block.id ?? block.tool_use_id ?? null).filter((id) => id != null),
      chars: typeof content === "string" ? content.length : JSON.stringify(content ?? "").length,
    };
  });
}

async function explainContextMismatch(bodies: string[], checkout: string): Promise<Record<string, unknown>> {
  if (bodies.length < 2) return { error: "need two bodies", count: bodies.length };
  const finger = await import(pathToFileURL(join(checkout, "packages/commercial/src/http/proxy/boxCallFingerprint.ts")).href) as {
    deriveBoxContextHash: (body: unknown, completedToolTail?: boolean) => string;
  };
  const cache = await import(pathToFileURL(join(checkout, "packages/commercial/src/http/proxy/boxCacheAnnotations.ts")).href) as {
    normalizeBoxSemanticBody: (body: unknown) => { messages: unknown[]; metadata?: unknown; system?: unknown; tools?: unknown; model?: unknown; max_tokens?: unknown };
  };
  const first = JSON.parse(bodies[0]!) as { messages?: Array<Record<string, unknown>> };
  const second = JSON.parse(bodies[1]!) as { messages?: Array<Record<string, unknown>> };
  const firstHash = finger.deriveBoxContextHash(first);
  const prefixHash = finger.deriveBoxContextHash(second, true);
  const left = cache.normalizeBoxSemanticBody(first);
  const right = cache.normalizeBoxSemanticBody(second);
  const { metadata: leftMeta, ...leftModel } = left;
  const { metadata: rightMeta, messages: rightMessages, ...rightModel } = right;
  const prefix = { ...rightModel, messages: rightMessages.slice(0, -2) };
  const changes: Array<Record<string, unknown>> = [];
  walkDiff(leftModel, prefix, "$", changes, 40);
  const top = ["model", "max_tokens", "system", "tools", "thinking", "output_config", "tool_choice", "stream"] as const;
  const topLevel: Record<string, unknown> = {};
  for (const key of top) {
    const a = JSON.stringify((first as Record<string, unknown>)[key] ?? null);
    const b = JSON.stringify((second as Record<string, unknown>)[key] ?? null);
    topLevel[key] = a === b ? "same" : { first: a.slice(0, 180), second: b.slice(0, 180) };
  }
  return {
    firstHash, prefixHash, equal: firstHash === prefixHash,
    firstRoles: messageOutline(first),
    secondRoles: messageOutline(second),
    normalizedFirstCount: left.messages.length,
    normalizedPrefixCount: rightMessages.length - 2,
    topLevel, changes,
    metadataSame: JSON.stringify(leftMeta ?? null) === JSON.stringify(rightMeta ?? null),
  };
}

function classifyRequest(raw: string): { kind: string; reasons: string[] } {
  const reasons: string[] = [];
  if (raw.includes(SUMMARY_MARK)) reasons.push("idle-prompt-mark");
  if (raw.includes("continued from a previous conversation") || raw.includes("This session is being continued")) {
    reasons.push("stock-continuation-phrase");
  }
  let lastIsToolResult = false;
  try {
    const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
    const last = parsed.messages?.at(-1);
    const text = JSON.stringify(last?.content ?? "");
    lastIsToolResult = last?.role === "user" && text.includes("tool_result");
    if (lastIsToolResult) reasons.push("last-user-is-tool-result");
  } catch { reasons.push("unparsed"); }
  if (reasons.includes("idle-prompt-mark")) return { kind: "idle-summary", reasons };
  if (reasons.includes("stock-continuation-phrase") && !lastIsToolResult) return { kind: "stock-auto-summary", reasons };
  if (lastIsToolResult) return { kind: "live-continuation", reasons };
  reasons.push("ordinary-user");
  return { kind: "business", reasons };
}

function toolResultBytes(messages: Array<{ content?: unknown }>): number {
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!block || typeof block !== "object" || (block as { type?: string }).type !== "tool_result") continue;
      const content = (block as { content?: unknown }).content;
      total += typeof content === "string" ? content.length : JSON.stringify(content ?? "").length;
    }
  }
  return total;
}

function lastToolResult(messages: Array<{ content?: unknown }>): { id: string; content: unknown; isError: boolean } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const content = messages[index]?.content;
    if (!Array.isArray(content)) continue;
    for (let blockIndex = content.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = content[blockIndex] as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
        return { id: block.tool_use_id, content: block.content, isError: block.is_error === true };
      }
    }
  }
  return null;
}

function ndjson(rows: unknown[]): Buffer {
  return Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

function streamEvent(value: unknown): { type: string; event: unknown } {
  return { type: "stream_event", event: value };
}

function handoffChunk(id: string, boxName: string, input: Record<string, unknown>, initTools: string[] | null): Buffer {
  const usage = { input_tokens: 20, output_tokens: 0 };
  const use = { type: "tool_use", id, name: boxName, input };
  const rows: unknown[] = [];
  if (initTools) rows.push({ type: "system", subtype: "init", tools: initTools, mcp_servers: [{}] });
  rows.push(
    streamEvent({ type: "message_start", message: { id: `msg_${id}`, model: "claude-opus-5-5", role: "assistant", content: [], usage } }),
    streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: boxName, input: {} } }),
    streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } }),
    { type: "assistant", message: { id: `msg_${id}`, model: "claude-opus-5-5", role: "assistant", content: [use] } },
    streamEvent({ type: "content_block_stop", index: 0 }),
    streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 20, output_tokens: 4 } }),
    streamEvent({ type: "message_stop" }),
  );
  return ndjson(rows);
}

function echoChunk(id: string, content: unknown, isError: boolean): Buffer {
  const block: Record<string, unknown> = { type: "tool_result", tool_use_id: id, content };
  if (isError) block.is_error = true;
  return ndjson([{ type: "user", message: { role: "user", content: [block] } }]);
}

function prepareModelSpool(raw: string): void {
  const names = Array.from({ length: 0 });
  void names;
  let parsed: { messages?: Array<{ role?: string; content?: unknown }>; tools?: Array<{ name?: string }> } = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  const classified = classifyRequest(raw);
  const initTools = (() => {
    try {
      const count = parsed.tools?.length ?? 0;
      return Array.from({ length: count }, (_, index) => `mcp__ocbridge__t${index}`);
    } catch { return ["mcp__ocbridge__t0"]; }
  })();
  if (!growthActive || classified.kind === "idle-summary") {
    spoolBuf = textSpool(initTools);
    pendingStdout = null;
    return;
  }
  const bashIndex = (parsed.tools ?? []).findIndex((tool) => tool.name === "Bash");
  const size = toolResultBytes(parsed.messages ?? []);
  const prior = classified.kind === "live-continuation" ? lastToolResult(parsed.messages ?? []) : null;
  const finish = size >= GROW_TARGET || growthRound >= 60;
  if (bashIndex < 0 || finish) {
    const final = textSpool(prior ? [] : initTools);
    const echo = prior ? echoChunk(prior.id, prior.content, prior.isError) : Buffer.alloc(0);
    spoolBuf = prior ? Buffer.concat([spoolBuf, echo, stripInit(final)]) : final;
    pendingStdout = null;
    return;
  }
  growthRound += 1;
  const id = `toolu_grow_${growthRound}`;
  const input = { command: `python3 -c 'print("y"*${GROW_CHARS}, end="")'` };
  const boxName = `mcp__ocbridge__t${bashIndex}`;
  const chunk = handoffChunk(id, boxName, input, prior ? null : initTools);
  const echo = prior ? echoChunk(prior.id, prior.content, prior.isError) : Buffer.alloc(0);
  spoolBuf = prior ? Buffer.concat([spoolBuf, echo, chunk]) : chunk;
  pendingStdout = JSON.stringify({
    version: 1, modelToolUseId: id, mcpRequestId: growthRound,
    name: `t${bashIndex}`, arguments: input,
  });
}

function stripInit(buffer: Buffer): Buffer {
  const text = buffer.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline < 0 || !text.startsWith("{\"type\":\"system\"")) return buffer;
  return Buffer.from(text.slice(newline + 1));
}

function textSpool(tools: string[]): Buffer {
  const model = "claude-opus-5-5";
  const text = summaryRequested ? "outer-history-summary" : "DONE-6K";
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const rows = [
    { type: "system", subtype: "init", tools, mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_idle_6k", model, role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    { type: "assistant", message: { id: "msg_idle_6k", model, role: "assistant", content: [{ type: "text", text }] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 20, output_tokens: 4 } }),
    event({ type: "message_stop" }),
    { type: "result", subtype: "success", is_error: false, usage: { input_tokens: 20, output_tokens: 4 } },
  ];
  return Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

function makeLocalPythonExec(toolNames: () => string[]): {
  log: string[];
  unknowns: number;
  run: (request: { command: string; args: string[]; cwd?: string; environment?: Record<string, string> }) => Promise<{ stdout: string; stderrBytes: number; exitCode: 0 }>;
} {
  const log: string[] = [];
  let runNonce = "";
  let leaseEpoch = "";
  return {
    log,
    unknowns: 0,
    async run(request) {
      if (request.command !== "/usr/bin/python3" || request.args[0] !== "-I") {
        throw new Error(`BOX_TEST_EXEC_NOT_PYTHON ${request.command} ${request.args[0] ?? ""}`);
      }
      const args = request.args;
      const script = args[2] ?? "";
      if (args[1] === "-c" && script.includes("sys.argv=[p,*argv]") && (args[3] ?? "").startsWith("/tmp/ocv5-289-v2-detached-runner-") && args[5] !== "--read") {
        log.push("synthetic-launch");
        return { stdout: "launched\n", stderrBytes: 0, exitCode: 0 as const };
      }
      if (args[5] === "--read") {
        log.push("synthetic-spool");
        const offset = Number(args[7] ?? 0);
        const source = spoolBuf.length > 0 ? spoolBuf : textSpool(toolNames());
        const start = Math.min(Number.isFinite(offset) ? offset : 0, source.length);
        const part = source.subarray(start);
        return { stdout: JSON.stringify({ data: part.toString("base64"), offset: start + part.length }), stderrBytes: 0, exitCode: 0 as const };
      }
      if (script.includes("pending.") && pendingStdout) {
        log.push("synthetic-pending");
        return { stdout: pendingStdout, stderrBytes: 0, exitCode: 0 as const };
      }
      if (script.includes("terminal.json")) {
        log.push("synthetic-terminal-proof");
        return { stdout: JSON.stringify({ runNonce, leaseEpoch, keeperPid: 1, cliPid: 2, reason: "worker_complete", revision: 1 }) + "\n", stderrBytes: 0, exitCode: 0 as const };
      }
      log.push("python");
      const ran = spawnSync(request.command, request.args, {
        cwd: request.cwd && existsSync(request.cwd) ? request.cwd : "/tmp",
        env: { ...process.env, ...request.environment },
        encoding: "utf8",
        timeout: 20_000,
      });
      if (ran.status !== 0) throw new Error((ran.stderr || ran.stdout || `python exit ${ran.status}`).slice(0, 500));
      if (script.includes("identity['identityHash']")) {
        const parsed = JSON.parse(ran.stdout) as { runNonce?: string; leaseEpoch?: string };
        runNonce = parsed.runNonce ?? runNonce;
        leaseEpoch = parsed.leaseEpoch ?? leaseEpoch;
        log.push("python-prelaunch");
      }
      return { stdout: ran.stdout ?? "", stderrBytes: Buffer.byteLength(ran.stderr ?? ""), exitCode: 0 as const };
    },
  };
}

function listJson(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    let names: string[] = [];
    try { names = readdirSync(current); } catch { return; }
    for (const name of names) {
      const path = join(current, name);
      if (name.endsWith(".json")) out.push(path);
      else walk(path);
    }
  };
  walk(dir);
  return out;
}

function sse(text: string): Response {
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_idle", type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 4 } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ];
  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const enc = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function execStage(plan: {
  cwd: string; snapshotHash: string | null; stageInputs: readonly Array<{ command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv }>;
  run: { command: string; args: string[] }; cleanup: { command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv };
}): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ocv5-296-idle-stage-"));
  const from = "/home/box/.claude/projects";
  const runKey = JSON.stringify([plan.run.command, plan.run.args]);
  try {
    for (const step of [...plan.stageInputs, plan.cleanup]) {
      if (JSON.stringify([step.command, step.args]) === runKey) throw new Error("refusing inner claude exec");
      if (step.command !== "/usr/bin/python3") throw new Error(`refusing ${step.command}`);
      await new Promise<void>((resolveStep, reject) => {
        const child: ChildProcess = spawn(step.command, step.args.map((arg) => arg.replaceAll(from, root)), {
          cwd: step.cwd, env: step.environment,
        });
        let stderr = "";
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", (chunk) => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", (code) => code === 0 ? resolveStep() : reject(new Error((stderr || `exit ${code}`).slice(0, 400))));
      });
    }
  } finally {
    rmSync(plan.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}

function signAuthority(protocol: {
  MODEL_AUTHORITY_VERSION: number; AUTHORITY_TTL_MS: number;
  authoritySigningInput: (payload: unknown) => Uint8Array;
  encodeAuthorityEnvelope: (payload: unknown, sig: Buffer) => string;
  turnLeaseSigningInput: (lease: unknown) => Uint8Array;
  encodeTurnLeaseEnvelope: (lease: unknown, sig: Buffer) => string;
}, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], keyId: string): { authority: string; lease: string } {
  const now = Date.now();
  const expiresAt = now + protocol.AUTHORITY_TTL_MS;
  const payload = {
    v: protocol.MODEL_AUTHORITY_VERSION, keyId, uid: 3, containerId: 7,
    authorityTurnId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", connectionChallenge: "chal-idle",
    canonicalModel: MODEL, engine: "ccb",
    executionDescriptor: {
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: false, contextOwner: "box-native-v1" },
      },
      capabilitySchemaVersion: 1, contextWindow: 200_000, supportedEfforts: [], supportsVision: false,
    },
    executionRevision: "b".repeat(64), securityEpoch: 12,
    issuedAt: expiresAt - protocol.AUTHORITY_TTL_MS, expiresAt,
  };
  const lease = {
    v: protocol.MODEL_AUTHORITY_VERSION, keyId, uid: 3, containerId: 7,
    authorityTurnId: payload.authorityTurnId, canonicalModel: MODEL, securityEpoch: 12,
    connectionChallenge: "chal-idle", issuedAt: now - 60_000, expiresAt: now + 30 * 60_000,
  };
  return {
    authority: protocol.encodeAuthorityEnvelope(payload, cryptoSign(null, protocol.authoritySigningInput(payload), privateKey)),
    lease: protocol.encodeTurnLeaseEnvelope(lease, cryptoSign(null, protocol.turnLeaseSigningInput(lease), privateKey)),
  };
}
