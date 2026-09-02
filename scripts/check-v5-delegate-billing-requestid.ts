#!/usr/bin/env tsx
/**
 * Deploy-gate contract for INC-20260902-DELEGATE-ENGINE-BILLING-REQUESTID.
 *
 * Codex/Grok engine delegations used to never write usage_records.mode=delegate:
 * the adapters only emit billing when master minted a 32-hex requestId, while
 * handleDelegateTask passed `undefined` as the sessions.submit requestId. This
 * gate drives the REAL Gateway.prototype.handleDelegateTask with a stub session
 * manager and asserts, fail-closed:
 *   (1) shouldAdmit / resolveEngine contract (codex+grok admit, ccb/glm/cursor skip)
 *   (2) codex delegate: admit once → the minted 32-hex requestId reaches submit
 *       → codex_billing frame is live-settled exactly once with delegate attribution
 *   (3) glm delegate: no admit, no requestId
 *   (4) submit failure: journal abandoned with the same requestId
 *   (5) client durability: failed live settle is queued and retried once with the
 *       same requestId; leftover queue is drained on construct
 *
 * Run: npx --no-install tsx scripts/check-v5-delegate-billing-requestid.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const testHome = mkdtempSync(join(tmpdir(), "oc-delegate-billing-gate-"));
process.env.OPENCLAUDE_HOME = testHome;
process.env.OC_MODEL_AUTHORITY = "0";

process.on("uncaughtException", (err) => {
  console.error(err);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error(err);
  process.exit(1);
});

const billingMod = await import("../packages/gateway/src/delegateEngineBilling.js");
const {
  createDelegateEngineBillingClient,
  resolveDelegateEngineBillingEngine,
  shouldAdmitDelegateEngineBilling,
} = billingMod;
type DelegateEngineBillingClient = import("../packages/gateway/src/delegateEngineBilling.js").DelegateEngineBillingClient;
const serverMod = await import("../packages/gateway/src/server.js");
const { Gateway, PerTurnDelegationGuard } = serverMod;

const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const REQUEST_ID = "ab".repeat(16);
const PARENT_KEY = "agent:main:webchat:dm:wsess-engine-billing-gate";

// ---------------------------------------------------------------- (1) pure contract
assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: "codex" }), true, "codex must admit");
assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: "grok" }), true, "grok must admit");
assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: "ccb" }), false, "ccb must not admit");
assert.equal(shouldAdmitDelegateEngineBilling({ delegateEngine: "cursor" }), false, "cursor must not admit");
assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: "gpt-5.6-sol" }), true, "baked codex id must admit");
assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: "grok-build" }), true, "grok model must admit");
assert.equal(shouldAdmitDelegateEngineBilling({ requestedModel: "glm-5.3-zai" }), false, "glm must not admit");
assert.equal(shouldAdmitDelegateEngineBilling({}), false, "no model → no admit");
assert.equal(resolveDelegateEngineBillingEngine({ delegateEngine: "grok" }), "grok");
assert.equal(resolveDelegateEngineBillingEngine({ model: "grok-build" }), "grok");
assert.equal(resolveDelegateEngineBillingEngine({ delegateEngine: "codex", model: "gpt-5.6-sol" }), "codex");

// ---------------------------------------------------------------- gateway fixture
type BillingStub = DelegateEngineBillingClient & {
  admits: Array<Record<string, unknown>>;
  settles: Array<Record<string, unknown>>;
  abandons: string[];
};

function makeBillingClient(): BillingStub {
  const admits: Array<Record<string, unknown>> = [];
  const settles: Array<Record<string, unknown>> = [];
  const abandons: string[] = [];
  return {
    admits,
    settles,
    abandons,
    async admit(input) {
      admits.push(input as unknown as Record<string, unknown>);
      return { requestId: REQUEST_ID, engineSessionId: `oceng-${"b".repeat(48)}` };
    },
    async settle(billing) {
      settles.push(billing as unknown as Record<string, unknown>);
    },
    async abandon(requestId) {
      abandons.push(requestId);
    },
  };
}

function makeGateway(opts: {
  billing: BillingStub;
  emitBilling?: boolean;
  submitError?: Error;
}): any {
  const agent = { id: "main", provider: "anthropic", model: "glm-5.2" };
  const gw = Object.create(Gateway.prototype) as any;
  gw._shuttingDown = false;
  gw.clientsByPeer = new Map();
  gw.lastActiveChannel = new Map();
  gw._seenIdempotencyKeys = new Map();
  gw._activeDelegations = 0;
  gw._activeDelegationsByParent = new Map();
  gw._hiddenDelegateGuard = new PerTurnDelegationGuard();
  gw._delegateEngineBilling = opts.billing;
  gw._bufferedGroup = undefined;
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
  gw.rateLimiter = { check: () => true };
  gw.router = { route: () => ({ sessionKey: PARENT_KEY, agent }) };
  gw.deps = {
    config: {
      version: 1,
      provider: "anthropic",
      gateway: { bind: "127.0.0.1", port: 18789, accessToken: "test" },
      auth: { mode: "subscription", claudeCodePath: "/tmp/ccb" },
      defaults: { model: "glm-5.2", permissionMode: "default" },
      channels: { webchat: { enabled: true } },
    },
  };
  gw._getAgentsConfig = async () => ({
    default: "main",
    agents: [
      agent,
      { id: "coding-assistant", model: "glm-5.3-zai" },
      { id: "auditor", model: "gpt-5.6-sol" },
    ],
  });
  gw._isIdempotencyDuplicate = () => false;
  gw._markIdempotencyKey = () => {};
  gw._runLog = { start: () => ({}), complete: () => {} };
  gw._lastSubmitRequestId = "UNSET";
  gw._submitArgCount = 0;
  gw.sessions = {
    destroySession: async () => {},
    beginClientTurn: () => {},
    endClientTurn: () => {},
    getByKey: () => ({
      _teamModeTurn: true,
      _currentTurnUserText: "gate task",
      sessionKey: PARENT_KEY,
      channel: "webchat",
      peerId: "wsess-engine-billing-gate",
      agentId: "main",
      userId: "1",
    }),
    getOrCreate: async () => {
      const session = {
        agentId: "auditor",
        currentTurnStatus: null,
        runner: {
          interrupt: () => {},
          shutdown: () => {},
          waitForOutputDrain: async () => {},
          sendPermissionResponse: () => {},
          off: () => {},
          on: () => {},
        },
      };
      gw._session = session;
      return session;
    },
    submit: async (
      _session: unknown,
      _payload: string,
      onEvent: (e: any) => void,
      _effort?: string | null,
      _model?: string,
      requestId?: string,
    ) => {
      gw._lastSubmitRequestId = requestId;
      gw._submitOnEvent = onEvent;
      if (opts.submitError) throw opts.submitError;
      if (opts.emitBilling) {
        onEvent({
          kind: "codex_billing",
          requestId,
          engineSessionId: `oceng-${"b".repeat(48)}`,
          status: "success",
          durationMs: 11,
          usage: { input_tokens: 8, output_tokens: 3 },
          delegateAgentId: "auditor",
          parentSessionId: "wsess-engine-billing-gate",
        });
      }
      onEvent({ kind: "block", block: { kind: "text", text: "gate child done" } });
      onEvent({ kind: "final", meta: { cost: 0, inputTokens: 1, outputTokens: 1, turn: 1 } });
    },
    bufferPendingAgentGroup: (_key: string, group: unknown) => {
      gw._bufferedGroup = group;
      return true;
    },
  };
  gw.deliver = () => {};
  return gw;
}

async function delegate(
  gw: any,
  targetAgentId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: any }> {
  const req: any = { method: "POST", headers: {} };
  gw.readBody = async () => JSON.stringify(body);
  let status = 0;
  let raw = "";
  const res: any = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (chunk?: unknown) => {
      raw = String(chunk ?? "");
    },
  };
  await gw.handleDelegateTask(req, res, targetAgentId);
  return { status, body: raw ? JSON.parse(raw) : {} };
}

function memberBody(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    goal: "gate subtask",
    context: "gate context",
    sourceAgent: "main",
    parentSessionKey: PARENT_KEY,
    ...extra,
  };
}

// ---------------------------------------------------------------- (2) codex admit → submit requestId → live settle
{
  const billing = makeBillingClient();
  const gw = makeGateway({ billing, emitBilling: true });
  const r = await delegate(gw, "auditor", memberBody({ model: "gpt-5.6-sol" }));
  assert.equal(r.status, 200, `codex delegate HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, true, `codex delegate must succeed: ${JSON.stringify(r.body)}`);
  assert.equal(billing.admits.length, 1, "codex delegate must admit exactly once");
  assert.equal(billing.admits[0]?.engine, "codex", "admit engine must be codex");
  assert.equal(billing.admits[0]?.model, "gpt-5.6-sol", "admit model must be the delegate model");
  assert.equal(billing.admits[0]?.delegateAgentId, "auditor", "admit must carry delegateAgentId");
  assert.equal(
    typeof gw._lastSubmitRequestId,
    "string",
    "handleDelegateTask must pass the minted requestId to sessions.submit (was undefined pre-fix)",
  );
  assert.match(
    gw._lastSubmitRequestId,
    REQUEST_ID_RE,
    "sessions.submit requestId must be the master-minted 32-hex id",
  );
  assert.equal(gw._lastSubmitRequestId, REQUEST_ID, "submit requestId must equal the admitted requestId");
  assert.equal(billing.settles.length, 1, "codex_billing frame must be live-settled exactly once");
  assert.equal(billing.abandons.length, 0, "successful delegate must not abandon");
  const settled = billing.settles[0]!;
  assert.equal(settled.requestId, REQUEST_ID, "settle must carry the admitted requestId");
  assert.equal(settled.delegateAgentId, "auditor", "settle must carry delegate attribution");
  assert.equal(settled.parentSessionId, "wsess-engine-billing-gate", "settle must carry parent session");
  assert.equal(settled.kind, undefined, "settle payload must not leak the stream event kind");
}

// ---------------------------------------------------------------- (3) glm delegate: no admit / no requestId
{
  const billing = makeBillingClient();
  const gw = makeGateway({ billing });
  const r = await delegate(gw, "coding-assistant", memberBody({ model: "glm-5.3-zai" }));
  assert.equal(r.status, 200, `glm delegate HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(gw._lastSubmitRequestId, undefined, "glm delegate must not mint a requestId");
  assert.equal(billing.admits.length, 0, "glm delegate must not admit");
  assert.equal(billing.settles.length, 0, "glm delegate must not settle");
  assert.equal(billing.abandons.length, 0, "glm delegate must not abandon");
}

// ---------------------------------------------------------------- (4) submit failure → abandon same requestId
{
  const billing = makeBillingClient();
  const gw = makeGateway({ billing, submitError: new Error("runner crashed") });
  const r = await delegate(gw, "auditor", memberBody({ model: "gpt-5.6-sol" }));
  assert.equal(r.status, 200, `failed codex delegate HTTP ${r.status}: ${JSON.stringify(r.body)}`);
  assert.equal(r.body.ok, false, "failed delegate must report ok=false");
  assert.equal(billing.admits.length, 1, "failed delegate still admits once");
  assert.equal(billing.settles.length, 0, "failed delegate must not settle");
  assert.deepEqual(billing.abandons, [REQUEST_ID], "failed delegate must abandon the admitted requestId");
}

// ---------------------------------------------------------------- (5) client durability
function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(body));
      },
    },
  };
}
const CLIENT_ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: "https://master.invalid",
  OPENCLAUDE_V3_CONTAINER_TOKEN: "container-token",
};
{
  const queuePath = join(testHome, "retry-queue.json");
  let settlePosts = 0;
  const client = createDelegateEngineBillingClient({
    env: CLIENT_ENV,
    queuePath,
    retryMs: 60_000,
    startupRecovery: false,
    fetcher: (async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/settle")) {
        settlePosts += 1;
        if (settlePosts === 1) return response(500, { error: { code: "DELEGATE_ENGINE_BILLING_HTTP_500" } });
        return response(200, { settled: true });
      }
      return response(200, { ok: true });
    }) as any,
  });
  const billing = {
    requestId: "f".repeat(32),
    engineSessionId: `oceng-${"a".repeat(48)}`,
    status: "success" as const,
    durationMs: 4,
    delegateAgentId: "auditor",
  };
  await assert.rejects(() => client.settle(billing), /HTTP_500/, "failed live settle must surface");
  const queued = JSON.parse(readFileSync(queuePath, "utf8")) as { pending: Array<{ requestId: string }> };
  assert.equal(queued.pending.length, 1, "failed settle must be persisted to the durable queue");
  assert.equal(queued.pending[0]?.requestId, billing.requestId, "queued row must keep the same requestId");
  await client.retryPending?.();
  assert.equal(settlePosts, 2, "retryPending must re-POST the same requestId once");
  const drained = JSON.parse(readFileSync(queuePath, "utf8")) as { pending: unknown[] };
  assert.deepEqual(drained.pending, [], "successful retry must drain the queue");
  await client.retryPending?.();
  assert.equal(settlePosts, 2, "drained queue must not POST the same requestId again");
}
{
  const queuePath = join(testHome, "boot-queue.json");
  const leftover = {
    requestId: "1".repeat(32),
    engineSessionId: `oceng-${"a".repeat(48)}`,
    status: "success" as const,
    durationMs: 1,
  };
  writeFileSync(queuePath, `${JSON.stringify({ schemaVersion: 1, pending: [leftover] })}\n`);
  let settledRequestId = "";
  let release!: () => void;
  const sawSettle = new Promise<void>((resolveSettle) => {
    release = resolveSettle;
  });
  createDelegateEngineBillingClient({
    env: CLIENT_ENV,
    queuePath,
    retryMs: 10,
    fetcher: (async (url: string, options: { body: string }) => {
      if (new URL(url).pathname.endsWith("/settle")) {
        settledRequestId = (JSON.parse(options.body) as { requestId: string }).requestId;
        release();
        return response(200, { settled: true });
      }
      return response(200, { ok: true });
    }) as any,
  });
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("startup recovery did not drain the leftover queue within 5s")), 5000),
  );
  await Promise.race([sawSettle, timeout]);
  assert.equal(settledRequestId, leftover.requestId, "startup drain must settle the leftover requestId");
  let drained = false;
  for (let i = 0; i < 50 && !drained; i++) {
    const q = JSON.parse(readFileSync(queuePath, "utf8")) as { pending: unknown[] };
    drained = q.pending.length === 0;
    if (!drained) await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(drained, "startup drain must rewrite the queue file as empty");
}

// ---------------------------------------------------------------- deploy wiring must keep referencing this gate
const commercialDeploy = readFileSync(join(root, "scripts/deploy-v5.sh"), "utf8");
assert.ok(
  commercialDeploy.includes("check-v5-delegate-billing-requestid.ts"),
  "deploy-v5.sh must invoke check-v5-delegate-billing-requestid.ts",
);
const selfhostRelease = readFileSync(join(root, "scripts/v5-selfhost-master-release-lib.sh"), "utf8");
assert.ok(
  selfhostRelease.includes("check-v5-delegate-billing-requestid.ts"),
  "v5-selfhost-master-release-lib.sh must invoke check-v5-delegate-billing-requestid.ts",
);

rmSync(testHome, { recursive: true, force: true });
console.log(
  "[delegate-billing-requestid] PASS — codex/grok delegate admits a 32-hex requestId that reaches sessions.submit, codex_billing is live-settled once with delegate attribution, glm skips, failures abandon, failed settles are queued and retried once",
);
process.exit(0);
