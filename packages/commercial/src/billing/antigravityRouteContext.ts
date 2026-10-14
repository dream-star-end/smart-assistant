/**
 * Short-lived opaque Antigravity relay routes (OCV5-415 P2).
 * A token is bound to container + user + requestId + canonical model + the
 * gemini OAuth account picked for the turn. No credential is stored here.
 *
 * Hosted turns mint on master and are consumed on egress, so production MUST
 * configure the shared KV (Redis); tests keep the in-memory map.
 */
import { createHash, randomBytes } from "node:crypto";

import { ANTIGRAVITY_RELAY_PREFIX, isAntigravityEngineModel } from "@openclaude/protocol";

export { ANTIGRAVITY_RELAY_PREFIX };
/** Long turns keep calling the relay; the bridge expires the route at the end. */
export const ANTIGRAVITY_RELAY_TTL_MS = 60 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;
const KV_PREFIX = "oc:v5:antigravity-relay:";

export type AntigravityRelayRoute = {
  token: string;
  containerId: number;
  userId: bigint;
  requestId: string;
  modelId: string;
  accountId: bigint;
  /** Spendable credits at admission; the relay stops new generate calls past it. */
  budgetCredits: bigint;
  expiresAt: number;
};

export type AntigravityRelayKv = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
};

const routes = new Map<string, AntigravityRelayRoute>();
let kv: AntigravityRelayKv | null = null;

export function configureAntigravityRelayKv(next: AntigravityRelayKv | null): void {
  kv = next;
}

function tokenKey(token: string): string {
  return `${KV_PREFIX}${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

function serialize(row: AntigravityRelayRoute): string {
  return JSON.stringify({
    containerId: row.containerId,
    userId: row.userId.toString(),
    requestId: row.requestId,
    modelId: row.modelId,
    accountId: row.accountId.toString(),
    budgetCredits: row.budgetCredits.toString(),
    expiresAt: row.expiresAt,
  });
}

function deserialize(token: string, raw: string): AntigravityRelayRoute | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (!Number.isInteger(body.containerId) || (body.containerId as number) <= 0) return null;
  if (typeof body.userId !== "string" || !/^\d+$/.test(body.userId)) return null;
  if (typeof body.accountId !== "string" || !/^\d+$/.test(body.accountId)) return null;
  if (typeof body.budgetCredits !== "string" || !/^\d+$/.test(body.budgetCredits)) return null;
  if (typeof body.requestId !== "string" || !REQUEST_ID_RE.test(body.requestId)) return null;
  if (typeof body.modelId !== "string" || !isAntigravityEngineModel(body.modelId)) return null;
  if (typeof body.expiresAt !== "number" || !Number.isFinite(body.expiresAt)) return null;
  return {
    token,
    containerId: body.containerId as number,
    userId: BigInt(body.userId),
    requestId: body.requestId,
    modelId: body.modelId,
    accountId: BigInt(body.accountId),
    budgetCredits: BigInt(body.budgetCredits),
    expiresAt: body.expiresAt,
  };
}

export async function mintAntigravityRelayRoute(args: {
  containerId: number;
  userId: bigint | number;
  requestId: string;
  modelId: string;
  accountId: bigint;
  budgetCredits: bigint;
  relayPort: number;
  nowMs?: number;
  ttlMs?: number;
}): Promise<{ token: string; baseUrl: string }> {
  if (!Number.isInteger(args.containerId) || args.containerId <= 0) {
    throw new Error("antigravity relay containerId is invalid");
  }
  if (!REQUEST_ID_RE.test(args.requestId)) {
    throw new Error("antigravity relay requestId is invalid");
  }
  if (!isAntigravityEngineModel(args.modelId)) {
    throw new Error("antigravity relay model is not allowlisted");
  }
  if (args.budgetCredits <= 0n) {
    throw new Error("antigravity relay budget must be positive");
  }
  if (!Number.isInteger(args.relayPort) || args.relayPort <= 0 || args.relayPort > 65535) {
    throw new Error("antigravity relay port is invalid");
  }
  const token = randomBytes(32).toString("hex");
  const now = args.nowMs ?? Date.now();
  const ttl = args.ttlMs ?? ANTIGRAVITY_RELAY_TTL_MS;
  const row: AntigravityRelayRoute = {
    token,
    containerId: args.containerId,
    userId: BigInt(args.userId),
    requestId: args.requestId,
    modelId: args.modelId,
    accountId: args.accountId,
    budgetCredits: args.budgetCredits,
    expiresAt: now + ttl,
  };
  if (kv) {
    await kv.set(tokenKey(token), serialize(row), Math.max(1, Math.ceil(ttl / 1000)));
  } else {
    routes.set(token, row);
  }
  return {
    token,
    baseUrl: `http://127.0.0.1:${args.relayPort}${ANTIGRAVITY_RELAY_PREFIX}/route/${token}`,
  };
}

export async function resolveAntigravityRelayRoute(args: {
  token: string;
  containerId: number;
  userId: bigint | number;
  nowMs?: number;
}): Promise<AntigravityRelayRoute | null> {
  if (!TOKEN_RE.test(args.token)) return null;
  const now = args.nowMs ?? Date.now();
  let row: AntigravityRelayRoute | null = null;
  if (kv) {
    const raw = await kv.get(tokenKey(args.token));
    row = raw ? deserialize(args.token, raw) : null;
  } else {
    row = routes.get(args.token) ?? null;
  }
  if (!row) return null;
  if (row.expiresAt <= now) {
    await expireAntigravityRelayRoute(args.token);
    return null;
  }
  if (row.containerId !== args.containerId) return null;
  if (row.userId !== BigInt(args.userId)) return null;
  return row;
}

export async function expireAntigravityRelayRoute(token: string): Promise<void> {
  if (!TOKEN_RE.test(token)) return;
  if (kv) {
    await kv.del(tokenKey(token));
    return;
  }
  routes.delete(token);
}

export function _resetAntigravityRelayRoutesForTests(): void {
  routes.clear();
  kv = null;
}
