/**
 * 审计/事件表统一 retention(审计体系整改批)。
 *
 * 动机:评审发现核心审计表全部无清理(admin_audit/agent_audit/compute_host_audit/
 * turn_traces/rate_limit_events 无界增长),而外围事件表反而各自长了 sweeper
 * (account_refresh_events 28d / provider_health 30min / wechat_audit 7d)。
 * 本模块把"哪张表保留多久"收敛为单一权威注册表 + 一个每日 sweeper,新增事件表
 * 只需在注册表加一行,不再各自造轮子。
 *
 * 政策取值:
 *   - security_events   180d  安全复盘窗口(半年足够;有告警面做实时性)
 *   - agent_audit        90d  工具失败遥测,排障价值随时间衰减
 *   - agent_tool_rollup_reports 90d 工具成功/失败聚合;counts 由 FK 级联清理
 *   - compute_host_audit 90d  遥测已退出本表(0129),剩真实生命周期事件,量级小,
 *                             90d 覆盖"host 出事回看历史"场景
 *   - turn_traces        90d  请求ID→用户/会话反查,计费争议窗口内必须在
 *   - rate_limit_events  30d  限流命中信号,只喂告警聚合
 *   - connector_write_ledger 90d  写确认账本**终态**行(带 status 谓词;活跃态不删)
 *   - refresh_tokens     过期后 30d  auth 死行回收(列=expires_at;revoked 未过期行
 *                             保留给重用检测,见注册表内注释)
 *   - admin_alert_outbox 90d  告警投递队列 sent/failed 终态行(带 status 谓词)
 *   - admin_audit        永久  合规审计,显式登记在 PERMANENT_AUDIT_TABLES,
 *                             不允许出现在删除政策里(sweeper 有 fail-fast 断言)
 *   - account_refresh_events / provider_health / wechat_audit 已有各自 sweeper,
 *     不重复纳管(避免双清理权威;登记债:后续可迁入本表统一)
 *
 * 运维:COMMERCIAL_AUDIT_RETENTION_SWEEP_DISABLED=1 一键关停(UX 铁律:限流/清理类
 * 默认宽松 + env 可回滚)。天数可经 COMMERCIAL_AUDIT_RETENTION_OVERRIDES 覆盖,
 * 格式 `table=days,table=days`(只允许注册表内的表,防 env 注入任意表名)。
 */

import { query } from "../db/queries.js";

export interface RetentionPolicy {
  /** 表名(标识符来自本常量表,永不来自用户输入——SQL 内直接拼接的前提) */
  table: string;
  /** 时间列名(同上,常量) */
  column: string;
  days: number;
  /**
   * 可选附加 WHERE 谓词(**常量,来自本注册表,永不来自用户输入**——SQL 直接拼接的前提)。
   * 用于只清"终态"行的表(如 connector_write_ledger:活跃态行仍持 params 密文,
   * 由 connectorSweeper 转终态后才可删)。
   */
  predicate?: string;
}

export const AUDIT_RETENTION_POLICIES: readonly RetentionPolicy[] = [
  { table: "security_events", column: "created_at", days: 180 },
  { table: "agent_audit", column: "occurred_at", days: 90 },
  { table: "agent_tool_rollup_reports", column: "created_at", days: 90 },
  { table: "compute_host_audit", column: "ts", days: 90 },
  { table: "turn_traces", column: "created_at", days: 90 },
  { table: "rate_limit_events", column: "created_at", days: 30 },
  { table: "product_friction_events", column: "updated_at", days: 30 },
  { table: "image_generation_attempts", column: "started_at", days: 30, predicate: "outcome<>'pending'" },
  { table: "selfheal_wecom_inbound_dedupe", column: "received_at", days: 90 },
  // P1#11:连接器写账本 90 天终态 retention 统一收口到这里(connectorSweeper 只做
  // 活跃→终态转换,不再自删)。谓词保证只删终态行——活跃态(pending/approved/executing)
  // 仍持 params 密文,绝不在此删除。
  {
    table: "connector_write_ledger",
    column: "created_at",
    days: 90,
    predicate: "status IN ('succeeded','failed','unknown','expired','denied')",
  },
  // 2026-07-16 巡检批:本注册表是仓内 retention 的单一权威,收口范围从"审计/事件表"
  // 扩到"无自有 sweeper 的有界状态表"——与其为下面两张表各造一个清理调度器(第二机制),
  // 不如沿用同一注册表 + 同一 sweeper。
  //
  // refresh_tokens:巡检发现全库 3.9 万行中 97% 是过期/吊销死行(最老 04-20),全仓无
  // 任何删除路径。谓词按 expires_at 过期 30d 才删:revoked 未过期的行**故意保留**——
  // 旋转家族的"吊销 token 被重用 → 撤全家族"防盗检测依赖能查到该行,等自然过期再入围。
  { table: "refresh_tokens", column: "expires_at", days: 30 },
  // admin_alert_outbox:投递队列的 sent/failed 终态行此前无任何回收。pending/带
  // next_attempt_at 的活跃行绝不在此删除(谓词钉死终态)。
  {
    table: "admin_alert_outbox",
    column: "created_at",
    days: 90,
    predicate: "status IN ('sent','failed')",
  },
] as const;

/** 显式声明永久保留的审计表——出现在删除政策里=编程错误。 */
export const PERMANENT_AUDIT_TABLES: readonly string[] = ["admin_audit"] as const;

