import type { ModelAuthorityEngine } from "@openclaude/protocol";

/**
 * 哪些引擎的 turn 会以平台次级模型打 anthropic proxy `/v1/messages`,
 * 因此 authority/lease 必须签上 aux 放行集。
 */
export function engineUsesAnthropicAuxModels(engine: ModelAuthorityEngine): boolean {
  switch (engine) {
    case "ccb":
    case "cursor":
      return true;
    default:
      return false;
  }
}

export function isGrokEngineKind(kind: string | undefined): boolean {
  switch (kind) {
    case "grok":
      return true;
    default:
      return false;
  }
}

export function isNonCcbAuthorityEngine(kind: ModelAuthorityEngine): boolean {
  switch (kind) {
    case "ccb":
      return false;
    default:
      return true;
  }
}

export function matchesAuthorityEngine(
  actual: ModelAuthorityEngine,
  expected: ModelAuthorityEngine,
): boolean {
  return actual === expected;
}

const SERVER_BILLING_REQUEST_ID_ENGINES = new Set<ModelAuthorityEngine>([
  "codex",
  "antigravity",
]);

export function needsServerBillingRequestId(kind: ModelAuthorityEngine): boolean {
  return SERVER_BILLING_REQUEST_ID_ENGINES.has(kind);
}

const EXTERNAL_BILLING_ENGINES = new Map<unknown, "zcode" | "antigravity" | "cursor">([
  ["zcode", "zcode"],
  ["antigravity", "antigravity"],
  ["cursor", "cursor"],
]);

export function classifyExternalBillingEngine(
  kind: unknown,
): "zcode" | "antigravity" | "cursor" | null {
  return EXTERNAL_BILLING_ENGINES.get(kind) ?? null;
}
