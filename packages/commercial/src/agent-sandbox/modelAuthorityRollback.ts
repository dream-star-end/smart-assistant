/**
 * 模型权威 flag 回滚时的容器平滑清退器。
 *
 * 总 flag 不能在仍有 `OC_MODEL_AUTHORITY=1` 容器时直接关闭：这些容器会继续要求签名
 * envelope，而旧 master 已不再签发，用户下一条消息会被 runtime 拒绝。部署脚本先以
 * `OC_MODEL_AUTHORITY=1 + OC_MODEL_AUTHORITY_PROVISION_REQUIRED=0` 重启 master，停止制造
 * 新强制容器；本模块再逐个 authenticated drain 旧容器，并要求连续 quiet window 内没有
 * flagged/provisioning/unknown 尾巴，之后部署脚本才可关总 flag。
 */

export type ModelAuthorityRollbackState =
  | "flagged_running"
  | "flagged_stopped"
  | "missing"
  | "provisioning"
  | "unknown"
  | "unflagged";

export interface ModelAuthorityRollbackTarget {
  /** DB row id for active rows; `docker:<cid>` for Docker-only orphans. */
  id: number | string;
  state: ModelAuthorityRollbackState;
}

export interface ModelAuthorityRollbackDeps {
  /** 每轮重新取 DB + Docker 活体快照；抛错视作 unknown，不能进入 quiet。 */
  scan(): Promise<ModelAuthorityRollbackTarget[]>;
  /** 仅 running flagged 调用；只有 accepted 才允许 cleanup。 */
  drain(target: ModelAuthorityRollbackTarget): Promise<"accepted" | "busy" | "failed">;
  /** stopped/missing 或已 accepted 的 running flagged 才调用。 */
  cleanup(target: ModelAuthorityRollbackTarget): Promise<void>;
  now(): number;
  sleep(ms: number): Promise<void>;
  log?(message: string): void;
}

export interface ModelAuthorityRollbackOptions {
  timeoutMs?: number;
  quietMs?: number;
  pollMs?: number;
}

export interface ModelAuthorityRollbackResult {
  elapsedMs: number;
  scans: number;
}

const DEFAULT_TIMEOUT_MS = 45 * 60_000;
const DEFAULT_QUIET_MS = 20_000;
const DEFAULT_POLL_MS = 1_000;

function positiveDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be > 0, got ${String(value)}`);
  }
  return value;
}

/**
 * 收敛所有 flagged 容器，并以真实单调时钟证明连续 quiet window。
 *
 * fail-closed 规则：
 * - scan 抛错、unknown、provisioning、drain busy/failed、cleanup 抛错都重置 quiet；
 * - running flagged 只有 drain=accepted 后才 cleanup；
 * - 超时抛错，由 deploy-v5.sh 保持总 flag=1 与 egress enforce=true。
 */
export async function runModelAuthorityContainerRollback(
  deps: ModelAuthorityRollbackDeps,
  options: ModelAuthorityRollbackOptions = {},
): Promise<ModelAuthorityRollbackResult> {
  const timeoutMs = positiveDuration("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const quietMs = positiveDuration("quietMs", options.quietMs ?? DEFAULT_QUIET_MS);
  const pollMs = positiveDuration("pollMs", options.pollMs ?? DEFAULT_POLL_MS);
  const startedAt = deps.now();
  let quietSince: number | null = null;
  let scans = 0;
  let lastSummary = "not_scanned";

  const throwIfTimedOut = (): void => {
    const elapsedMs = deps.now() - startedAt;
    if (elapsedMs >= timeoutMs) {
      throw new Error(
        `model authority container rollback timed out after ${Math.round(elapsedMs)}ms; last=${lastSummary}`,
      );
    }
  };

  while (true) {
    throwIfTimedOut();
    scans += 1;
    let targets: ModelAuthorityRollbackTarget[];
    try {
      targets = await deps.scan();
      // scan 是 DB + Docker I/O，可能本身跨过 deadline；不能在过期快照上宣告 quiet。
      throwIfTimedOut();
    } catch (err) {
      throwIfTimedOut();
      quietSince = null;
      lastSummary = `scan_error:${(err as Error)?.message ?? String(err)}`;
      deps.log?.(`[model-authority-rollback] ${lastSummary}`);
      await deps.sleep(pollMs);
      continue;
    }

    let unsettled = false;
    const counts = new Map<ModelAuthorityRollbackState, number>();
    for (const target of targets) {
      counts.set(target.state, (counts.get(target.state) ?? 0) + 1);
      switch (target.state) {
        case "unflagged":
          break;
        case "provisioning":
        case "unknown":
          unsettled = true;
          break;
        case "flagged_running": {
          unsettled = true;
          let result: "accepted" | "busy" | "failed" = "failed";
          try {
            result = await deps.drain(target);
            throwIfTimedOut();
          } catch {
            throwIfTimedOut();
            result = "failed";
          }
          if (result === "accepted") {
            try {
              await deps.cleanup(target);
              throwIfTimedOut();
            } catch {
              throwIfTimedOut();
              // 下一轮重试；本轮仍不允许进入 quiet。
            }
          }
          break;
        }
        case "flagged_stopped":
        case "missing":
          unsettled = true;
          try {
            await deps.cleanup(target);
            throwIfTimedOut();
          } catch {
            throwIfTimedOut();
            // 下一轮重试；本轮仍不允许进入 quiet。
          }
          break;
      }
    }

    lastSummary = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([state, count]) => `${state}=${count}`)
      .join(",") || "empty";

    const now = deps.now();
    throwIfTimedOut();
    if (unsettled) {
      quietSince = null;
    } else if (quietSince === null) {
      quietSince = now;
      deps.log?.(`[model-authority-rollback] quiet window started (${lastSummary})`);
    } else if (now - quietSince >= quietMs) {
      return { elapsedMs: now - startedAt, scans };
    }

    await deps.sleep(pollMs);
  }
}
