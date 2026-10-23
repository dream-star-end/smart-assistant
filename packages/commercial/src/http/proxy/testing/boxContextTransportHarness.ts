/** Synthetic identity/catalog harness for transport admission proofs.
 * It cannot reserve credits, query billing tables or execute a model. */
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MODEL_AUTHORITY_VERSION, AUTHORITY_TTL_MS, authoritySigningInput,
  encodeAuthorityEnvelope, encodeTurnLeaseEnvelope, turnLeaseSigningInput,
  type ModelAuthorityPayload, type TurnLease,
} from "@openclaude/protocol";
import { makeAnthropicProxyHandler } from "../index.js";
import { AUTHORITY_HEADER, TURN_LEASE_HEADER, LOCAL_CATALOG_HEADER, encodeLocalCatalogToken } from "../modelAuthorityGate.js";
import type { AnthropicProxyDeps, ProxyBody } from "../shared.js";
import type { BoxContextBinding, BoxContextTransport } from "../boxContextTransport.js";

export const CONTEXT_PROBE_MODEL = "box-api-claude-opus-5-5";
const EPOCH = 12;
const KEY = "mak1_testkey00000001";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const raw = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url");
const keyring = new Map([[KEY, new Uint8Array(raw)]]);

export class ContextProbeResponse extends EventEmitter {
  statusCode = 0;
  body = "";
  headersSent = false;
  writableEnded = false;
  destroyed = false;
  headers = new Map<string, unknown>();
  setHeader(k: string, v: unknown) { this.headers.set(k.toLowerCase(), v); return this; }
  writeHead(status: number) { this.statusCode = status; this.headersSent = true; return this; }
  end(chunk?: string | Buffer) {
    if (chunk) this.body += chunk.toString();
    this.headersSent = true;
    this.writableEnded = true;
    return this;
  }
  json(): any { return this.body ? JSON.parse(this.body) : {}; }
}
export function contextProbeBody(messages: unknown[], extra: Partial<ProxyBody> = {}): ProxyBody {
  return { model: CONTEXT_PROBE_MODEL, max_tokens: 128, stream: true, messages,
    metadata: { session_id: "g607-native-session" }, ...extra };
}

