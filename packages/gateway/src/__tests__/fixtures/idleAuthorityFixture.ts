/** Test-only bridge issuance for each logical user inbound in the idle fixture. */
import { randomBytes, sign as cryptoSign, type KeyObject } from "node:crypto";
import * as protocol from "@openclaude/protocol";

export interface IdleAuthorityRecord {
  authorityTurnId: string;
  issuedAt: number;
  expiresAt: number;
  leaseIssuedAt: number;
  leaseExpiresAt: number;
}

export function mintIdleUserAuthority(
  privateKey: KeyObject, keyId: string, model: string, now = Date.now(),
) {
  const authorityTurnId = randomBytes(16).toString("hex");
  const payload: Parameters<typeof protocol.authoritySigningInput>[0] = {
    v: protocol.MODEL_AUTHORITY_VERSION, keyId, uid: 3, containerId: 7,
    authorityTurnId, connectionChallenge: "chal-idle",
    canonicalModel: model, engine: "ccb",
    executionDescriptor: {
      capabilityProfile: {
        supportsVision: false,
        reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: true, supportsThinking: false, contextOwner: "box-native-v1" },
      },
      capabilitySchemaVersion: 1, contextWindow: 200_000, supportedEfforts: [], supportsVision: false,
    },
    executionRevision: "b".repeat(64), securityEpoch: 12,
    issuedAt: now, expiresAt: now + protocol.AUTHORITY_TTL_MS,
  };
  // Preserve the existing fixture lease window; do not extend it to fit a test.
  const lease: Parameters<typeof protocol.turnLeaseSigningInput>[0] = {
    v: protocol.MODEL_AUTHORITY_VERSION, keyId, uid: 3, containerId: 7,
    authorityTurnId, canonicalModel: model, securityEpoch: 12,
    connectionChallenge: "chal-idle", issuedAt: now - 60_000, expiresAt: now + 30 * 60_000,
  };
  return {
    modelAuthority: {
      authorityEnvelope: protocol.encodeAuthorityEnvelope(payload, cryptoSign(null, protocol.authoritySigningInput(payload), privateKey)),
      leaseEnvelope: protocol.encodeTurnLeaseEnvelope(lease, cryptoSign(null, protocol.turnLeaseSigningInput(lease), privateKey)),
      executionDescriptor: {
        canonicalModel: model, contextWindow: 200_000, capabilityZero: true,
        supportsThinking: false, supportsVision: false, supportedEfforts: [],
        contextOwner: "box-native-v1" as const,
      },
    },
    record: {
      authorityTurnId, issuedAt: payload.issuedAt, expiresAt: payload.expiresAt,
      leaseIssuedAt: lease.issuedAt, leaseExpiresAt: lease.expiresAt,
    } satisfies IdleAuthorityRecord,
  };
}
