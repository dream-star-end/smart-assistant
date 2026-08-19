/**
 * Short-lived opaque ZCode Anthropic relay routes.
 * Tokens are bound to container + user + requestId + canonical model.
 * The real Coding Plan key never enters this map.
 */
import { randomBytes } from "node:crypto";

export const ZCODE_RELAY_PREFIX = "/internal/v5/zcode-relay";
export const ZCODE_RELAY_TTL_MS = 15 * 60 * 1000;
export const ZCODE_UPSTREAM_MODEL = "zai-coding-plan/glm-5.3";
export const ZCODE_UPSTREAM_API_MODEL = "glm-5.3";
export const ZCODE_CANONICAL_MODELS = ["zcode-experimental", "glm-5.3-zai"] as const;
export type ZcodeCanonicalModel = (typeof ZCODE_CANONICAL_MODELS)[number];

const TOKEN_RE = /^[0-9a-f]{64}$/;
const REQUEST_ID_RE = /^[0-9a-f]{32}$/;

export type ZcodeRelayRoute = {
  token: string;
  containerId: number;
  userId: bigint;
  requestId: string;
  modelId: ZcodeCanonicalModel;
  expiresAt: number;
};

const routes = new Map<string, ZcodeRelayRoute>();

function isCanonical(modelId: string): modelId is ZcodeCanonicalModel {
  return (ZCODE_CANONICAL_MODELS as readonly string[]).includes(modelId);
}

export function mintZcodeRelayRoute(args: {
  containerId: number;
  userId: bigint | number;
  requestId: string;
  modelId: string;
  relayPort: number;
  nowMs?: number;
  ttlMs?: number;
}): { token: string; baseUrl: string } {
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
  routes.set(token, {
    token,
    containerId: args.containerId,
    userId: BigInt(args.userId),
    requestId: args.requestId,
    modelId: args.modelId,
    expiresAt: now + ttl,
  });
  return {
    token,
    baseUrl: `http://127.0.0.1:${args.relayPort}${ZCODE_RELAY_PREFIX}/route/${token}`,
  };
}

export function resolveZcodeRelayRoute(args: {
  token: string;
  containerId: number;
  userId: bigint | number;
  nowMs?: number;
}): ZcodeRelayRoute | null {
  if (!TOKEN_RE.test(args.token)) return null;
  const row = routes.get(args.token);
  if (!row) return null;
  const now = args.nowMs ?? Date.now();
  if (row.expiresAt <= now) {
    routes.delete(args.token);
    return null;
  }
  if (row.containerId !== args.containerId) return null;
  if (row.userId !== BigInt(args.userId)) return null;
  return row;
}

export function expireZcodeRelayRoute(token: string): void {
  if (!TOKEN_RE.test(token)) return;
  routes.delete(token);
}

export function _resetZcodeRelayRoutesForTests(): void {
  routes.clear();
}

export function zcodeRelayTokenRe(): RegExp {
  return TOKEN_RE;
}