/**
 * v5 自愈体系(RFC §7 [解 M-retention])运维业务账本 —— **永久保留(ops-ledger 档)**。
 *
 * incident/repair 账本是独立运维业务账本,**不冒充 admin_audit 合规域**(那是人类管理员
 * 操作留痕),自成 'ops-ledger':为满足"永久可回溯"整链(核心账本 + 进度时间线 + 投递/
 * 收件人快照)一律不删(repair 量级小,无存储压力)。
 *
 * 与 TTL policies(会 DELETE)、PERMANENT_AUDIT_TABLES **三者互斥**,由下方 fail-fast 断言强制:
 * 任一 ops-ledger 表若被误加进删除政策或与合规永久表重名,resolveRetentionPolicies 抛错拒启。
 */
export const PERMANENT_OPS_LEDGER_TABLES: readonly string[] = [
  "incidents",
  "codex_repairs",
  "codex_repair_events",
  "incident_recipients",
  "incident_deliveries",
  "selfheal_user_impact_evidence",
  "selfheal_user_notice_proposals",
  "selfheal_user_notice_recipients",
] as const;

// 模块加载即校验:合规永久表与运维永久账本表名不得重叠(命名域彻底分离,防混淆)。
{
  const overlap = PERMANENT_OPS_LEDGER_TABLES.filter((t) => PERMANENT_AUDIT_TABLES.includes(t));
  if (overlap.length > 0) {
    throw new Error(
      `[auditRetention] ops-ledger 永久表与合规审计永久表重叠: ${overlap.join(",")} — 命名域必须分离`,
    );
  }
}

export const AUDIT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface AuditRetentionSweeperHandle {
  stop(): void;
  /** 测试/运维用:立即跑一轮,返回 per-table 删除行数。 */
  runNow(): Promise<Record<string, number>>;
}

export interface AuditRetentionSweeperOptions {
  intervalMs?: number;
  /** 测试用:首次 boot 立即跑(默认 false,boot 后等 intervalMs,避免启动风暴)。 */
  runOnStart?: boolean;
  onError?: (table: string, err: unknown) => void;
  /** env 覆盖串,默认读 process.env.COMMERCIAL_AUDIT_RETENTION_OVERRIDES。 */
  overrides?: string;
  /** 测试用注入:覆盖默认的 DELETE 执行(便于无 DB 单元测试;同 refreshEventsSweeper 惯例)。 */
  purgeFn?: (p: RetentionPolicy) => Promise<number>;
}

function defaultOnError(table: string, err: unknown): void {
  // eslint-disable-next-line no-console
  console.warn(`[auditRetentionSweeper] purge ${table} failed:`, err);
}

/** 解析 env 覆盖串;未注册的表名忽略并 warn(不给 env 开任意表删除的口子)。 */
export function resolveRetentionPolicies(overrides?: string): RetentionPolicy[] {
  const map = new Map(AUDIT_RETENTION_POLICIES.map((p) => [p.table, { ...p }]));
  const raw = overrides ?? process.env.COMMERCIAL_AUDIT_RETENTION_OVERRIDES ?? "";
  for (const pair of raw.split(",")) {
    const [table, daysStr] = pair.split("=").map((s) => s?.trim());
    if (!table) continue;
    const days = Number(daysStr);
    const p = map.get(table);
    if (!p) {
      // eslint-disable-next-line no-console
      console.warn(`[auditRetentionSweeper] override 忽略未注册表: ${table}`);
      continue;
    }
    if (Number.isFinite(days) && days >= 1) p.days = Math.floor(days);
  }
  const resolved = [...map.values()];
  // fail-fast 断言:永久表(合规审计 + 运维账本)绝不允许出现在删除政策里(防未来误加)。
  for (const p of resolved) {
    if (PERMANENT_AUDIT_TABLES.includes(p.table)) {
      throw new Error(`[auditRetentionSweeper] ${p.table} 声明为永久保留(合规审计),禁止配置删除政策`);
    }
    if (PERMANENT_OPS_LEDGER_TABLES.includes(p.table)) {
      throw new Error(`[auditRetentionSweeper] ${p.table} 声明为永久保留(ops-ledger 运维账本),禁止配置删除政策`);
    }
  }
  return resolved;
}

async function purgeTable(p: RetentionPolicy): Promise<number> {
  // 标识符与谓词均来自常量注册表(resolveRetentionPolicies 已过滤 env 注入,
  // env 只能改 days、不能改 table/column/predicate),可安全拼接。
  const extra = p.predicate ? ` AND (${p.predicate})` : "";
  const r = await query(
    `DELETE FROM ${p.table} WHERE ${p.column} < NOW() - ($1 || ' days')::interval${extra}`,
    [String(p.days)],
  );
  return r.rowCount ?? 0;
}

export function startAuditRetentionSweeper(
  opts: AuditRetentionSweeperOptions = {},
): AuditRetentionSweeperHandle {
  const interval = Math.max(60_000, opts.intervalMs ?? AUDIT_RETENTION_INTERVAL_MS);
  const onError = opts.onError ?? defaultOnError;
  const purgeFn = opts.purgeFn ?? purgeTable;
  const policies = resolveRetentionPolicies(opts.overrides);
  let stopped = false;

  async function runOneTick(): Promise<Record<string, number>> {
    const deleted: Record<string, number> = {};
    for (const p of policies) {
      if (stopped) break;
      try {
        deleted[p.table] = await purgeFn(p);
      } catch (err) {
        onError(p.table, err);
        deleted[p.table] = -1;
      }
    }
    const summary = Object.entries(deleted)
      .filter(([, n]) => n !== 0)
      .map(([t, n]) => `${t}=${n}`)
      .join(" ");
    if (summary) {
      // eslint-disable-next-line no-console
      console.log(`[auditRetentionSweeper] purged: ${summary}`);
    }
    return deleted;
  }

  const timer = setInterval(() => {
    if (stopped) return;
    void runOneTick();
  }, interval);
  if (typeof timer.unref === "function") timer.unref();

  if (opts.runOnStart) void runOneTick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    runNow: runOneTick,
  };
}
