import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlavorIdentity } from "../flavor/assertFlavor.js";

/** OCV5-713: one versioned policy restores both user availability and C3. */
export function modelAvailableForIdentity(
  identity: FlavorIdentity | undefined,
  grokEnabled: boolean,
  modelId: string,
): boolean {
  return identity?.status !== "ok" || identity.flavor !== "selfhost" || grokEnabled ||
    !(modelId === "grok-build" || modelId.startsWith("grok-build-"));
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
