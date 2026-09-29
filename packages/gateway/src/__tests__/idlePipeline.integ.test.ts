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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IDLE_COMPACT_PROMPT, assembleIdleArtifact, writeIdleCandidate, writeIdleNative } from "../boxIdleCompact.js";
import { _setModelCatalogClientForTests } from "../modelCatalogClient.js";

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
const CATALOG_SECRET = "a".repeat(64);
const CATALOG_TOKEN = `oc-v3.7.${CATALOG_SECRET}`;
const PROJECTION_OK = "d".repeat(64);
const READY_FALSE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = false;";
const READY_TRUE = "export const BOX_NATIVE_CONTEXT_ROUTE_READY = true;";
const SUMMARY_MARK = "preserve the user goal, decisions, constraints";
const MAX_HTTP = 80;
const GROW_CHARS = 180_000;
const GROW_TARGET = 8_860_467;
let summaryRequested = false;
let growthActive = false;
let growthRound = 0;
let growthStopRound = 60;
let growthTarget = GROW_TARGET;
let toolsPerRound = 1;
let growthChars = GROW_CHARS;
let executionLogPath = "";
let growthBodyPrefix = "ocv5-296-r19-live";
let largestGrowthRequest = "";
let spoolBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
const pendingById = new Map<string, string>();
let mcpSerial = 0;
const growthBodies: string[] = [];
const TEST_DB = "postgres://test:test@127.0.0.1:55432/openclaude_test";
const SCHEMA = `ocv5_296_idle_${randomBytes(3).toString("hex")}`;
const REDIS_URL = "redis://127.0.0.1:56379/12";

type LocalClaims = { v: number; kind: string; securityEpoch: string; projectionRevision: string };
type CredentialProof = {
  hasAuthority: boolean;
  hasLease: boolean;
  hasLocal: boolean;
  localSha256: string | null;
  claims: LocalClaims | null;
  claimsError: string | null;
  ocTurnKey: string | null;
};

function headerOne(headers: IncomingHttpHeaders, name: string): { value: string | null; duplicate: boolean } {
  const raw = headers[name];
  if (Array.isArray(raw)) return { value: null, duplicate: raw.length > 0 };
  if (typeof raw === "string" && raw.trim() !== "") return { value: raw.trim(), duplicate: false };
  return { value: null, duplicate: false };
}

function credentialProof(headers: IncomingHttpHeaders, raw: string): CredentialProof {
  const authority = headerOne(headers, "x-oc-model-authority");
  const lease = headerOne(headers, "x-oc-turn-lease");
  const local = headerOne(headers, "x-oc-local-catalog");
  let claims: LocalClaims | null = null;
  let claimsError: string | null = null;
  if (local.duplicate) claimsError = "duplicate-local-header";
  else if (local.value) {
    try {
      const decoded = JSON.parse(Buffer.from(local.value, "base64url").toString("utf8")) as Partial<LocalClaims>;
      claims = {
        v: Number(decoded.v),
        kind: String(decoded.kind),
        securityEpoch: String(decoded.securityEpoch),
        projectionRevision: String(decoded.projectionRevision),
      };
    } catch (error) {
      claimsError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    hasAuthority: authority.duplicate || authority.value !== null,
    hasLease: lease.duplicate || lease.value !== null,
    hasLocal: local.duplicate || local.value !== null,
    localSha256: local.value ? createHash("sha256").update(local.value).digest("hex") : null,
    claims,
    claimsError,
    ocTurnKey: ocTurnKeyOf(raw),
  };
}

function ocTurnKeyOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { metadata?: { user_id?: unknown }; oc_turn_key?: unknown };
    if (typeof parsed.oc_turn_key === "string") return parsed.oc_turn_key;
    const userId = parsed.metadata?.user_id;
    const meta = typeof userId === "string"
      ? JSON.parse(userId) as { oc_turn_key?: unknown }
      : userId as { oc_turn_key?: unknown } | undefined;
    return typeof meta?.oc_turn_key === "string" ? meta.oc_turn_key : null;
  } catch {
    return null;
  }
}

function resetCatalogClient(dropLkg: boolean): void {
  _setModelCatalogClientForTests(null);
  if (dropLkg) rmSync(join(HOME, "model-catalog-lkg.json"), { force: true });
}

function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

