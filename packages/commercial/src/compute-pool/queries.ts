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
  QuarantineReasonCode,
} from "./types.js";
import { isHardQuarantineReason, softReasonPriority } from "./types.js";
import { writeAuditInTx } from "./audit.js";

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
  max_containers, bridge_cidr, egress_proxy_endpoint,
  expires_at,
  loaded_image_id, loaded_image_at,
  quarantine_reason_code, quarantine_reason_detail, quarantine_at,
  last_health_endpoint_ok, last_health_poll_at,
  last_uplink_ok, last_uplink_at,
  last_egress_probe_ok, last_egress_probe_at,
  created_at, updated_at
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

/** 0042 — placement gate fresh window (秒)。host 任一维度超过该窗口即视为 stale。 */
export const PLACEMENT_FRESH_WINDOW_SECONDS = 60;

/**
 * 0042 — full placement gate SQL predicate(共享片段)。
 *
 * 单 host 与全集查询共用同一份谓词,避免 listSchedulableHosts /
 * getSchedulableHostById 两边漂移(Codex round 2 要求)。
 *
 * 调用方需:
 *   - JOIN compute_pool_state 单例 alias = `desired`
 *   - 把 `compute_hosts.*` 字段拼齐(含 name)
 *   - 在 WHERE 中拼接此 predicate
 */
const PLACEMENT_GATE_PREDICATE = `
  status = 'ready'
  AND desired.desired_image_id IS NOT NULL
  AND loaded_image_id IS NOT NULL
  AND loaded_image_id = desired.desired_image_id
  AND (
    name = 'self'
    OR (
      last_health_endpoint_ok = TRUE
      AND last_health_poll_at IS NOT NULL
      AND last_health_poll_at > NOW() - INTERVAL '${PLACEMENT_FRESH_WINDOW_SECONDS} seconds'
      AND last_uplink_ok = TRUE
      AND last_uplink_at IS NOT NULL
      AND last_uplink_at > NOW() - INTERVAL '${PLACEMENT_FRESH_WINDOW_SECONDS} seconds'
      AND last_egress_probe_ok = TRUE
      AND last_egress_probe_at IS NOT NULL
      AND last_egress_probe_at > NOW() - INTERVAL '${PLACEMENT_FRESH_WINDOW_SECONDS} seconds'
    )
  )
`;

/**
 * 0042 — 真实 placement gate(全集)。仅返回**完整可调度**的 host:
 *   - 满足 PLACEMENT_GATE_PREDICATE
 *   - active < max_containers (这里在 JS 侧 filter)
 *
 * self host(name='self')特殊:
 *   - 与 master 同进程,无 /health RPC、无反向 mTLS 通道、无 :9444 forward proxy
 *     自检(forward proxy 跑在 :9444,但 self 内 master 直接走容器 → :8123 别走 mtls)。
 *   - 因此跳过 last_*_ok / last_*_at / last_health_poll_at fresh 校验。
 *   - 但 loaded_image_id 必须仍与 desired_image_id 一致(否则 docker run 会拉
 *     master 本机不存在的 tag),由 master 启动时 backfill 写入。
 *
 * desired_image_id IS NULL(单例 row 还没 init)→ 整个 SELECT 返回空集,
 * 等价于"placement gate 关闭",backfill 完成前不会调度任何 host。这是设计:
 * master 启动顺序保证 setDesiredImage 早于 HTTP listen,故业务感知不到。
 */
export async function listSchedulableHosts(): Promise<SchedulableHost[]> {
  const r = await getPool().query<ComputeHostRow & { active_containers: string }>(
    `WITH desired AS (
        SELECT desired_image_id FROM compute_pool_state WHERE singleton='singleton'
     )
     SELECT ${COMPUTE_HOST_COLS},
            COALESCE(
              (SELECT COUNT(*) FROM agent_containers ac
                WHERE ac.host_uuid = compute_hosts.id
                  AND ac.state = 'active'),
              0
            )::text AS active_containers
       FROM compute_hosts, desired
      WHERE ${PLACEMENT_GATE_PREDICATE}
      ORDER BY created_at ASC`,
  );
  return r.rows
    .map((row) => ({
      row,
      activeContainers: Number.parseInt(row.active_containers, 10),
    }))
    .filter((h) => h.activeContainers < h.row.max_containers);
}

/**
 * 0042 — 单 host 形式 full placement gate。pinned/dataHost/(可选)requireHostId
 * 等 bypass 路径必须用这个 helper,**不要再自己 getHostById + status==='ready'**。
 *
 * 与 listSchedulableHosts 区别:
 *   - 不在 helper 里 filter capacity:返回 row + activeContainers,
 *     调用方自己决定 over-cap 是 throw busy 还是 fall-through。这是有意的,
 *     pinned/dataHost 在 capacity-full 时各有不同语义(dataHost throw busy
 *     保数据 sticky,pinned fall-through)。
 *   - 限定 id=$1 LIMIT 1。
 *
 * 返 null = host 不存在 / 不在 ready / 不通 image gate / 任一 dim stale。
 */
