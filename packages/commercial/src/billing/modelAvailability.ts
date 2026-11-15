import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlavorIdentity } from "../flavor/assertFlavor.js";

/**
 * Local Anthropic Claude Code models retired on selfhost (OCV5-754).
 * Remote / Go / Box Claude (`box-claude-*`, `*-remote`, `*-go`, `antigravity-claude-*`,
 * `cc5-remote-*`) stay enabled.
 */
export function isLocalAnthropicClaudeModelId(modelId: string): boolean {
  return modelId.startsWith("claude-") && !modelId.endsWith("-remote") && !modelId.endsWith("-go");
}

/** True when the current commercial process is pinned to selfhost and local CC is disabled. */
export function isSelfhostLocalCcDisabled(): boolean {
  return deploymentIdentity?.status === "ok" && deploymentIdentity.flavor === "selfhost";
}

/** OCV5-713 / OCV5-754: one versioned policy governs user availability and catalog visibility. */
export function modelAvailableForIdentity(
  identity: FlavorIdentity | undefined,
  grokEnabled: boolean,
  modelId: string,
): boolean {
  if (identity?.status !== "ok" || identity.flavor !== "selfhost") return true;
  if (isLocalAnthropicClaudeModelId(modelId)) return false;
  return grokEnabled || !(modelId === "grok-build" || modelId.startsWith("grok-build-"));
}

let deploymentIdentity: FlavorIdentity | undefined;
let deploymentGrokEnabled = true;

/** Boot only: master and egress read the policy in their verified release. */
export function configureModelAvailability(identity: FlavorIdentity): void {
  if (identity.status !== "ok") return;
  if (deploymentIdentity?.status === "ok" && deploymentIdentity.flavor !== identity.flavor) {
    throw new Error("Model availability deployment identity cannot change");
  }
  let grokEnabled = true;
  if (identity.flavor === "selfhost") {
    const file = join(dirname(identity.manifestPath), "deploy/v5-selfhost/model-availability.json");
    const policy: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!policy || typeof policy !== "object" || !("grokEnabled" in policy) ||
        typeof policy.grokEnabled !== "boolean") {
      throw new Error("Selfhost model policy requires boolean grokEnabled");
    }
    grokEnabled = policy.grokEnabled;
  }
  deploymentIdentity = identity;
  deploymentGrokEnabled = grokEnabled;
}

export function isModelAvailable(modelId: string): boolean {
  return modelAvailableForIdentity(deploymentIdentity, deploymentGrokEnabled, modelId);
}
