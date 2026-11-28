import { createHash } from "node:crypto";
import {
  MODEL_AUTHORITY_FIELD,
  type AuthoritativeRollingCheckpoint,
  type AuthorityPoolMigrationGrant,
  type ModelAuthorityBundle,
  type RemoteExecutionBackend,
} from "@openclaude/protocol";
import type {
  ContinuityAppliedVerifier,
  PrepareRollingCheckpointCallback,
} from "../account-pool/remotePool/selfhostCrossPoolSelector.js";
import type { Logger } from "../logging/logger.js";

export const CROSS_POOL_CHECKPOINT_FIELD = "_crossPoolCheckpoint" as const;
export const CROSS_POOL_CHECKPOINT_WIRE_VERSION = 1 as const;
export const CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS = 16_384;
export const MIGRATION_INSTALL_RECEIPT_TYPE = "outbound.control.migration_install_receipt" as const;
const CROSS_POOL_CHECKPOINT_MAX_UTF8_BYTES = 49_152;
const MIGRATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface PendingMigrationInstallRecord {
  readonly sessionKey: string;
  readonly placementEpoch: number;
  readonly migrationId: string;
  readonly continuityTier?: string;
  readonly checkpointGeneration?: string | null;
}

export interface MigrationInstallDispatchLookupRecord {
  readonly clientMessageId: string;
  readonly dispatchId: string;
  readonly attemptNo: number;
  readonly sessionId?: string;
  readonly pendingMigrationInstall?: PendingMigrationInstallRecord;
}

