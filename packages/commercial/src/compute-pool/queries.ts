/**
 * compute_hosts + agent_containers(host 维度)DB 查询层。
 *
 * 约定:
 *   - 所有读接口返 ComputeHostRow(snake_case)。上层 service 层做 mapRowToHost。
 *   - 所有凭据读取**不在这里解密**(避免 query 层持有明文);调用方拿到 nonce+ct
 *     自行调 decryptSshPassword / decryptAgentPsk。
 *   - 事务边界由调用方控制;本层不隐式开 tx。
 */

import type { PoolClient } from "pg";
import { getPool } from "../db/index.js";
import type {
  ComputeHostRow,
  ComputeHostStatus,
} from "./types.js";

// ─── SELECT ────────────────────────────────────────────────────────────

const COMPUTE_HOST_COLS = `
  id, name, host, ssh_port, ssh_user, agent_port,
  ssh_password_nonce, ssh_password_ct, ssh_fingerprint,
  agent_psk_nonce, agent_psk_ct,
  agent_cert_pem, agent_cert_fingerprint_sha256,
  agent_cert_not_before, agent_cert_not_after,
  status, last_bootstrap_at, last_bootstrap_err,
  last_health_at, last_health_ok, last_health_err,
  consecutive_health_fail, consecutive_health_ok,
  max_containers, bridge_cidr, egress_proxy_endpoint, created_at, updated_at
`;

export async function listAllHosts(): Promise<ComputeHostRow[]> {
  const r = await getPool().query<ComputeHostRow>(
    `SELECT ${COMPUTE_HOST_COLS} FROM compute_hosts ORDER BY created_at ASC`,
  );
  return r.rows;
}

export async function getHostById(id: string): Promise<ComputeHostRow | null> {
  const r = await getPool().query<ComputeHostRow>(
    `SELECT ${COMPUTE_HOST_COLS} FROM compute_hosts WHERE id = $1 LIMIT 1`,
    [id],
  );
  return r.rowCount === 0 ? null : r.rows[0]!;
}

export async function getHostByName(name: string): Promise<ComputeHostRow | null> {
  const r = await getPool().query<ComputeHostRow>(
    `SELECT ${COMPUTE_HOST_COLS} FROM compute_hosts WHERE name = $1 LIMIT 1`,
    [name],
  );
  return r.rowCount === 0 ? null : r.rows[0]!;
}

/** self host (name='self') — 0030 migration 保证总存在一行。 */
export async function getSelfHost(): Promise<ComputeHostRow> {
  const r = await getHostByName("self");
  if (!r) {
    throw new Error(
      "self host missing from compute_hosts — migration 0030 not applied?",
    );
  }
  return r;
}

/**
 * 调度用:status='ready' 的 host 列表,带**即时容器计数**。
 * LEFT JOIN LATERAL 聚合保证单次查询原子,避免 "先查 host 再分别 count" 的 TOCTOU。
 *
 * 只返回 container_count < max_containers 的 host(schedulable)。
 */
export interface SchedulableHost {
  row: ComputeHostRow;
  activeContainers: number;
}
export async function listSchedulableHosts(): Promise<SchedulableHost[]> {
  // host_uuid 是 0030 新列;老全局 bound_ip 唯一索引仍然存在,所以 M1 期间
  // 各 host 实际还得用不相交子网(Plan v2 §C)。
  const r = await getPool().query<ComputeHostRow & { active_containers: string }>(
    `SELECT ${COMPUTE_HOST_COLS},
            COALESCE(
              (SELECT COUNT(*) FROM agent_containers ac
                WHERE ac.host_uuid = compute_hosts.id
                  AND ac.state = 'active'),
              0
            )::text AS active_containers
       FROM compute_hosts
      WHERE status = 'ready'
      ORDER BY created_at ASC`,
  );
  return r.rows
    .map((row) => ({
      row,
      activeContainers: Number.parseInt(row.active_containers, 10),
    }))
    .filter((h) => h.activeContainers < h.row.max_containers);
}

/** admin 列表:所有 host + 即时容器计数(含非 ready)。 */
export async function listAllHostsWithCounts(): Promise<SchedulableHost[]> {
  const r = await getPool().query<ComputeHostRow & { active_containers: string }>(
    `SELECT ${COMPUTE_HOST_COLS},
            COALESCE(
              (SELECT COUNT(*) FROM agent_containers ac
                WHERE ac.host_uuid = compute_hosts.id
                  AND ac.state = 'active'),
              0
            )::text AS active_containers
       FROM compute_hosts
      ORDER BY created_at ASC`,
  );
  return r.rows.map((row) => ({
    row,
    activeContainers: Number.parseInt(row.active_containers, 10),
  }));
}

