/**
 * Short-lived opaque ZCode Anthropic relay routes.
 * Tokens are bound to container + user + requestId + canonical model.
 * The real Coding Plan key never enters this map.
 *
 * Hosted turns mint on master and are consumed on egress (172.31.0.1:18892).
 * Process-local memory cannot see the other process; production MUST configure
 * a shared KV (Redis). Tests keep the in-memory map when KV is unset.
 */
import { createHash, randomBytes } from "node:crypto";

import { ZCODE_RELAY_PREFIX } from "@openclaude/protocol";

export { ZCODE_RELAY_PREFIX };
export const ZCODE_RELAY_TTL_MS = 15 * 60 * 1000;
export const ZCODE_UPSTREAM_MODEL = "zai-coding-plan/glm-5.3";
export const ZCODE_UPSTREAM_API_MODEL = "glm-5.3";
export const ZCODE_CANONICAL_MODELS = ["zcode-experimental", "glm-5.3-zai"] as const;
export type ZcodeCanonicalModel = (typeof ZCODE_CANONICAL_MODELS)[number];

const TOKEN_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const KV_PREFIX = "oc:v5:zcode-relay:";

export type ZcodeRelayRoute = {
  token: string;
  containerId: number;
  userId: bigint;
  requestId: string;
  modelId: ZcodeCanonicalModel;
  expiresAt: number;
};

export type ZcodeRelayKv = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
};

const routes = new Map<string, ZcodeRelayRoute>();
let kv: ZcodeRelayKv | null = null;

export function configureZcodeRelayKv(next: ZcodeRelayKv | null): void {
  kv = next;
}

export function createIoredisZcodeRelayKv(client: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, expiryMode: "EX", ttlSec: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
}): ZcodeRelayKv {
  return {
    get: (key) => client.get(key),
    set: async (key, value, ttlSec) => {
      await client.set(key, value, "EX", ttlSec);
    },
    del: async (key) => {
      await client.del(key);
    },
  };
}

function isCanonical(modelId: string): modelId is ZcodeCanonicalModel {
  return (ZCODE_CANONICAL_MODELS as readonly string[]).includes(modelId);
}

function tokenKey(token: string): string {
  return `${KV_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function serialize(row: ZcodeRelayRoute): string {
  return JSON.stringify({
    containerId: row.containerId,
    userId: row.userId.toString(),
    requestId: row.requestId,
    modelId: row.modelId,
    expiresAt: row.expiresAt,
  });
}

function deserialize(token: string, raw: string): ZcodeRelayRoute | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (!Number.isInteger(body.containerId) || (body.containerId as number) <= 0) return null;
  if (typeof body.userId !== "string" && typeof body.userId !== "number") return null;
  if (typeof body.requestId !== "string" || !REQUEST_ID_RE.test(body.requestId)) return null;
  if (typeof body.modelId !== "string" || !isCanonical(body.modelId)) return null;
  if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) return null;
  return {
    token,
    containerId: body.containerId as number,
    userId: BigInt(body.userId),
    requestId: body.requestId,
    modelId: body.modelId,
    expiresAt: body.expiresAt,
  };
}

export async function mintZcodeRelayRoute(args: {
  containerId: number;
  userId: bigint | number;
  requestId: string;
  modelId: string;
  relayPort: number;
  nowMs?: number;
  ttlMs?: number;
}): Promise<{ token: string; baseUrl: string }> {
  if (!Number.isInteger(args.containerId) || args.containerId <= 0) {
    throw new Error("zcode relay containerId is invalid");
  }
  if (!REQUEST_ID_RE.test(args.requestId)) {
    throw new Error("zcode relay requestId is invalid");
  }
  if (!isCanonical(args.modelId)) {
    throw new Error("zcode relay model is not allowlisted");
  }
  if (!Number.isInteger(args.relayPort) || args.relayPort <= 0 || args.relayPort > 65535) {
    throw new Error("zcode relay port is invalid");
  }
  const token = randomBytes(32).toString("hex");
  const now = args.nowMs ?? Date.now();
  const ttl = args.ttlMs ?? ZCODE_RELAY_TTL_MS;
  const row: ZcodeRelayRoute = {
    token,
    containerId: args.containerId,
    userId: BigInt(args.userId),
    requestId: args.requestId,
    modelId: args.modelId,
    expiresAt: now + ttl,
  };
  if (kv) {
    await kv.set(tokenKey(token), serialize(row), Math.max(1, Math.ceil(ttl / 1000)));
  } else {
    routes.set(token, row);
  }
  return {
    token,
    baseUrl: `http://127.0.0.1:${args.relayPort}${ZCODE_RELAY_PREFIX}/route/${token}`,
  };
}

export async function resolveZcodeRelayRoute(args: {
  token: string;
  containerId: number;
  userId: bigint | number;
  nowMs?: number;
}): Promise<ZcodeRelayRoute | null> {
  if (!TOKEN_RE.test(args.token)) return null;
  const now = args.nowMs ?? Date.now();
  let row: ZcodeRelayRoute | null = null;
  if (kv) {
    const raw = await kv.get(tokenKey(args.token));
    row = raw ? deserialize(args.token, raw) : null;
  } else {
    row = routes.get(args.token) ?? null;
  }
  if (!row) return null;
  if (row.expiresAt <= now) {
    await expireZcodeRelayRoute(args.token);
    return null;
  }
  if (row.containerId !== args.containerId) return null;
  if (row.userId !== BigInt(args.userId)) return null;
  return row;
}

export async function expireZcodeRelayRoute(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  if (kv) {
    await kv.del(tokenKey(token));
    return;
  }
  routes.delete(token);
}

export function _resetZcodeRelayRoutesForTests(): void {
  routes.clear();
  kv = null;
}

export function zcodeRelayTokenRe(): RegExp {
  return TOKEN_RE;
}