export interface MigrationInstallReceiptContext {
  readonly uid: number | bigint;
  readonly admittedDispatches: ReadonlyMap<string, MigrationInstallDispatchLookupRecord>;
  readonly pendingMigrationInstalls?: Map<string, MigrationInstallDispatchLookupRecord>;
  readonly markPlacementMigrationInstalled?: (args: {
    readonly uid: number;
    readonly sessionKey: string;
    readonly placementEpoch: number;
    readonly migrationId: string;
    readonly checkpointGeneration: string | null;
    readonly consumedByTurnKey: string;
    readonly requireWarmCheckpointMatch: boolean;
  }) => Promise<unknown>;
  readonly onInstalled?: (record: MigrationInstallDispatchLookupRecord) => void;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

/** OCV5-902 B1 / OCV5-928 W2-CS1: Only non-warm (`cold_degraded` / legacy untiered) migrations may clear on generic `running`/`terminal` receipts. */
export function shouldMarkInstallFromDispatchReceipt(
  pending: PendingMigrationInstallRecord | null | undefined,
  receiptState: unknown,
): boolean {
  if (!pending || pending.continuityTier === "tape_rebuilt" || pending.continuityTier === "warm_capsule") return false;
  if (typeof pending.checkpointGeneration === "string" && pending.checkpointGeneration.trim().length > 0) return false;
  return receiptState === "running" || receiptState === "terminal";
}

/** OCV5-902 B1: Clears legacy `cold_degraded` pending installs on verified `running`/`terminal` dispatch receipts. */
export function tryMarkLegacyColdInstallFromReceipt(
  receipt: { readonly clientMessageId: string; readonly dispatchId: string; readonly attemptNo: number; readonly sessionId: string; readonly state: unknown },
  ctx: {
    readonly uid: number | bigint;
    readonly pendingMigrationInstalls: Map<string, MigrationInstallDispatchLookupRecord>;
    readonly markPlacementMigrationInstalled?: MigrationInstallReceiptContext["markPlacementMigrationInstalled"];
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  },
): void {
  const rec = ctx.pendingMigrationInstalls.get(receipt.clientMessageId);
  const pending = rec?.pendingMigrationInstall;
  if (!rec || !pending || !ctx.markPlacementMigrationInstalled) return;
  if (rec.dispatchId !== receipt.dispatchId || rec.attemptNo !== receipt.attemptNo || (typeof rec.sessionId === "string" && rec.sessionId !== receipt.sessionId)) return;
  if (!shouldMarkInstallFromDispatchReceipt(pending, receipt.state)) return;
  void ctx
    .markPlacementMigrationInstalled({
      uid: Number(ctx.uid), sessionKey: pending.sessionKey, placementEpoch: pending.placementEpoch,
      migrationId: pending.migrationId, checkpointGeneration: null,
      consumedByTurnKey: rec.clientMessageId, requireWarmCheckpointMatch: false,
    })
    .then((installed) => { if (installed) ctx.pendingMigrationInstalls.delete(rec.clientMessageId); })
    .catch((err) => {
      ctx.warn?.("user-chat-bridge: legacy cold migration install PG commit failed", {
        clientMessageId: rec.clientMessageId, dispatchId: rec.dispatchId, migrationId: pending.migrationId, err,
      });
    });
}

function evaluateMigrationReceiptGenerationMatch(
  pending: PendingMigrationInstallRecord,
  continuityTier: string,
  checkpointGeneration: string | null,
): { readonly ok: true; readonly requireWarmCheckpointMatch: boolean } | { readonly ok: false; readonly warnMessage: string } {
  const expectedGen = typeof pending.checkpointGeneration === "string" && pending.checkpointGeneration.trim().length > 0 ? pending.checkpointGeneration.trim() : null;
  if (expectedGen !== null) {
    if (continuityTier !== "tape_rebuilt" || checkpointGeneration !== expectedGen) {
      return { ok: false, warnMessage: "user-chat-bridge: warm migration install receipt generation mismatch ignored" };
    }
    return { ok: true, requireWarmCheckpointMatch: true };
  }
  if (pending.continuityTier === "tape_rebuilt" || pending.continuityTier === "warm_capsule") {
    if (continuityTier === "cold_degraded" && checkpointGeneration === null) return { ok: true, requireWarmCheckpointMatch: false };
    return { ok: false, warnMessage: "user-chat-bridge: warm migration install receipt generation mismatch ignored" };
  }
  if (checkpointGeneration !== null) {
    return { ok: false, warnMessage: "user-chat-bridge: non-warm migration install receipt unexpected generation ignored" };
  }
  return { ok: true, requireWarmCheckpointMatch: false };
}

/** OCV5-902 B1: Master parser/handler for `outbound.control.migration_install_receipt` frames. */
export function parseAndHandleMigrationInstallReceipt(frameText: string | null, ctx: MigrationInstallReceiptContext): boolean {
  if (frameText === null || !frameText.includes(`"${MIGRATION_INSTALL_RECEIPT_TYPE}"`)) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(frameText); } catch { return false; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as { type?: unknown }).type !== MIGRATION_INSTALL_RECEIPT_TYPE) return false;
  const r = parsed as Record<string, unknown>;
  const cmid = typeof r.clientMessageId === "string" ? r.clientMessageId.trim() : "";
  const dispatchId = typeof r.dispatchId === "string" ? r.dispatchId.trim() : "";
  const attemptNo = r.attemptNo;
  const sessionKey = typeof r.sessionKey === "string" ? r.sessionKey.trim() : "";
  const migrationId = typeof r.migrationId === "string" ? r.migrationId.trim() : "";
  const placementEpoch = r.placementEpoch;
  const continuityTier = typeof r.continuityTier === "string" ? r.continuityTier.trim() : "";
  const rawGen = r.checkpointGeneration;
  const checkpointGeneration = rawGen === null ? null : typeof rawGen === "string" && rawGen.trim().length > 0 && rawGen.trim().length <= 128 ? rawGen.trim() : undefined;

  if (
    cmid.length === 0 || dispatchId.length === 0 || typeof attemptNo !== "number" || !Number.isSafeInteger(attemptNo) || attemptNo < 1 ||
    sessionKey.length === 0 || !MIGRATION_ID_RE.test(migrationId) || typeof placementEpoch !== "number" || !Number.isSafeInteger(placementEpoch) ||
    placementEpoch < 1 || continuityTier.length === 0 || checkpointGeneration === undefined
  ) {
    ctx.warn?.("user-chat-bridge: malformed migration install receipt ignored", { clientMessageId: cmid || undefined, dispatchId: dispatchId || undefined });
    return true;
  }

  const rec = ctx.pendingMigrationInstalls?.get(cmid) ?? ctx.admittedDispatches.get(cmid);
  const pending = rec?.pendingMigrationInstall;
  if (!rec || !pending) return true;

  if (rec.dispatchId !== dispatchId || rec.attemptNo !== attemptNo || pending.sessionKey !== sessionKey || pending.migrationId !== migrationId || pending.placementEpoch !== placementEpoch) {
    ctx.warn?.("user-chat-bridge: migration install receipt identity mismatch ignored", { clientMessageId: cmid, dispatchId, migrationId });
    return true;
  }

  const genCheck = evaluateMigrationReceiptGenerationMatch(pending, continuityTier, checkpointGeneration);
  if (!genCheck.ok) {
    ctx.warn?.(genCheck.warnMessage, { clientMessageId: cmid, dispatchId, migrationId });
    return true;
  }

  if (ctx.markPlacementMigrationInstalled) {
    void ctx
      .markPlacementMigrationInstalled({
        uid: Number(ctx.uid), sessionKey: pending.sessionKey, placementEpoch: pending.placementEpoch,
        migrationId: pending.migrationId, checkpointGeneration, consumedByTurnKey: rec.clientMessageId,
        requireWarmCheckpointMatch: genCheck.requireWarmCheckpointMatch,
      })
      .then((installed) => {
        if (installed) { ctx.pendingMigrationInstalls?.delete(rec.clientMessageId); ctx.onInstalled?.(rec); }
      })
      .catch((err) => {
        ctx.warn?.("user-chat-bridge: migration install receipt PG commit failed", { clientMessageId: cmid, dispatchId, migrationId, err });
      });
  }
  return true;
}

export interface CrossPoolCheckpointWirePayload {
  readonly v: typeof CROSS_POOL_CHECKPOINT_WIRE_VERSION;
  readonly generation: string;
  readonly migrationId: string;
  readonly placementEpoch: number;
  readonly mode: string;
  readonly anchorSeq: number;
  readonly sourceEngine: string;
  readonly summary: string;
  readonly sha256: string;
  readonly instructions?: string;
}

export interface CrossPoolMigrationCommittedMeta {
  readonly migrationId: string;
  readonly placementEpoch: number;
  readonly continuityTier?: string;
  readonly checkpointGeneration: string | null;
}

function toProtocolPoolMigrationGrant(
  grant: AuthorityPoolMigrationGrant | undefined,
): AuthorityPoolMigrationGrant | undefined {
  if (!grant) return undefined;
  return {
    migrationId: grant.migrationId,
    placementEpoch: grant.placementEpoch,
    allowBackendTransition: true,
    ...(grant.continuityTier !== undefined ? { continuityTier: grant.continuityTier } : {}),
  };
}

/**
 * OCV5-902 P0-1: Builds a verified wire carrier payload for a `tape_rebuilt` cross-pool
 * migration grant. Returns `null` if the checkpoint or grant fails integrity/size bounds.
 */
