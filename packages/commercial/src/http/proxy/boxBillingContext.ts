/** Server-owned settlement attribution frozen before a Box call. The existing
 * request_finalize_journal row stores this without a schema migration. */
import type { BillingAuthorityStamp, FinalizeContext } from "../../billing/proxyBilling.js";
import { parseVerificationSponsorshipSnapshot,
  serializeVerificationSponsorshipSnapshot,
  type VerificationSponsorshipSnapshot } from "../../billing/verificationSponsorship.js";

export interface BoxBillingContextV1 {
  v: 1;
  sessionId: string | null;
  mode: "chat" | "delegate";
  parentSessionId: string | null;
  delegateAgentId: string | null;
  turnKey: string;
  parentTurnKey: string | null;
  authority: { kind: BillingAuthorityStamp["kind"]; executionRevision: string;
    projectionRevision: string | null; securityEpoch: string } | null;
  dispatchId: string | null;
  attemptNo: number | null;
  verificationSponsorship: Record<string, string> | null;
  apiKeyId: string | null;
}

type Inputs = Pick<FinalizeContext, "sessionId" | "mode" | "parentSessionId"
  | "delegateAgentId" | "turnKey" | "parentTurnKey" | "authority"
  | "dispatchId" | "attemptNo" | "verificationSponsorship" | "apiKeyId">;

export function serializeBoxBillingContext(input: Inputs): BoxBillingContextV1 {
  if (!input.turnKey || !/^[a-f0-9]{64}$/.test(input.turnKey)) {
    throw new Error("BOX_BILLING_TURN_KEY_INVALID");
  }
  return { v: 1, sessionId: input.sessionId ?? null, mode: input.mode ?? "chat",
    parentSessionId: input.parentSessionId ?? null,
    delegateAgentId: input.delegateAgentId ?? null,
    turnKey: input.turnKey, parentTurnKey: input.parentTurnKey ?? null,
    authority: input.authority ? {
      kind: input.authority.kind,
      executionRevision: input.authority.executionRevision,
      projectionRevision: input.authority.projectionRevision,
      securityEpoch: input.authority.securityEpoch.toString() } : null,
    dispatchId: input.dispatchId ?? null, attemptNo: input.attemptNo ?? null,
    verificationSponsorship: input.verificationSponsorship
      ? serializeVerificationSponsorshipSnapshot(input.verificationSponsorship) : null,
    apiKeyId: input.apiKeyId === null || input.apiKeyId === undefined
      ? null : input.apiKeyId.toString() };
}

export function parseBoxBillingContext(raw: unknown): Pick<FinalizeContext,
  "sessionId" | "mode" | "parentSessionId" | "delegateAgentId" | "turnKey"
  | "parentTurnKey" | "authority" | "dispatchId" | "attemptNo"
  | "verificationSponsorship" | "apiKeyId"> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  const maybeText = (v: unknown, max: number): v is string | null =>
    v === null || (typeof v === "string" && v.length > 0 && v.length <= max);
  if (x.v !== 1 || !maybeText(x.sessionId, 256)
    || (x.mode !== "chat" && x.mode !== "delegate")
    || !maybeText(x.parentSessionId, 256) || !maybeText(x.delegateAgentId, 128)
    || typeof x.turnKey !== "string" || !/^[a-f0-9]{64}$/.test(x.turnKey)
    || (x.parentTurnKey !== null && (typeof x.parentTurnKey !== "string"
      || !/^[a-f0-9]{64}$/.test(x.parentTurnKey)))
    || !maybeText(x.dispatchId, 128)
    || (x.attemptNo !== null && (!Number.isSafeInteger(x.attemptNo)
      || (x.attemptNo as number) < 1))
    || (x.apiKeyId !== null && (typeof x.apiKeyId !== "string"
      || !/^[1-9][0-9]{0,19}$/.test(x.apiKeyId)))) return null;
  let authority: BillingAuthorityStamp | null = null;
  if (x.authority !== null) {
    if (!x.authority || typeof x.authority !== "object" || Array.isArray(x.authority)) return null;
    const a = x.authority as Record<string, unknown>;
    if ((a.kind !== "bridge_signed" && a.kind !== "local_catalog")
      || typeof a.executionRevision !== "string" || a.executionRevision.length < 1
      || !maybeText(a.projectionRevision, 128)
      || typeof a.securityEpoch !== "string" || !/^[0-9]{1,20}$/.test(a.securityEpoch)) return null;
    authority = { kind: a.kind, executionRevision: a.executionRevision,
      projectionRevision: a.projectionRevision, securityEpoch: BigInt(a.securityEpoch) };
  }
  let verificationSponsorship: VerificationSponsorshipSnapshot | null = null;
  if (x.verificationSponsorship !== null) {
    verificationSponsorship = parseVerificationSponsorshipSnapshot(x.verificationSponsorship);
    if (!verificationSponsorship) return null;
  }
  return { sessionId: x.sessionId, mode: x.mode,
    parentSessionId: x.parentSessionId, delegateAgentId: x.delegateAgentId,
    turnKey: x.turnKey, parentTurnKey: x.parentTurnKey,
    authority, dispatchId: x.dispatchId, attemptNo: x.attemptNo as number | null,
    verificationSponsorship,
    apiKeyId: x.apiKeyId === null ? null : BigInt(x.apiKeyId as string) };
}
