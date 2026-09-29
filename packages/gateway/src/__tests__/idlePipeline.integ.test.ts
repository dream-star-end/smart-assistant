/**
 * OCV5-296 idle chain. Real SessionManager.submit, real CcbAdapter,
 * real SubprocessRunner, and this checkout's claude-code-best entry.
 * The proxy is a git-archive candidate with only route-ready flipped true.
 * Synthetic bytes are the model SSE after the real plan/stage/journal.
 * The node -e header adapter is not this test.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
const MAX_HTTP = 8;
const TEST_DB = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const SCHEMA = `ocv5_296_idle_${randomBytes(3).toString("hex")}`;
const REDIS_URL = "redis://127.0.0.1:56379/12";

test("real submit reaches a short idle no-op without a summary HTTP", { timeout: 180_000 }, async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const keyId = "mak1_testkey00000001";
  const keyring = new Map<string, Uint8Array>([[keyId, new Uint8Array(publicRaw)]]);
  const hits: Array<{ url: string; status: number; bytes: number; summary: boolean; body?: string }> = [];
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
      const write = res.write.bind(res);
      const end = res.end.bind(res);
      res.write = ((chunk: string | Uint8Array) => {
        responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        return write(chunk);
      }) as typeof res.write;
      res.end = ((chunk?: string | Uint8Array) => {
        if (chunk != null) responseBody += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
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
      await handler(replay, res, { hostUuid: "ocv5-296-idle", boundIp: "127.0.0.1" });
      hits.push({
        url: path, status: res.statusCode, bytes: raw.length,
        summary: raw.includes(SUMMARY_MARK), body: responseBody.slice(0, 400),
        shape,
      });
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
    const short = (report.nativeFiles as Array<{ applied?: boolean; summaryText?: string }>).some((file) => file.applied && !file.summaryText);
    assert.equal(short, true, JSON.stringify(report.nativeFiles));
    const beforeSecond = hits.length;
    await sm.submit(session, "ordinary next", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
    const added = hits.slice(beforeSecond);
    report.secondHits = added;
    assert.equal(added.some((hit) => hit.summary), false);
    assert.equal(added.some((hit) => hit.url === "/v1/messages" && hit.status === 200), true);
  } finally {
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

function textSpool(tools: string[]): Buffer {
  const model = "claude-opus-5-5";
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const rows = [
    { type: "system", subtype: "init", tools, mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_idle_6k", model, role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    event({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "DONE-6K" } }),
    { type: "assistant", message: { id: "msg_idle_6k", model, role: "assistant", content: [{ type: "text", text: "DONE-6K" }] } },
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
  let spool = textSpool(["mcp__ocbridge__t0"]);
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
        if (offset === 0 && toolNames().length > 0) spool = textSpool(toolNames());
        const part = spool.subarray(Math.min(Number.isFinite(offset) ? offset : 0, spool.length));
        return { stdout: JSON.stringify({ data: part.toString("base64"), offset: (Number.isFinite(offset) ? offset : 0) + part.length }), stderrBytes: 0, exitCode: 0 as const };
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
