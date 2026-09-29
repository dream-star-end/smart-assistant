/**
 * OCV5-296 C: verified Box byte envelope.
 * Exercises the production handler, Prepared continuation, fingerprint and
 * text plan. Does not exec Box, publish a tool result, or treat a stub 200
 * as a terminal model turn.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MODEL_AUTHORITY_VERSION,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type TurnLease,
} from "@openclaude/protocol";

import { makeBoxTextPlan, BoxTextPlanError } from "./boxTextPlan.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";
import {
  deriveBoxCallFingerprint,
  deriveBoxContextHash,
  hashBoxAssistantContent,
  BoxCallFingerprintError,
} from "./boxCallFingerprint.js";
import { prepareBoxContinuation } from "./boxPreparedContinuation.js";
import { BOX_TOOL_MAX_ROUNDS, BOX_TOOL_MAX_WALL_MS } from "./boxToolCapacity.js";
import { makeAnthropicProxyHandler } from "./index.js";
import { TURN_LEASE_HEADER } from "./modelAuthorityGate.js";
import {
  BOX_NATIVE_CONTEXT_OWNER,
  HttpError,
  MAX_BODY_BYTES_HARD_CEILING,
  PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
  PROXY_BYTE_BUDGET_LEGACY,
  budgetFromVerifiedGate,
  enforceFieldByteBudgets,
  readBoxNativeContextOwner,
  runWithVerifiedProxyByteBudget,
  selectVerifiedBoxByteBudget,
  type AnthropicProxyDeps,
  type ProxyBody,
} from "./shared.js";

const MODEL = "box-api-claude-opus-5-5";
const CHUNK = 128 * 1024;
const supervisor = readFileSync(new URL("../../../../../scripts/ocv5-289/box_supervisor.py", import.meta.url));
const keeper = readFileSync(new URL("../../../../../scripts/ocv5-289/box_keeper.py", import.meta.url));

function rounds(n: number): unknown[] {
  const messages: unknown[] = [{ role: "user", content: "start" }];
  for (let i = 0; i < n; i += 1) {
    const id = `toolu_${String(i).padStart(6, "0")}`;
    messages.push({
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: { path: `f${i}` } }],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: "x".repeat(CHUNK) }],
    });
  }
  return messages;
}

function bodyOf(messages: unknown[], extra: Record<string, unknown> = {}): ProxyBody {
  return {
    model: MODEL,
    max_tokens: 128,
    stream: true,
    messages,
    ...extra,
  } as ProxyBody;
}

const turnMeta = {
  user_id: JSON.stringify({
    oc_turn_key: "ab".repeat(32),
    session_id: "box-budget-session",
  }),
};

test("envelope selector ignores model text and headers", () => {
  const profile = {
    supportsVision: false,
    reasoning: { supported: [], codexModelDefault: null },
    ccb: {
      capabilityZero: false,
      supportsThinking: true,
      contextOwner: BOX_NATIVE_CONTEXT_OWNER,
    },
  };
  assert.equal(readBoxNativeContextOwner(profile), BOX_NATIVE_CONTEXT_OWNER);
  assert.equal(readBoxNativeContextOwner({ ccb: { contextOwner: "box-native-v2" } }), null);
  assert.equal(readBoxNativeContextOwner({ ccb: { context_owner: BOX_NATIVE_CONTEXT_OWNER } }), null);
  assert.equal(readBoxNativeContextOwner({ ccb: "box-native-v1" }), null);
  const granted = selectVerifiedBoxByteBudget({
    authorityKind: "bridge_signed",
    routeKind: "box",
    capabilityProfile: profile,
    serverRouteReady: true,
  });
  assert.equal(granted.id, "box-native-v1");
  assert.equal(granted.messages, 16 * 1024 * 1024);
  assert.equal(granted.totalBody, 24 * 1024 * 1024);
  assert.equal(granted.contextHash, 24 * 1024 * 1024);
  assert.equal(granted.snapshot, 24 * 1024 * 1024);
  assert.equal(granted.system, PROXY_BYTE_BUDGET_LEGACY.system);
  assert.equal(granted.tools, PROXY_BYTE_BUDGET_LEGACY.tools);
  for (const broken of [
    { authorityKind: "local_catalog" },
    { routeKind: "oauth" },
    { routeKind: "static" },
    { serverRouteReady: false },
    { capabilityProfile: { ccb: { capabilityZero: false } } },
    { authorityKind: "bridge_signed", routeKind: "box", serverRouteReady: true,
      capabilityProfile: { ccb: { contextOwner: "client-said-so" } } },
  ] as const) {
    assert.equal(selectVerifiedBoxByteBudget({
      authorityKind: "bridge_signed",
      routeKind: "box",
      capabilityProfile: profile,
      serverRouteReady: true,
      ...broken,
    }).id, "legacy");
  }
  assert.equal(budgetFromVerifiedGate(null, "box", true).id, "legacy");
  assert.equal(BOX_TOOL_MAX_ROUNDS, 128);
  assert.equal(BOX_TOOL_MAX_WALL_MS, 4 * 60 * 60 * 1000);
});

test("64x128KiB passes only the verified messages budget", () => {
  const sixtyThree = bodyOf(rounds(63));
  const sixtyFour = bodyOf(rounds(64));
  const bytes63 = Buffer.byteLength(JSON.stringify(sixtyThree.messages), "utf8");
  const bytes64 = Buffer.byteLength(JSON.stringify(sixtyFour.messages), "utf8");
  assert.ok(bytes63 <= PROXY_BYTE_BUDGET_LEGACY.messages, `63 rounds ${bytes63}`);
  assert.ok(bytes64 > PROXY_BYTE_BUDGET_LEGACY.messages, `64 rounds ${bytes64}`);
  assert.ok(bytes64 <= PROXY_BYTE_BUDGET_BOX_NATIVE_V1.messages, `64 rounds ${bytes64}`);
  assert.doesNotThrow(() => enforceFieldByteBudgets(sixtyThree));
  assert.throws(() => enforceFieldByteBudgets(sixtyFour), (error: unknown) =>
    error instanceof HttpError && error.status === 413 && error.code === "BODY_FIELD_TOO_LARGE");
  assert.doesNotThrow(() => enforceFieldByteBudgets(sixtyFour, PROXY_BYTE_BUDGET_BOX_NATIVE_V1));
  console.log(JSON.stringify({
    event: "ocv5-296-messages-bytes",
    rounds63: bytes63,
    rounds64: bytes64,
  }));
});

test("context hash ceiling moves only inside the verified budget", () => {
  const small = bodyOf([{ role: "user", content: "same-shape" }]);
  const legacyHash = deriveBoxContextHash(small);
  const trustedHash = runWithVerifiedProxyByteBudget(
    PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
    () => deriveBoxContextHash(small),
  );
  assert.equal(legacyHash, trustedHash);
  assert.match(legacyHash, /^[a-f0-9]{64}$/);
  const wide = bodyOf([{ role: "user", content: "w".repeat(20 * 1024 * 1024) }]);
  assert.throws(() => deriveBoxContextHash(wide), (error: unknown) =>
    error instanceof BoxCallFingerprintError && error.code === "BOX_CALL_BODY_TOO_LARGE");
  const hashed = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () => {
    const context = deriveBoxContextHash(wide);
    const fingerprint = deriveBoxCallFingerprint(3n, {
      ...wide,
      metadata: turnMeta,
    });
    return { context, fingerprint };
  });
  assert.match(hashed.context, /^[a-f0-9]{64}$/);
  assert.match(hashed.fingerprint.requestHash, /^[a-f0-9]{64}$/);
  runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () => {
    assert.throws(() => hashBoxAssistantContent([
      { type: "text", text: "a".repeat(17 * 1024 * 1024) },
    ]), /BOX_CALL_BODY_TOO_LARGE/);
  });
});

test("64 completed rounds reach Prepared and a real text plan, not a fake 200", () => {
  const live = bodyOf(rounds(64), {
    metadata: turnMeta,
    tools: [{ name: "Read", description: "read a file", input_schema: { type: "object" } }],
  });
  const prepared = runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () =>
    prepareBoxContinuation({
      uid: 3n,
      canonicalModel: MODEL,
      rawBody: live,
      authorityKind: "bridge_signed",
      authorityTurnId: "ab".repeat(16),
    }));
  assert.equal(prepared.classification, "continuation_candidate");
  assert.match(prepared.nextContextHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(prepared.priorContextHash ?? "", /^[a-f0-9]{64}$/);
  assert.match(prepared.fingerprint?.replayFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(prepared.authority.kind, "bridge_signed");

  const finished = rounds(64);
  finished.push({ role: "user", content: [{ type: "text", text: "continue" }] });
  const historical = bodyOf(finished);
  const mapped = compileBoxCliSyntheticTurn(
    { ...historical, model: "claude-opus-5-5" },
    { cwd: "/tmp/ocv5-289-run-000000000000000000000000", cliVersion: "2.1.280" },
  );
  const snapshotBytes = Buffer.byteLength(mapped.snapshotJsonl);
  assert.ok(snapshotBytes > 8 * 1024 * 1024, `snapshot ${snapshotBytes}`);
  assert.ok(snapshotBytes <= 24 * 1024 * 1024, `snapshot ${snapshotBytes}`);
  console.log(JSON.stringify({ event: "ocv5-296-snapshot-bytes", snapshotBytes }));
  const planInput = {
    body: historical,
    upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 8192,
    supervisorAsset: supervisor,
    keeperAsset: keeper,
  };
  assert.throws(() => makeBoxTextPlan(planInput), (error: unknown) =>
    error instanceof BoxTextPlanError && error.code === "BOX_TEXT_INPUT_TOO_LARGE");
  // Snapshot ceiling is raised, but boxStageFiles.ts still rejects a single
  // staged file above 8 MiB. That file is outside this change set. The 64-round
  // history therefore stops at BOX_STAGE_FILE_INVALID and does not build argv.
  assert.throws(() => runWithVerifiedProxyByteBudget(
    PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
    () => makeBoxTextPlan(planInput),
  ), (error: unknown) => error instanceof Error && "code" in error
    && (error as { code: string }).code === "BOX_STAGE_FILE_INVALID");
  const smallHistory = rounds(40);
  smallHistory.push({ role: "user", content: [{ type: "text", text: "continue" }] });
  const smallPlan = makeBoxTextPlan({ ...planInput, body: bodyOf(smallHistory) });
  assert.ok(smallPlan.snapshotHash && /^[a-f0-9]{64}$/.test(smallPlan.snapshotHash));
  assert.ok(smallPlan.stageInputs.length > 0);
  assert.ok(smallPlan.run.args.includes("--resume") || smallPlan.run.args.includes("--session-id"));
  assert.equal(smallPlan.run.command, "/usr/bin/python3");
  const tooBig = bodyOf([
    { role: "user", content: "h".repeat(25 * 1024 * 1024) },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
    { role: "user", content: "next" },
  ]);
  assert.throws(() => runWithVerifiedProxyByteBudget(PROXY_BYTE_BUDGET_BOX_NATIVE_V1, () => makeBoxTextPlan({
    body: tooBig,
    upstreamModel: "claude-opus-5-5",
    maxOutputTokensLimit: 8192,
    supervisorAsset: supervisor,
    keeperAsset: keeper,
  })), (error: unknown) => error instanceof BoxTextPlanError && error.code === "BOX_TEXT_INPUT_TOO_LARGE");
});

test("24MiB candidate memory is measured, not declared safe", async () => {
  const filler = 23 * 1024 * 1024;
  const payload = Buffer.concat([
    Buffer.from('{"model":"m","max_tokens":1,"messages":[{"role":"user","content":"'),
    Buffer.alloc(filler, 0x61),
    Buffer.from('"}]}'),
  ]);
  assert.ok(payload.length < MAX_BODY_BYTES_HARD_CEILING);
  assert.ok(payload.length > 16 * 1024 * 1024);
  const before = process.memoryUsage();
  const started = process.hrtime.bigint();
  const parsed = await Promise.all([0, 1].map(async () => JSON.parse(payload.toString("utf8")) as { messages: unknown[] }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const after = process.memoryUsage();
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].messages.length, 1);
  assert.equal(parsed[1].messages.length, 1);
  const rssDelta = after.rss - before.rss;
  console.log(JSON.stringify({
    event: "ocv5-296-memory",
    payloadBytes: payload.length,
    concurrentParses: 2,
    elapsedMs: Math.round(elapsedMs),
    rssBefore: before.rss,
    rssAfter: after.rss,
    rssDelta,
    heapUsedDelta: after.heapUsed - before.heapUsed,
    externalDelta: after.external - before.external,
  }));
  assert.ok(Number.isFinite(rssDelta));
});

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
const KEY_ID = "mak1_testkey00000001";
const keyring = new Map<string, Uint8Array>([[KEY_ID, new Uint8Array(publicRaw)]]);
const EPOCH = 12;

function signLease(canonicalModel = MODEL): string {
  const now = Date.now();
  const lease: TurnLease = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: KEY_ID,
    uid: 3,
    containerId: 7,
    authorityTurnId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    canonicalModel,
    securityEpoch: EPOCH,
    connectionChallenge: "chal-budget",
    issuedAt: now,
    expiresAt: now + 30 * 60_000,
  };
  return encodeTurnLeaseEnvelope(lease, cryptoSign(null, turnLeaseSigningInput(lease), privateKey));
}

function profile(owner: string | null): Record<string, unknown> {
  return {
    supportsVision: false,
    reasoning: { supported: [], codexModelDefault: null },
    ccb: {
      capabilityZero: false,
      supportsThinking: true,
      ...(owner ? { contextOwner: owner } : {}),
    },
  };
}

function catalog(providerId: string, owner: string | null) {
  const descriptor = {
    canonicalModel: MODEL,
    engine: "ccb",
    providerId,
    upstreamModelId: "claude-opus-5-5",
    contextWindow: 200_000,
    capabilityProfile: profile(owner),
    capabilitySchemaVersion: 1,
    defaultEffort: null,
  };
  const pricing = {
    model_id: MODEL,
    display_name: "Box",
    input_per_mtok: 1n,
    output_per_mtok: 1n,
    cache_read_per_mtok: 1n,
    cache_write_per_mtok: 1n,
    multiplier: "1.000",
    enabled: true,
    sort_order: 0,
    visibility: "public",
    extra_system_prompt: null,
    default_effort: null,
    updated_at: new Date(),
  };
  const snapshot = {
    securityEpoch: BigInt(EPOCH),
    executionRevision: "b".repeat(64),
    billingRevision: "c".repeat(64),
    aliasToCanonical: (model: string) => model,
    resolve: (model: string) => (model === MODEL ? descriptor : null),
    canUseModel: () => true,
    billingPricingFor: (model: string) => (model === MODEL ? pricing : null),
    projectionRevisionFor: () => "d".repeat(64),
  };
  return {
    async assertFresh() { return snapshot; },
  };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  body = "";
  headersSent = false;
  setHeader(): void {}
  writeHead(status: number): this {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }
  end(chunk?: string | Buffer): void {
    if (chunk) this.body += chunk.toString();
    this.headersSent = true;
  }
  json(): { error?: { code?: string } } {
    return this.body ? JSON.parse(this.body) as { error?: { code?: string } } : {};
  }
}

function request(payload: Buffer | object, headers: Record<string, string> = {}): IncomingMessage {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = "POST";
  req.url = "/v1/messages";
  req.headers = { host: "127.0.0.1", ...headers };
  return req;
}

function handlerFor(options: {
  catalog?: ReturnType<typeof catalog> | null;
  enforce?: boolean;
  box?: boolean;
  lease?: string | null;
} = {}) {
  let launches = 0;
  const previous = process.env.OC_BOX_MODEL_API;
  if (options.box) process.env.OC_BOX_MODEL_API = "1";
  else delete process.env.OC_BOX_MODEL_API;
  const deps = {
    pgPool: {},
    pricing: { get: () => null },
    preCheckRedis: {
      async atomicReserve() { throw new Error("precheck-should-not-launch"); },
      async releaseReservation() { return true; },
    },
    scheduler: {},
    identity: {
      async resolve() { return { uid: 3n, containerId: 7n }; },
      async authorize() {},
    },
    loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set<string>() }),
    rateLimitRedis: { async incr() { return 1; }, async expire() { return 1; } },
    ...(options.catalog ? { modelCatalog: options.catalog, modelAuthorityEnforce: options.enforce !== false } : {}),
    authorityKeyring: () => keyring,
    boxModel: {
      async fetch() {
        launches += 1;
        throw new Error("box-launch");
      },
    },
  } as unknown as AnthropicProxyDeps;
  return {
    launches: () => launches,
    restore() {
      if (previous === undefined) delete process.env.OC_BOX_MODEL_API;
      else process.env.OC_BOX_MODEL_API = previous;
    },
    handler: makeAnthropicProxyHandler(deps),
  };
}

async function call(payload: Buffer | object, options: Parameters<typeof handlerFor>[0] = {}, headers: Record<string, string> = {}) {
  const harness = handlerFor(options);
  const res = new MockRes();
  let thrown: unknown = null;
  try {
    await harness.handler(
      request(payload, headers),
      res as unknown as ServerResponse,
      { hostUuid: "budget-test", boundIp: "127.0.0.1" },
    );
  } catch (error) {
    thrown = error;
  } finally {
    harness.restore();
  }
  return { res, thrown, launches: harness.launches() };
}

test("production handler keeps legacy and hard ceilings, and does not launch", async () => {
  const sixtyFour = bodyOf(rounds(64), { metadata: turnMeta });
  const legacy = await call(sixtyFour);
  assert.equal(legacy.launches, 0);
  assert.equal(legacy.res.statusCode, 413);
  assert.equal(legacy.res.json().error?.code, "BODY_FIELD_TOO_LARGE");

  const overMessages = bodyOf([{ role: "user", content: "m".repeat(16 * 1024 * 1024 + 64) }]);
  const capped = await call(overMessages, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
    lease: signLease(),
  }, { [TURN_LEASE_HEADER]: signLease() });
  assert.equal(capped.launches, 0);
  assert.equal(capped.res.statusCode, 413);
  assert.equal(capped.res.json().error?.code, "BODY_FIELD_TOO_LARGE");

  const raw = Buffer.concat([
    Buffer.from('{"model":"claude-sonnet-4-6","max_tokens":16,"stream":true,"messages":[{"role":"user","content":"'),
    Buffer.alloc(MAX_BODY_BYTES_HARD_CEILING, 0x61),
    Buffer.from('"}]}'),
  ]);
  const tooRaw = await call(raw);
  assert.equal(tooRaw.launches, 0);
  assert.equal(tooRaw.res.statusCode, 413);
  assert.equal(tooRaw.res.json().error?.code, "PAYLOAD_TOO_LARGE");
});

test("production handler admits the verified envelope and still rejects bad sig, non-box, and missing capability", async () => {
  const nine = bodyOf([{ role: "user", content: "n".repeat(9 * 1024 * 1024) }]);
  const lease = signLease();
  const admitted = await call(nine, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
    lease,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(admitted.launches, 0, "fetch must not run");
  assert.notEqual(admitted.res.statusCode, 413, admitted.res.body || String(admitted.thrown));
  assert.ok(admitted.thrown instanceof Error, `expected pre-launch failure, status=${admitted.res.statusCode} body=${admitted.res.body}`);

  const badSig = await call(nine, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
  }, { [TURN_LEASE_HEADER]: "not-a-signature" });
  assert.equal(badSig.launches, 0);
  assert.equal(badSig.res.statusCode, 413);

  const badSigSmall = await call(bodyOf([{ role: "user", content: "hi" }]), {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
  }, { [TURN_LEASE_HEADER]: "not-a-signature" });
  assert.equal(badSigSmall.launches, 0);
  assert.equal(badSigSmall.res.statusCode, 403);
  assert.equal(badSigSmall.res.json().error?.code, "MODEL_AUTHORITY_INVALID");

  const notBox = await call(nine, {
    catalog: catalog("anthropic", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(notBox.launches, 0);
  assert.equal(notBox.res.statusCode, 413);

  const noCap = await call(nine, {
    catalog: catalog("box_cli", null),
    box: true,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(noCap.launches, 0);
  assert.equal(noCap.res.statusCode, 413);

  const notReady = await call(nine, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: false,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(notReady.launches, 0);
  assert.equal(notReady.res.statusCode, 413);

  const headerOnly = await call(nine, {
    catalog: catalog("box_cli", null),
    box: true,
  }, {
    [TURN_LEASE_HEADER]: lease,
    "x-oc-context-owner": BOX_NATIVE_CONTEXT_OWNER,
  });
  assert.equal(headerOnly.launches, 0);
  assert.equal(headerOnly.res.statusCode, 413);
});
