import { getPool } from "../db/index.js";
import { rootLogger } from "../logging/logger.js";
import { stopAndRemoveV3Container, type V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";

/** Behavior-neutral extraction from bootstrap to keep its file-size budget. */
export function createUnattestedContainerRecycler(getDeps: () => V3SupervisorDeps | undefined): (containerId: number, reason: string) => void {
  /**
   * 容器不支持 model authority attestation(旧 release / 旧 env)→ 销毁它。
   *
   * 复用既有的 codex stale recycle 范式:DB 翻 vanished + docker 清实体,用户下一条
   * 消息触发 ensureRunning 重新 provision(此时 supervisor 会注入 keyring env)。
   * best-effort:清不干净也无妨 —— ensureRunning 会撞名字冲突后自己重试清理(与
   * orphanReconcile 路径一致)。
   */
  return (containerId: number, reason: string): void => {
    const v3Deps = getDeps();
    if (!v3Deps) return;
    const depsForRecycle = v3Deps;
    void (async () => {
      try {
        const { rows } = await getPool().query<{
          id: number;
          container_internal_id: string | null;
          host_uuid: string | null;
          runtime_kind: string;
        }>(
          // lint-agent-containers-sql: allow — recycle by id then branch on kind (must see any state)
          "SELECT id, container_internal_id, host_uuid, runtime_kind FROM agent_containers WHERE id = $1",
          [containerId],
        );
        const row = rows[0];
        if (!row) return;
        if (row.runtime_kind === "desktop") {
          const { getDesktopTunnelRegistry } = await import("./desktopTunnelRegistry.js");
          getDesktopTunnelRegistry().drop(containerId, "attestation_failed");
          await getPool().query(
            `UPDATE agent_containers SET update_required = true, updated_at = NOW()
              WHERE id = $1 AND runtime_kind = 'desktop'`,
            [containerId],
          );
          await getPool().query(
            `INSERT INTO desktop_device_audit(user_id, event, container_id, extra)
             SELECT user_id, 'update_required', id, $2::jsonb FROM agent_containers
              WHERE id = $1 AND runtime_kind = 'desktop' AND state = 'active'`,
            [containerId, JSON.stringify({ reason })],
          );
          rootLogger.warn("[commercial] desktop container marked update_required (no vanish)", {
            containerId,
            reason,
          });
          return;
        }
        await stopAndRemoveV3Container(depsForRecycle, row);
        rootLogger.warn("[commercial] recycled container without model-authority attestation", {
          containerId,
          reason,
        });
      } catch (err) {
        rootLogger.error("[commercial] model-authority recycle failed", {
          containerId,
          reason,
          err: (err as Error)?.message ?? String(err),
        });
      }
    })();
  };

}