export function buildCrossPoolCheckpointWirePayload(
  cp: AuthoritativeRollingCheckpoint | null | undefined,
  migrationGrant: AuthorityPoolMigrationGrant | null | undefined,
): CrossPoolCheckpointWirePayload | null {
  if (!cp || !migrationGrant) return null;
  if (
    migrationGrant.allowBackendTransition !== true ||
    migrationGrant.continuityTier !== "tape_rebuilt"
  ) {
    return null;
  }
  const migrationId =
    typeof migrationGrant.migrationId === "string" ? migrationGrant.migrationId.trim() : "";
  if (migrationId.length < 8 || migrationId.length > 128) return null;
  if (
    typeof migrationGrant.placementEpoch !== "number" ||
    !Number.isSafeInteger(migrationGrant.placementEpoch) ||
    migrationGrant.placementEpoch < 1
  ) {
    return null;
  }
  const generation =
    typeof cp.checkpointGeneration === "string" ? cp.checkpointGeneration.trim() : "";
  if (generation.length === 0 || generation.length > 128) return null;
  const summary = typeof cp.summary === "string" ? cp.summary.trim() : "";
  if (summary.length === 0 || summary.length > CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS) {
    return null;
  }
  if (Buffer.byteLength(summary, "utf8") > CROSS_POOL_CHECKPOINT_MAX_UTF8_BYTES) {
    return null;
  }
  const instructions =
    typeof cp.instructions === "string" && cp.instructions.trim().length > 0
      ? cp.instructions.trim()
      : undefined;
  if (instructions !== undefined && instructions.length > 4_096) return null;

  const sha256 = createHash("sha256").update(summary, "utf8").digest("hex");
  return Object.freeze({
    v: CROSS_POOL_CHECKPOINT_WIRE_VERSION,
    generation,
    migrationId,
    placementEpoch: migrationGrant.placementEpoch,
    mode: cp.mode,
    anchorSeq: cp.anchorSeq,
    sourceEngine: cp.sourceEngine,
    summary,
    sha256,
    ...(instructions !== undefined ? { instructions } : {}),
  });
}

