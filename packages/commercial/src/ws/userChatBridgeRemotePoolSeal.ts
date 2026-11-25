import {
  MODEL_AUTHORITY_FIELD,
  type AuthorityPoolMigrationGrant,
  type ModelAuthorityBundle,
  type RemoteExecutionBackend,
} from "@openclaude/protocol";
import type { Logger } from "../logging/logger.js";

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
    canonicalModel: string;
    engine: string;
    cause: unknown;
    expectedSecurityEpoch?: number;
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
    }) => Promise<boolean>;
  }) => Promise<{
    executionBackend?: RemoteExecutionBackend;
    fallbackPool: "local_pool" | "remote_pool";
    resolvedCanonicalModel?: string;
    migrationGrant?: AuthorityPoolMigrationGrant;
  } | null>;
  readonly returnToRemoteGrantResolver?: (args: {
    uid: number;
    containerId: number;
    sessionKey: string;
    canonicalModel: string;
    engine: string;
    executionBackend: RemoteExecutionBackend;
    expectedSecurityEpoch?: number;
    beforeCommit?: (prepared: { migrationGrant: AuthorityPoolMigrationGrant }) => Promise<boolean>;
    onBlocked?: (code: string) => void;
  }) => Promise<AuthorityPoolMigrationGrant | null>;
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
  let preSignedBundle: ModelAuthorityBundle | undefined;
  let effectiveBillingRequestId = input.billingRequestId;
  let committedTransport: PreparedLocalFallbackTransport | undefined;
  let committedCompensateOnce: ((reason: string) => Promise<void>) | undefined;

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
        poolMigration =
          (await input
            .returnToRemoteGrantResolver({
              uid: input.uid,
              containerId: input.containerId,
              sessionKey: input.sessionKey,
              canonicalModel: input.exec.canonicalModel,
              engine: input.exec.engine,
              executionBackend,
              expectedSecurityEpoch: input.exec.securityEpoch,
              onBlocked: (code) => {
                returnBlockedCode = code;
              },
              beforeCommit: async (prepared) => {
                const latestEpoch = await input.readEpochAtSign().catch(() => null);
                if (latestEpoch === null || Number(latestEpoch) !== input.exec.securityEpoch) {
                  returnEpochDrifted = true;
                  return false;
                }
                preSignedBundle = input.signAuthorityBundle(
                  input.exec,
                  input.billingRequestId,
                  input.authorityTurnId,
                  executionBackend,
                  prepared.migrationGrant,
                );
                return true;
              },
            })
            .catch(() => null)) ?? undefined;
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
    }
  } catch (err) {
    let preparedLocalExec: TExec | undefined;
    let preparedTransport: PreparedLocalFallbackTransport | undefined;
    let transportCompensated = false;
    let fallbackEpochDrifted = false;
    let preSignedMigrationId: string | undefined;

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
          migrationGrant,
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
              canonicalModel: input.exec.canonicalModel,
              engine: input.exec.engine,
              cause: err,
              expectedSecurityEpoch: input.exec.securityEpoch,
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
          poolMigration = fb.migrationGrant;
          fallbackAccepted = true;
        }
      } else if (preparedLocalExec) {
        // B01: Reusing an already-active local_container placement (no same-pool migration;
        // preserves idempotent redelivered migrationGrant if first local turn was never confirmed).
        // Still enforce sign-boundary epoch verification and local transport preparation!
        if (await prepareAndSignLocalTarget(preparedLocalExec, fb.migrationGrant)) {
          execToSign = preparedLocalExec;
          executionBackend = undefined;
          poolMigration = fb.migrationGrant;
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
            poolMigration = fb.migrationGrant;
            fallbackAccepted = true;
          }
        }
      } else if (!fb.resolvedCanonicalModel) {
        if (engineRequiresLocalFallbackTransport(input.exec.engine)) {
          if (preSignedBundle && preparedTransport) {
            executionBackend = undefined;
            poolMigration = fb.migrationGrant;
            fallbackAccepted = true;
          } else if (await prepareAndSignLocalTarget(input.exec, fb.migrationGrant)) {
            executionBackend = undefined;
            poolMigration = fb.migrationGrant;
            fallbackAccepted = true;
          }
        } else {
          executionBackend = undefined;
          poolMigration = fb.migrationGrant;
          fallbackAccepted = true;
        }
      }
    } else if (fb?.executionBackend) {
      await compensateTransportOnce("fallback_switched_to_remote");
      executionBackend = fb.executionBackend;
      poolMigration = fb.migrationGrant;
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
    committedTransport = preparedTransport;
    committedCompensateOnce = compensateTransportOnce;
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
        poolMigration,
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

  return {
    ...(committedTransport ? committedTransport.extraFrameFields : {}),
    model: execToSign.canonicalModel,
    [MODEL_AUTHORITY_FIELD]: finalBundle,
  };
}
