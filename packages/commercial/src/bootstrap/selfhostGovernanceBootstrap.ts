/**
 * OCV5-914 — Selfhost governance service composition helper (L6 commercial-bootstrap).
 * Commercial instances strictly receive `undefined` (routes fail-closed 404).
 */
import {
  createSelfhostGovernanceService,
  type SelfhostGovernanceService,
} from "../admin/selfhostGovernanceService.js";
import { loadSelfhostGovernanceEnvConfig } from "../runtimeCapabilities.js";

export function createOptionalSelfhostGovernance(
  runtimeChannel: string,
  flavorIdentity: { status: string; flavor?: string },
): SelfhostGovernanceService | undefined {
  if (
    runtimeChannel !== "v5" ||
    flavorIdentity.status !== "ok" ||
    flavorIdentity.flavor !== "selfhost"
  ) {
    return undefined;
  }
  return createSelfhostGovernanceService(loadSelfhostGovernanceEnvConfig());
}
