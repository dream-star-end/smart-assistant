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
 * and two-phase cross-pool fallback to local CCB) and seals the model authority fields.
 * Extracted from `userChatBridge.ts` to keep the bridge under the file-size ratchet cap.
 */
export async function resolveRemotePoolBackendAndSeal<TExec extends SealExecLike>(
  input: RemotePoolSealDeps<TExec>,
): Promise<Record<string, unknown> | null> {
  let executionBackend: RemoteExecutionBackend | undefined;
  let execToSign = input.exec;
  let poolMigration: AuthorityPoolMigrationGrant | undefined;
  let preSignedBundle: ModelAuthorityBundle | undefined;

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
    let fallbackEpochDrifted = false;
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
                if (!input.resolveLocalExec) return true;
                const localExec = await input.resolveLocalExec(target.canonicalModel).catch(() => null);
                if (
                  !localExec ||
                  localExec.placement !== "local" ||
                  localExec.engine !== input.exec.engine ||
                  localExec.securityEpoch !== input.exec.securityEpoch
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
                const latestEpoch = await input.readEpochAtSign().catch(() => null);
                if (latestEpoch === null || Number(latestEpoch) !== input.exec.securityEpoch) {
                  fallbackEpochDrifted = true;
                  return false;
                }
                preSignedBundle = input.signAuthorityBundle(
                  execForSign,
                  input.billingRequestId,
                  input.authorityTurnId,
                  undefined,
                  prepared.migrationGrant,
                );
                return true;
              },
            })
            .catch(() => null)
        : null;
    let fallbackAccepted = false;
    if (fb && fb.fallbackPool === "local_pool") {
      if (preparedLocalExec && preSignedBundle) {
        execToSign = preparedLocalExec;
        executionBackend = undefined;
        poolMigration = fb.migrationGrant;
        fallbackAccepted = true;
      } else if (preparedLocalExec) {
        // B01: Reusing an already-active local_container placement (no same-pool migration;
        // preserves idempotent redelivered migrationGrant if first local turn was never confirmed).
        // Still enforce sign-boundary epoch verification before signing!
        const latestEpoch = await input.readEpochAtSign().catch(() => null);
        if (latestEpoch === null || Number(latestEpoch) !== input.exec.securityEpoch) {
          fallbackEpochDrifted = true;
        } else {
          execToSign = preparedLocalExec;
          executionBackend = undefined;
          poolMigration = fb.migrationGrant;
          fallbackAccepted = true;
        }
      } else if (fb.resolvedCanonicalModel && input.resolveLocalExec) {
        const localExec = await input.resolveLocalExec(fb.resolvedCanonicalModel).catch(() => null);
        if (
          localExec &&
          localExec.placement === "local" &&
          localExec.engine === input.exec.engine &&
          localExec.securityEpoch === input.exec.securityEpoch
        ) {
          execToSign = localExec;
          executionBackend = undefined;
          poolMigration = fb.migrationGrant;
          fallbackAccepted = true;
        }
      } else if (!fb.resolvedCanonicalModel) {
        executionBackend = undefined;
        poolMigration = fb.migrationGrant;
        fallbackAccepted = true;
      }
    } else if (fb?.executionBackend) {
      executionBackend = fb.executionBackend;
      poolMigration = fb.migrationGrant;
      fallbackAccepted = true;
    }
    if (fallbackEpochDrifted) {
      return await input.reject(
        "MODEL_CONFIG_CHANGED_RETRY_TURN",
        "model configuration changed, please resend",
        "sign_boundary_epoch_changed",
      );
    }
    if (!fallbackAccepted) {
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
  }

  return {
    model: execToSign.canonicalModel,
    [MODEL_AUTHORITY_FIELD]:
      preSignedBundle ??
      input.signAuthorityBundle(
        execToSign,
        input.billingRequestId,
        input.authorityTurnId,
        executionBackend,
        poolMigration,
      ),
  };
}