export async function getSchedulableHostById(
  id: string,
): Promise<SchedulableHost | null> {
  const r = await getPool().query<ComputeHostRow & { active_containers: string }>(
    `WITH desired AS (
        SELECT desired_image_id FROM compute_pool_state WHERE singleton='singleton'
     )
     SELECT ${COMPUTE_HOST_COLS},
            COALESCE(
              (SELECT COUNT(*) FROM agent_containers ac
                WHERE ac.host_uuid = compute_hosts.id
                  AND ac.state = 'active'),
              0
            )::text AS active_containers
       FROM compute_hosts, desired
      WHERE id = $1
        AND ${PLACEMENT_GATE_PREDICATE}
      LIMIT 1`,
    [id],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    row,
    activeContainers: Number.parseInt(row.active_containers, 10),
  };
}

/**
 * 0042 — 兼容性导出:旧 listSchedulableHosts 行为(仅 status='ready'),
 * 内部模块如 imagePromote / backfill 需要"未必通过 gate 但 admin 视为可用"
 * 的列表时使用。**业务调度路径必须用 listSchedulableHosts**。
 */
export async function listReadyOrQuarantinedForImagePromote(): Promise<ComputeHostRow[]> {
  const r = await getPool().query<ComputeHostRow>(
    `SELECT ${COMPUTE_HOST_COLS} FROM compute_hosts
       WHERE status IN ('ready','quarantined')
       ORDER BY created_at ASC`,
  );
  return r.rows;
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

/**
 * 0042 admin 视图:host + 容器计数 + 全局 desired_image_id + placement gate 判定。
 *
 * 单条 SQL 把以下三件事原子化:
 *   - desired CTE 取 compute_pool_state singleton(desired_image_id)
 *   - 即时容器计数(同 listAllHostsWithCounts)
 *   - placement_gate_open = PLACEMENT_GATE_PREDICATE 当布尔表达式 SELECT
 *
 * 对应 Codex plan-review:UI 显示的 placement gate 必须跟真实调度路径用**同一份**
 * predicate / 同一个 statement 的 NOW()/snapshot,JS 侧不重算 fresh window 避免漂移。
 *
 * COALESCE(... , FALSE):predicate 的三值逻辑(NULL)未来若被改坏,这里钉死成
 * boolean 契约不外泄。
 */
export interface AdminHostWithGate {
  row: ComputeHostRow;
  activeContainers: number;
  desiredImageId: string | null;
  placementGateOpen: boolean;
}

export async function listAllHostsForAdmin(
  client?: PoolClient,
): Promise<AdminHostWithGate[]> {
  const q = client ?? getPool();
  const r = await q.query<
    ComputeHostRow & {
      active_containers: string;
      desired_image_id_global: string | null;
      placement_gate_open: boolean;
    }
  >(
    `WITH desired AS (
        SELECT desired_image_id FROM compute_pool_state WHERE singleton='singleton'
     )
     SELECT ${COMPUTE_HOST_COLS},
            desired.desired_image_id AS desired_image_id_global,
            COALESCE(
              (SELECT COUNT(*) FROM agent_containers ac
                WHERE ac.host_uuid = compute_hosts.id
                  AND ac.state = 'active'),
              0
            )::text AS active_containers,
            COALESCE((${PLACEMENT_GATE_PREDICATE}), FALSE) AS placement_gate_open
       FROM compute_hosts, desired
      ORDER BY created_at ASC`,
  );
  return r.rows.map((row) => ({
    row,
    activeContainers: Number.parseInt(row.active_containers, 10),
    desiredImageId: row.desired_image_id_global,
    placementGateOpen: row.placement_gate_open,
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
  /** 0041:VPS 租期到期(UTC Date 或 null=永久/未填)。仅展示,不参与调度。 */
  expiresAt?: Date | null;
}

export async function createHost(input: CreateHostInput): Promise<ComputeHostRow> {
  if (input.id !== undefined) {
    const r = await getPool().query<ComputeHostRow>(
      `INSERT INTO compute_hosts(
         id, name, host, ssh_port, ssh_user, agent_port,
         ssh_password_nonce, ssh_password_ct,
         agent_psk_nonce, agent_psk_ct,
         max_containers, bridge_cidr, expires_at, status
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'bootstrapping')
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
        input.expiresAt ?? null,
      ],
    );
    return r.rows[0]!;
  }
  const r = await getPool().query<ComputeHostRow>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct,
       agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, expires_at, status
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'bootstrapping')
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
      input.expiresAt ?? null,
    ],
  );
  return r.rows[0]!;
}

/**
 * 0041:更新 host 的 expires_at(可清空)。
 * 返 true 表更新到行,false 表 host 不存在。
 */
export async function updateExpiresAt(
  id: string,
  expiresAt: Date | null,
): Promise<boolean> {
  const r = await getPool().query(
    `UPDATE compute_hosts
        SET expires_at = $2, updated_at = NOW()
      WHERE id = $1`,
    [id, expiresAt],
  );
  return (r.rowCount ?? 0) > 0;
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

/**
 * 0042 — atomic markBootstrapResult。
 *
 * 三种结果路径(单 tx):
 *   - success + 无 softQuarantine → status='ready'(可立即调度,但需 image gate 通过)
 *   - success + softQuarantine     → status='quarantined' + reason_code/detail/at
 *     避免"ready 一瞬"被 health poll 命中调度后再 quarantine 的窗口
 *   - !success                     → status='broken' + last_bootstrap_err
 *
 * loadedImage(成功路径必填,失败路径可选):写 loaded_image_id/at。
 *
 * 同一 tx 写一条 audit 行(operation='bootstrap.result')。
 */
export interface MarkBootstrapInput {
  success: boolean;
  err?: string | null;
  softQuarantine?: { reason: QuarantineReasonCode; detail: string };
  loadedImage?: { id: string; tag: string };
  operationId: string;
  actor: string;
}

export async function markBootstrapResult(
  id: string,
  input: MarkBootstrapInput,
): Promise<{ status: ComputeHostStatus }> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    let nextStatus: ComputeHostStatus;
    let reasonCode: string | null = null;
    let reasonDetail: string | null = null;
    if (input.success) {
      if (input.softQuarantine) {
        nextStatus = "quarantined";
        reasonCode = input.softQuarantine.reason;
        reasonDetail = input.softQuarantine.detail;
      } else {
        nextStatus = "ready";
      }
    } else {
      nextStatus = "broken";
    }

    await client.query(
      `UPDATE compute_hosts
          SET status = $2,
              last_bootstrap_at = NOW(),
              last_bootstrap_err = CASE WHEN $3::text IS NULL THEN NULL ELSE $3 END,
              loaded_image_id = COALESCE($4, loaded_image_id),
              loaded_image_at = CASE WHEN $4::text IS NULL THEN loaded_image_at ELSE NOW() END,
              quarantine_reason_code = $5,
              quarantine_reason_detail = $6,
              quarantine_at = CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        id,
        nextStatus,
        input.success ? null : input.err ?? null,
        input.loadedImage?.id ?? null,
        reasonCode,
        reasonDetail,
      ],
    );

    await writeAuditInTx(client, {
      hostId: id,
      operation: "bootstrap.result",
      operationId: input.operationId,
      reasonCode: reasonCode,
      detail: {
        success: input.success,
        nextStatus,
        err: input.err ?? null,
        loadedImageId: input.loadedImage?.id ?? null,
        loadedImageTag: input.loadedImage?.tag ?? null,
        softQuarantineDetail: input.softQuarantine?.detail ?? null,
      },
      actor: input.actor,
    });

    await client.query("COMMIT");
    return { status: nextStatus };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 0042 — 综合 health 维度快照写入 + 自愈状态机。
 *
 * 入参 snapshot 反映本轮一次 master → host /health RPC 拿到的多维度结果。
 * 任一维度 undefined = 老 agent 不报 → 该维度本次不更新(保留之前的值/null)。
 *
 * 状态机:
 *   - hard quarantine(image-* 系列)的 host 不被本函数动 status,直接更新 last_*
 *     维度即可(由 imagePromote / runtime ImageNotFound 路径单独清/重置)。
 *   - 否则,根据各维度计算 softFailed:
 *       endpointFailed = endpointOk === false
 *       uplinkFailed   = uplinkOk === false
 *       egressFailed   = egressOk === false
 *     连续失败计数器(consecutive_health_fail)— endpointOk=false 时累 +1,否则
 *     在 "all known dims OK" 时 reset 0 + consecutive_health_ok +1。
 *     失败计数 ≥3 → soft quarantine,reason 选 priority 最高的失败维度。
 *     成功计数 ≥3 且当前是 soft-reason quarantined → 回 ready 并清 reason。
 *
 * loadedImageId 入参:agent 报上来的 host 内 docker image config ID — 与 master 期望
 * 不一致时会引发 image-mismatch quarantine,但**那由 imagePromote 周期任务执行**,
 * 此函数不直接 hard-quarantine。
 *
 * 同一 tx 写 audit:operation='health.snapshot',若发生 status 切换额外写
 * operation='health.transition'。
 */
export interface HealthSnapshotInput {
  /** master → host:9443 GET /health 是否 200。**必填**(本字段触发计数器逻辑)。 */
  endpointOk: boolean;
  endpointErr?: string | null;
  /** node-agent /health 反馈的反向通道自检。 */
  uplinkOk?: boolean;
  uplinkErr?: string | null;
  /** node-agent /health 反馈的 :9444 forward proxy 自检。 */
  egressOk?: boolean;
  egressErr?: string | null;
  /**
   * node-agent /health 反馈的 host 内 image config ID。string 才参与 row
   * loaded_image_id 写回(与 DB 不同时更新);undefined / 缺字段 = "agent
   * 没报"= 不动 row(避免把已知值清成 NULL)。
   *
   * 注意 caller(nodeHealth.ts)必须传 string|undefined,不要 ?? null。
   */
  loadedImageId?: string;
  loadedImageTag?: string | null;
  operationId: string;
  actor: string;
}

export interface HealthSnapshotResult {
  previousStatus: ComputeHostStatus;
  nextStatus: ComputeHostStatus;
  appliedReason: QuarantineReasonCode | null;
  cleared: boolean;
}

export async function applyHealthSnapshot(
  id: string,
  input: HealthSnapshotInput,
): Promise<HealthSnapshotResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{
      status: ComputeHostStatus;
      f: number;
      s: number;
      reason: QuarantineReasonCode | null;
      name: string;
    }>(
      `SELECT status,
              consecutive_health_fail AS f,
              consecutive_health_ok   AS s,
              quarantine_reason_code  AS reason,
              name
         FROM compute_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error(`compute_hosts row not found: ${id}`);
    }
    const { status: previousStatus, f, s, reason: prevReason } = cur.rows[0]!;

    // 各维度知/未知。endpointOk 必填,其它可能 undefined。
    const endpointFailed = !input.endpointOk;
    const uplinkKnown = input.uplinkOk !== undefined;
    const uplinkFailed = uplinkKnown && input.uplinkOk === false;
    const egressKnown = input.egressOk !== undefined;
    const egressFailed = egressKnown && input.egressOk === false;

    // 任一维度显式失败 → 视为本轮 fail
    const anyFailed = endpointFailed || uplinkFailed || egressFailed;

    // 收紧(plan v4 round-2):consecutive_health_ok 只在**三维度全报且全 true**
    // 才递增。undefined uplink/egress(老 agent rollback / 字段缺失)不再当成
    // OK,避免 quarantined→ready 在缺数据时翻牌(下游 bypass 路径如 pinned/dataHost
    // 还有 getSchedulableHostById full gate 兜底,但状态机源头也不再撒谎)。
    const trulyAllOk =
      input.endpointOk &&
      uplinkKnown &&
      input.uplinkOk === true &&
      egressKnown &&
      input.egressOk === true;

    let nextFail = anyFailed ? f + 1 : 0;
    let nextOk = trulyAllOk ? s + 1 : 0;

    let nextStatus: ComputeHostStatus = previousStatus;
    let appliedReason: QuarantineReasonCode | null = null;
    let nextReasonCode: QuarantineReasonCode | null = prevReason;
    let nextReasonDetail: string | null = null;
    let cleared = false;

    // hard quarantine 不在这里改 status / reason。
    const isHardCurrent = isHardQuarantineReason(prevReason);

    // 选本轮 priority 最高(序号最小)的失败维度,供 ready→quarantined 进入和
    // quarantined→quarantined 升级两条路径共享。
    const failedCandidates: QuarantineReasonCode[] = [];
    if (uplinkFailed) failedCandidates.push("uplink-probe-failed");
    if (endpointFailed) failedCandidates.push("health-poll-fail");
    if (egressFailed) failedCandidates.push("egress-probe-failed");
    failedCandidates.sort((a, b) => softReasonPriority(a) - softReasonPriority(b));
    const failedReason: QuarantineReasonCode | null = failedCandidates[0] ?? null;
    const failedDetail: string | null =
      failedReason === "uplink-probe-failed" ? input.uplinkErr ?? "uplink probe failed"
      : failedReason === "egress-probe-failed" ? input.egressErr ?? "egress probe failed"
      : failedReason === "health-poll-fail" ? input.endpointErr ?? "health endpoint failed"
      : null;

    if (!isHardCurrent) {
      // 自愈机:status='ready' + 累计 fail≥3 → 进 soft quarantine
      if (previousStatus === "ready" && nextFail >= 3) {
        appliedReason = failedReason ?? "health-poll-fail";
        nextStatus = "quarantined";
        nextReasonCode = appliedReason;
        nextReasonDetail = failedDetail ?? "health endpoint failed";
        nextFail = 0;
        nextOk = 0;
      } else if (
        // Codex round-3 BLOCKER B:quarantined → quarantined reason 升级。
        // 已 soft quarantined 的 host,如本轮失败维度 priority 高于当前 reason,
        // 累计 3 轮即升级 reason(detail 同步刷),避免 alerting 卡在低优先级。
        // hard reason 已被外层 isHardCurrent 排除;prevReason 此时为 soft 或 null
        // (null 不应出现于 quarantined,但兜底视为可被任何 failedReason 覆盖)。
        previousStatus === "quarantined" &&
        nextFail >= 3 &&
        failedReason !== null &&
        (prevReason === null ||
          softReasonPriority(failedReason) < softReasonPriority(prevReason))
      ) {
        appliedReason = failedReason;
        nextStatus = "quarantined";
        nextReasonCode = appliedReason;
        nextReasonDetail = failedDetail;
        nextFail = 0;
        nextOk = 0;
      } else if (previousStatus === "quarantined" && nextOk >= 3) {
        nextStatus = "ready";
        nextReasonCode = null;
        nextReasonDetail = null;
        cleared = true;
        nextFail = 0;
        nextOk = 0;
      }
    }

    // 写入维度字段。维度未知的不动(COALESCE 用 CASE 实现 known/unknown 区分)。
    //
    // legacy 字段语义保留(plan v4 round-2):
    //   - last_health_ok = endpointOk(仅反映 endpoint 维度,不混入 uplink/egress)
    //   - last_health_err = endpointFailed ? msg : null(同上 — endpoint OK 时
    //     即使 uplink fail,这字段也写 NULL,避免 last_health_ok=true / err=msg
    //     的不一致状态)
    //
    // loaded_image_id 写回:agent 报 string 且与 DB 不同时更新(健康轮询发现
    // image 漂移 → DB 立即对齐 → imagePromote 下一轮看到 mismatch 触发重分发)。
    // undefined → 不动(避免把"agent 没报"当成"清成 NULL")。
    const incomingLoadedImageId =
      typeof input.loadedImageId === "string" ? input.loadedImageId : null;
    await client.query(
      `UPDATE compute_hosts
          SET status = $2,
              last_health_at = NOW(),
              last_health_ok = $3,
              last_health_err = $4,
              consecutive_health_fail = $5,
              consecutive_health_ok = $6,
              last_health_endpoint_ok = $7,
              last_health_poll_at = NOW(),
              last_uplink_ok = CASE WHEN $8::boolean IS NULL THEN last_uplink_ok ELSE $8 END,
              last_uplink_at = CASE WHEN $8::boolean IS NULL THEN last_uplink_at ELSE NOW() END,
              last_egress_probe_ok = CASE WHEN $9::boolean IS NULL THEN last_egress_probe_ok ELSE $9 END,
              last_egress_probe_at = CASE WHEN $9::boolean IS NULL THEN last_egress_probe_at ELSE NOW() END,
              quarantine_reason_code = CASE
                WHEN $10::text IS NOT NULL THEN $10
                WHEN $11::boolean THEN NULL
                ELSE quarantine_reason_code
              END,
              quarantine_reason_detail = CASE
                WHEN $10::text IS NOT NULL THEN $12
                WHEN $11::boolean THEN NULL
                ELSE quarantine_reason_detail
              END,
              quarantine_at = CASE
                WHEN $10::text IS NOT NULL THEN NOW()
                WHEN $11::boolean THEN NULL
                ELSE quarantine_at
              END,
              -- sha-divergence guard:docker save | docker load 后远端 daemon
              -- 重算 layer/manifest sha,daemon-reported sha 永远 ≠ master 写入的
              -- desired_image_id。imagePromote 一旦把 host 对齐到 desired
              -- (loaded_image_id == desired_image_id),health-snapshot 不应再用
              -- daemon sha 覆盖 — 否则 PLACEMENT_GATE_PREDICATE 永远失败,数据
              -- sticky 用户在 nodeScheduler 走 NodePoolBusy 死循环。
              --
              -- 代价:同 tag 不同 image 的"操作员手动 docker pull"漂移本层察觉
              -- 不到(promote loaded==desired 时直接 already,不再调
              -- streamImageToHost 重检)。runtime-image-missing hard quarantine
              -- 只能兜底 tag 缺失/不可运行;同 tag 被替换成另一个仍可运行的真实
              -- image 属于本方案接受的弱化风险,DB 会继续认为 host 已对齐。
              loaded_image_id = CASE
                WHEN $13::text IS NOT NULL
                  AND $13::text IS DISTINCT FROM loaded_image_id
                  AND loaded_image_id IS DISTINCT FROM (
                    SELECT desired_image_id FROM compute_pool_state
                     WHERE singleton = 'singleton'
                  )
                THEN $13::text
                ELSE loaded_image_id
              END,
              loaded_image_at = CASE
                WHEN $13::text IS NOT NULL
                  AND $13::text IS DISTINCT FROM loaded_image_id
                  AND loaded_image_id IS DISTINCT FROM (
                    SELECT desired_image_id FROM compute_pool_state
                     WHERE singleton = 'singleton'
                  )
                THEN NOW()
                ELSE loaded_image_at
              END,
              updated_at = NOW()
        WHERE id = $1`,
      [
        id,
        nextStatus,
        input.endpointOk,
        endpointFailed ? (input.endpointErr ?? "health probe failed") : null,
        nextFail,
        nextOk,
        input.endpointOk,
        uplinkKnown ? input.uplinkOk! : null,
        egressKnown ? input.egressOk! : null,
        appliedReason,
        cleared,
        nextReasonDetail,
        incomingLoadedImageId,
      ],
    );

    await writeAuditInTx(client, {
      hostId: id,
      operation: "health.snapshot",
      operationId: input.operationId,
      reasonCode: appliedReason,
      detail: {
        endpointOk: input.endpointOk,
        endpointErr: input.endpointErr ?? null,
        uplinkOk: input.uplinkOk ?? null,
        uplinkErr: input.uplinkErr ?? null,
        egressOk: input.egressOk ?? null,
        egressErr: input.egressErr ?? null,
        loadedImageId: input.loadedImageId ?? null,
        loadedImageTag: input.loadedImageTag ?? null,
        consecutiveFail: nextFail,
        consecutiveOk: nextOk,
        previousStatus,
        nextStatus,
        previousReason: prevReason,
        cleared,
      },
      actor: input.actor,
    });

    // health.transition 写一行的条件:status 切换 OR soft reason 升级
    // (quarantined→quarantined 但 reason 变了)。后者让 reason-only 升级
    // 同样有 transition 行,运维 alerting 可统一按 health.transition 订阅。
    const reasonChanged =
      appliedReason !== null && appliedReason !== prevReason;
    if (nextStatus !== previousStatus || reasonChanged) {
      await writeAuditInTx(client, {
        hostId: id,
        operation: "health.transition",
        operationId: input.operationId,
        reasonCode: appliedReason,
        detail: {
          from: previousStatus,
          to: nextStatus,
          previousReason: prevReason,
          nextReason: nextReasonCode,
          cleared,
        },
        actor: input.actor,
      });
    }

    await client.query("COMMIT");
    return {
      previousStatus,
      nextStatus,
      appliedReason,
      cleared,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 兼容旧调用 — markHealth(id, ok, err) → 转发到 applyHealthSnapshot 的最小子集。
 * 仅用于回滚/快速过渡;新代码应直接调 applyHealthSnapshot。
 *
 * 不传 operationId/actor 时本函数自动生成 system 标签。
 */
export async function markHealth(
  id: string,
  ok: boolean,
  err: string | null,
): Promise<{ previousStatus: ComputeHostStatus; nextStatus: ComputeHostStatus }> {
  const r = await applyHealthSnapshot(id, {
    endpointOk: ok,
    endpointErr: err,
    operationId: `legacy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    actor: "system:markHealth-legacy",
  });
  return { previousStatus: r.previousStatus, nextStatus: r.nextStatus };
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

/**
 * admin "设 draining"。返 true = affected 1 行,false = 状态不允许 / id 不存在。
 *
 * plan v4 round-2:补 audit 行(operation='admin.set-draining',
 * detail.from = 修改前 status)。两步 tx:SELECT FOR UPDATE 拿 previousStatus
 * → UPDATE → audit。RETURNING 不能用,UPDATE 完成后再 SELECT 自然读到 'draining',
 * detail.from 会失真。
 */
export async function setDraining(
  id: string,
  audit: { actor: string; operationId?: string },
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ status: ComputeHostStatus }>(
      `SELECT status FROM compute_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const previousStatus = cur.rows[0]!.status;
    if (
      previousStatus !== "ready" &&
      previousStatus !== "quarantined" &&
      previousStatus !== "broken"
    ) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(
      `UPDATE compute_hosts
          SET status = 'draining', updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
    await writeAuditInTx(client, {
      hostId: id,
      operation: "admin.set-draining",
      operationId: audit.operationId,
      reasonCode: null,
      detail: { from: previousStatus, to: "draining" },
      actor: audit.actor,
    });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * admin "清除 quarantine" —— 从 quarantined 拉回 ready,重置计数 + reason 字段。
 * 返 true = 成功切换,false = 当前状态不是 quarantined(或 id 不存在)。
 *
 * 0042:同时清 quarantine_reason_code/detail/at,并写一条 audit 行。
 */
export async function clearQuarantine(
  id: string,
  audit: { actor: string; operationId?: string },
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // plan v4 round-2:先 SELECT FOR UPDATE 拿 pre-UPDATE reason,再 UPDATE,
    // 然后 audit 用第一步拿到的 previousReason。
    // 旧实现的 RETURNING (SELECT ... WHERE id=$1) 在同一 statement 内子查询读到的是
    // post-UPDATE 值,因此 prev_reason 永远是 NULL,审计追溯失效。
    const cur = await client.query<{
      status: ComputeHostStatus;
      reason: QuarantineReasonCode | null;
    }>(
      `SELECT status, quarantine_reason_code AS reason
         FROM compute_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rowCount === 0 || cur.rows[0]!.status !== "quarantined") {
      await client.query("ROLLBACK");
      return false;
    }
    const previousReason = cur.rows[0]!.reason;
    await client.query(
      `UPDATE compute_hosts
          SET status = 'ready',
              consecutive_health_fail = 0,
              consecutive_health_ok = 0,
              last_health_err = NULL,
              quarantine_reason_code = NULL,
              quarantine_reason_detail = NULL,
              quarantine_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [id],
    );
    await writeAuditInTx(client, {
      hostId: id,
      operation: "quarantine.clear",
      operationId: audit.operationId,
      reasonCode: null,
      detail: { mode: "force", previousReason },
      actor: audit.actor,
    });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 0042 — 按 reason code 选择性清除 quarantine。仅当当前 reason 完全匹配时才动 status。
 *
 * 用于 imagePromote 推完镜像后清 image-mismatch / image-distribute-failed,
 * 不会误清那种"hard image-* 已修但同时又 soft probe 失败"的并发竞态——后者
 * 在 promote 完成后下一轮 health snapshot 才会调正。
 */
export async function clearQuarantineByReason(
  id: string,
  reasonCode: QuarantineReasonCode,
  audit: { actor: string; operationId?: string },
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `UPDATE compute_hosts
          SET status = 'ready',
              quarantine_reason_code = NULL,
              quarantine_reason_detail = NULL,
              quarantine_at = NULL,
              consecutive_health_fail = 0,
              consecutive_health_ok = 0,
              updated_at = NOW()
        WHERE id = $1
          AND status = 'quarantined'
          AND quarantine_reason_code = $2`,
      [id, reasonCode],
    );
    if ((r.rowCount ?? 0) === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    await writeAuditInTx(client, {
      hostId: id,
      operation: "quarantine.clear-by-reason",
      operationId: audit.operationId,
      reasonCode,
      detail: { mode: "by-reason", matchedReason: reasonCode },
      actor: audit.actor,
    });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 0042 — 设置 quarantine 状态(by reason)。
 *
 * 优先级语义:
 *   - 当前 hard reason → 不被任何后续 set 覆盖,直到清除(promote 路径会走
 *     clearQuarantineByReason)。
 *   - 当前 soft reason + 新 reason 是 hard → 升级到 hard。
 *   - 当前 soft reason + 新 reason 是 soft 且 priority 更高 → 切换到新 soft。
 *   - 当前 soft reason + 新 reason 是 soft 且 priority 不高 → 不变(detail 也不动,
 *     避免被同优先级反复覆盖产生噪音)。
 *   - 当前 ready/无 reason → 直接 set。
 *   - bootstrapping/draining/broken 不动 status。
 *
 * 返回 { applied: boolean, previousStatus, nextStatus, previousReason, nextReason }。
 */
export interface SetQuarantinedInput {
  reason: QuarantineReasonCode;
  detail: string;
  operationId: string;
  actor: string;
}
export interface SetQuarantinedResult {
  applied: boolean;
  previousStatus: ComputeHostStatus;
  nextStatus: ComputeHostStatus;
  previousReason: QuarantineReasonCode | null;
  nextReason: QuarantineReasonCode | null;
}

export async function setQuarantined(
  id: string,
  input: SetQuarantinedInput,
): Promise<SetQuarantinedResult> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{
      status: ComputeHostStatus;
      reason: QuarantineReasonCode | null;
    }>(
      `SELECT status, quarantine_reason_code AS reason
         FROM compute_hosts WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (cur.rowCount === 0) {
      await client.query("ROLLBACK");
      throw new Error(`compute_hosts row not found: ${id}`);
    }
    const { status: previousStatus, reason: previousReason } = cur.rows[0]!;

    // 不动 status 的状态:bootstrapping/draining/broken
    if (
      previousStatus === "bootstrapping" ||
      previousStatus === "draining" ||
      previousStatus === "broken"
    ) {
      await writeAuditInTx(client, {
        hostId: id,
        operation: "quarantine.set-skipped",
        operationId: input.operationId,
        reasonCode: input.reason,
        detail: { reason: input.reason, detail: input.detail, currentStatus: previousStatus },
        actor: input.actor,
      });
      await client.query("COMMIT");
      return {
        applied: false,
        previousStatus,
        nextStatus: previousStatus,
        previousReason,
        nextReason: previousReason,
      };
    }

    // 优先级判定
    let apply = false;
    if (isHardQuarantineReason(input.reason)) {
      // hard 永远 apply,但若当前已经是同一 hard reason → 还是 apply(刷 detail/audit)
      apply = true;
    } else if (isHardQuarantineReason(previousReason)) {
      apply = false; // soft 不能覆盖 hard
    } else if (previousReason === null) {
      apply = true;
    } else {
      // 都是 soft:仅当新 reason priority 更高(数字更小)
      apply = softReasonPriority(input.reason) < softReasonPriority(previousReason);
    }

    if (!apply) {
      await writeAuditInTx(client, {
        hostId: id,
        operation: "quarantine.set-skipped",
        operationId: input.operationId,
        reasonCode: input.reason,
        detail: {
          reason: input.reason,
          detail: input.detail,
          previousReason,
          previousStatus,
        },
        actor: input.actor,
      });
      await client.query("COMMIT");
      return {
        applied: false,
        previousStatus,
        nextStatus: previousStatus,
        previousReason,
        nextReason: previousReason,
      };
    }

    await client.query(
      `UPDATE compute_hosts
          SET status = 'quarantined',
              quarantine_reason_code = $2,
              quarantine_reason_detail = $3,
              quarantine_at = NOW(),
              consecutive_health_fail = 0,
              consecutive_health_ok = 0,
              updated_at = NOW()
        WHERE id = $1`,
      [id, input.reason, input.detail],
    );
    await writeAuditInTx(client, {
      hostId: id,
      operation: "quarantine.set",
      operationId: input.operationId,
      reasonCode: input.reason,
      detail: {
        reason: input.reason,
        detail: input.detail,
        previousStatus,
        previousReason,
      },
      actor: input.actor,
    });
    await client.query("COMMIT");
    return {
      applied: true,
      previousStatus,
      nextStatus: "quarantined",
      previousReason,
      nextReason: input.reason,
    };
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 0042 — 写 loaded_image_id/at(image_pull / distribute 成功后调用)。
 * source 用于 audit:'bootstrap.image_pull' / 'distribute' / 'self-master-init'。
 */
export async function setLoadedImage(
  id: string,
  imageId: string,
  imageTag: string,
  audit: { actor: string; operationId: string; source: string },
): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE compute_hosts
          SET loaded_image_id = $2,
              loaded_image_at = NOW(),
              updated_at = NOW()
        WHERE id = $1`,
      [id, imageId],
    );
    await writeAuditInTx(client, {
      hostId: id,
      operation: "image.loaded",
      operationId: audit.operationId,
      reasonCode: null,
      detail: {
        imageId,
        imageTag,
        source: audit.source,
      },
      actor: audit.actor,
    });
    await client.query("COMMIT");
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch { /* swallow */ }
    throw e;
  } finally {
    client.release();
  }
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
 * 调度用 user-level pin 查找:admin 把特定 user 钉到特定 host(QA/测试)。
 * 返 NULL 表示该 user 未设 pin,scheduler 走默认 sticky+least-loaded 路径。
 *
 * 仅返 host_uuid;调用方自己判 host 是否 ready / 满 / cooldown,失效 fall-through。
 * 0040 migration 引入 users.pinned_host_uuid。
 */
export async function getUserPinnedHost(userId: number): Promise<string | null> {
  const r = await getPool().query<{ pinned_host_uuid: string | null }>(
    `SELECT pinned_host_uuid FROM users WHERE id = $1`,
    [userId],
  );
  return r.rows[0]?.pinned_host_uuid ?? null;
}

/**
 * 调度用 sticky 查找:某 user 是否已有 active 容器 → 返其 host_uuid。
 * 如果 host 已经 not ready,调用方应拒 sticky 并进 pickHost。
 *
 * **保留意图**:语义"必须存在 active 容器"。`sshMux resolvePlacement`
 * (index.ts:898)依赖此语义把 SSH 命令路由到正在跑的容器所在 host —— 不能
 * 改成包含 vanished,否则会路由到没有运行容器的 host。
 *
 * **注意**:nodeScheduler.pickHost 不再用此函数,改用下面的 findUserDataHost
 * (覆盖 vanished,把用户的 docker named volume 留在哪台 host 作为强 sticky
 * 依据)。详见 v1.0.17 changelog 与 findUserDataHost doc。
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

/**
 * v1.0.17 — 调度用"数据 sticky":找该 user 数据(docker named volume
 * `oc-v3-data-u<uid>` + `oc-v3-proj-u<uid>`)最近一次落在哪台 host。
 *
 * 与 findUserStickyHost 的区别:
 *   - findUserStickyHost: 只查 state='active' —— "正在跑的容器在哪"
 *   - findUserDataHost:   查 active + vanished —— "用户数据 volume 在哪"
 *
 * 为什么需要这个新函数:idle sweep(30 min)把容器 vanished 后 docker volume
 * 不删(GC 只在 banned 7d / no-login 90d 才动 volume),volume 物理上是
 * host-local 的,跨 host 没有同步代码。如果 vanished 后用户重连被调度到
 * 不同 host → ensureVolume 在新 host 上幂等创建**空** volume → 用户工作
 * 目录 + ~/.openclaude (skills/agents/CLAUDE.md/shell history) 全空。
 *
 * 排序:
 *   1. (state = 'active') DESC —— active 必然是最新写,优先
 *   2. created_at DESC —— 否则取最近一次 vanished 容器
 *   3. id DESC —— created_at 撞上 tie-break(同毫秒内的并发)
 *
 * `WHERE ac.host_uuid IS NOT NULL` 防御性兜住老的 host_uuid=NULL legacy 行
 * (M1 monolith 阶段 INSERT 时不带 host_uuid 的极少数遗留)。
 *
 * 现网线上 agent_containers ~190 行,顺序扫无性能问题。表过万行后建议补
 * idx_ac_user_state_created (user_id, state, created_at DESC, id DESC)
 * WHERE host_uuid IS NOT NULL —— 但本次修复不加索引,KISS。
 *
 * 调用方语义(主动 vs 被动状态严格区分):
 *   - 返 null → user 全新,从未 provision 过(走 least-loaded)
 *   - 非 null + hostStatus='ready' + host 未满 + 非 cooldown → 命中,return
 *   - 非 null + hostStatus='ready' + host 满 → 抛 NodePoolBusyError(让客户端
 *     host_full retry;不 fallback,fallback=空 volume)
 *   - 非 null + cooldown 中 → 同上抛 NodePoolBusyError(60s 临时避让)
 *   - 非 null + hostStatus='draining' → 抛 NodePoolBusyError。draining 是 admin
 *     **主动**状态,数据仍在 host 本地,fall-through 会重现空 volume bug
 *   - 非 null + hostStatus='quarantined'/'broken' → fall through(被动故障,
 *     host 真坏,数据救不回来,优先可用性)
 *   - 非 null + hostStatus='bootstrapping' → fall through(过渡态)
 *
 * 注:JOIN compute_hosts 的语义决定 host 行真不存在时本函数返 null(等价于
 * "user 全新")而不是 hostStatus='missing'。M1 schema migration 0030 将
 * agent_containers.host_uuid 设为 ON DELETE RESTRICT,所以理论上不会出现
 * "容器行存在但 host 行被删"的情况;调用方仍按"missing → fall through"防御。
 */
export async function findUserDataHost(userId: number): Promise<{
  hostUuid: string;
  hostStatus: ComputeHostStatus;
  containerId: number;
  containerState: "active" | "vanished";
} | null> {
  // SQL state filter 必须 5 行内显式 — 仓库 lint-agent-containers-sql.ts 强校验。
  // ORDER BY (state='active') DESC 显式 active 优先于 vanished;然后 created_at
  // DESC + id DESC tie-break。LIMIT 1 因为只要最近一台。
  const r = await getPool().query<{
    container_id: string;
    host_uuid: string;
    host_status: ComputeHostStatus;
    state: "active" | "vanished";
  }>(
    `SELECT ac.id AS container_id,
            ac.host_uuid,
            ch.status AS host_status,
            ac.state
       FROM agent_containers ac
       JOIN compute_hosts ch ON ch.id = ac.host_uuid
      WHERE ac.user_id = $1
        AND ac.state IN ('active', 'vanished')
        AND ac.host_uuid IS NOT NULL
      ORDER BY (ac.state = 'active') DESC,
               ac.created_at DESC,
               ac.id DESC
      LIMIT 1`,
    [userId],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    hostUuid: row.host_uuid,
    hostStatus: row.host_status,
    containerId: Number.parseInt(row.container_id, 10),
    containerState: row.state,
  };
}
