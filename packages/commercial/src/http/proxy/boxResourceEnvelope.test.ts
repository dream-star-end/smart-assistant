/**
 * OCV5-296 C: verified Box byte envelope.
 * Exercises the production handler, Prepared continuation, fingerprint and
 * text plan. Does not exec Box, publish a tool result, or treat a stub 200
 * as a terminal model turn.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  AUTHORITY_TTL_MS,
  MODEL_AUTHORITY_VERSION,
  authoritySigningInput,
  encodeAuthorityEnvelope,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type ModelAuthorityPayload,
  type TurnLease,
} from "@openclaude/protocol";
import type { BoxCcExecRequest } from "@openclaude/gateway";

import { makeBoxStageFiles } from "./boxStageFiles.js";
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
import { AUTHORITY_HEADER, TURN_LEASE_HEADER } from "./modelAuthorityGate.js";
import {
  BOX_NATIVE_CONTEXT_OWNER,
  HttpError,
  MAX_BODY_BYTES_HARD_CEILING,
  PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
  PROXY_BYTE_BUDGET_LEGACY,
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
  const grantedInput = {
    authorityKind: "bridge_signed" as const,
    routeKind: "box" as const,
    canonicalModel: MODEL,
    providerId: "box_cli",
    declaredContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    verifiedSignedContextOwner: BOX_NATIVE_CONTEXT_OWNER,
    routeReady: true,
  };
  const granted = selectVerifiedBoxByteBudget(grantedInput);
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
    { routeReady: false },
    { providerId: "ark" },
    { canonicalModel: "claude-opus-5-5" },
    { declaredContextOwner: undefined },
    { verifiedSignedContextOwner: null },
    { declaredContextOwner: "client-said-so" },
  ]) {
    assert.equal(selectVerifiedBoxByteBudget({ ...grantedInput, ...broken }).id, "legacy");
  }
  assert.equal(profile.ccb.contextOwner, BOX_NATIVE_CONTEXT_OWNER);
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
  const plan = runWithVerifiedProxyByteBudget(
    PROXY_BYTE_BUDGET_BOX_NATIVE_V1,
    () => makeBoxTextPlan(planInput),
  );
  assert.ok(plan.snapshotHash && /^[a-f0-9]{64}$/.test(plan.snapshotHash));
  assert.ok(plan.stageInputs.length > 0);
  assert.equal(plan.run.args.includes("--output-format"), true);
  const root = `/tmp/ocv5-296-stage-${randomBytes(4).toString("hex")}`;
  const from = "/home/box/.claude/projects";
  mkdirSync(root, { mode: 0o700 });
  const started = process.hrtime.bigint();
  const run = (step: BoxCcExecRequest) => spawnSync(
    step.command,
    step.args.map((arg) => arg.replaceAll(from, root)),
    { cwd: step.cwd, env: step.environment, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60_000 },
  );
  try {
    for (const step of plan.stageInputs) {
      const result = run(step);
      assert.equal(result.status, 0, result.stderr);
    }
    const projectDir = `${root}/${plan.cwd.replaceAll("/", "-")}`;
    const snapName = readdirSync(projectDir).find((name) => name.endsWith(".jsonl"));
    assert.ok(snapName);
    const published = readFileSync(`${projectDir}/${snapName}`);
    assert.equal(createHash("sha256").update(published).digest("hex"), plan.snapshotHash);
    assert.ok(published.length > 8 * 1024 * 1024, `published ${published.length}`);
    const cleaned = run(plan.cleanup);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    console.log(JSON.stringify({
      event: "ocv5-296-stage-exec",
      snapshotBytes: published.length,
      stageSteps: plan.stageInputs.length,
      elapsedMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6),
      claudeArgvExecuted: false,
    }));
  } finally {
    rmSync(plan.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
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

function runStep(step: BoxCcExecRequest, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args.map((arg) => arg.replaceAll(from, to)), {
      cwd: step.cwd, env: step.environment,
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `exit ${code}`)));
  });
}

test("two concurrent snapshot stages record RSS and time", async () => {
  const raw = Buffer.alloc(9 * 1024 * 1024, 0x71);
  const hash = createHash("sha256").update(raw).digest("hex");
  const jobs = [0, 1].map((index) => {
    const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
    const project = `/home/box/.claude/projects/${cwd.replaceAll("/", "-")}`;
    const sid = "12345678-1234-4123-8123-123456789abc";
    const plan = makeBoxStageFiles({
      cwd, project, snapshotMaxBytes: 24 * 1024 * 1024,
      files: [{ path: `${project}/${sid}.jsonl`, raw, hash }],
    });
    const root = `/tmp/ocv5-296-conc-${index}-${randomBytes(3).toString("hex")}`;
    return { cwd, sid, plan, root };
  });
  const before = process.memoryUsage();
  const started = process.hrtime.bigint();
  const results = await Promise.all(jobs.map(async (job) => {
    mkdirSync(job.root, { mode: 0o700 });
    try {
      for (const step of job.plan.requests) {
        await runStep(step, "/home/box/.claude/projects", job.root);
      }
      const published = readFileSync(`${job.root}/${job.cwd.replaceAll("/", "-")}/${job.sid}.jsonl`);
      return published.length;
    } finally {
      rmSync(job.cwd, { recursive: true, force: true });
      rmSync(job.root, { recursive: true, force: true });
    }
  }));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  const after = process.memoryUsage();
  assert.deepEqual(results, [raw.length, raw.length]);
  console.log(JSON.stringify({
    event: "ocv5-296-memory",
    kind: "two-concurrent-9MiB-snapshot-stage",
    payloadBytes: raw.length,
    concurrent: 2,
    elapsedMs: Math.round(elapsedMs),
    rssBefore: before.rss,
    rssAfter: after.rss,
    rssDelta: after.rss - before.rss,
    heapUsedDelta: after.heapUsed - before.heapUsed,
  }));
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

function signAuthorityWithOwner(): string {
  const now = Date.now();
  const payload: ModelAuthorityPayload = {
    v: MODEL_AUTHORITY_VERSION,
    keyId: KEY_ID,
    uid: 3,
    containerId: 7,
    authorityTurnId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    connectionChallenge: "chal-budget",
    canonicalModel: MODEL,
    engine: "ccb",
    executionDescriptor: {
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: true, contextOwner: "box-native-v1" },
      },
      capabilitySchemaVersion: 1,
      contextWindow: 200_000,
      supportedEfforts: [],
      supportsVision: false,
    },
    executionRevision: "b".repeat(64),
    securityEpoch: EPOCH,
    issuedAt: now,
    expiresAt: now + AUTHORITY_TTL_MS,
  };
  return encodeAuthorityEnvelope(payload, cryptoSign(null, authoritySigningInput(payload), privateKey));
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

test("production handler keeps the enlarged envelope off while route-ready is false", async () => {
  const nine = bodyOf([{ role: "user", content: "n".repeat(9 * 1024 * 1024) }]);
  const lease = signLease();
  const leaseOnly = await call(nine, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
    lease,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(leaseOnly.launches, 0);
  assert.equal(leaseOnly.res.statusCode, 413, "lease-only has no capability");

  const signedCap = await call(nine, {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
  }, { [AUTHORITY_HEADER]: signAuthorityWithOwner() });
  assert.equal(signedCap.launches, 0);
  assert.equal(signedCap.res.statusCode, 413, "signed token does not override route-ready false");

  const withinLegacy = await call(bodyOf([{ role: "user", content: "hi" }]), {
    catalog: catalog("box_cli", BOX_NATIVE_CONTEXT_OWNER),
    box: true,
  }, { [TURN_LEASE_HEADER]: lease });
  assert.equal(withinLegacy.launches, 0);
  assert.notEqual(withinLegacy.res.statusCode, 413);
  assert.ok(withinLegacy.thrown instanceof Error, "within legacy still stops before Box fetch");

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