export async function countActiveContainersOnHost(
  hostUuid: string,
  client?: PoolClient,
): Promise<number> {
  const q = client ?? getPool();
  const r = await q.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM agent_containers
      WHERE host_uuid = $1 AND state = 'active'`,
    [hostUuid],
  );
  return Number.parseInt(r.rows[0]!.n, 10);
}

/**
 * 容器身份反查(新路径):按 (host_uuid, bound_ip) 定位 active container row。
 *
 * 替换 containerIdentity 原先的 findActiveByBoundIp(ip) — 改造后 anthropicProxy
 * 会从 mTLS cert SAN URI 解出 host_uuid,从 X-V3-Container-IP 头取 bound_ip,
 * 然后来这里查。
 */
export interface ActiveContainerRow {
  id: number;
  user_id: number;
  bound_ip: string;
  secret_hash: Buffer | null;
  host_uuid: string;
}
export async function findActiveByHostAndBoundIp(
  hostUuid: string,
  boundIp: string,
): Promise<ActiveContainerRow | null> {
  const r = await getPool().query<{
    id: string;
    user_id: string;
    bound_ip: string;
    secret_hash: Buffer | null;
    host_uuid: string;
  }>(
    `SELECT id, user_id, host(bound_ip) AS bound_ip, secret_hash, host_uuid
       FROM agent_containers
      WHERE state='active'
        AND host_uuid = $1
        AND bound_ip = $2
      LIMIT 1`,
    [hostUuid, boundIp],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    id: Number.parseInt(row.id, 10),
    user_id: Number.parseInt(row.user_id, 10),
    bound_ip: row.bound_ip,
    secret_hash: row.secret_hash,
    host_uuid: row.host_uuid,
  };
}

// ─── INSERT / UPDATE ───────────────────────────────────────────────────

export interface CreateHostInput {
  /**
   * 可选:调用方预生成 UUID(要做到 AAD 绑定 hostId 就必须先有 id 再加密)。
   * 省略 → DB 的 gen_random_uuid() 兜底。
   */
  id?: string;
  name: string;
  host: string;
  sshPort: number;
  sshUser: string;
  agentPort: number;
  sshPasswordNonce: Buffer;
  sshPasswordCt: Buffer;
  agentPskNonce: Buffer;
  agentPskCt: Buffer;
  maxContainers: number;
  /** 用户在 admin UI 里填的 bridge 子网;落 DB 后 scheduler 用它分配 bound_ip。 */
  bridgeCidr: string;
}

export async function createHost(input: CreateHostInput): Promise<ComputeHostRow> {
  if (input.id !== undefined) {
    const r = await getPool().query<ComputeHostRow>(
      `INSERT INTO compute_hosts(
         id, name, host, ssh_port, ssh_user, agent_port,
         ssh_password_nonce, ssh_password_ct,
         agent_psk_nonce, agent_psk_ct,
         max_containers, bridge_cidr, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'bootstrapping')
       RETURNING ${COMPUTE_HOST_COLS}`,
      [
        input.id,
        input.name,
        input.host,
        input.sshPort,
        input.sshUser,
        input.agentPort,
        input.sshPasswordNonce,
        input.sshPasswordCt,
        input.agentPskNonce,
        input.agentPskCt,
        input.maxContainers,
        input.bridgeCidr,
      ],
    );
    return r.rows[0]!;
  }
  const r = await getPool().query<ComputeHostRow>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'bootstrapping')
     RETURNING ${COMPUTE_HOST_COLS}`,
    [
      input.name,
      input.host,
      input.sshPort,
      input.sshUser,
      input.agentPort,
      input.sshPasswordNonce,
      input.sshPasswordCt,
      input.agentPskNonce,
      input.agentPskCt,
      input.maxContainers,
      input.bridgeCidr,
    ],
  );
  return r.rows[0]!;
}

