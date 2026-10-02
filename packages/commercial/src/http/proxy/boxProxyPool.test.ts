/**
 * OCV5-297: Box-routed requests move from the shared per-uid slot to the Box
 * pool once the verified route is Box, and Box / general traffic are rate
 * counted on separate keys. Without injected Box deps nothing changes.
 * Runs until pre-check (no DB here) and never launches Box; slot order is
 * observed through recording limiters.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import {
  MODEL_AUTHORITY_VERSION,
  encodeTurnLeaseEnvelope,
  turnLeaseSigningInput,
  type TurnLease,
} from "@openclaude/protocol";

import { makeAnthropicProxyHandler } from "./index.js";
import { TURN_LEASE_HEADER } from "./modelAuthorityGate.js";
import {
  ConcurrencyLimiter,
  DEFAULT_PROXY_RATE_LIMIT,
  type AnthropicProxyDeps,
} from "./shared.js";

const MODEL = "box-api-claude-opus-5-5";

/** Records acquire/release order across the shared and Box pools. */
class SpyLimiter extends ConcurrencyLimiter {
  constructor(max: number, private readonly label: string, private readonly events: string[]) { super(max); }
  override acquire(key: string): (() => void) | null {
    const release = super.acquire(key);
    if (!release) { this.events.push(`${this.label}!`); return null; }
    this.events.push(`${this.label}+`);
    return () => { this.events.push(`${this.label}-`); release(); };
  }
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicRaw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
const KEY_ID = "mak1_testkey00000001";
const keyring = new Map<string, Uint8Array>([[KEY_ID, new Uint8Array(publicRaw)]]);
const EPOCH = 12;

function signLease(): string {
  const now = Date.now();
  const lease: TurnLease = {
    v: MODEL_AUTHORITY_VERSION, keyId: KEY_ID, uid: 3, containerId: 7,
    authorityTurnId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", canonicalModel: MODEL,
    securityEpoch: EPOCH, connectionChallenge: "chal-pool", issuedAt: now, expiresAt: now + 30 * 60_000,
  };
  return encodeTurnLeaseEnvelope(lease, cryptoSign(null, turnLeaseSigningInput(lease), privateKey));
}

function catalog(providerId: string) {
  const descriptor = {
    canonicalModel: MODEL, engine: "ccb", providerId, upstreamModelId: "claude-opus-5-5",
    contextWindow: 200_000,
    capabilityProfile: { supportsVision: false, reasoning: { supported: [], codexModelDefault: null },
      ccb: { capabilityZero: false, supportsThinking: true } },
    capabilitySchemaVersion: 1, defaultEffort: null,
  };
  const pricing = {
    model_id: MODEL, display_name: "Box", input_per_mtok: 1n, output_per_mtok: 1n,
    cache_read_per_mtok: 1n, cache_write_per_mtok: 1n, multiplier: "1.000", enabled: true,
    sort_order: 0, visibility: "public", extra_system_prompt: null, default_effort: null,
    updated_at: new Date(),
  };
  const snapshot = {
    securityEpoch: BigInt(EPOCH), executionRevision: "b".repeat(64), billingRevision: "c".repeat(64),
    aliasToCanonical: (model: string) => model,
    resolve: (model: string) => (model === MODEL ? descriptor : null),
    canUseModel: () => true,
    billingPricingFor: (model: string) => (model === MODEL ? pricing : null),
    projectionRevisionFor: () => "d".repeat(64),
  };
  return { async assertFresh() { return snapshot; } };
}

class MockRes extends EventEmitter {
  statusCode = 0;
  body = "";
  headersSent = false;
  setHeader(): void {}
  writeHead(status: number): this { this.statusCode = status; this.headersSent = true; return this; }
  end(chunk?: string | Buffer): void { if (chunk) this.body += chunk.toString(); this.headersSent = true; }
  code(): string | undefined {
    return this.body ? (JSON.parse(this.body) as { error?: { code?: string } }).error?.code : undefined;
  }
}

function request(): IncomingMessage {
  const body = {
    model: MODEL, max_tokens: 64, stream: true,
    messages: [{ role: "user", content: "hi" }],
    metadata: { user_id: JSON.stringify({ oc_turn_key: "ab".repeat(32), session_id: "pool-session" }) },
  };
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
  req.method = "POST";
  req.url = "/v1/messages";
  req.headers = { host: "127.0.0.1", [TURN_LEASE_HEADER]: signLease() };
  return req;
}

interface Harness {
  shared: ConcurrencyLimiter;
  keys: string[];
  counts: Map<string, number>;
}

async function call(providerId: string, extra: Partial<AnthropicProxyDeps> = {},
  incr: (key: string, counts: Map<string, number>) => number = (key, counts) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  }): Promise<{ res: MockRes; harness: Harness }> {
  const previous = process.env.OC_BOX_MODEL_API;
  process.env.OC_BOX_MODEL_API = "1";
  const shared = (extra.concurrencyLimiter as ConcurrencyLimiter | undefined) ?? new ConcurrencyLimiter(4);
  const harness: Harness = { shared, keys: [], counts: new Map() };
  const deps = {
    pgPool: {},
    pricing: { get: () => null },
    preCheckRedis: {
      async atomicReserve() { throw new Error("precheck-stop"); },
      async releaseReservation() { return true; },
    },
    scheduler: {},
    identity: { async resolve() { return { uid: 3n, containerId: 7n }; }, async authorize() {} },
    loadUserModelAuthz: async () => ({ role: "admin", grantedModelIds: new Set<string>() }),
    rateLimitRedis: {
      async incr(key: string) { harness.keys.push(key); return incr(key, harness.counts); },
      async expire() { return 1; },
    },
    modelCatalog: catalog(providerId),
    modelAuthorityEnforce: true,
    authorityKeyring: () => keyring,
    boxModel: { async fetch() { throw new Error("box-launch"); } },
    ...extra,
    concurrencyLimiter: shared,
  } as unknown as AnthropicProxyDeps;
  const res = new MockRes();
  try {
    await makeAnthropicProxyHandler(deps)(request(), res as unknown as ServerResponse,
      { hostUuid: "pool-test", boundIp: "127.0.0.1" }).catch(() => {});
  } finally {
    if (previous === undefined) delete process.env.OC_BOX_MODEL_API;
    else process.env.OC_BOX_MODEL_API = previous;
  }
  return { res, harness };
}

