/** Shared fixtures for the Grok vision backend tests (unit + integ). */
import { Readable } from "node:stream";

import { hashSecret, type ContainerIdentityRepo } from "../../auth/containerIdentity.js";
import type { UserModelAuthz } from "../../auth/userModelAuthz.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  ModelCatalogSnapshot,
  type ModelCatalogPricing,
} from "../../billing/modelCatalog.js";

export const VISION_HOST = "host-1";
export const VISION_IP = "10.0.0.9";
export const VISION_SECRET = "b".repeat(64);
export const VISION_CTX = { hostUuid: VISION_HOST, boundIp: VISION_IP };
export const GROK_TOKEN_BYTES = "grok-access-secret";

/** 1x1 PNG. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function visionToken(containerId: number): string {
  return `oc-v3.${containerId}.${VISION_SECRET}`;
}

export function visionIdentityRepo(containerId: number, userId: number): ContainerIdentityRepo {
  return {
    async findActiveByHostAndBoundIp(hostUuid, boundIp) {
      if (hostUuid !== VISION_HOST || boundIp !== VISION_IP) return null;
      return {
        id: containerId,
        user_id: userId,
        bound_ip: VISION_IP,
        host_uuid: VISION_HOST,
        secret_hash: hashSecret(VISION_SECRET),
      };
    },
  };
}

export function visionReq(method: string, body: unknown, auth: string) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const req = Readable.from([Buffer.from(raw)]) as unknown as import("node:http").IncomingMessage;
  req.method = method;
  req.url = "/internal/v3/grok-vision";
  req.headers = { authorization: auth };
  return req;
}

export function visionRes() {
  const chunks: Buffer[] = [];
  const headers: Record<string, unknown> = {};
  const res = {
    statusCode: 0,
    setHeader(k: string, v: unknown) { headers[k.toLowerCase()] = v; },
    getHeader(k: string) { return headers[k.toLowerCase()]; },
    end(c?: unknown) { if (c) chunks.push(Buffer.from(c as string)); },
    write(c: unknown) { chunks.push(Buffer.from(c as string)); return true; },
  } as unknown as import("node:http").ServerResponse & { statusCode: number };
  return { res, json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any> };
}

/** grok-build at the production catalog price: 250 / 1500 / 25 / 0 per Mtok, x1.000. */
export function grokVisionSnapshot(over: {
  price?: Partial<ModelCatalogPricing>;
  engine?: "grok" | "ccb";
  upstreamModelId?: string;
  state?: "active" | "disabled";
} = {}): ModelCatalogSnapshot {
  return new ModelCatalogSnapshot({
    entries: [{
      entryId: 1,
      modelId: "grok-build",
      engine: over.engine ?? "grok",
      providerId: over.engine ?? "grok",
      upstreamModelId: over.upstreamModelId ?? "grok-4.7",
      contextWindow: 256_000,
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: ["medium"] as const, codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false },
      },
      capabilitySchemaVersion: CAPABILITY_SCHEMA_VERSION,
      state: over.state ?? "active",
      lockVersion: 1,
    }],
    aliases: new Map(),
    pricing: new Map([["grok-build", {
      modelId: "grok-build",
      displayName: "Grok 4.7",
      inputPerMtok: 250n,
      outputPerMtok: 1500n,
      cacheReadPerMtok: 25n,
      cacheWritePerMtok: 0n,
      multiplier: "1.000",
      visibility: "public",
      sortOrder: 0,
      defaultEffort: null,
      ...(over.price ?? {}),
    }]]),
    securityEpoch: 7n,
  });
}

export const PUBLIC_VISION_AUTHZ: UserModelAuthz = {
  role: "user",
  grantedModelIds: new Set(),
  deniedModelIds: new Set(),
  userPlanTier: null,
  orgPlanCode: null,
};

/** The response shape the official CLI chat proxy returned on 2026-10-06 (trimmed). */
export function grokVisionUpstreamPayload(over: { text?: string; usage?: unknown } = {}) {
  return {
    model: "grok-4.7-build",
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: over.text ?? "785941" }] },
    ],
    ...(over.usage === null
      ? {}
      : {
          usage: over.usage ?? {
            input_tokens: 1367,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 54,
            output_tokens_details: { reasoning_tokens: 52 },
            total_tokens: 1421,
          },
        }),
  };
}