export async function updateStatus(
  id: string,
  status: ComputeHostStatus,
  err?: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE compute_hosts
        SET status = $2,
            last_bootstrap_err = COALESCE($3, last_bootstrap_err),
            updated_at = NOW()
      WHERE id = $1`,
    [id, status, err ?? null],
  );
}

export async function markBootstrapResult(
  id: string,
  success: boolean,
  err: string | null,
): Promise<void> {
  if (success) {
    await getPool().query(
      `UPDATE compute_hosts
          SET status = 'ready',
              last_bootstrap_at = NOW(),
              last_bootstrap_err = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
  } else {
    await getPool().query(
      `UPDATE compute_hosts
          SET status = 'broken',
              last_bootstrap_at = NOW(),
              last_bootstrap_err = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [id, err],
    );
  }
}

export async function markHealth(
  id: string,
  ok: boolean,
  err: string | null,
): Promise<{ previousStatus: ComputeHostStatus; nextStatus: ComputeHostStatus }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ status: ComputeHostStatus; f: number; s: number }>(
      `SELECT status,
              consecutive_health_fail AS f,
              consecutive_health_ok   AS s
         FROM compute_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error(`compute_hosts row not found: ${id}`);
    }
    const { status, f, s } = cur.rows[0]!;
    let nextFail = ok ? 0 : f + 1;
    let nextOk = ok ? s + 1 : 0;
    let nextStatus: ComputeHostStatus = status;

    // 只在 ready ↔ quarantined 之间自愈切换;broken / draining / bootstrapping 不动
    if (status === "ready" && nextFail >= 3) {
      nextStatus = "quarantined";
      nextFail = 0;
      nextOk = 0;
    } else if (status === "quarantined" && nextOk >= 3) {
      nextStatus = "ready";
      nextFail = 0;
      nextOk = 0;
    }

    await client.query(
      `UPDATE compute_hosts
          SET status = $2,
              last_health_at = NOW(),
              last_health_ok = $3,
              last_health_err = $4,
              consecutive_health_fail = $5,
              consecutive_health_ok = $6,
              updated_at = NOW()
        WHERE id = $1`,
      [id, nextStatus, ok, err, nextFail, nextOk],
    );
    await client.query("COMMIT");
    return { previousStatus: status, nextStatus };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function updateSshFingerprint(
  id: string,
  fingerprint: string,
): Promise<void> {
  await getPool().query(
    `UPDATE compute_hosts
        SET ssh_fingerprint = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, fingerprint],
  );
}

export interface UpdateCertInput {
  id: string;
  certPem: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
}

export async function updateCert(input: UpdateCertInput): Promise<void> {
  await getPool().query(
    `UPDATE compute_hosts
        SET agent_cert_pem = $2,
            agent_cert_fingerprint_sha256 = $3,
            agent_cert_not_before = $4,
            agent_cert_not_after = $5,
            updated_at = NOW()
      WHERE id = $1`,
    [input.id, input.certPem, input.fingerprintSha256, input.notBefore, input.notAfter],
  );
}

/** 为 self host 懒生成并回写 psk(启动时只做一次)。nonce+ct 非空时才 store。 */
export async function updateAgentPsk(
  id: string,
  nonce: Buffer,
  ct: Buffer,
): Promise<void> {
  await getPool().query(
    `UPDATE compute_hosts
        SET agent_psk_nonce = $2,
            agent_psk_ct    = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [id, nonce, ct],
  );
}

/**
 * 0038 — bootstrap egress_endpoint_probe step 回写。
 * endpoint 非空 = :9444 mTLS forward proxy 探活通过(host 可参与账号自动分配);
 * NULL = 探活未通过(host 仍可调度容器,但被排除在 egress 自动分配外)。
 */
export async function setEgressProxyEndpoint(
  id: string,
  endpoint: string | null,
): Promise<void> {
  await getPool().query(
    `UPDATE compute_hosts
        SET egress_proxy_endpoint = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, endpoint],
  );
}

/** admin "设 draining"。返 true = affected 1 行,false = 状态不允许 / id 不存在。 */
export async function setDraining(id: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE compute_hosts
        SET status = 'draining', updated_at = NOW()
      WHERE id = $1 AND status IN ('ready','quarantined','broken')`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * admin "清除 quarantine" —— 从 quarantined 拉回 ready,重置计数。
 * 返 true = 成功切换,false = 当前状态不是 quarantined(或 id 不存在)。
 */
export async function clearQuarantine(id: string): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE compute_hosts
        SET status = 'ready',
            consecutive_health_fail = 0,
            consecutive_health_ok = 0,
            last_health_err = NULL,
            updated_at = NOW()
      WHERE id = $1 AND status = 'quarantined'`,
    [id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** admin 删除 — 仅 draining 且 active container = 0 */
export async function deleteHost(id: string): Promise<boolean> {
  // self host 不可删
  const head = await getPool().query<{ name: string; status: ComputeHostStatus; n: string }>(
    `SELECT name, status,
            (SELECT COUNT(*)::text FROM agent_containers
              WHERE host_uuid = compute_hosts.id AND state='active') AS n
       FROM compute_hosts WHERE id = $1`,
    [id],
  );
  if (head.rowCount === 0) return false;
  const { name, status, n } = head.rows[0]!;
  if (name === "self") {
    throw new Error("cannot delete self host");
  }
  if (status !== "draining") {
    throw new Error(`host must be in draining status to delete, got ${status}`);
  }
  if (Number.parseInt(n, 10) > 0) {
    throw new Error(`host still has ${n} active containers; drain first`);
  }
  const r = await getPool().query(`DELETE FROM compute_hosts WHERE id = $1`, [id]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 调度用 sticky 查找:某 user 是否已有 active 容器 → 返其 host_uuid。
 * 如果 host 已经 not ready,调用方应拒 sticky 并进 pickHost。
 */
export async function findUserStickyHost(userId: number): Promise<{
  hostUuid: string;
  hostStatus: ComputeHostStatus;
  containerId: number;
} | null> {
  const r = await getPool().query<{
    container_id: string;
    host_uuid: string;
    host_status: ComputeHostStatus;
  }>(
    `SELECT ac.id AS container_id,
            ac.host_uuid,
            ch.status AS host_status
       FROM agent_containers ac
       JOIN compute_hosts ch ON ch.id = ac.host_uuid
      WHERE ac.user_id = $1 AND ac.state='active'
      LIMIT 1`,
    [userId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    hostUuid: row.host_uuid,
    hostStatus: row.host_status,
    containerId: Number.parseInt(row.container_id, 10),
  };
}