const boxRate = { ...DEFAULT_PROXY_RATE_LIMIT, scope: "proxy_uid_box", windowSeconds: 60, max: 120 };

test("Box route releases the shared slot and holds a Box pool slot while running", async () => {
  const events: string[] = [];
  const shared = new SpyLimiter(4, "shared", events);
  const box = new SpyLimiter(10, "box", events);
  await call("box_cli", { concurrencyLimiter: shared, boxConcurrencyLimiter: box });
  assert.deepEqual(events, ["shared+", "box+", "shared-", "box-"],
    "Box slot taken before the shared slot is given back; Box slot freed at the end");
  assert.equal(shared.count("uid:3"), 0);
  assert.equal(box.count("box:uid:3"), 0);
});

test("a tenth concurrent Box run is admitted beyond the shared cap of 4", async () => {
  const events: string[] = [];
  const shared = new SpyLimiter(4, "shared", events);
  const box = new SpyLimiter(10, "box", events);
  const held = Array.from({ length: 9 }, () => box.acquire("box:uid:3")!);
  events.length = 0;
  const { res } = await call("box_cli", { concurrencyLimiter: shared, boxConcurrencyLimiter: box });
  assert.notEqual(res.code(), "CONCURRENT_LIMIT");
  assert.deepEqual(events, ["shared+", "box+", "shared-", "box-"]);
  held.forEach((release) => release());
  assert.equal(box.count("box:uid:3"), 0);
});

test("a full Box pool rejects with CONCURRENT_LIMIT and frees the shared slot", async () => {
  const events: string[] = [];
  const shared = new SpyLimiter(4, "shared", events);
  const box = new SpyLimiter(2, "box", events);
  const held = [box.acquire("box:uid:3")!, box.acquire("box:uid:3")!];
  events.length = 0;
  const { res } = await call("box_cli", { concurrencyLimiter: shared, boxConcurrencyLimiter: box });
  assert.equal(res.statusCode, 429);
  assert.equal(res.code(), "CONCURRENT_LIMIT");
  assert.deepEqual(events, ["shared+", "box!", "shared-"]);
  assert.equal(box.count("box:uid:3"), 2);
  held.forEach((release) => release());
});

test("without injected Box deps the Box route keeps the shared slot (commercial unchanged)", async () => {
  const events: string[] = [];
  const shared = new SpyLimiter(4, "shared", events);
  const { harness } = await call("box_cli", { concurrencyLimiter: shared });
  assert.deepEqual(events, ["shared+", "shared-"]);
  assert.deepEqual(harness.keys.map((key) => key.split(":")[2]), ["proxy_uid"], "single shared rate check");
});

test("Box and general traffic are counted on separate rate keys", async () => {
  const boxed = await call("box_cli", { boxRateLimit: boxRate });
  const scopes = boxed.harness.keys.map((key) => key.split(":")[2]);
  assert.deepEqual(scopes, ["proxy_uid", "proxy_uid_box"]);
  const general = await call("anthropic", { boxRateLimit: boxRate });
  assert.deepEqual(general.harness.keys.map((key) => key.split(":")[2]), ["proxy_uid", "proxy_uid_general"]);
});

test("Box rate allows 120/min while the general class stays at its own cap", async () => {
  const boxOk = await call("box_cli", { boxRateLimit: boxRate },
    (key) => (key.includes(":proxy_uid_box:") ? 120 : 1));
  assert.notEqual(boxOk.res.code(), "RATE_LIMITED", "120th Box request passes");
  const boxOver = await call("box_cli", { boxRateLimit: boxRate },
    (key) => (key.includes(":proxy_uid_box:") ? 121 : 1));
  assert.equal(boxOver.res.statusCode, 429);
  assert.equal(boxOver.res.code(), "RATE_LIMITED");
  const generalOver = await call("anthropic", { boxRateLimit: boxRate },
    (key) => (key.includes(":proxy_uid_general:") ? DEFAULT_PROXY_RATE_LIMIT.max + 1 : 1));
  assert.equal(generalOver.res.statusCode, 429);
  assert.equal(generalOver.res.code(), "RATE_LIMITED");
  const preReadCeiling = await call("box_cli", { boxRateLimit: boxRate },
    (key) => (key.includes(":proxy_uid:") ? DEFAULT_PROXY_RATE_LIMIT.max + 120 : 1));
  assert.notEqual(preReadCeiling.res.code(), "RATE_LIMITED", "pre-read ceiling is shared + Box");
});
