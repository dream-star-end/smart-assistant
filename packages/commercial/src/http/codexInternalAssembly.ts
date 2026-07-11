/**
 * codexInternalAssembly — codex 内部端点(token-refresh / relay)的装配单一权威源。
 *
 * M1b 架构决策(2026-07-02):codex relay 归属 egress 进程。
 *   92ddbbdc 把容器出站(172.31.0.1:18892)拆到独立 openclaude-v5-egress 进程,
 *   /v1/messages 在 egress 本地跑全链,master 重启不再掐断在飞 LLM 流。codex 的
 *   `/internal/v3/codex-relay`(流式)与 `/internal/v3/codex/token-refresh`
 *   (reverse-RPC 401 自愈)按同一拓扑在 **egress 进程本地挂载**(egress/main.ts),
 *   使 codex 在飞流/续 token 不受 master 重启影响;master dispatchInternal 同时保留
 *   挂载,服务非 split 拓扑(dev / 测试 / 单进程部署)—— split 模式下容器流量在
 *   egress 已被本地吃掉,不会双跑。
 *
 * 两个进程装配同一批 db 闭包 / fileWriter(状态全在 PG + 容器 auth 目录,跨进程
 * 天然一致)。此前 v3 形态这 ~120 行内联在 index.ts;拆到本模块是为了 master 与
 * egress 共用同一份实现,根除"两处手抄闭包长出漂移"的一类风险。
 *
 * ⚠️ 部署红线(memory: v5-egress-split):改本文件 / internalCodexRelay /
 * internalCodexTokenRefresh 及其依赖后,部署必须 `deploy-v5.sh --egress`,
 * 否则 egress 进程继续跑旧代码。
 */

import { tx } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import type { ContainerIdentityRepo } from "../auth/containerIdentity.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import type { RateLimitRedis } from "../middleware/rateLimit.js";
import type { PreCheckRedis } from "../billing/preCheck.js";
import type { Pool } from "pg";
import { writeCodexContainerAuthFile } from "../codex-auth/codexAuthFile.js";
import {
  putRemoteCodexContainerAuth,
  deleteRemoteCodexContainerAuth,
} from "../codex-auth/remoteCodexAuth.js";
import { DEFAULT_V3_CODEX_CONTAINER_DIR } from "../codex-auth/constants.js";
import { resolveServiceableHostTarget } from "../compute-pool/nodeAgentClient.js";
import { V3_AGENT_GID, V3_AGENT_UID } from "../agent-sandbox/constants.js";
import {
  makeCodexTokenRefreshHandler,
  type CodexTokenRefreshHandler,
} from "./internalCodexTokenRefresh.js";
import {
  makeCodexRelayHandler,
  makeDefaultCodexRelayDb,
  type CodexRelayHandler,
} from "./internalCodexRelay.js";

/** per-container codex auth 根目录(env 覆盖 → default),master/egress 同权威。 */
export function readCodexContainerDir(): string {
  return process.env.OC_V3_CODEX_CONTAINER_DIR?.trim() || DEFAULT_V3_CODEX_CONTAINER_DIR;
}

/**
 * 远端 host per-container codex auth 写入 helper —— 统一
 * getHostById → hostRowToTarget → put → finally psk.fill(0) 三件套。
 * 与 index.ts v3Deps.putRemoteCodexAuth 同实现(那份保留是 v3supervisor deps
 * 形状要求;两者都收敛调用 putRemoteCodexContainerAuth,无第二套协议)。
 */
export async function putRemoteCodexAuthViaServiceableHost(
  hostUuid: string,
  containerId: string,
  accessToken: string,
  lastRefreshIso: string,
): Promise<void> {
  // A3 — service file-IO:revoked / 缺 fingerprint 的 host 直接拒。
  const target = await resolveServiceableHostTarget(hostUuid);
  try {
    await putRemoteCodexContainerAuth(target, containerId, accessToken, lastRefreshIso);
  } finally {
    target.psk?.fill(0);
  }
}

/** 对称删除(stopAndRemove / fanout 清理路径用)。 */
export async function deleteRemoteCodexAuthViaServiceableHost(
  hostUuid: string,
  containerId: string,
): Promise<void> {
  const target = await resolveServiceableHostTarget(hostUuid);
  try {
    await deleteRemoteCodexContainerAuth(target, containerId);
  } finally {
    target.psk?.fill(0);
  }
}

export interface CodexInternalHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  rateLimitRedis: RateLimitRedis;
  healthTracker: AccountHealthTracker;
  /** 本机 compute_hosts host_id(UUID)。 */
  selfHostId: string;
  /** refresh 失败 disable 后的 fanout 触发闭包(master 用 ref 延迟装配;egress 直连)。 */
  triggerCodexDisableFanout: (accountId: bigint) => void;
}