export function contextProbeHarness(store: BoxContextTransport, options: {
  owner?: boolean; provider?: string; external?: boolean; badSignature?: boolean;
  localCatalog?: boolean; leaseOnly?: boolean;
} = {}) {
  const owner = options.owner !== false;
  const capabilityProfile = {
    supportsVision: false,
    reasoning: { supported: [], codexModelDefault: null },
    ccb: { capabilityZero: false, supportsThinking: true,
      ...(owner ? { contextOwner: "box-native-v1" } : {}) },
  };
  const descriptor = { canonicalModel: CONTEXT_PROBE_MODEL, engine: "ccb",
    providerId: options.provider ?? "box_cli", upstreamModelId: "claude-opus-5-5",
    contextWindow: 1_000_000, capabilityProfile, capabilitySchemaVersion: 1, defaultEffort: null };
  const pricing = { model_id: CONTEXT_PROBE_MODEL, display_name: "Box fixture",
    input_per_mtok: 1n, output_per_mtok: 1n, cache_read_per_mtok: 1n, cache_write_per_mtok: 1n,
    multiplier: "1.000", enabled: true, sort_order: 0, visibility: "public",
    extra_system_prompt: null, default_effort: null, updated_at: new Date() };
  const snapshot = { securityEpoch: BigInt(EPOCH), executionRevision: "b".repeat(64),
    billingRevision: "c".repeat(64), aliasToCanonical: (m: string) => m,
    resolve: (m: string) => m === CONTEXT_PROBE_MODEL ? descriptor : null,
    canUseModel: () => true,
    billingPricingFor: (m: string) => m === CONTEXT_PROBE_MODEL ? pricing : null,
    projectionRevisionFor: () => "d".repeat(64) };
  const counts = { prechecks: 0, db: 0, models: 0, cursor: 0, puts: 0, gets: 0 };
  const forbiddenDb = () => { counts.db++; throw new Error("stage queried billing"); };
  const forbiddenPrecheck = async () => { counts.prechecks++; throw new Error("stage reserved credits"); };
  const logs: Array<{ event: string; data: unknown }> = [];
  const log: any = { child: () => log, info: (event: string, data: unknown) => logs.push({ event, data }),
    warn: (event: string, data: unknown) => logs.push({ event, data }),
    error: (event: string, data: unknown) => logs.push({ event, data }) };
  const previous = process.env.OC_BOX_MODEL_API;
  const previousHealth = process.env.OC_PROVIDER_HEALTH_ENFORCE;
  process.env.OC_BOX_MODEL_API = "1";
  process.env.OC_PROVIDER_HEALTH_ENFORCE = "0"; // synthetic catalog never queries a live health database
  const handler = makeAnthropicProxyHandler({
    pgPool: { query: forbiddenDb, connect: forbiddenDb },
    pricing: { get: () => pricing }, scheduler: {},
    preCheckRedis: { atomicReserve: forbiddenPrecheck, eval: forbiddenPrecheck,
      releaseReservation: async () => true },
    identity: { resolve: async () => ({ uid: 765n, containerId: 765n,
      ...(options.external ? { apiKey: { id: 765n, creditLimit: null, spentCredits: 0n } } : {}) }),
      authorize: async () => {} },
    loadUserModelAuthz: async () => ({ role: "user", grantedModelIds: new Set<string>() }),
    rateLimitRedis: { incr: async () => 1, expire: async () => 1 },
    modelCatalog: { assertFresh: async () => snapshot }, modelAuthorityEnforce: true,
    authorityKeyring: () => keyring, logger: log,
    boxContextTransport: {
      put: async (b: BoxContextBinding, m: readonly unknown[]) => { counts.puts++; return store.put(b, m); },
      get: async (b: BoxContextBinding, r: string) => { counts.gets++; return store.get(b, r); },
    },
    boxModel: { fetch: async () => { counts.models++; throw new Error("stage executed model"); },
      switchCompaction: {} },
    cursorExternal: { handle: async () => { counts.cursor++; throw new Error("stage executed Cursor"); } },
  } as unknown as AnthropicProxyDeps);
  function headers() {
    const now = Date.now();
    const common = { v: MODEL_AUTHORITY_VERSION, keyId: KEY, uid: 765, containerId: 765,
      authorityTurnId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6", canonicalModel: CONTEXT_PROBE_MODEL,
      securityEpoch: EPOCH, connectionChallenge: "g607-context", issuedAt: now } as const;
    const authority: ModelAuthorityPayload = { ...common, engine: "ccb",
      executionDescriptor: { capabilityProfile, capabilitySchemaVersion: 1,
        contextWindow: 1_000_000, supportedEfforts: [], supportsVision: false },
      executionRevision: "b".repeat(64), expiresAt: now + AUTHORITY_TTL_MS } as ModelAuthorityPayload;
    const lease: TurnLease = { ...common, expiresAt: now + 30 * 60_000 };
    if (options.localCatalog) return { host: "127.0.0.1",
      [LOCAL_CATALOG_HEADER]: encodeLocalCatalogToken({ v: 1, kind: "local_catalog",
        securityEpoch: String(EPOCH), projectionRevision: "d".repeat(64) }) };
    if (options.leaseOnly) return { host: "127.0.0.1",
      [TURN_LEASE_HEADER]: encodeTurnLeaseEnvelope(lease,
        cryptoSign(null, turnLeaseSigningInput(lease), privateKey)) };
    return { host: "127.0.0.1",
      [AUTHORITY_HEADER]: options.badSignature ? "invalid-authority"
        : encodeAuthorityEnvelope(authority, cryptoSign(null, authoritySigningInput(authority), privateKey)),
      [TURN_LEASE_HEADER]: encodeTurnLeaseEnvelope(lease,
        cryptoSign(null, turnLeaseSigningInput(lease), privateKey)) };
  }
  return {
    counts, logs,
    async call(body: ProxyBody, endpoint = "/v1/messages/context") {
      const req = Readable.from([Buffer.from(JSON.stringify(body))]) as IncomingMessage;
      req.method = "POST"; req.url = endpoint; req.headers = headers();
      const res = new ContextProbeResponse();
      await handler(req, res as unknown as ServerResponse,
        { hostUuid: "g607-fixture", boundIp: "127.0.0.1" });
      return res;
    },
    close() {
      if (previous === undefined) delete process.env.OC_BOX_MODEL_API;
      else process.env.OC_BOX_MODEL_API = previous;
      if (previousHealth === undefined) delete process.env.OC_PROVIDER_HEALTH_ENFORCE;
      else process.env.OC_PROVIDER_HEALTH_ENFORCE = previousHealth;
    },
  };
}

