import { DEFAULT_CODEX_ENGINE_MODEL, type CodexEngineModelId } from "@openclaude/protocol";

export const LEGACY_TEAM_LEADER_FALLBACK_MODEL: CodexEngineModelId = "gpt-6-astra";

/**
 * Prefer DEFAULT_CODEX_ENGINE_MODEL; only during staggered rollout when it is
 * not yet user-allowed while the legacy Codex leader remains active/allowed,
 * fall back to gpt-6-astra so non-admin teamMode turns keep working.
 */
export function resolveAuthorizedTeamLeaderModel(
  isAllowed: ((modelId: string) => boolean) | null | undefined,
): CodexEngineModelId {
  if (
    isAllowed &&
    !isAllowed(DEFAULT_CODEX_ENGINE_MODEL) &&
    isAllowed(LEGACY_TEAM_LEADER_FALLBACK_MODEL)
  ) {
    return LEGACY_TEAM_LEADER_FALLBACK_MODEL;
  }
  return DEFAULT_CODEX_ENGINE_MODEL;
}

export function resolveBridgeTeamLeaderModel(
  pricing: { get(modelId: string): { enabled?: boolean } | null | undefined } | undefined,
  checker: { isAllowed(modelId: string): boolean } | null,
): CodexEngineModelId {
  if (checker === null) return DEFAULT_CODEX_ENGINE_MODEL;
  return resolveAuthorizedTeamLeaderModel(
    (m) => (pricing ? Boolean(pricing.get(m)?.enabled) : true) && checker.isAllowed(m),
  );
}

/** Apply only after the bridge has resolved this turn as teamModeMain. */
export function applyTeamLeaderForwarding(
  frame: Record<string, unknown>,
  model: string = DEFAULT_CODEX_ENGINE_MODEL,
): void {
  Object.assign(frame, {
    agentId: "main",
    model,
    effortLevel: "high",
  });
}