/**
 * `/internal/v3/codex/token-refresh` handler 装配。
 *
 * db 闭包语义(v3 原样,codex round 2 BLOCKER#2):两处都 LEFT JOIN claude_accounts
 * 取 ca.status,让 handler 拒刷 disabled/quarantined/已删账号;FOR UPDATE 只锁
 * agent_containers(`OF ac` 收窄),与 lazy migrate 兼容。channel 过滤(P1d/0098)
 * 保证只服务本 channel 容器。
 */
export function buildCodexTokenRefreshHandler(
  deps: CodexInternalHandlerDeps,
): CodexTokenRefreshHandler {
  return makeCodexTokenRefreshHandler({
    identityRepo: deps.identityRepo,
    rateLimitRedis: deps.rateLimitRedis,
    codexContainerDir: readCodexContainerDir(),
    containerUid: V3_AGENT_UID,
    containerGid: V3_AGENT_GID,
    selfHostId: deps.selfHostId,
    refreshDeps: {
      health: deps.healthTracker,
      triggerCodexDisableFanout: deps.triggerCodexDisableFanout,
    },
    db: {
      async readContainerAccount(containerId) {
        const r = await getPool().query<{
          codex_account_id: string | null;
          user_id: string;
          state: string;
          host_uuid: string | null;
          account_status: string | null;
        }>(
          `SELECT ac.codex_account_id::text AS codex_account_id,
                  ac.user_id::text AS user_id,
                  ac.state,
                  ac.host_uuid::text AS host_uuid,
                  ca.status AS account_status
             FROM agent_containers ac -- state selected above; refresh handler rejects non-active
             LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
            WHERE ac.id = $1 AND ac.runtime_channel = $2`,
          [containerId, getRuntimeChannel()],
        );
        if (r.rows.length === 0) return null;
        const row = r.rows[0];
        return {
          codexAccountId: row.codex_account_id === null ? null : BigInt(row.codex_account_id),
          userId: BigInt(row.user_id),
          state: row.state,
          hostUuid: row.host_uuid,
          accountStatus: row.account_status,
        };
      },
      async txWithLock(containerId, fn) {
        return await tx(async (client) => {
          const lockRes = await client.query<{
            codex_account_id: string | null;
            user_id: string;
            state: string;
            host_uuid: string | null;
            account_status: string | null;
          }>(
            `SELECT ac.codex_account_id::text AS codex_account_id,
                    ac.user_id::text AS user_id,
                    ac.state,
                    ac.host_uuid::text AS host_uuid,
                    ca.status AS account_status
               FROM agent_containers ac -- state selected above; handler re-validates under lock
               LEFT JOIN claude_accounts ca ON ca.id = ac.codex_account_id
              WHERE ac.id = $1 AND ac.runtime_channel = $2
                FOR UPDATE OF ac`,
            [containerId, getRuntimeChannel()],
          );
          const row =
            lockRes.rows.length === 0
              ? null
              : {
                  codexAccountId:
                    lockRes.rows[0].codex_account_id === null
                      ? null
                      : BigInt(lockRes.rows[0].codex_account_id),
                  userId: BigInt(lockRes.rows[0].user_id),
                  state: lockRes.rows[0].state,
                  hostUuid: lockRes.rows[0].host_uuid,
                  accountStatus: lockRes.rows[0].account_status,
                };
          return await fn(client, row);
        });
      },
    },
    fileWriter: {
      async writeLocal(args) {
        await writeCodexContainerAuthFile(args);
      },
      async writeRemote(hostUuid, containerId, accessToken, lastRefreshIso) {
        await putRemoteCodexAuthViaServiceableHost(
          hostUuid,
          containerId,
          accessToken,
          lastRefreshIso,
        );
      },
    },
  });
}

/** `/internal/v3/codex-relay` handler 装配(路由态全在 PG,master/egress 等价)。 */
export function buildCodexRelayHandler(deps: {
  identityRepo: ContainerIdentityRepo;
  preCheckRedis: PreCheckRedis;
  pgPool: Pool;
  onImageCharge?: (userId: bigint, payload: { costCredits: string; balanceAfter: string | null }) => void;
}): CodexRelayHandler {
  return makeCodexRelayHandler({
    identityRepo: deps.identityRepo,
    db: makeDefaultCodexRelayDb(),
    preCheckRedis: deps.preCheckRedis,
    pgPool: deps.pgPool,
    onImageCharge: deps.onImageCharge,
  });
}