export function extractCrossPoolCheckpointGeneration(
  sealed: Record<string, unknown> | null | undefined,
): string | null {
  if (!sealed || typeof sealed !== "object") return null;
  const raw = sealed[CROSS_POOL_CHECKPOINT_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const gen = (raw as { generation?: unknown }).generation;
  return typeof gen === "string" && gen.trim().length > 0 ? gen.trim() : null;
}

/**
 * Honest seal-side continuity verifier: proves the checkpoint is non-empty, within wire
 * frame limits, hashes cleanly into a valid wire carrier payload, and binds it to the
 * outgoing sealed frame before permitting `continuityTier = 'tape_rebuilt'`.
 */
export function createSealWireContinuityVerifier(opts?: {
  readonly maxSummaryChars?: number;
  readonly onBound?: (cp: AuthoritativeRollingCheckpoint) => void;
}): ContinuityAppliedVerifier {
  const maxSummaryChars = Math.min(
    CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS,
    typeof opts?.maxSummaryChars === "number" && opts.maxSummaryChars > 0
      ? Math.floor(opts.maxSummaryChars)
      : CROSS_POOL_CHECKPOINT_MAX_SUMMARY_CHARS,
  );
  return async (ctx) => {
    const cp = ctx.checkpoint;
    if (!cp || typeof cp.summary !== "string") return { applied: false };
    const trimmed = cp.summary.trim();
    if (trimmed.length === 0 || trimmed.length > maxSummaryChars) {
      return { applied: false };
    }
    const probeGrant: AuthorityPoolMigrationGrant = {
      migrationId: "mig-probe-wire-verify",
      placementEpoch: ctx.targetPlacementEpoch,
      allowBackendTransition: true,
      continuityTier: "tape_rebuilt",
    };
    const wire = buildCrossPoolCheckpointWirePayload(cp, probeGrant);
    if (!wire) return { applied: false };
    opts?.onBound?.(cp);
    return { applied: true, checkpointId: cp.checkpointGeneration };
  };
}

export interface SealExecLike {
  readonly canonicalModel: string;
  readonly engine: string;
  readonly placement: "local" | "remote_pool";
  readonly securityEpoch: number;
}

export interface PreparedLocalFallbackTransport {
  readonly extraFrameFields: Record<string, unknown>;
  readonly billingRequestId?: string;
  readonly compensate: (reason: string) => Promise<void> | void;
  readonly onForwarded?: (forwarded: boolean) => void;
}

export interface LocalFallbackCommittedHandle {
  readonly compensate: (reason: string) => Promise<void>;
  readonly onForwarded?: (forwarded: boolean) => void;
  readonly billingRequestId?: string;
  readonly localEngine: string;
}

const ENGINES_REQUIRING_LOCAL_FALLBACK_TRANSPORT: Readonly<Record<string, boolean>> =
  Object.freeze({
    codex: true,
    antigravity: true,
  });

/**
 * Engines whose local fallback execution cannot rely solely on egress per-request billing
 * and MUST mint real local route/journal/relay credentials via `prepareLocalFallbackTransport`
 * before PG `placementEpoch` commit (fail-closed if absent or failed).
 */
export function engineRequiresLocalFallbackTransport(engine: string): boolean {
  return ENGINES_REQUIRING_LOCAL_FALLBACK_TRANSPORT[engine] === true;
}

export interface RemotePoolSealDeps<TExec extends SealExecLike> {
  readonly uid: number;
  readonly containerId: number | undefined;
  readonly sessionKey: string | undefined;
  readonly sessionId?: string;
  readonly hasLocalHistory?: boolean;
  readonly historicalMessages?: readonly unknown[];
  readonly excludeClientMessageId?: string;
  readonly prepareRollingCheckpoint?: PrepareRollingCheckpointCallback;
  readonly enableCrossPoolCheckpoint?: boolean;
  readonly verifyContinuityApplied?: ContinuityAppliedVerifier;
  readonly onMigrationCommitted?: (meta: CrossPoolMigrationCommittedMeta) => void;
  readonly exec: TExec;
  readonly billingRequestId?: string;
  readonly authorityTurnId?: string;
  readonly log: Logger | null;
  readonly cc5BackendSelector?: (input: {
    uid: number;
    containerId: number;
    sessionKey: string;
    canonicalModel: string;
    engine: string;
    placement: "local" | "remote_pool";
  }) => Promise<RemoteExecutionBackend | undefined>;
  readonly crossPoolFallbackSelector?: (args: {
    uid: number;
    containerId: number;
    sessionKey: string;
    sessionId?: string;
    canonicalModel: string;
    engine: string;
    cause: unknown;
    expectedSecurityEpoch?: number;
    historicalMessages?: readonly unknown[];
    excludeClientMessageId?: string;
    prepareRollingCheckpoint?: PrepareRollingCheckpointCallback;
    verifyContinuityApplied?: ContinuityAppliedVerifier;
    validateTargetSignable?: (target: {
      canonicalModel: string;
      logicalModel: string;
      engine: string;
      fallbackPool: "local_pool";
    }) => Promise<boolean>;
    beforeCommit?: (prepared: {
      fallbackPool: "local_pool";
      resolvedCanonicalModel: string;
      logicalModel: string;
      migrationGrant: AuthorityPoolMigrationGrant;
      deliveredCheckpoint?: AuthoritativeRollingCheckpoint;
    }) => Promise<boolean>;
  }) => Promise<{
    executionBackend?: RemoteExecutionBackend;
    fallbackPool: "local_pool" | "remote_pool";
    resolvedCanonicalModel?: string;
    migrationGrant?: AuthorityPoolMigrationGrant;
    deliveredCheckpoint?: AuthoritativeRollingCheckpoint;
  } | null>;
  readonly returnToRemoteGrantResolver?: (args: {
    uid: number;
    containerId: number;
    sessionKey: string;
    sessionId?: string;
    canonicalModel: string;
    engine: string;
    executionBackend: RemoteExecutionBackend;
    expectedSecurityEpoch?: number;
    hasLocalHistory?: boolean;
    historicalMessages?: readonly unknown[];
    excludeClientMessageId?: string;
    prepareRollingCheckpoint?: PrepareRollingCheckpointCallback;
    verifyContinuityApplied?: ContinuityAppliedVerifier;
    onDeliveredCheckpoint?: (checkpoint: AuthoritativeRollingCheckpoint) => void;
    beforeCommit?: (prepared: {
      migrationGrant: AuthorityPoolMigrationGrant;
      deliveredCheckpoint?: AuthoritativeRollingCheckpoint;
    }) => Promise<boolean>;
    onBlocked?: (code: string) => void;
  }) => Promise<
    (AuthorityPoolMigrationGrant & { readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint }) | null
  >;
  readonly forcedLocalMigrationResolver?: (args: {
    uid: number;
    containerId: number;
    sessionKey: string;
    sessionId?: string;
    canonicalModel: string;
    engine: string;
    reason?: string;
    expectedSecurityEpoch?: number;
    historicalMessages?: readonly unknown[];
    excludeClientMessageId?: string;
    prepareRollingCheckpoint?: PrepareRollingCheckpointCallback;
    verifyContinuityApplied?: ContinuityAppliedVerifier;
    onDeliveredCheckpoint?: (checkpoint: AuthoritativeRollingCheckpoint) => void;
    beforeCommit?: (prepared: {
      migrationGrant: AuthorityPoolMigrationGrant;
      deliveredCheckpoint?: AuthoritativeRollingCheckpoint;
    }) => Promise<boolean>;
    onBlocked?: (code: string) => void;
  }) => Promise<
    (AuthorityPoolMigrationGrant & { readonly deliveredCheckpoint?: AuthoritativeRollingCheckpoint }) | null
  >;
  readonly recordRemotePlacement?: (args: {
    readonly uid: number;
    readonly sessionKey: string;
    readonly engine: string;
    readonly operationId: string;
    readonly profileId?: string;
  }) => Promise<void>;
  /**
   * Mints authentic local billing + transport route credentials for non-egress-billed
   * engines (`codex` / `antigravity`) BEFORE PG `placementEpoch` commit.
   * Must return `null` (or throw) if local billing/route cannot be established.
   */
  readonly prepareLocalFallbackTransport?: (args: {
    readonly localExec: TExec;
    readonly billingRequestId?: string;
    readonly authorityTurnId?: string;
  }) => Promise<PreparedLocalFallbackTransport | null>;
  /**
   * Exposes the idempotent compensation + forward lifecycle handle to the outer bridge
   * ONLY when fallback sealing succeeds and commits, so post-seal failures (`cleaned`,
   * `ERR_FRAME_TOO_BIG`, container forward rejection, prompt-queue cancel) still unwind
   * all local billing/route resources with zero leakage.
   */
  readonly onLocalFallbackCommitted?: (handle: LocalFallbackCommittedHandle) => void;
  readonly resolveLocalExec?: (canonicalModel: string) => Promise<TExec | null>;
  readonly isModelAllowed?: (canonicalModel: string) => boolean;
  readonly readEpochAtSign: () => Promise<bigint>;
  readonly signAuthorityBundle: (
    exec: TExec,
    billingRequestId?: string,
    authorityTurnId?: string,
    executionBackend?: RemoteExecutionBackend,
    poolMigration?: AuthorityPoolMigrationGrant,
  ) => ModelAuthorityBundle;
  readonly reject: (code: string, message: string, reason: string) => Promise<null>;
}

/**
 * Resolves the remote execution backend (including return-to-remote migration grant
 * and two-phase cross-pool fallback to local CCB/Codex/Antigravity) and seals the
 * model authority fields.
 * Extracted from `userChatBridge.ts` to keep the bridge under the file-size ratchet cap.
 */
export async function resolveRemotePoolBackendAndSeal<TExec extends SealExecLike>(
  input: RemotePoolSealDeps<TExec>,
): Promise<Record<string, unknown> | null> {
  let executionBackend: RemoteExecutionBackend | undefined;
  let execToSign = input.exec;
  let poolMigration: AuthorityPoolMigrationGrant | undefined;
  let deliveredCheckpoint: AuthoritativeRollingCheckpoint | undefined;
  let preSignedBundle: ModelAuthorityBundle | undefined;
  let effectiveBillingRequestId = input.billingRequestId;
  let committedTransport: PreparedLocalFallbackTransport | undefined;
  let committedCompensateOnce: ((reason: string) => Promise<void>) | undefined;

  let wireBoundCheckpoint: AuthoritativeRollingCheckpoint | undefined;
  const shouldInjectDefaultVerifier =
    input.enableCrossPoolCheckpoint === true ||
    input.sessionId !== undefined ||
    input.historicalMessages !== undefined ||
    input.prepareRollingCheckpoint !== undefined;
  const continuityVerifier: ContinuityAppliedVerifier | undefined =
    input.verifyContinuityApplied ??
    (shouldInjectDefaultVerifier
      ? createSealWireContinuityVerifier({
          onBound: (cp) => {
            wireBoundCheckpoint = cp;
          },
        })
      : undefined);

  try {
    if (input.exec.placement === "remote_pool") {
      if (!input.sessionKey || !input.cc5BackendSelector || input.containerId === undefined) {
        throw new Error("REMOTE_LANE_UNAVAILABLE");
      }
      executionBackend = await input.cc5BackendSelector({
        uid: input.uid,
        containerId: input.containerId,
        sessionKey: input.sessionKey,
        canonicalModel: input.exec.canonicalModel,
        engine: input.exec.engine,
        placement: input.exec.placement,
      });
      if (!executionBackend) throw new Error("REMOTE_LANE_UNAVAILABLE");
      if (input.returnToRemoteGrantResolver) {
        let returnEpochDrifted = false;
        let returnBlockedCode: string | undefined;
        let returnDeliveredCheckpoint: AuthoritativeRollingCheckpoint | undefined;
        const resolvedReturnGrant = await input
          .returnToRemoteGrantResolver({
            uid: input.uid,
            containerId: input.containerId,
            sessionKey: input.sessionKey,
            ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            canonicalModel: input.exec.canonicalModel,
            engine: input.exec.engine,
            executionBackend,
            expectedSecurityEpoch: input.exec.securityEpoch,
            ...(input.hasLocalHistory !== undefined ? { hasLocalHistory: input.hasLocalHistory } : {}),
            ...(input.historicalMessages !== undefined
              ? { historicalMessages: input.historicalMessages }
              : {}),
            ...(input.excludeClientMessageId !== undefined
              ? { excludeClientMessageId: input.excludeClientMessageId }
              : {}),
            ...(input.prepareRollingCheckpoint !== undefined
              ? { prepareRollingCheckpoint: input.prepareRollingCheckpoint }
              : {}),
            ...(continuityVerifier !== undefined
              ? { verifyContinuityApplied: continuityVerifier }
              : {}),
            onDeliveredCheckpoint: (cp) => {
              returnDeliveredCheckpoint = cp;
            },
            onBlocked: (code) => {
              returnBlockedCode = code;
            },
            beforeCommit: async (prepared) => {
              const latestEpoch = await input.readEpochAtSign().catch(() => null);
              if (latestEpoch === null || Number(latestEpoch) !== input.exec.securityEpoch) {
                returnEpochDrifted = true;
                return false;
              }
              const candidateCp = prepared.deliveredCheckpoint ?? wireBoundCheckpoint;
              if (
                prepared.migrationGrant.continuityTier === "tape_rebuilt" &&
                buildCrossPoolCheckpointWirePayload(candidateCp, prepared.migrationGrant) === null
              ) {
                returnBlockedCode = "CROSS_POOL_CHECKPOINT_UNAVAILABLE";
                return false;
              }
              if (prepared.deliveredCheckpoint) {
                returnDeliveredCheckpoint = prepared.deliveredCheckpoint;
              }
              preSignedBundle = input.signAuthorityBundle(
                input.exec,
                input.billingRequestId,
                input.authorityTurnId,
                executionBackend,
                toProtocolPoolMigrationGrant(prepared.migrationGrant),
              );
              return true;
            },
          })
          .catch(() => null);
        poolMigration = toProtocolPoolMigrationGrant(resolvedReturnGrant ?? undefined);
        deliveredCheckpoint =
          returnDeliveredCheckpoint ??
          resolvedReturnGrant?.deliveredCheckpoint ??
          (poolMigration?.continuityTier === "tape_rebuilt" ? wireBoundCheckpoint : undefined);
        if (returnEpochDrifted) {
          return await input.reject(
            "MODEL_CONFIG_CHANGED_RETRY_TURN",
            "model configuration changed, please resend",
            "sign_boundary_epoch_changed",
          );
        }
        if (returnBlockedCode) {
          return await input.reject(
            "REMOTE_NATIVE_UNAVAILABLE",
            "remote node unavailable for this chat, retry shortly",
            "return_to_remote_blocked",
          );
        }
      }
      // OCV5-902 B4: Persist initial `remote_pool` placement pointer on first healthy direct remote
      // turn so a subsequent admin remote-binding disable always finds an authoritative pointer.
      if (!poolMigration && input.recordRemotePlacement) {
        const profileId =
          "profileId" in executionBackend && typeof executionBackend.profileId === "string"
            ? executionBackend.profileId
            : undefined;
        await input
          .recordRemotePlacement({
            uid: input.uid,
            sessionKey: input.sessionKey,
            engine: input.exec.engine,
            operationId: executionBackend.operationId,
            ...(profileId ? { profileId } : {}),
          })
          .catch((recErr) => {
            input.log?.warn("user-chat-bridge: initial remote placement pointer persist failed", {
              sessionKey: input.sessionKey,
              err: recErr,
            });
          });
      }
    } else if (
      input.exec.placement === "local" &&
      input.forcedLocalMigrationResolver &&
      input.sessionKey &&
      input.containerId !== undefined
    ) {
      let forcedEpochDrifted = false;
      let forcedBlockedCode: string | undefined;
      let forcedDeliveredCheckpoint: AuthoritativeRollingCheckpoint | undefined;
      const resolvedForcedGrant = await input
        .forcedLocalMigrationResolver({
          uid: input.uid,
          containerId: input.containerId,
          sessionKey: input.sessionKey,
          ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
          canonicalModel: input.exec.canonicalModel,
          engine: input.exec.engine,
          reason: "MODEL_POOL_BINDING_FORCED_LOCAL",
          expectedSecurityEpoch: input.exec.securityEpoch,
          ...(input.historicalMessages !== undefined
            ? { historicalMessages: input.historicalMessages }
            : {}),
          ...(input.excludeClientMessageId !== undefined
            ? { excludeClientMessageId: input.excludeClientMessageId }
            : {}),
          ...(input.prepareRollingCheckpoint !== undefined
            ? { prepareRollingCheckpoint: input.prepareRollingCheckpoint }
            : {}),
          ...(continuityVerifier !== undefined
            ? { verifyContinuityApplied: continuityVerifier }
            : {}),
          onDeliveredCheckpoint: (cp) => {
            forcedDeliveredCheckpoint = cp;
          },
          onBlocked: (code) => {
            forcedBlockedCode = code;
          },
          beforeCommit: async (prepared) => {
            const latestEpoch = await input.readEpochAtSign().catch(() => null);
            if (latestEpoch === null || Number(latestEpoch) !== input.exec.securityEpoch) {
              forcedEpochDrifted = true;
              return false;
            }
            const candidateCp = prepared.deliveredCheckpoint ?? wireBoundCheckpoint;
            if (
              prepared.migrationGrant.continuityTier === "tape_rebuilt" &&
              buildCrossPoolCheckpointWirePayload(candidateCp, prepared.migrationGrant) === null
            ) {
              forcedBlockedCode = "CROSS_POOL_CHECKPOINT_UNAVAILABLE";
              return false;
            }
            if (prepared.deliveredCheckpoint) {
              forcedDeliveredCheckpoint = prepared.deliveredCheckpoint;
            }
            preSignedBundle = input.signAuthorityBundle(
              input.exec,
              input.billingRequestId,
              input.authorityTurnId,
              undefined,
              toProtocolPoolMigrationGrant(prepared.migrationGrant),
            );
            return true;
          },
        })
        .catch(() => null);
      poolMigration = toProtocolPoolMigrationGrant(resolvedForcedGrant ?? undefined);
      deliveredCheckpoint =
        forcedDeliveredCheckpoint ??
        resolvedForcedGrant?.deliveredCheckpoint ??
        (poolMigration?.continuityTier === "tape_rebuilt" ? wireBoundCheckpoint : undefined);
      if (forcedEpochDrifted) {
        return await input.reject(
          "MODEL_CONFIG_CHANGED_RETRY_TURN",
          "model configuration changed, please resend",
          "sign_boundary_epoch_changed",
        );
      }
      if (forcedBlockedCode) {
        return await input.reject(
          "REMOTE_NATIVE_UNAVAILABLE",
          "remote node unavailable for this chat, retry shortly",
          "forced_local_migration_blocked",
        );
      }
    }
  } catch (err) {
    let preparedLocalExec: TExec | undefined;
    let preparedTransport: PreparedLocalFallbackTransport | undefined;
    let transportCompensated = false;
    let fallbackEpochDrifted = false;
    let preSignedMigrationId: string | undefined;
    let fallbackDeliveredCheckpoint: AuthoritativeRollingCheckpoint | undefined;

    const compensateTransportOnce = async (reason: string): Promise<void> => {
      if (!preparedTransport || transportCompensated) return;
      transportCompensated = true;
      try {
        await preparedTransport.compensate(reason);
      } catch (compErr) {
        input.log?.error("user-chat-bridge: local fallback transport compensation failed", {
          reason,
          engine: preparedLocalExec?.engine ?? input.exec.engine,
          err: compErr,
        });
      }
    };

    const prepareTransportIfRequired = async (localExec: TExec): Promise<boolean> => {
      if (!engineRequiresLocalFallbackTransport(localExec.engine)) {
        return true;
      }
      if (!input.prepareLocalFallbackTransport) {
        return false;
      }
      let prepared: PreparedLocalFallbackTransport | null;
      try {
        prepared = await input.prepareLocalFallbackTransport({
          localExec,
          billingRequestId: input.billingRequestId,
          authorityTurnId: input.authorityTurnId,
        });
      } catch (prepErr) {
        input.log?.warn("user-chat-bridge: local fallback transport preparation threw", {
          engine: localExec.engine,
          model: localExec.canonicalModel,
          err: prepErr,
        });
        return false;
      }
      if (!prepared) {
        return false;
      }
      preparedTransport = prepared;
      if (prepared.billingRequestId !== undefined) {
        effectiveBillingRequestId = prepared.billingRequestId;
      }
      return true;
    };

    const prepareAndSignLocalTarget = async (
      localExec: TExec,
      migrationGrant: AuthorityPoolMigrationGrant | undefined,
    ): Promise<boolean> => {
      const latestEpochBeforePrep = await input.readEpochAtSign().catch(() => null);
      if (
        latestEpochBeforePrep === null ||
        Number(latestEpochBeforePrep) !== input.exec.securityEpoch
      ) {
        fallbackEpochDrifted = true;
        return false;
      }
      const transportReady = await prepareTransportIfRequired(localExec);
      if (!transportReady) {
        return false;
      }
      // MAJOR-2: local fallback transport prep performs async DB/Redis/OAuth I/O;
      // re-read the authoritative security epoch immediately before signing.
      if (preparedTransport) {
        const latestEpochAfterPrep = await input.readEpochAtSign().catch(() => null);
        if (
          latestEpochAfterPrep === null ||
          Number(latestEpochAfterPrep) !== input.exec.securityEpoch
        ) {
          fallbackEpochDrifted = true;
          await compensateTransportOnce("sign_boundary_epoch_changed");
          return false;
        }
      }
      try {
        preSignedBundle = input.signAuthorityBundle(
          localExec,
          effectiveBillingRequestId,
          input.authorityTurnId,
          undefined,
          toProtocolPoolMigrationGrant(migrationGrant),
        );
        preSignedMigrationId = migrationGrant?.migrationId;
      } catch (signErr) {
        input.log?.error("user-chat-bridge: local fallback authority signing failed", {
          engine: localExec.engine,
          model: localExec.canonicalModel,
          err: signErr,
        });
        await compensateTransportOnce("fallback_sign_failed");
        return false;
      }
      return true;
    };

    const fb =
      input.sessionKey && input.containerId !== undefined && input.crossPoolFallbackSelector
        ? await input
            .crossPoolFallbackSelector({
              uid: input.uid,
              containerId: input.containerId,
              sessionKey: input.sessionKey,
              ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
              canonicalModel: input.exec.canonicalModel,
              engine: input.exec.engine,
              cause: err,
              expectedSecurityEpoch: input.exec.securityEpoch,
              ...(input.historicalMessages !== undefined
                ? { historicalMessages: input.historicalMessages }
                : {}),
              ...(input.excludeClientMessageId !== undefined
                ? { excludeClientMessageId: input.excludeClientMessageId }
                : {}),
              ...(input.prepareRollingCheckpoint !== undefined
                ? { prepareRollingCheckpoint: input.prepareRollingCheckpoint }
                : {}),
              ...(continuityVerifier !== undefined
                ? { verifyContinuityApplied: continuityVerifier }
                : {}),
              validateTargetSignable: async (target) => {
                if (
                  engineRequiresLocalFallbackTransport(target.engine) &&
                  !input.prepareLocalFallbackTransport
                ) {
                  return false;
                }
                if (!input.resolveLocalExec) return true;
                const localExec = await input
                  .resolveLocalExec(target.canonicalModel)
                  .catch(() => null);
                if (
                  !localExec ||
                  localExec.placement !== "local" ||
                  localExec.engine !== input.exec.engine ||
                  localExec.securityEpoch !== input.exec.securityEpoch
                ) {
                  return false;
                }
                if (
                  engineRequiresLocalFallbackTransport(localExec.engine) &&
                  !input.prepareLocalFallbackTransport
                ) {
                  return false;
                }
                if (input.isModelAllowed && !input.isModelAllowed(localExec.canonicalModel)) {
                  return false;
                }
                preparedLocalExec = localExec;
                return true;
              },
              beforeCommit: async (prepared) => {
                const candidateCp = prepared.deliveredCheckpoint ?? wireBoundCheckpoint;
                if (
                  prepared.migrationGrant.continuityTier === "tape_rebuilt" &&
                  buildCrossPoolCheckpointWirePayload(candidateCp, prepared.migrationGrant) === null
                ) {
                  return false;
                }
                if (prepared.deliveredCheckpoint) {
                  fallbackDeliveredCheckpoint = prepared.deliveredCheckpoint;
                }
                const execForSign = preparedLocalExec ?? input.exec;
                return await prepareAndSignLocalTarget(execForSign, prepared.migrationGrant);
              },
            })
            .catch(() => null)
        : null;

    let fallbackAccepted = false;
    if (fb && fb.fallbackPool === "local_pool") {
      if (preparedLocalExec && preSignedBundle) {
        const grantMatches =
          !preSignedMigrationId ||
          !fb.migrationGrant ||
          fb.migrationGrant.migrationId === preSignedMigrationId;
        const transportSatisfied =
          !engineRequiresLocalFallbackTransport(preparedLocalExec.engine) ||
          preparedTransport !== undefined;
        if (grantMatches && transportSatisfied) {
          execToSign = preparedLocalExec;
          executionBackend = undefined;
          poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
          fallbackAccepted = true;
        }
      } else if (preparedLocalExec) {
        // B01: Reusing an already-active local_container placement (no same-pool migration;
        // preserves idempotent redelivered migrationGrant if first local turn was never confirmed).
        // Still enforce sign-boundary epoch verification and local transport preparation!
        if (await prepareAndSignLocalTarget(preparedLocalExec, fb.migrationGrant)) {
          execToSign = preparedLocalExec;
          executionBackend = undefined;
          poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
          fallbackAccepted = true;
        }
      } else if (fb.resolvedCanonicalModel && input.resolveLocalExec) {
        const localExec = await input
          .resolveLocalExec(fb.resolvedCanonicalModel)
          .catch(() => null);
        if (
          localExec &&
          localExec.placement === "local" &&
          localExec.engine === input.exec.engine &&
          localExec.securityEpoch === input.exec.securityEpoch &&
          (!input.isModelAllowed || input.isModelAllowed(localExec.canonicalModel))
        ) {
          if (await prepareAndSignLocalTarget(localExec, fb.migrationGrant)) {
            execToSign = localExec;
            executionBackend = undefined;
            poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
            fallbackAccepted = true;
          }
        }
      } else if (!fb.resolvedCanonicalModel) {
        if (engineRequiresLocalFallbackTransport(input.exec.engine)) {
          if (preSignedBundle && preparedTransport) {
            executionBackend = undefined;
            poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
            fallbackAccepted = true;
          } else if (await prepareAndSignLocalTarget(input.exec, fb.migrationGrant)) {
            executionBackend = undefined;
            poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
            fallbackAccepted = true;
          }
        } else {
          executionBackend = undefined;
          poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
          fallbackAccepted = true;
        }
      }
    } else if (fb?.executionBackend) {
      await compensateTransportOnce("fallback_switched_to_remote");
      executionBackend = fb.executionBackend;
      poolMigration = toProtocolPoolMigrationGrant(fb.migrationGrant);
      fallbackAccepted = true;
    }

    if (fallbackEpochDrifted) {
      await compensateTransportOnce("sign_boundary_epoch_changed");
      return await input.reject(
        "MODEL_CONFIG_CHANGED_RETRY_TURN",
        "model configuration changed, please resend",
        "sign_boundary_epoch_changed",
      );
    }
    if (!fallbackAccepted) {
      await compensateTransportOnce("cross_pool_fallback_rejected");
      input.log?.warn("user-chat-bridge: remote lane unavailable", {
        model: input.exec.canonicalModel,
        cause:
          err instanceof Error
            ? err.cause instanceof Error
              ? err.cause.message
              : err.message
            : String(err),
      });
      const errCode = (err as (Error & { code?: string }) | null)?.code ?? "";
      if (
        err instanceof Error &&
        (errCode === "REMOTE_NODE_MEMORY_EXHAUSTED" || errCode === "REMOTE_NODE_TASKS_EXHAUSTED")
      ) {
        const active = Number((err as Error & { activeSessions?: unknown }).activeSessions);
        const count = Number.isSafeInteger(active) && active >= 0 ? active : 0;
        return await input.reject(
          errCode,
          `远端节点${errCode === "REMOTE_NODE_TASKS_EXHAUSTED" ? "进程/线程额度不足" : "内存不足"}，当前底座已有 ${count} 个会话在跑`,
          errCode.toLowerCase(),
        );
      }
      return await input.reject(
        "REMOTE_NATIVE_UNAVAILABLE",
        "remote node unavailable for this chat, retry shortly",
        "remote_native_binding_rejected",
      );
    }
    deliveredCheckpoint =
      fb?.deliveredCheckpoint ??
      fallbackDeliveredCheckpoint ??
      (poolMigration?.continuityTier === "tape_rebuilt" ? wireBoundCheckpoint : undefined);
    committedTransport = preparedTransport;
    committedCompensateOnce = compensateTransportOnce;
  }

  const wireCheckpoint =
    poolMigration?.continuityTier === "tape_rebuilt" && deliveredCheckpoint
      ? buildCrossPoolCheckpointWirePayload(deliveredCheckpoint, poolMigration)
      : null;

  // OCV5-902 B2 hard invariant: never emit a `tape_rebuilt` bundle without a valid wire carrier!
  if (poolMigration?.continuityTier === "tape_rebuilt" && wireCheckpoint === null) {
    if (committedCompensateOnce) {
      await committedCompensateOnce("missing_warm_checkpoint_carrier");
    }
    return await input.reject(
      "REMOTE_NATIVE_UNAVAILABLE",
      "cross-pool continuity checkpoint unavailable, retry shortly",
      "missing_warm_checkpoint_carrier",
    );
  }

  let finalBundle: ModelAuthorityBundle;
  try {
    finalBundle =
      preSignedBundle ??
      input.signAuthorityBundle(
        execToSign,
        effectiveBillingRequestId,
        input.authorityTurnId,
        executionBackend,
        toProtocolPoolMigrationGrant(poolMigration),
      );
  } catch (signErr) {
    if (committedCompensateOnce) {
      await committedCompensateOnce("fallback_sign_failed");
    }
    throw signErr;
  }

  if (committedTransport && committedCompensateOnce) {
    input.onLocalFallbackCommitted?.({
      compensate: committedCompensateOnce,
      onForwarded: committedTransport.onForwarded,
      billingRequestId: effectiveBillingRequestId,
      localEngine: execToSign.engine,
    });
  }

  if (poolMigration) {
    input.onMigrationCommitted?.({
      migrationId: poolMigration.migrationId,
      placementEpoch: poolMigration.placementEpoch,
      ...(poolMigration.continuityTier !== undefined
        ? { continuityTier: poolMigration.continuityTier }
        : {}),
      checkpointGeneration: wireCheckpoint?.generation ?? null,
    });
  }

  return {
    ...(committedTransport ? committedTransport.extraFrameFields : {}),
    ...(wireCheckpoint ? { [CROSS_POOL_CHECKPOINT_FIELD]: wireCheckpoint } : {}),
    model: execToSign.canonicalModel,
    [MODEL_AUTHORITY_FIELD]: finalBundle,
  };
}
