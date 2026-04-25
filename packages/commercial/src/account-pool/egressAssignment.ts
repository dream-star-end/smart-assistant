/**
 * 0038 — OAuth 账号 → compute_host(:9444 mTLS forward proxy)自动分配。
 *
 * 目的:每台 host 的本机 NIC IP 当某账号的稳定出口,降低 Anthropic 风控误判
 * (账号反复换 IP / 跟其他账号共享同一 IP 都是 anti-abuse 信号)。
 *
 * 调用点:
 *   - admin 新建账号成功后(adminCreateAccount)→ pickAndAssignEgressHost
 *   - admin UI 重新分配 → reassignEgressHost(accountId, hostId|null)
 *   - host DELETE → FK ON DELETE SET NULL 自动 orphan(见 migration 0038)
 *
 * 兼容性:
 *   - 账号 egress_proxy 非 NULL → 优先级最高(admin 显式手填代理)→ 不分配 host
 *   - 池子里没有合格 host → assignment 返 null,账号继续走 master 默认出口
 *   - 任何错误(host 表查不到 / lock 拿不到 / DB 抖动)→ assignment 不冒泡,
 *     由调用方决定要不要 swallow(adminCreateAccount 选择 swallow,不阻塞账号创建)
 *
 * 并发性:同一事务内 pg_advisory_xact_lock(SHARED_KEY) 序列化所有分配请求,
 * 避免两个并发 createAccount 都选了同一个最低占用的 host。
 */

import { getPool } from "../db/index.js";

/**
 * 全局分配序列化用的 advisory lock key。
 * 9444 = forward proxy 端口(语义关联,便于运维 dump pg_locks 时识别)。
 * 单一 key 足够,因为分配频率低(账号添加/重分配,人工触发为主)。
 */
const ASSIGN_LOCK_KEY = 9444;

/**
 * pickAndAssignEgressHost — 选最少账号的合格 host 并写 claude_accounts.egress_host_uuid。
 *
 * 合格 host 条件:
 *   - status='ready'
 *   - egress_proxy_endpoint IS NOT NULL(:9444 探活通过)
 *   - agent_cert_fingerprint_sha256 IS NOT NULL(否则 master 端无法 pin)
 *   - psk 字段非空(否则无法 Bearer 认证)
 *
 * 排序:已分配账号数 ASC,平局 created_at ASC(老 host 先填满,符合 admin 直觉)。
 *
 * 返:被分配到的 host id;池子无合格 host 时返 null(账号留 NULL,fallback 默认出口)。
 */
export async function pickAndAssignEgressHost(
  accountId: bigint | string,
): Promise<string | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [ASSIGN_LOCK_KEY]);
    const r = await client.query<{ id: string }>(
      `SELECT ch.id
         FROM compute_hosts ch
         LEFT JOIN claude_accounts ca ON ca.egress_host_uuid = ch.id
        WHERE ch.status = 'ready'
          AND ch.egress_proxy_endpoint IS NOT NULL
          AND ch.agent_cert_fingerprint_sha256 IS NOT NULL
          AND octet_length(ch.agent_psk_nonce) > 0
          AND octet_length(ch.agent_psk_ct)    > 0
        GROUP BY ch.id, ch.created_at
        ORDER BY COUNT(ca.id) ASC, ch.created_at ASC
        LIMIT 1`,
    );
    if (r.rowCount === 0) {
      await client.query("COMMIT");
      return null;
    }
    const hostId = r.rows[0]!.id;
    await client.query(
      `UPDATE claude_accounts
          SET egress_host_uuid = $1, updated_at = NOW()
        WHERE id = $2`,
      [hostId, String(accountId)],
    );
    await client.query("COMMIT");
    return hostId;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* swallow */
    }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * reassignEgressHost — admin UI 显式重分配。
 *
 *   - hostId === null → 清空(账号回退到 master 默认出口或 egress_proxy)
 *   - hostId === 'auto' → 走 pickAndAssignEgressHost
 *   - hostId === '<uuid>' → 直接绑该 host(校验:host 必须 ready + endpoint 非空 + 证书指纹齐 + psk 齐)
 *
 * 不验证账号存在性 — 调用方 adminPatchAccount 已查过 row。
 */
export async function reassignEgressHost(
  accountId: bigint | string,
  hostId: string | null | "auto",
): Promise<string | null> {
  if (hostId === "auto") {
    return pickAndAssignEgressHost(accountId);
  }
  if (hostId === null) {
    await getPool().query(
      `UPDATE claude_accounts
          SET egress_host_uuid = NULL, updated_at = NOW()
        WHERE id = $1`,
      [String(accountId)],
    );
    return null;
  }
  // 显式 hostId — 校验后再写
  const r = await getPool().query<{ id: string }>(
    `SELECT id FROM compute_hosts
      WHERE id = $1
        AND status = 'ready'
        AND egress_proxy_endpoint IS NOT NULL
        AND agent_cert_fingerprint_sha256 IS NOT NULL
        AND octet_length(agent_psk_nonce) > 0
        AND octet_length(agent_psk_ct)    > 0
      LIMIT 1`,
    [hostId],
  );
  if (r.rowCount === 0) {
    throw new RangeError("egress_host_not_eligible");
  }
  await getPool().query(
    `UPDATE claude_accounts
        SET egress_host_uuid = $1, updated_at = NOW()
      WHERE id = $2`,
    [hostId, String(accountId)],
  );
  return hostId;
}