async function runIdleCase(mode: "short" | "fresh" | "live2" | "grow2" | "localAuth" | "seam"): Promise<void> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
  const keyId = "mak1_testkey00000001";
  const keyring = new Map<string, Uint8Array>([[keyId, new Uint8Array(publicRaw)]]);
  const hits: Array<{ url: string; status: number; bytes: number; summary: boolean; body?: string; keptPrefix?: boolean; shape?: unknown; digest?: unknown; kind?: string; reasons?: string[]; requestId?: string; mentions?: { leaf: boolean; next: boolean; idle: boolean }; cred?: CredentialProof }> = [];
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
  let restoreLocalAuth: (() => void) | undefined;
  const report: Record<string, unknown> = { schema: SCHEMA, redis: REDIS_URL, checkout: CHECKOUT };
  let holdNextSettlement = false;
  let holdSummaryCommit = false;
  let summaryResponseEnded = false;
  let preIdleCaptured = false;
  const heldRequestIds: string[] = [];
  const heldCommits: Array<() => void> = [];
  const releaseHeldCommits = () => {
    const pending = heldCommits.splice(0);
    for (const resume of pending) resume();
  };
  try {
    mkdirSync(HOME, { recursive: true });
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
      connectionString: TEST_DB, max: 4, application_name: "ocv5-296-idle",
      options: `-c search_path=${SCHEMA}`,
    });
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, enableReadyCheck: true });
    adminEnd = () => admin.end();
    poolEnd = () => pool.end();
    const connect = pool.connect.bind(pool);
    const wrapClient = (client: { query: (...args: never[]) => unknown }) => {
      const query = client.query.bind(client);
      let sawUsageInsert = false;
      let sawJournalWrite = false;
      let usageRequestId = "";
      client.query = ((a: unknown, b?: unknown, c?: unknown) => {
        const text = typeof a === "string"
          ? a
          : a && typeof a === "object" && "text" in a ? String((a as { text?: unknown }).text ?? "") : "";
        const verb = text.trim().toUpperCase();
        if (verb.startsWith("BEGIN")) {
          sawUsageInsert = false;
          sawJournalWrite = false;
          usageRequestId = "";
        }
        if (/INSERT\s+INTO\s+usage_records/i.test(text)) {
          sawUsageInsert = true;
          const values = Array.isArray(b)
            ? b
            : a && typeof a === "object" && "values" in a && Array.isArray((a as { values?: unknown }).values)
              ? (a as { values: unknown[] }).values
              : [];
          if (typeof values[13] === "string") usageRequestId = values[13];
        }
        if (/(INSERT|UPDATE)\s+/i.test(text) && /request_finalize_journal/i.test(text)) sawJournalWrite = true;
        const run = () => c !== undefined ? query(a as never, b as never, c as never)
          : b !== undefined ? query(a as never, b as never)
          : query(a as never);
        if (verb.startsWith("COMMIT") && holdNextSettlement && summaryResponseEnded && (sawUsageInsert || sawJournalWrite)) {
          holdNextSettlement = false;
          if (usageRequestId) heldRequestIds.push(usageRequestId);
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
    redisQuit = async () => {
      try {
        await redis.del("precheck:u:{3}:locks", "precheck:u:{3}:amounts");
      } catch (error) {
        cleanupErrors.push(`redis-del: ${error instanceof Error ? error.message : String(error)}`);
      }
      await redis.quit();
    };
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
    const projectionRow = () => ({
      modelId: MODEL, displayName: "Box", engine: "ccb" as const, providerId: "box_cli",
      contextWindow: 200_000, supportedEfforts: [] as string[], supportsVision: false,
      capabilityZero: true, supportsThinking: false, defaultEffort: null as string | null, sortOrder: 0,
    });
    // Egress fence stays on this object. Catalog HTTP uses it too, except the
    // three negative faults, which diverge on purpose.
    const proxySnapshot = {
      securityEpoch: 12n, executionRevision: "b".repeat(64), billingRevision: "c".repeat(64),
      aliasToCanonical: (model: string) => model,
      resolve: (model: string) => (model === MODEL ? descriptor : null),
      canUseModel: () => true,
      billingPricingFor: (model: string) => (model === MODEL ? pricing : null),
      projectionRevisionFor: () => PROJECTION_OK,
      listForUser: () => [projectionRow()],
      aliasesForUser: () => ({} as Record<string, string>),
    };
    let catalogFault: "none" | "epoch" | "projection" | "model" = "none";
    const catalogSnapshot = () => {
      if (catalogFault === "epoch") return { ...proxySnapshot, securityEpoch: 99n };
      if (catalogFault === "projection") return { ...proxySnapshot, projectionRevisionFor: () => "e".repeat(64) };
      if (catalogFault === "model") return { ...proxySnapshot, listForUser: () => [] as Array<ReturnType<typeof projectionRow>> };
      return proxySnapshot;
    };
    const catalog = { async assertFresh() { return proxySnapshot; } };
    let catalogGets = 0;
    let epochGets = 0;
    let localAuthBodyPath = "";
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
    const proof = candidateProof.makeBoxIdleProofHandler({
      identity, journal,
      readCapsule: (pointer: { sha256: string; bytes: number }) => replayMod.readBoxReplayMessage(replayDir, pointer),
    });
    const catalogHttp = await import(pathToFileURL(join(CHECKOUT, "packages/commercial/src/http/internalModelCatalog.ts")).href);
    const identityMod = await import(pathToFileURL(join(CHECKOUT, "packages/commercial/src/auth/containerIdentity.ts")).href);
    const catalogHandler = catalogHttp.makeModelCatalogHandler({
      identityRepo: {
        async findActiveByHostAndBoundIp(hostUuid: string, boundIp: string) {
          if (hostUuid !== "ocv5-296-idle" || boundIp !== "127.0.0.1") return null;
          return {
            id: 7, user_id: 3, bound_ip: boundIp, host_uuid: hostUuid,
            secret_hash: identityMod.hashSecret(CATALOG_SECRET),
          };
        },
      },
      catalog: { async assertFresh() { return catalogSnapshot(); } },
      loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set<string>() }),
      readEpoch: async () => catalogSnapshot().securityEpoch,
      loadRoutingAvailability: async () => ({ unavailableProviderIds: new Set<string>(), revision: "availability-idle" }),
    } as never);
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
          if (current.summary && (res.statusCode || 0) > 0) summaryResponseEnded = true;
        }
        return end(chunk as never);
      }) as typeof res.end;
      const replay = Readable.from([raw]) as IncomingMessage;
      replay.method = req.method;
      replay.url = req.url;
      replay.headers = req.headers;
      const path = (req.url ?? "").split("?")[0];
      if (path === catalogHttp.MODEL_CATALOG_PATH || path === catalogHttp.MODEL_CATALOG_EPOCH_PATH) {
        if (path === catalogHttp.MODEL_CATALOG_EPOCH_PATH) epochGets += 1;
        else catalogGets += 1;
        await catalogHandler(replay, res, { hostUuid: "ocv5-296-idle", boundIp: "127.0.0.1" });
        return;
      }
      if (path === "/internal/v3/marketplace/sync") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ identityCompat: { schema: 1, userId: "3", profiles: [] } }));
        return;
      }
      if (path === "/internal/box/idle-proof") {
        await proof(replay, res, { hostUuid: "ocv5-296-idle", boundIp: "127.0.0.1" });
        hits.push({ url: path, status: res.statusCode, bytes: raw.length, summary: false, body: responseBody.slice(0, 4000) });
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
      const text = raw.toString("utf8");
      if (growthActive && text.length >= largestGrowthRequest.length) largestGrowthRequest = text;
      if (growthActive && growthBodies.length < 3) {
        growthBodies.push(text);
        const rawDir = process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir();
        const bodyName = `${growthBodyPrefix}-${growthBodies.length}.json`;
        if (bodyName.includes("r17-growth")) throw new Error("refusing to overwrite r17");
        writeFileSync(join(rawDir, bodyName), text);
      }
      if (mode === "localAuth" && summaryRequested && !localAuthBodyPath) {
        const rawDir = process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir();
        localAuthBodyPath = join(rawDir, "ocv5-296-idle-local-catalog-request.json");
        writeFileSync(localAuthBodyPath, text);
      }
      if (summaryRequested && (mode === "grow2" || mode === "seam") && !preIdleCaptured) {
        preIdleCaptured = true;
        const stageLabel = mode === "grow2" ? "r22" : "seam";
        report.preIdle = capturePreIdleTranscript(stageLabel);
        report.stageAtSummary = copyStage(`${stageLabel}-summary`);
      }
      if (holdSummaryCommit && summaryRequested) {
        holdNextSettlement = true;
        holdSummaryCommit = false;
        report.summaryCommitHeld = true;
      }
      current = {
        url: path, status: 0, bytes: raw.length,
        summary: summaryRequested, keptPrefix: raw.includes("OCV5296_OLD_PREFIX"), shape,
        cred: credentialProof(req.headers, text),
        digest, kind: classified.kind, reasons: classified.reasons,
        mentions: { leaf: text.includes("ordinary leaf"), next: text.includes("ordinary next"), idle: text.includes(SUMMARY_MARK) },
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
    const adapterConfig = {
      version: 1,
      gateway: { bind: "127.0.0.1", port: 0, accessToken: "" },
      auth: { mode: "subscription", claudeCodePath: join(candidate, "claude-code-best"), claudeCodeEntry: "src/entrypoints/cli.tsx", claudeCodeRuntime: "bun" },
      terminal: { type: "local" },
      sessions: { dbPath: join(HOME, "sessions.db") },
      defaults: { permissionMode: "bypassPermissions" },
    } as never;
    report.case = mode;
    report.liveGrowthNotRun = { reason: "not the 45-round chain", targetBytes: GROW_TARGET };
    const armCatalog = (disableAutoCompact: boolean) => {
      const previousFlag = process.env.OC_MODEL_AUTHORITY;
      const previousAuto = process.env.DISABLE_AUTO_COMPACT;
      const previousToken = process.env.OPENCLAUDE_V3_CONTAINER_TOKEN;
      process.env.OC_MODEL_AUTHORITY = "1";
      if (disableAutoCompact) process.env.DISABLE_AUTO_COMPACT = "1";
      process.env.OPENCLAUDE_V3_CONTAINER_TOKEN = CATALOG_TOKEN;
      restoreLocalAuth = () => {
        restoreEnv("OC_MODEL_AUTHORITY", previousFlag);
        restoreEnv("DISABLE_AUTO_COMPACT", previousAuto);
        restoreEnv("OPENCLAUDE_V3_CONTAINER_TOKEN", previousToken);
        _setModelCatalogClientForTests(null);
      };
      resetCatalogClient(true);
    };
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
    if (mode === "short") {
    const adapter = new CcbAdapter({
      sessionKey: "agent:main:webchat:dm:idle-peer",
      agentId: "main",
      agentBaseDir: work,
      config: adapterConfig,
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

    } else if (mode === "fresh") {
      const seeded = seedOuterHistory(process.env.CLAUDE_CONFIG_DIR!, work);
      report.seededBytes = seeded.bytes;
      const freshKey = "agent:main:webchat:dm:idle-fresh-r18";
      const freshAdapter = new CcbAdapter({
        sessionKey: freshKey,
        agentId: "main",
        agentBaseDir: work,
        resumeSessionId: seeded.sessionId,
        config: adapterConfig,
        model: MODEL,
        permissionMode: "bypassPermissions",
        harness: "ccb",
        executionTarget: { kind: "local" },
      });
      adapterShutdown = () => freshAdapter.shutdown();
      const freshSession = {
        sessionKey: freshKey,
        agentId: "main",
        channel: "webchat",
        peerId: "idle-fresh-r18",
        title: "Idle",
        startedAt: Date.now(),
        runner: freshAdapter,
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
      holdNextSettlement = true;
      const beforeFresh = hits.length;
      let freshError = "";
      try {
        await sm.submit(freshSession, "ordinary leaf", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
      } catch (error) {
        freshError = error instanceof Error ? error.message : String(error);
      }
      const freshHits = hits.slice(beforeFresh).filter((hit) => hit.url === "/v1/messages");
      report.freshError = freshError || null;
      report.freshHits = freshHits.map((hit) => ({
        status: hit.status, bytes: hit.bytes, kind: hit.kind, reasons: hit.reasons,
        requestId: hit.requestId, summary: hit.summary, digest: hit.digest,
      }));
      const okHits = freshHits.filter((hit) => hit.status === 200);
      const stock = okHits.filter((hit) => hit.kind === "stock-auto-summary");
      const large = okHits.filter((hit) => ((hit.digest as { contentBytes?: number } | undefined)?.contentBytes ?? 0) >= 7_000_000);
      if (freshError || stock.length !== 1 || large.length !== 1 || okHits.length !== 2 || stock[0]?.requestId === large[0]?.requestId) {
        throw new Error(`fresh roots not established: ${freshError || "shape"} hits=${JSON.stringify(report.freshHits).slice(0, 1500)}`);
      }
      assert.equal(okHits.some((hit) => hit.summary || hit.kind === "idle-summary"), false);
      const freshIds = okHits.map((hit) => hit.requestId).filter((id): id is string => Boolean(id));
      assert.equal(new Set(freshIds).size, 2, JSON.stringify(freshIds));
      assert.equal(heldRequestIds.length, 1, JSON.stringify(heldRequestIds));
      const heldId = heldRequestIds[0]!;
      assert.equal(freshIds.includes(heldId), true, heldId);
      const candidateFile = join(HOME, "idle-candidates", `${encodeURIComponent(freshKey)}.json`);
      assert.equal(existsSync(candidateFile), true);
      const usageHidden = await pool.query<{ request_id: string }>(
        "SELECT request_id FROM usage_records WHERE request_id = $1 OR request_id = $2",
        [freshIds[0], freshIds[1]]);
      const journalHidden = await pool.query<{ request_id: string; state: string }>(
        "SELECT request_id, state FROM request_finalize_journal WHERE request_id = $1 OR request_id = $2",
        [freshIds[0], freshIds[1]]);
      report.heldVisibility = { heldId, usage: usageHidden.rows, journal: journalHidden.rows };
      for (const id of freshIds) {
        assert.equal(usageHidden.rows.some((row) => row.request_id === id), false, id);
        const state = journalHidden.rows.find((row) => row.request_id === id)?.state;
        assert.notEqual(state, "committed", id);
      }
      const creditsHeld = BigInt((await pool.query("SELECT credits::text AS credits FROM users WHERE id = 3")).rows[0].credits);
      assert.equal(creditsHeld, 50_000_000n);
      const blockedAt = hits.filter((hit) => hit.url === "/v1/messages").length;
      let blockedError = "";
      try {
        await sm.submit(freshSession, "blocked-user", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
      } catch (error) {
        blockedError = error instanceof Error ? error.message : String(error);
      }
      report.blockedError = blockedError;
      assert.equal(blockedError.includes("IDLE_HISTORY_PENDING"), true, blockedError);
      assert.equal(hits.filter((hit) => hit.url === "/v1/messages").length, blockedAt);
      assert.equal(existsSync(candidateFile), true);
      releaseHeldCommits();
      let settled = false;
      for (let attempt = 0; attempt < 80 && !settled; attempt += 1) {
        const rows = await pool.query<{ request_id: string; state: string }>(
          "SELECT request_id, state FROM request_finalize_journal WHERE request_id = $1 OR request_id = $2",
          [freshIds[0], freshIds[1]]);
        const usage = await pool.query<{ request_id: string }>(
          "SELECT request_id FROM usage_records WHERE request_id = $1 OR request_id = $2",
          [freshIds[0], freshIds[1]]);
        settled = freshIds.every((id) => rows.rows.some((row) => row.request_id === id && row.state === "committed"))
          && freshIds.every((id) => usage.rows.some((row) => row.request_id === id));
        if (!settled) await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(settled, true, "held request ids did not become committed usage");
      const beforeNext = hits.length;
      await sm.submit(freshSession, "ordinary next", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
      const nextHits = hits.slice(beforeNext);
      const nextModel = nextHits.filter((hit) => hit.url === "/v1/messages");
      report.nextHits = nextModel.map((hit) => ({
        status: hit.status, bytes: hit.bytes, kind: hit.kind, reasons: hit.reasons, summary: hit.summary,
        requestId: hit.requestId, mentions: hit.mentions,
        last: (hit.digest as { last?: string } | undefined)?.last ?? null,
      }));
      assert.equal(nextModel.some((hit) => hit.summary || hit.kind === "idle-summary" || hit.mentions?.idle), false, JSON.stringify(report.nextHits));
      const nextBusiness = nextModel.filter((hit) => hit.status === 200 && hit.mentions?.next === true && hit.kind !== "idle-summary");
      assert.equal(nextBusiness.length, 1, JSON.stringify(report.nextHits));
      assert.equal(freshIds.includes(nextBusiness[0]!.requestId ?? ""), false);
      assert.equal(existsSync(candidateFile), false);
      const nativeRows = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8"))) as Array<{ applied?: boolean; summaryText?: string; sessionId?: string }>;
      const ops = listJson(join(HOME, "idle-ops")).map((file) => JSON.parse(readFileSync(file, "utf8"))) as Array<{ disposition?: string; summaryText?: string; sourceSessionId?: string }>;
      report.nativeFiles = nativeRows;
      report.opFiles = ops;
      assert.equal(nativeRows.some((file) => file.sessionId === seeded.sessionId && file.applied === true && !file.summaryText), true, JSON.stringify(nativeRows));
      assert.equal(ops.some((op) => op.sourceSessionId === seeded.sessionId && op.disposition === "short" && !op.summaryText), true, JSON.stringify(ops));
      const proofs = nextHits.filter((hit) => hit.url === "/internal/box/idle-proof" && hit.status === 200).map((hit) => {
        try { return JSON.parse(hit.body ?? "") as Record<string, unknown>; } catch { return { parse: false as const }; }
      });
      report.proofs = proofs;
      const ready = proofs.filter((proof) => proof.status === "terminal_set");
      assert.equal(ready.length >= 1, true, JSON.stringify(proofs));
      for (const proof of ready) {
        assert.equal("summaryText" in proof, false);
        assert.equal("capsuleSha256" in proof, false);
        assert.equal("requestId" in proof, false);
        assert.deepEqual([...(proof.requestIds as string[])].sort(), [...freshIds].sort());
      }
      const books = await pool.query<{ request_id: string; turn_key: string; ledger_id: string; delta: string; balance_after: string }>(
        `SELECT u.request_id, u.turn_key, l.id::text AS ledger_id, l.delta::text, l.balance_after::text
           FROM usage_records u JOIN credit_ledger l ON l.id = u.ledger_id
          WHERE u.user_id = 3 ORDER BY l.id`);
      report.ledgers = books.rows;
      assert.equal(new Set(books.rows.map((row) => row.request_id)).size, books.rows.length);
      assert.equal(new Set(books.rows.map((row) => row.ledger_id)).size, books.rows.length);
      const freshBooks = books.rows.filter((row) => freshIds.includes(row.request_id));
      assert.equal(freshBooks.length, 2, JSON.stringify(books.rows));
      assert.equal(freshBooks[0]!.turn_key, freshBooks[1]!.turn_key);
      assert.notEqual(freshBooks[0]!.request_id, freshBooks[1]!.request_id);
      assert.ok(BigInt(freshBooks[0]!.delta) < 0n && BigInt(freshBooks[1]!.delta) < 0n);
      const nextBooks = books.rows.filter((row) => !freshIds.includes(row.request_id));
      assert.equal(nextBooks.length, 1);
      assert.notEqual(nextBooks[0]!.turn_key, freshBooks[0]!.turn_key);
      let running = 50_000_000n;
      for (const row of books.rows) {
        running += BigInt(row.delta);
        assert.equal(BigInt(row.balance_after), running, row.ledger_id);
      }
      const credits = BigInt((await pool.query("SELECT credits::text AS credits FROM users WHERE id = 3")).rows[0].credits);
      report.credits = { after: credits.toString(), ledgerSum: (running - 50_000_000n).toString() };
      assert.equal(credits, running);
      const journals = await pool.query<{ request_id: string; state: string; turn_key: string; owner: string | null; resume: string | null; box_state: string }>(
        `SELECT request_id, state, ctx->>'boxTurnKey' AS turn_key, ctx->>'boxOwnerRequestId' AS owner,
                ctx->>'boxResumeRequestId' AS resume, ctx->>'boxState' AS box_state
           FROM request_finalize_journal WHERE request_id = $1 OR request_id = $2`,
        [freshIds[0], freshIds[1]]);
      report.freshJournal = journals.rows;
      assert.equal(journals.rows.length, 2);
      for (const row of journals.rows) {
        assert.equal(row.state, "committed");
        assert.equal(row.owner, null);
        assert.equal(row.resume, null);
        assert.equal(row.box_state, "terminal");
        assert.equal(row.turn_key, freshBooks[0]!.turn_key);
      }
    } else if (mode === "localAuth") {
      armCatalog(true);
      report.liveChainProof = false;
      report.authFixture = "OC_MODEL_AUTHORITY=1; real catalog handler; egress snapshot unchanged except negative faults";
      const sourceKey = "agent:main:webchat:dm:idle-auth-source";
      const sourceAdapter = new CcbAdapter({
        sessionKey: sourceKey, agentId: "main", agentBaseDir: work, config: adapterConfig,
        model: MODEL, permissionMode: "bypassPermissions", harness: "ccb", executionTarget: { kind: "local" },
      });
      const sourceSession = {
        sessionKey: sourceKey, agentId: "main", channel: "webchat", peerId: "idle-auth-source",
        title: "Idle", startedAt: Date.now(), runner: sourceAdapter, model: MODEL, lock: Promise.resolve(),
        lastUsedAt: 0, totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0, turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
        executionTarget: { kind: "local" }, providerTag: "ccb",
      } as never;
      adapterShutdown = () => sourceAdapter.shutdown();
      await sm.submit(sourceSession, "c".repeat(6000), onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
      const sourceHit = hits.find((hit) => hit.url === "/v1/messages");
      report.sourceCred = sourceHit?.cred ?? null;
      report.sourceStatus = sourceHit?.status ?? null;
      if (!sourceHit || sourceHit.status !== 200 || !sourceHit.cred?.hasAuthority || !sourceHit.cred.hasLease || sourceHit.cred.hasLocal) {
        throw new Error(`source authority contract failed status=${sourceHit?.status ?? "missing"} cred=${JSON.stringify(sourceHit?.cred ?? null)}`);
      }
      await sourceAdapter.shutdown();
      const seeded = seedOuterHistory(process.env.CLAUDE_CONFIG_DIR!, work, { rounds: 8, marker: "OCV5296_AUTH_SEED" });
      assert.ok(seeded.bytes >= 700_000, `synthetic seed ${seeded.bytes} is under the idle floor`);
      const seedFile = join(seeded.project, `${seeded.sessionId}.jsonl`);
      const seedBytes = readFileSync(seedFile);
      const seedCopy = join(process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir(), "ocv5-296-pre-idle-local-auth-seed.jsonl");
      writeFileSync(seedCopy, seedBytes);
      const revision = createHash("sha256").update(`ocv5-296-local-auth:${seeded.sessionId}`).digest("hex");
      const idleKey = "agent:main:webchat:dm:idle-auth-idle";
      const idleTurnKey = createHash("sha256").update(`${idleKey}:${revision}`).digest("hex");
      writeIdleNative(HOME, {
        v: 1, opId: idleTurnKey, revision, sessionId: seeded.sessionId, modelCalls: 0, frozenTail: [], attachments: [],
      });
      report.preIdle = {
        synthetic: true, notLiveChain: true, seedBytes: seedBytes.length,
        seedSha256: createHash("sha256").update(seedBytes).digest("hex"), seedCopy,
        sessionId: seeded.sessionId, idleTurnKey, revision,
      };
      const idleAdapter = new CcbAdapter({
        sessionKey: idleKey, agentId: "main", agentBaseDir: work, resumeSessionId: seeded.sessionId,
        config: adapterConfig, model: MODEL, permissionMode: "bypassPermissions", harness: "ccb",
        executionTarget: { kind: "local" },
      });
      adapterShutdown = () => idleAdapter.shutdown();
      const idleSession = {
        sessionKey: idleKey, agentId: "main", channel: "webchat", peerId: "idle-auth-idle",
        title: "Idle", startedAt: Date.now(), runner: idleAdapter, model: MODEL, lock: Promise.resolve(),
        lastUsedAt: 0, totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0, turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
        executionTarget: { kind: "local" }, providerTag: "ccb",
      } as never;
      const beforeIdle = hits.length;
      const idleRun = idleAdapter.submitTurn({
        input: IDLE_COMPACT_PROMPT, turnKey: idleTurnKey, onEvent, sessionTotals: idleSession, toolUseIdToName: new Map(),
      });
      await idleRun.submitted;
      const idleSummary = await Promise.race([
        idleRun.summary,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 180_000)),
      ]);
      const idleHits = hits.slice(beforeIdle).filter((hit) => hit.url === "/v1/messages");
      const idleHit = idleHits.find((hit) => hit.cred?.ocTurnKey === idleTurnKey && hit.summary)
        ?? idleHits.find((hit) => hit.cred?.ocTurnKey === idleTurnKey);
      report.catalogGets = catalogGets;
      report.epochGets = epochGets;
      report.idleRequestPath = localAuthBodyPath || null;
      report.idleHits = idleHits.map((hit) => ({
        status: hit.status, bytes: hit.bytes, kind: hit.kind, summary: hit.summary, cred: hit.cred, body: (hit.body ?? "").slice(0, 180),
      }));
      report.idleTurnFinished = idleSummary !== null;
      if (!idleHit?.cred) throw new Error(`no dedicated idle HTTP ${JSON.stringify(report.idleHits).slice(0, 900)}`);
      const cred = idleHit.cred;
      if (!cred.hasLocal || cred.hasAuthority || cred.hasLease || cred.ocTurnKey !== idleTurnKey) {
        throw new Error(`idle credential contract failed ${JSON.stringify(cred)}`);
      }
      if (cred.claims?.v !== 1 || cred.claims.kind !== "local_catalog" || cred.claims.securityEpoch !== "12" || cred.claims.projectionRevision !== PROJECTION_OK) {
        throw new Error(`idle claims failed ${JSON.stringify({ claims: cred.claims, claimsError: cred.claimsError })}`);
      }
      if (idleHit.status !== 200) {
        throw new Error(`legitimate local catalog not accepted status=${idleHit.status} body=${idleHit.body ?? ""}`);
      }
      assert.equal(catalogGets >= 1, true, "catalog handler was not fetched");
      report.nativeObserved = listJson(join(HOME, "idle-native")).map((file) => {
        const row = JSON.parse(readFileSync(file, "utf8")) as { applied?: boolean; modelCalls?: number; modelStarted?: boolean; summaryText?: string; opId?: string };
        return {
          applied: row.applied === true, modelCalls: row.modelCalls ?? null, modelStarted: row.modelStarted === true,
          summaryPrefix: typeof row.summaryText === "string" ? row.summaryText.slice(0, 80) : null, opId: row.opId ?? null,
        };
      });
      report.compactSuccessNotClaimed = true;
      const usage = await pool.query<{ request_id: string; authority_kind: string | null; projection_revision: string | null; security_epoch: string | null; turn_key: string | null }>(
        `SELECT request_id, authority_kind, projection_revision, security_epoch::text AS security_epoch, turn_key
           FROM usage_records WHERE request_id = $1 OR request_id = $2`,
        [sourceHit.requestId ?? "", idleHit.requestId ?? ""]);
      report.usageAuthority = usage.rows;
      const journals = await pool.query<{ request_id: string; kind: string | null; has_turn: boolean }>(
        `SELECT request_id, ctx->>'authorityKind' AS kind, (ctx ? 'authorityTurnId') AS has_turn
           FROM request_finalize_journal WHERE request_id = $1 OR request_id = $2`,
        [sourceHit.requestId ?? "", idleHit.requestId ?? ""]);
      report.journalAuthority = journals.rows;
      const sourceUsage = usage.rows.find((row) => row.request_id === sourceHit.requestId);
      const idleUsage = usage.rows.find((row) => row.request_id === idleHit.requestId);
      assert.equal(usage.rows.filter((row) => row.request_id === sourceHit.requestId).length, 1);
      assert.equal(usage.rows.filter((row) => row.request_id === idleHit.requestId).length, 1);
      assert.ok(sourceUsage, "source usage row missing");
      assert.equal(sourceUsage!.authority_kind, "bridge_signed");
      assert.ok(idleUsage, "idle usage row missing");
      assert.equal(idleUsage!.authority_kind, "local_catalog");
      assert.equal(idleUsage!.projection_revision, PROJECTION_OK);
      assert.equal(idleUsage!.security_epoch, "12");
      assert.equal(idleUsage!.turn_key, idleTurnKey);
      const authBooks = await pool.query<{ request_id: string; ledger_id: string; delta: string; balance_after: string }>(
        `SELECT u.request_id, l.id::text AS ledger_id, l.delta::text, l.balance_after::text
           FROM usage_records u JOIN credit_ledger l ON l.id = u.ledger_id
          WHERE u.request_id = $1 OR u.request_id = $2 ORDER BY l.id`,
        [sourceHit.requestId, idleHit.requestId]);
      assert.equal(authBooks.rows.length, 2, JSON.stringify(authBooks.rows));
      assert.equal(new Set(authBooks.rows.map((row) => row.ledger_id)).size, 2);
      let authRunning = 50_000_000n;
      const allBooks = await pool.query<{ delta: string; balance_after: string; ledger_id: string }>(
        `SELECT l.id::text AS ledger_id, l.delta::text, l.balance_after::text
           FROM credit_ledger l WHERE l.user_id = 3 ORDER BY l.id`);
      for (const row of allBooks.rows) {
        authRunning += BigInt(row.delta);
        assert.equal(BigInt(row.balance_after), authRunning, row.ledger_id);
      }
      report.authBalance = authRunning.toString();
      const idleJournal = journals.rows.find((row) => row.request_id === idleHit.requestId);
      if (idleJournal) {
        assert.equal(idleJournal.kind, "local_catalog");
        assert.equal(idleJournal.has_turn, false);
      }
      const fingerprint = async () => {
        const locks = [...((await redis.zrange("precheck:u:{3}:locks", 0, -1)) as string[])].sort();
        const amounts = await redis.hgetall("precheck:u:{3}:amounts");
        const rows = await pool.query<{ request_id: string }>("SELECT request_id FROM usage_records ORDER BY request_id");
        return { locks, amounts, usage: rows.rows.map((row) => row.request_id) };
      };
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (Number(await redis.zcard("precheck:u:{3}:locks")) === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const baseline = await fingerprint();
      report.precheckBaseline = { locks: baseline.locks.length, usage: baseline.usage.length };
      // A new process. The compact turn's trailing stdout must not finish the next parser.
      await idleAdapter.shutdown();
      const probeKey = "agent:main:webchat:dm:idle-auth-probe";
      const probeAdapter = new CcbAdapter({
        sessionKey: probeKey, agentId: "main", agentBaseDir: work, config: adapterConfig,
        model: MODEL, permissionMode: "bypassPermissions", harness: "ccb", executionTarget: { kind: "local" },
      });
      adapterShutdown = () => probeAdapter.shutdown();
      const probeSession = {
        sessionKey: probeKey, agentId: "main", channel: "webchat", peerId: "idle-auth-probe",
        title: "Idle", startedAt: Date.now(), runner: probeAdapter, model: MODEL, lock: Promise.resolve(),
        lastUsedAt: 0, totalCostUSD: 0, totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0, turns: 0, _lastCcbCumulativeCost: 0, toolUseIdToName: new Map(),
        executionTarget: { kind: "local" }, providerTag: "ccb",
      } as never;
      const probe = async (fault: "epoch" | "projection" | "model", textLabel: string) => {
        catalogFault = fault;
        resetCatalogClient(fault !== "epoch");
        const before = hits.length;
        const epochBefore = epochGets;
        const turnKey = createHash("sha256").update(`ocv5-296-${fault}`).digest("hex");
        const run = probeAdapter.submitTurn({
          input: textLabel, turnKey, onEvent, sessionTotals: probeSession, toolUseIdToName: new Map(),
        });
        if (fault === "model") {
          await assert.rejects(run.submitted, /missing from current projection/);
          assert.equal(hits.length, before, "wrong model reached egress");
          assert.deepEqual(await fingerprint(), baseline);
          return { fault, status: null as number | null, http: false };
        }
        await run.submitted;
        const done = await Promise.race([
          run.summary,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 90_000)),
        ]);
        const added = hits.slice(before).filter((hit) => hit.url === "/v1/messages");
        if (added.length === 0 || done === null) {
          throw new Error(`${fault} produced no gate HTTP hits=${added.length} finished=${done !== null}`);
        }
        for (const hit of added) {
          assert.equal(hit.status, 409, `${fault} ${hit.status} ${hit.body ?? ""}`);
          assert.equal(hit.cred?.hasLocal, true, fault);
          assert.equal(hit.cred?.hasAuthority, false, fault);
          assert.equal(hit.cred?.hasLease, false, fault);
        }
        if (fault === "epoch") {
          assert.equal(added.some((hit) => hit.cred?.claims?.securityEpoch === "99"), true, JSON.stringify(added[0]?.cred?.claims));
          assert.ok(epochGets > epochBefore, "epoch revocation did not read the epoch endpoint");
        }
        if (fault === "projection") {
          assert.equal(added.some((hit) => hit.cred?.claims?.projectionRevision === "e".repeat(64)), true, JSON.stringify(added[0]?.cred?.claims));
        }
        assert.deepEqual(await fingerprint(), baseline, `${fault} precheck changed`);
        return { fault, status: added[0]?.status ?? null, http: true, localSha256: added[0]?.cred?.localSha256 ?? null };
      };
      report.negatives = [
        await probe("epoch", "epoch revoke probe"),
        await probe("projection", "projection mismatch probe"),
        await probe("model", "wrong model probe"),
      ];
      catalogFault = "none";
      report.catalogGets = catalogGets;
      report.epochGets = epochGets;
      report.notRun = ["typed-summary success", "three crash windows", "same-session second idle", "45-round chain"];
    } else {
      const growing = mode === "grow2" || mode === "seam";
      const seam = mode === "seam";
      if (growing) {
        armCatalog(false);
      }
      growthActive = true;
      growthRound = 0;
      growthStopRound = seam ? 8 : growing ? 60 : 1;
      growthTarget = seam ? 900_000 : GROW_TARGET;
      toolsPerRound = growing ? 8 : 1;
      growthChars = growing ? 25_000 : GROW_CHARS;
      growthBodyPrefix = seam ? "ocv5-296-r22-seam" : growing ? "ocv5-296-r22-grow" : "ocv5-296-r19-live";
      executionLogPath = growing ? join(work, "execution-log") : "";
      mcpSerial = 0;
      pendingById.clear();
      growthBodies.length = 0;
      const liveKey = seam ? "agent:main:webchat:dm:idle-seam" : growing ? "agent:main:webchat:dm:idle-grow2" : "agent:main:webchat:dm:idle-live2";
      const liveAdapter = new CcbAdapter({
        sessionKey: liveKey,
        agentId: "main",
        agentBaseDir: work,
        config: adapterConfig,
        model: MODEL,
        permissionMode: "bypassPermissions",
        harness: "ccb",
        executionTarget: { kind: "local" },
      });
      adapterShutdown = () => liveAdapter.shutdown();
      const liveSession = {
        sessionKey: liveKey,
        agentId: "main",
        channel: "webchat",
        peerId: growing ? "idle-grow2" : "idle-live2",
        title: "Idle",
        startedAt: Date.now(),
        runner: liveAdapter,
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
      if (growing) holdSummaryCommit = true;
      const before = hits.length;
      let liveError = "";
      let submitDone = false;
      const submitPromise = sm.submit(liveSession, "grow", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority })
        .then(() => { submitDone = true; }, (error) => {
          liveError = error instanceof Error ? error.message : String(error);
          submitDone = true;
        });
      const waitCap = seam ? 540_000 : 3_200_000;
      const waitStart = Date.now();
      while (!submitDone && heldCommits.length === 0 && Date.now() - waitStart < waitCap) {
        await sleep(200);
      }
      if (growing && heldCommits.length > 0) {
        const summaryHit = [...hits].reverse().find((hit) => hit.kind === "idle-summary");
        for (let attempt = 0; attempt < 30 && summaryHit && !summaryHit.requestId; attempt += 1) await sleep(100);
        const summaryId = summaryHit?.requestId ?? "";
        const candidateFile = join(HOME, "idle-candidates", `${encodeURIComponent(liveKey)}.json`);
        const nativeHeld = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8")) as { applied?: boolean; summaryText?: string; modelCalls?: number });
        const visible = summaryId
          ? await admin.query<{ usage_n: string; state: string | null }>(
            `SELECT
               (SELECT count(*)::text FROM ${SCHEMA}.usage_records WHERE request_id = $1) AS usage_n,
               (SELECT state FROM ${SCHEMA}.request_finalize_journal WHERE request_id = $1) AS state`,
            [summaryId])
          : { rows: [{ usage_n: "missing-request-id", state: null }] };
        const httpAtHold = hits.filter((hit) => hit.url === "/v1/messages").length;
        let blockedText = "";
        const blockedPromise = sm.submit(liveSession, "barrier-user", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority })
          .then(() => "ok", (error) => {
            blockedText = error instanceof Error ? error.message : String(error);
            return blockedText;
          });
        const blockedNow = await Promise.race([
          blockedPromise,
          sleep(8_000).then(() => "still-waiting"),
        ]);
        const httpDelta = hits.filter((hit) => hit.url === "/v1/messages").length - httpAtHold;
        report.summaryBarrier = {
          phase: submitDone ? "submit-returned-while-held" : "commit-held",
          summaryStatus: summaryHit?.status ?? null,
          summaryRequestId: summaryId || null,
          summaryTurnKey: summaryHit?.cred?.ocTurnKey ?? null,
          localOnly: summaryHit?.cred ? summaryHit.cred.hasLocal && !summaryHit.cred.hasAuthority && !summaryHit.cred.hasLease : null,
          usageVisible: visible.rows[0]?.usage_n ?? null,
          journalState: visible.rows[0]?.state ?? null,
          candidate: existsSync(candidateFile),
          nativeApplied: nativeHeld.some((file) => file.applied === true),
          blockedNow,
          newModelHttp: httpDelta,
        };
        assert.equal(summaryHit?.status, 200, "summary HTTP missing while its commit is held");
        assert.notEqual(summaryId, "", "summary request id missing while its commit is held");
        assert.equal(visible.rows[0]?.usage_n, "0", "summary usage visible before COMMIT");
        assert.notEqual(visible.rows[0]?.state, "committed", "summary journal committed before COMMIT");
        assert.equal(existsSync(candidateFile), true, "candidate missing while summary commit is held");
        assert.equal(nativeHeld.some((file) => file.applied === true), false, "history applied before summary COMMIT");
        assert.equal(httpDelta, 0, "new user reached the model while summary commit is held");
        assert.equal(blockedNow === "still-waiting" || blockedNow.includes("IDLE_HISTORY_PENDING"), true, blockedNow);
        releaseHeldCommits();
        const barrierUser = await Promise.race([
          blockedPromise,
          sleep(180_000).then(() => "barrier-user-timeout"),
        ]);
        report.barrierUser = barrierUser;
        if (barrierUser === "barrier-user-timeout") throw new Error("barrier user did not settle after the summary commit was released");
      }
      if (!submitDone) {
        const finished = await Promise.race([
          submitPromise.then(() => true, () => true),
          sleep(180_000).then(() => false),
        ]);
        if (!finished) {
          releaseHeldCommits();
          throw new Error("SessionManager.submit stayed blocked after the summary commit was released");
        }
      }
      await submitPromise;
      const liveHits = hits.slice(before).filter((hit) => hit.url === "/v1/messages");
      report.liveError = liveError || null;
      report.liveHits = liveHits.map((hit) => ({
        status: hit.status, bytes: hit.bytes, kind: hit.kind, reasons: hit.reasons,
        requestId: hit.requestId, summary: hit.summary,
        contentBytes: (hit.digest as { contentBytes?: number } | undefined)?.contentBytes ?? null,
        body: (hit.body ?? "").slice(0, 180),
      }));
      report.execLog = localExec.log;
      report.pendingCount = localExec.log.filter((line) => line === "synthetic-pending").length;
      const continuation = liveHits.filter((hit) => hit.kind === "live-continuation");
      const rejected = liveHits.filter((hit) => hit.status === 409 || (hit.body ?? "").includes("BOX_TOOL_CONTEXT_CHANGED"));
      if (rejected.length > 0 || continuation.length === 0 || continuation.some((hit) => hit.status !== 200)) {
        report.contextDiff = await explainContextMismatch(growthBodies, CHECKOUT);
        throw new Error(`live continuation red: ${liveError || "no 200 continuation"} hits=${JSON.stringify(report.liveHits).slice(0, 1200)} diff=${JSON.stringify(report.contextDiff).slice(0, 1500)}`);
      }
      const launchCount = localExec.log.filter((line) => line === "synthetic-launch").length;
      report.launchCount = launchCount;
      if (!growing) {
        assert.equal(launchCount, 1, JSON.stringify(localExec.log));
      } else {
        // Idle recovery and the following user start more CLIs. Re-execution is the pending-id check.
        assert.ok(launchCount >= 1, JSON.stringify(localExec.log.slice(-40)));
        if (report.summaryBarrier == null) {
          throw new Error("summary COMMIT barrier did not arm; refusing to treat growth HTTP as the commit proof");
        }
        report.liveGrowthNotRun = mode === "grow2" ? false : report.liveGrowthNotRun;
      }
      if (growing) {
        const logged = readFileSync(executionLogPath, "utf8").trim().split("\n").filter(Boolean);
        const expectedIds: string[] = [];
        for (let round = 1; round <= growthRound; round += 1) {
          for (let index = 0; index < toolsPerRound; index += 1) expectedIds.push(`toolu_g${round}_${index}`);
        }
        report.executionLogCount = logged.length;
        report.growthRound = growthRound;
        assert.deepEqual([...logged].sort(), [...expectedIds].sort());
        assert.equal(new Set(logged).size, logged.length);
        const retained = Math.max(...liveHits.map((hit) => (hit.digest as { contentBytes?: number } | undefined)?.contentBytes ?? 0));
        report.retainedBytes = retained;
        if (seam) {
          assert.ok(retained >= 700_000 && retained < GROW_TARGET, `seam retained ${retained}`);
          report.notLiveChain = true;
        } else {
          assert.ok(retained >= GROW_TARGET, `retained ${retained} after ${growthRound} rounds`);
        }
      } else {
      assert.equal(growthRound, 1);
      const toolUses = growthBodies.flatMap((body) => {
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
          return (parsed.messages ?? []).flatMap((message) => Array.isArray(message.content)
            ? message.content.filter((block): block is { type?: string; id?: string } => Boolean(block) && typeof block === "object" && (block as { type?: string }).type === "tool_use").map((block) => block.id)
            : []);
        } catch { return []; }
      });
      report.toolUses = toolUses;
      if (!growing) assert.deepEqual(toolUses, ["toolu_grow_1"]);
      assert.equal(liveHits.filter((hit) => hit.kind === "idle-summary").length, 0);
      report.contextDiff = await explainContextMismatch(growthBodies, CHECKOUT);
      assert.equal((report.contextDiff as { equal?: boolean }).equal, true, JSON.stringify(report.contextDiff).slice(0, 800));
      const ids = continuation.map((hit) => hit.requestId).filter((id): id is string => Boolean(id));
      const firstId = liveHits.find((hit) => hit.kind !== "live-continuation" && hit.status === 200)?.requestId;
      assert.equal(typeof firstId, "string");
      const linked = await pool.query<{ request_id: string; state: string; owner: string | null; resume: string | null }>(
        `SELECT request_id, state, ctx->>'boxOwnerRequestId' AS owner, ctx->>'boxResumeRequestId' AS resume
           FROM request_finalize_journal WHERE request_id = $1 OR request_id = $2`,
        [firstId, ids[0]]);
      report.liveJournal = linked.rows;
      assert.equal(linked.rows.length, 2, JSON.stringify(linked.rows));
      for (const row of linked.rows) assert.equal(row.state, "committed", row.request_id);
      const resumes = linked.rows.map((row) => row.resume).filter((value): value is string => Boolean(value));
      const owners = linked.rows.map((row) => row.owner).filter((value): value is string => Boolean(value));
      assert.equal(owners.includes(firstId!), true, JSON.stringify(linked.rows));
      assert.equal(resumes.includes(ids[0]!), true, JSON.stringify(linked.rows));
      }
      assert.equal(liveError, "");
      if (growing) {
        growthActive = false;
        if (seam && heldCommits.length > 0) {
          const blockedAt = hits.filter((hit) => hit.url === "/v1/messages").length;
          let blocked = "";
          try {
            await sm.submit(liveSession, "blocked-user", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
          } catch (error) {
            blocked = error instanceof Error ? error.message : String(error);
          }
          report.blockedError = blocked;
          assert.equal(blocked.includes("IDLE_HISTORY_PENDING"), true, blocked);
          assert.equal(hits.filter((hit) => hit.url === "/v1/messages").length, blockedAt);
          const idleId = hits.find((hit) => hit.kind === "idle-summary")?.requestId ?? "";
          releaseHeldCommits();
          for (let attempt = 0; attempt < 80 && idleId; attempt += 1) {
            const row = await pool.query<{ state: string }>("SELECT state FROM request_finalize_journal WHERE request_id = $1", [idleId]);
            if (row.rows[0]?.state === "committed") break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        const beforeNext = hits.length;
        let nextError = "";
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await sm.submit(liveSession, "ordinary next", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
            nextError = "";
            break;
          } catch (error) {
            nextError = error instanceof Error ? error.message : String(error);
            if (!nextError.includes("IDLE_HISTORY_PENDING")) break;
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        }
        report.nextError = nextError || null;
        const nextHits = hits.slice(beforeNext).filter((hit) => hit.url === "/v1/messages");
        report.nextHits = nextHits.map((hit) => ({
          status: hit.status, bytes: hit.bytes, kind: hit.kind, summary: hit.summary,
          requestId: hit.requestId,
          contentBytes: (hit.digest as { contentBytes?: number } | undefined)?.contentBytes ?? null,
        }));
        const summaries = [...liveHits, ...nextHits].filter((hit) => hit.kind === "idle-summary" && hit.status === 200);
        report.idleSummaryCount = summaries.length;
        report.nativeFiles = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8")));
        report.opFiles = listJson(join(HOME, "idle-ops")).map((file) => JSON.parse(readFileSync(file, "utf8")));
        if (nextError) throw new Error(nextError);
        assert.equal(summaries.length, 1, JSON.stringify(report.nextHits));
        const summaryHit = summaries[0]!;
        assert.equal(summaryHit.cred?.hasLocal, true, JSON.stringify(summaryHit.cred));
        assert.equal(summaryHit.cred?.hasAuthority, false, JSON.stringify(summaryHit.cred));
        assert.equal(summaryHit.cred?.hasLease, false, JSON.stringify(summaryHit.cred));
        assert.equal(summaryHit.cred?.claims?.kind, "local_catalog");
        assert.equal(summaryHit.cred?.claims?.securityEpoch, "12");
        assert.equal(summaryHit.cred?.claims?.projectionRevision, PROJECTION_OK);
        assert.equal((summaryHit.body ?? "").includes("MODEL_AUTHORITY_INVALID"), false, summaryHit.body ?? "");
        const appliedOp = (report.opFiles as Array<{ idleTurnKey?: string; summaryText?: string; receiptDigest?: string; artifact?: { digest?: string; messages?: Array<{ uuid?: string; type?: string; message?: { role?: string } }> } }>).find((op) =>
          op.summaryText === "outer-history-summary" && op.receiptDigest && op.artifact?.digest === op.receiptDigest);
        assert.ok(appliedOp, JSON.stringify(report.opFiles).slice(0, 800));
        assert.equal(summaryHit.cred?.ocTurnKey, appliedOp!.idleTurnKey, JSON.stringify(report.turnKeys ?? null));
        const business = nextHits.filter((hit) => hit.status === 200 && hit.kind === "business");
        assert.equal(business.length, 1, JSON.stringify(report.nextHits));
        assert.ok(((business[0]?.digest as { contentBytes?: number } | undefined)?.contentBytes ?? 1e9) < 1_000_000, JSON.stringify(report.nextHits));
        const summaryId = summaries[0]?.requestId;
        const nextId = nextHits.find((hit) => hit.kind === "business")?.requestId;
        for (let attempt = 0; attempt < 50 && nextId; attempt += 1) {
          const seen = await pool.query("SELECT 1 FROM usage_records WHERE request_id = $1", [nextId]);
          if (seen.rowCount) break;
          await sleep(100);
        }
        const books = await pool.query<{ request_id: string; turn_key: string; ledger_id: string; delta: string; balance_after: string }>(
          `SELECT u.request_id, u.turn_key, l.id::text AS ledger_id, l.delta::text, l.balance_after::text
             FROM usage_records u JOIN credit_ledger l ON l.id = u.ledger_id
            WHERE u.user_id = 3 ORDER BY l.id`);
        report.ledgerCount = books.rows.length;
        assert.equal(new Set(books.rows.map((row) => row.request_id)).size, books.rows.length);
        assert.equal(new Set(books.rows.map((row) => row.ledger_id)).size, books.rows.length);
        let running = 50_000_000n;
        for (const row of books.rows) {
          running += BigInt(row.delta);
          assert.equal(BigInt(row.balance_after), running, row.request_id);
        }
        const credits = BigInt((await pool.query("SELECT credits::text AS credits FROM users WHERE id = 3")).rows[0].credits);
        report.credits = { after: credits.toString(), ledgerSum: (running - 50_000_000n).toString() };
        assert.equal(credits, running);
        const keys = await pool.query<{ request_id: string; turn_key: string }>(
          "SELECT request_id, turn_key FROM usage_records WHERE request_id = $1 OR request_id = $2 OR request_id = $3",
          [liveHits[0]?.requestId, summaryId, nextId]);
        report.turnKeys = keys.rows;
        const appliedStage = copyStage(mode === "grow2" ? "r22-applied" : "seam-applied");
        const appliedNative = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8")) as { opId?: string; modelCalls?: number; summaryText?: string; applied?: boolean; artifact?: { digest?: string; messages?: unknown[] } });
        const appliedOps = listJson(join(HOME, "idle-ops")).map((file) => JSON.parse(readFileSync(file, "utf8")) as { idleTurnKey?: string; sourceSessionId?: string; sourceTurnKey?: string; revision?: string; summaryText?: string; receiptDigest?: string });
        const firstOp = appliedOps.find((op) => op.idleTurnKey === appliedOp!.idleTurnKey);
        assert.ok(firstOp?.sourceSessionId && firstOp.sourceTurnKey, JSON.stringify(firstOp ?? null));
        const summaryHttpBeforeSecond = hits.filter((hit) => hit.kind === "idle-summary").length;
        const beforeSecond = hits.length;
        let secondError = "";
        for (let attempt = 0; attempt < 8; attempt += 1) {
          try {
            await sm.submit(liveSession, "second-source", onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
            secondError = "";
            break;
          } catch (error) {
            secondError = error instanceof Error ? error.message : String(error);
            if (!secondError.includes("IDLE_HISTORY_PENDING")) break;
            await sleep(300);
          }
        }
        const secondHits = hits.slice(beforeSecond).filter((hit) => hit.url === "/v1/messages");
        const opsAfterSecond = listJson(join(HOME, "idle-ops")).map((file) => JSON.parse(readFileSync(file, "utf8")) as { idleTurnKey?: string; sourceTurnKey?: string; revision?: string; disposition?: string; summaryText?: string });
        const nativeAfterSecond = listJson(join(HOME, "idle-native")).map((file) => JSON.parse(readFileSync(file, "utf8")) as { opId?: string; modelCalls?: number; summaryText?: string });
        report.secondIdle = {
          error: secondError || null,
          hits: secondHits.map((hit) => ({ status: hit.status, kind: hit.kind, requestId: hit.requestId, summary: hit.summary })),
          newOp: opsAfterSecond.filter((op) => op.idleTurnKey !== firstOp?.idleTurnKey).map((op) => ({
            idleTurnKey: op.idleTurnKey, sourceTurnKey: op.sourceTurnKey, revision: op.revision, disposition: op.disposition ?? null,
          })),
        };
        if (secondError) throw new Error(secondError);
        assert.equal(hits.filter((hit) => hit.kind === "idle-summary").length, summaryHttpBeforeSecond, "second idle generated another summary");
        const oldAfter = opsAfterSecond.find((op) => op.idleTurnKey === firstOp?.idleTurnKey);
        assert.equal(oldAfter?.summaryText, firstOp?.summaryText);
        assert.equal(oldAfter?.sourceTurnKey, firstOp?.sourceTurnKey);
        const freshOp = opsAfterSecond.find((op) => op.idleTurnKey !== firstOp?.idleTurnKey && op.sourceTurnKey && op.sourceTurnKey !== firstOp?.sourceTurnKey);
        assert.ok(freshOp, `second idle did not open a new source op ${JSON.stringify(report.secondIdle)}`);
        const oldNative = nativeAfterSecond.find((file) => file.opId === firstOp?.idleTurnKey);
        const oldNativeBefore = appliedNative.find((file) => file.opId === firstOp?.idleTurnKey);
        assert.equal(oldNative?.modelCalls ?? null, oldNativeBefore?.modelCalls ?? null);
        let usageCursor = Number((await pool.query("SELECT count(*)::int AS n FROM usage_records")).rows[0].n);
        const windows = [];
        for (const windowName of ["before-artifact", "native-half", "receipt-lost"] as const) {
          restoreIdle(appliedStage);
          const candidate = { v: 1 as const, sessionKey: liveKey, sessionId: firstOp!.sourceSessionId!, turnKey: firstOp!.sourceTurnKey! };
          if (windowName === "before-artifact") {
            mutateOp(liveKey, (op) => { delete op.artifact; delete op.receiptDigest; });
            mutateNative((file) => { delete file.artifact; file.applied = false; });
            writeIdleCandidate(HOME, candidate);
          } else if (windowName === "native-half") {
            truncateNative();
            mutateOp(liveKey, (op) => { delete op.receiptDigest; });
            writeIdleCandidate(HOME, candidate);
          } else {
            mutateOp(liveKey, (op) => { delete op.receiptDigest; });
            writeIdleCandidate(HOME, candidate);
          }
          const httpBefore = hits.filter((hit) => hit.url === "/v1/messages").length;
          const summaryBefore = hits.filter((hit) => hit.kind === "idle-summary").length;
          let windowError = "";
          try {
            await sm.submit(liveSession, `recover-${windowName}`, onEvent, undefined, MODEL, undefined, undefined, undefined, { modelAuthority });
          } catch (error) {
            windowError = error instanceof Error ? error.message : String(error);
          }
          const added = hits.slice(httpBefore).filter((hit) => hit.url === "/v1/messages");
          const usageAfter = Number((await pool.query("SELECT count(*)::int AS n FROM usage_records")).rows[0].n);
          const usageDelta = usageAfter - usageCursor;
          usageCursor = usageAfter;
          const nativeNow = listJson(join(HOME, "idle-native")).map((file) => {
            try { return JSON.parse(readFileSync(file, "utf8")) as { modelCalls?: number; artifact?: { messages?: Array<{ uuid?: string; type?: string; message?: { role?: string } }> } }; }
            catch { return { parse: false }; }
          });
          windows.push({
            window: windowName,
            error: windowError || null,
            newSummary: hits.filter((hit) => hit.kind === "idle-summary").length - summaryBefore,
            newHttp: added.map((hit) => hit.kind),
            usageDelta,
            modelCalls: nativeNow.map((file) => "modelCalls" in file ? file.modelCalls ?? null : "unreadable"),
          });
        }
        report.windows = windows;
        report.appliedStage = appliedStage;
        for (const windowRow of windows) {
          assert.equal(windowRow.newSummary, 0, JSON.stringify(windowRow));
          assert.ok(windowRow.usageDelta <= 1, JSON.stringify(windowRow));
          if (windowRow.window !== "native-half") assert.equal(windowRow.error, null, JSON.stringify(windowRow));
        }
        const restored = JSON.parse(readFileSync(listJson(join(appliedStage, "idle-native"))[0] ?? "/dev/null", "utf8")) as { artifact?: { digest?: string; messages?: Array<{ uuid?: string; type?: string; message?: { role?: string; content?: string } }> }; summaryText?: string; opId?: string };
        if (restored.artifact?.messages && restored.summaryText && restored.opId) {
          const expected = assembleIdleArtifact({ opId: restored.opId, summaryText: restored.summaryText, tail: [], attachments: [] });
          report.artifactImage = {
            actualDigest: restored.artifact.digest ?? null,
            roles: restored.artifact.messages.map((message) => ({ uuid: message.uuid ?? null, type: message.type ?? null, role: message.message?.role ?? null })),
            expectedDigest: expected.digest,
            sameShape: restored.artifact.messages[0]?.type === "system" && restored.artifact.messages[1]?.type === "user",
          };
          assert.equal((report.artifactImage as { sameShape: boolean }).sameShape, true, JSON.stringify(report.artifactImage));
        }
      }
    }
  } finally {
    restoreLocalAuth?.();
    releaseHeldCommits();
    if (adapterShutdown) {
      const shutdown = adapterShutdown();
      const timed = await Promise.race([
        shutdown.then(() => "down", (error) => `shutdown:${error instanceof Error ? error.message : String(error)}`),
        sleep(20_000).then(() => "shutdown-timeout"),
      ]);
      if (timed !== "down") cleanupErrors.push(String(timed));
    }
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
    if (redisQuit) {
      try { await redisQuit(); }
      catch (error) { cleanupErrors.push(`redis-quit: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (candidate) {
      rmSync(join(candidate, "node_modules"), { force: true });
      rmSync(join(candidate, "claude-code-best/node_modules"), { force: true });
      rmSync(candidate, { recursive: true, force: true });
    }
    if (adminEnd) await adminEnd().catch(() => undefined);
    rmSync(HOME, { recursive: true, force: true });
    const rawName = mode === "short"
      ? "ocv5-296-idle-pipeline-r18-short-raw.json"
      : mode === "fresh"
        ? "ocv5-296-fresh-set-r18-raw.json"
        : mode === "localAuth"
          ? "ocv5-296-idle-local-catalog-raw.json"
          : mode === "grow2"
            ? "ocv5-296-idle-grow-r22-raw.json"
            : mode === "seam"
              ? "ocv5-296-idle-seam-r22-raw.json"
              : "ocv5-296-idle-pipeline-r19-live2-raw.json";
    const rawDir = process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir();
    const path = join(rawDir, rawName);
    report.cleanupErrors = cleanupErrors;
    if (/ocv5-296-(idle-pipeline-r1[7-9]|idle-pipeline-r20|r17-growth)/.test(path)) {
      throw new Error(`refusing to overwrite historical raw ${path}`);
    }
    writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ event: "ocv5-296-idle", case: mode, report: path, summaryHttp: report.summaryHttp, firstError: report.firstError, cleanup: cleanupErrors.length }));
    if (cleanupErrors.length > 0) throw new Error(`cleanup failed: ${cleanupErrors.join(" | ")}`);
  }
}

let idleQueue: Promise<void> = Promise.resolve();
function queueIdle(name: string, timeout: number, mode: "short" | "fresh"): void {
  const previous = idleQueue;
  let release = (): void => {};
  idleQueue = new Promise<void>((resolve) => { release = resolve; });
  test(name, { timeout }, async () => {
    await previous;
    try { await runIdleCase(mode); }
    finally { release(); }
  });
}

queueIdle("real submit reaches a short idle no-op without a summary HTTP", 300_000, "short");
queueIdle("fresh stock summary and business roots short-close through terminal_set", 900_000, "fresh");
test("live tool continuation keeps the persisted deferred-tools announcement", { timeout: 300_000 }, () => runIdleCase("live2"));
test("live bash rounds grow outer history through idle summary", { timeout: 3_600_000 }, () => runIdleCase("grow2"));
test("local catalog fixture accepts a dedicated idle request and rejects drift", { timeout: 600_000 }, () => runIdleCase("localAuth"));
test("prepared idle summary commits on its own turn then applies", { timeout: 1_200_000 }, () => runIdleCase("seam"));

type MessageDigest = {
  messages: number;
  contentBytes: number;
  marker: number;
  toolResults: number;
  context: string | null;
  stop: unknown;
  temperature: unknown;
  top_p: unknown;
  top_k: unknown;
  service_tier: unknown;
  tools: Array<string | undefined>;
  first: string;
  last: string;
  small?: string;
  meta: string;
};

function messageDigest(raw: string): MessageDigest | { parse: false } {
  try {
    const parsed = JSON.parse(raw) as {
      messages?: Array<{ content?: unknown }>;
      tools?: Array<{ name?: string }>;
      metadata?: unknown;
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
  let lastText = "";
  let lastIsToolResult = false;
  try {
    const parsed = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }> };
    const last = parsed.messages?.at(-1);
    lastText = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
    lastIsToolResult = last?.role === "user" && lastText.includes('"tool_result"');
    if (lastIsToolResult) reasons.push("last-user-is-tool-result");
  } catch { reasons.push("unparsed"); }
  if (lastText.includes(SUMMARY_MARK) || raw.includes(SUMMARY_MARK)) reasons.push("idle-prompt-mark");
  if (lastText.includes("continued from a previous conversation") || lastText.includes("This session is being continued")) {
    reasons.push("stock-continuation-phrase");
  }
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

function toolResultsIn(messages: Array<{ role?: string; content?: unknown }>): Array<{ id: string; content: unknown; isError: boolean }> {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "user" || !Array.isArray(message.content)) continue;
    const found: Array<{ id: string; content: unknown; isError: boolean }> = [];
    for (const block of message.content) {
      const item = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
      if (item?.type === "tool_result" && typeof item.tool_use_id === "string") {
        found.push({ id: item.tool_use_id, content: item.content, isError: item.is_error === true });
      }
    }
    if (found.length > 0) return found;
  }
  return [];
}

function ndjson(rows: unknown[]): Buffer {
  return Buffer.from(rows.map((row) => JSON.stringify(row) + "\n").join(""));
}

function streamEvent(value: unknown): { type: string; event: unknown } {
  return { type: "stream_event", event: value };
}

function handoffChunk(uses: Array<{ id: string; boxName: string; input: Record<string, unknown> }>, initTools: string[] | null): Buffer {
  const usage = { input_tokens: 20, output_tokens: 0 };
  const content = uses.map((use) => ({ type: "tool_use", id: use.id, name: use.boxName, input: use.input }));
  const rows: unknown[] = [];
  if (initTools) rows.push({ type: "system", subtype: "init", tools: initTools, mcp_servers: [{}] });
  rows.push(streamEvent({ type: "message_start", message: { id: `msg_${uses[0]?.id ?? "grow"}`, model: "claude-opus-5-5", role: "assistant", content: [], usage } }));
  uses.forEach((use, index) => {
    rows.push(
      streamEvent({ type: "content_block_start", index, content_block: { type: "tool_use", id: use.id, name: use.boxName, input: {} } }),
      streamEvent({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(use.input) } }),
      streamEvent({ type: "content_block_stop", index }),
    );
  });
  rows.push(
    { type: "assistant", message: { id: `msg_${uses[0]?.id ?? "grow"}`, model: "claude-opus-5-5", role: "assistant", content } },
    streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 20, output_tokens: 4 } }),
    streamEvent({ type: "message_stop" }),
  );
  return ndjson(rows);
}

function echoChunk(results: Array<{ id: string; content: unknown; isError: boolean }>): Buffer {
  const blocks = results.map((result) => {
    const block: Record<string, unknown> = { type: "tool_result", tool_use_id: result.id, content: result.content };
    if (result.isError) block.is_error = true;
    return block;
  });
  return ndjson([{ type: "user", message: { role: "user", content: blocks } }]);
}

function growthCommand(id: string): string {
  if (!executionLogPath) return `python3 -c 'print("y"*${growthChars}, end="")'`;
  const script = `import pathlib; p=pathlib.Path(${JSON.stringify(executionLogPath)}); p.parent.mkdir(parents=True, exist_ok=True); p.open('a').write(${JSON.stringify(id + "\n")}); print('y'*${growthChars}, end='')`;
  return `python3 -c ${JSON.stringify(script)}`;
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
    if (!growthActive) pendingById.clear();
    return;
  }
  const bashIndex = (parsed.tools ?? []).findIndex((tool) => tool.name === "Bash");
  const size = toolResultBytes(parsed.messages ?? []);
  const prior = classified.kind === "live-continuation" ? toolResultsIn(parsed.messages ?? []) : [];
  const retainedEnough = size >= growthTarget || growthRound >= growthStopRound;
  const truncated = toolsPerRound > 1 && prior.length > 0 && size < growthRound * toolsPerRound * growthChars * 0.5;
  const finish = retainedEnough || truncated;
  if (bashIndex < 0 || finish) {
    const final = textSpool(prior.length > 0 ? [] : initTools);
    const echo = prior.length > 0 ? echoChunk(prior) : Buffer.alloc(0);
    spoolBuf = prior.length > 0 ? Buffer.concat([spoolBuf, echo, stripInit(final)]) : final;
    return;
  }
  growthRound += 1;
  const boxName = `mcp__ocbridge__t${bashIndex}`;
  const uses = Array.from({ length: toolsPerRound }, (_, index) => {
    const id = toolsPerRound === 1 ? `toolu_grow_${growthRound}` : `toolu_g${growthRound}_${index}`;
    const input = { command: growthCommand(id) };
    mcpSerial += 1;
    pendingById.set(id, JSON.stringify({
      version: 1, modelToolUseId: id, mcpRequestId: mcpSerial,
      name: `t${bashIndex}`, arguments: input,
    }));
    return { id, boxName, input };
  });
  const chunk = handoffChunk(uses, prior.length > 0 ? null : initTools);
  const echo = prior.length > 0 ? echoChunk(prior) : Buffer.alloc(0);
  spoolBuf = prior.length > 0 ? Buffer.concat([spoolBuf, echo, chunk]) : chunk;
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
        const limit = Number(args[8] ?? 65536);
        const source = spoolBuf.length > 0 ? spoolBuf : textSpool(toolNames());
        const start = Math.min(Number.isFinite(offset) ? offset : 0, source.length);
        const cap = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 65536) : 65536;
        const part = source.subarray(start, Math.min(source.length, start + cap));
        return { stdout: JSON.stringify({ data: part.toString("base64"), offset: start + part.length }), stderrBytes: 0, exitCode: 0 as const };
      }
      if (script.includes("pending.")) {
        const toolId = args[4] ?? "";
        const pending = pendingById.get(toolId);
        if (!pending) throw new Error(`BOX_TEST_PENDING_MISSING ${toolId}`);
        log.push(`synthetic-pending:${toolId}`);
        return { stdout: pending, stderrBytes: 0, exitCode: 0 as const };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function copyStage(label: string): string {
  const rawDir = process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir();
  const dest = join(rawDir, `ocv5-296-stage-${label}-${SCHEMA.slice(-6)}`);
  if (/r1[7-9]|r20/.test(dest)) throw new Error(`refusing stage path ${dest}`);
  mkdirSync(dest, { recursive: true });
  for (const rel of ["idle-ops", "idle-native", "idle-candidates", "claude-config"]) {
    const src = join(HOME, rel);
    if (!existsSync(src)) continue;
    cpSync(src, join(dest, rel), { recursive: true });
  }
  return dest;
}

function restoreIdle(stage: string): void {
  for (const rel of ["idle-ops", "idle-native", "idle-candidates"]) {
    rmSync(join(HOME, rel), { recursive: true, force: true });
    const src = join(stage, rel);
    if (existsSync(src)) cpSync(src, join(HOME, rel), { recursive: true });
  }
}

function mutateOp(sessionKey: string, change: (op: Record<string, unknown>) => void): void {
  const folder = join(HOME, "idle-ops", encodeURIComponent(sessionKey));
  for (const name of readdirSync(folder)) {
    if (!name.endsWith(".json")) continue;
    const path = join(folder, name);
    const op = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (op.summaryText !== "outer-history-summary") continue;
    change(op);
    writeFileSync(path, JSON.stringify(op));
  }
}

function mutateNative(change: (file: Record<string, unknown>) => void): void {
  for (const path of listJson(join(HOME, "idle-native"))) {
    const file = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (file.summaryText !== "outer-history-summary") continue;
    change(file);
    writeFileSync(path, JSON.stringify(file));
  }
}

function truncateNative(): void {
  for (const path of listJson(join(HOME, "idle-native"))) {
    const buf = readFileSync(path);
    let summary = "";
    try { summary = (JSON.parse(buf.toString("utf8")) as { summaryText?: string }).summaryText ?? ""; } catch { continue; }
    if (summary !== "outer-history-summary") continue;
    writeFileSync(path, buf.subarray(0, Math.max(1, Math.floor(buf.length / 2))));
  }
}

function capturePreIdleTranscript(label: string): { files: Array<{ file: string; bytes: number; sha256: string }> } {
  const rawDir = process.env.OC_V5_296_IDLE_RAW_DIR || tmpdir();
  const saved: Array<{ file: string; bytes: number; sha256: string }> = [];
  const jsonl: string[] = [];
  const walk = (dir: string) => {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      let info;
      try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) {
        if (name === "node_modules" || name === "candidate") continue;
        walk(path);
      } else if (name.endsWith(".jsonl") && info.size <= 20_000_000 && Date.now() - info.mtimeMs < 6 * 60 * 60 * 1000) jsonl.push(path);
    }
  };
  for (const root of [process.env.CLAUDE_CONFIG_DIR, HOME, "/home/box/.claude"]) {
    if (root) walk(root);
  }
  const tag = SCHEMA.slice(-6);
  jsonl.sort().forEach((file, index) => {
    const dest = join(rawDir, `ocv5-296-pre-idle-${label}-${tag}-${index}.jsonl`);
    if (dest.includes("r17")) return;
    const buf = readFileSync(file);
    writeFileSync(dest, buf);
    saved.push({ file: dest, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  });
  if (largestGrowthRequest) {
    const dest = join(rawDir, `ocv5-296-pre-idle-${label}-${tag}-request.json`);
    if (!dest.includes("r17")) {
      writeFileSync(dest, largestGrowthRequest);
      saved.push({
        file: dest, bytes: Buffer.byteLength(largestGrowthRequest),
        sha256: createHash("sha256").update(largestGrowthRequest).digest("hex"),
      });
    }
  }
  return { files: saved };
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
  cwd: string; snapshotHash: string | null; stageInputs: ReadonlyArray<{ command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv }>;
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

type ProtocolModule = typeof import("@openclaude/protocol");

function signAuthority(protocol: Pick<ProtocolModule,
  "MODEL_AUTHORITY_VERSION" | "AUTHORITY_TTL_MS" | "authoritySigningInput" | "encodeAuthorityEnvelope" | "turnLeaseSigningInput" | "encodeTurnLeaseEnvelope"
>, privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], keyId: string): { authority: string; lease: string } {
  const now = Date.now();
  const expiresAt = now + protocol.AUTHORITY_TTL_MS;
  const payload: Parameters<ProtocolModule["authoritySigningInput"]>[0] = {
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
  const lease: Parameters<ProtocolModule["turnLeaseSigningInput"]>[0] = {
    v: protocol.MODEL_AUTHORITY_VERSION, keyId, uid: 3, containerId: 7,
    authorityTurnId: payload.authorityTurnId, canonicalModel: MODEL, securityEpoch: 12,
    connectionChallenge: "chal-idle", issuedAt: now - 60_000, expiresAt: now + 30 * 60_000,
  };
  return {
    authority: protocol.encodeAuthorityEnvelope(payload, cryptoSign(null, protocol.authoritySigningInput(payload), privateKey)),
    lease: protocol.encodeTurnLeaseEnvelope(lease, cryptoSign(null, protocol.turnLeaseSigningInput(lease), privateKey)),
  };
}
