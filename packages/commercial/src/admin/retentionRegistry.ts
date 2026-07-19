/**
 * 数据表 retention 离场语义 —— **单一声明面**(批D D3)。
 *
 * 此前"哪张表怎么离场"散在四处:AUDIT_RETENTION_POLICIES(TTL 删除)、PERMANENT_AUDIT_TABLES
 * (合规永久)、PERMANENT_OPS_LEDGER_TABLES(账本永久)、以及各自为政的手写 sweeper。新增一张表
 * 时没有任何机制逼你声明它的离场语义 —— 于是审计表长期无界增长(admin_audit/turn_traces 曾
 * 全无清理)、或声明了 sweeper 却从未实现(wechat_audit)。
 *
 * 本模块把上述四处**引用聚合**成一张覆盖全部 base table 的注册表:每张表恰好一个 disposition。
 * 配套的反向对账门(retentionRegistry.integ.test.ts)枚举 information_schema 全部 base table,
 * 断言每张都在本注册表 —— 新增表未声明离场语义即 CI 红,消灭"静默无界增长"这一整类风险。
 *
 * disposition 六选一:
 *   - ttl                  走 auditRetentionSweeper 的单列时间 TTL(权威 = AUDIT_RETENTION_POLICIES)
 *   - permanent-compliance 合规审计永久(权威 = PERMANENT_AUDIT_TABLES)
 *   - permanent-ledger     运维业务账本永久(权威 = PERMANENT_OPS_LEDGER_TABLES)
 *   - bespoke-sweeper      有专属 sweeper 定期清理(登记 sweeper 名;引用聚合,不搬实现)
 *   - durable              活体状态,靠实体删除/FK 级联/软删/手动运维清理,无基于时间的定期 sweep
 *   - deferred             离场语义待裁定(必须写 owner + 到期日,门不放过、也不逼本批做产品裁定)
 */

import {
  AUDIT_RETENTION_POLICIES,
  PERMANENT_AUDIT_TABLES,
  PERMANENT_OPS_LEDGER_TABLES,
} from "./auditRetention.js";

export type RetentionDisposition =
  | { kind: "ttl" }
  | { kind: "permanent-compliance" }
  | { kind: "permanent-ledger" }
  | { kind: "bespoke-sweeper"; sweeper: string }
  | { kind: "durable" }
  | { kind: "deferred"; owner: string; dueDate: string; note: string };

/**
 * 有专属 sweeper 定期清理的表 → 负责它的 sweeper(名/位置)。证据来自 retention 全表调研:
 * 每条都对应一个真实存在的定期 DELETE 路径(与 wechat_audit 那种"声明了但没实现"区分开)。
 */
export const BESPOKE_SWEEPER_TABLES: Readonly<Record<string, string>> = {
  account_refresh_events: "refreshEventsSweeper (account-pool/refreshEventsSweeper.ts)",
  provider_health_samples: "providerHealthScheduler (admin/providerHealthScheduler.ts)",
  provider_latency_samples: "latencyProber (egress/latencyProber.ts)",
  connector_oauth_pending: "connectorSweeper (connectors/sweeper.ts)",
  selfheal_webhook_nonces: "incidentSweeper (selfheal/sweeper.ts)",
  request_finalize_journal: "finalizeJournalReconciler.gcFinalizeJournal (billing/finalizeJournalReconciler.ts)",
  research_blobs: "researchJobScheduler.gcExpiredBlobs (research/store.ts)",
  research_artifacts: "researchJobScheduler.gcOldArtifacts (research/store.ts)",
  pending_usage_patches: "sessionsGcSweeper (db/pgSessionsBackend.ts)",
  server_authored_request_map: "sessionsGcSweeper (db/pgSessionsBackend.ts)",
  client_session_turn_tape_parts: "sessionsGcSweeper (db/pgSessionsBackend.ts)",
  oauth_pending_states: "oauthPendingStore write-triggered gc + consume-on-use (auth/oauthPendingStore.ts)",
  // 批D D3 新增:session_goals 终态离场,由 auditRetentionSweeper tick 驱动
  // (sweepTerminalSessionGoals,见 auditRetention.ts)。
  session_goals: "auditRetentionSweeper.sweepTerminalSessionGoals (admin/auditRetention.ts)",
  // 0170 durable dispatch:open/manual 未收敛行永久保留；只有已收敛终态按双龄列规则清理。
  turn_dispatches: "auditRetentionSweeper.sweepResolvedTurnDispatches (admin/auditRetention.ts)",
};

/**
 * 活体业务/运维状态表:靠实体删除 / 外键级联 / 软删 / 状态位 UPDATE / 手动运维清理,
 * **没有**基于时间的定期 sweep。它们的"离场"绑定实体生命周期,不是审计/事件流水。
 * (来自全表调研;新增此类表须显式补进本清单,反向门才放行。)
 */
export const DURABLE_TABLES: readonly string[] = [
  "account_group_models",
  "account_groups",
  "admin_alert_channels",
  "admin_alert_rule_state",
  "admin_alert_silences",
  "agent_containers",
  "agent_cost_overrides",
  "agent_migrations",
  "agent_subscriptions",
  // FK 级联于 ttl 父表 agent_tool_rollup_reports(有效离场由父表 90d TTL 决定)。
  "agent_tool_rollup_counts",
  "api_relay_credentials",
  "chat_session_account_pin",
  "claude_accounts",
  "client_session_archive_chunks",
  "client_session_archived_ids",
  "client_session_turn_tape_records",
  "client_session_turn_tapes",
  "client_sessions",
  "codex_route_contexts",
  "compute_hosts",
  "compute_pool_state",
  "connections",
  "connector_platform_oauth_apps",
  "connector_token_cache",
  "credit_ledger",
  "cron_wake_index",
  "deploy_state",
  "deploy_state_journal",
  "egress_proxies",
  "email_verifications",
  "feedback",
  "github_links",
  "github_session_workspaces",
  "image_generation_usage_records",
  "inbox_email_jobs",
  "inbox_message_assets",
  "inbox_message_reads",
  "inbox_messages",
  // incident 家族里唯一的**配置**表(非账本)→ durable,不进 PERMANENT_OPS_LEDGER_TABLES。
  "incident_policies",
  "leader_lease",
  "literature_deepxiv_config",
  "marketplace_agent_capability_bindings",
  "marketplace_capability_requirements",
  "marketplace_catalog_revision",
  "marketplace_installs",
  "marketplace_skill_listings",
  "marketplace_skill_versions",
  "minimax_media_usage_records",
  "model_aliases",
  "model_authority_deploy_state",
  "model_catalog",
  "model_pricing",
  "model_runtime_requirements",
  "model_security_epoch",
  "model_visibility_grants",
  "oauth_identities",
  "orders",
  "org_installs",
  "org_invitations",
  "org_invoice_profiles",
  "org_invoice_requests",
  "org_memberships",
  "org_subscriptions",
  "orgs",
  // 高风险自动回复总开关/独立同意是账号活体配置;账号删除时由 FK 级联离场。
  "plugin_automation_controls",
  // prompt_queue 家族:队列活体状态,靠消费出队 + 用户删除 FK 级联清理,无定期时间 sweep
  // (prompt_queue_mutations 是审计流水,单独走 ttl,见 AUDIT_RETENTION_POLICIES)。
  "prompt_queue_heads",
  "prompt_queue_item_attachments",
  "prompt_queue_items",
  "provider_ops",
  "research_config",
  "research_documents",
  "research_jobs",
  "research_phase_checkpoints",
  "schema_migrations",
  "selfheal_capability_uses",
  "selfheal_notice_approver_bindings",
  "selfheal_release_fuse",
  "server_authored_turn_anchor_map",
  "sessions_store_migration_state",
  "skill_embedding_cache",
  "skill_search_log",
  "subscription_plans",
  "system_settings",
  // 0170 会话 tape 的只读派生投影；会话删除路径显式清理，权威 tape 不依赖本表。
  "tape_chat_projection",
  "topup_plans",
  // 精确轮次退款幂等栅栏兼具账务回溯凭据；与 credit_ledger/usage_records 同档，
  // 必须永久保留以阻止历史 turn_key 被重复退款，不按时间清理。
  "turn_waivers",
  "turn_tape_cost_components",
  "usage_records",
  "user_api_keys",
  "user_preferences",
  "user_remote_hosts",
  "user_subscriptions",
  "users",
  "v5_migration_audit",
  "wechat_bindings",
  // 设计上永久保留(purgeSentTombstones/purgeFailedAged 均为 no-op,见 outboxStore.ts)。
  "wechat_outbox",
  "wechat_running_sessions",
  "wechat_session_pointer",
] as const;

/**
 * 离场语义**待裁定**的表:门不放过(必须显式登记),但不逼本批做产品裁定。
 * 每条必须带 owner + 到期日 + 说明,由反向对账门持续盯住。
 */
export const DEFERRED_TABLES: Readonly<
  Record<string, { owner: string; dueDate: string; note: string }>
> = {
  marketplace_skill_usage_events: {
    owner: "marketplace/growth",
    dueDate: "2026-09-30",
    note: "技能使用埋点事件流,量随市场增长。TTL(如聚合后清)还是永久留作排名/推荐信号,待产品裁定。",
  },
  response_rating: {
    owner: "product/quality",
    dueDate: "2026-09-30",
    note: "每条响应 👍/👎 评分。是否 TTL,还是永久留作模型训练信号,待裁定。",
  },
  // 批D D3 反向门首个命中的不一致:声明了 sweeper 却从未实现。
  wechat_audit: {
    owner: "wechat/im",
    dueDate: "2026-09-30",
    note:
      "入站原始 payload 审计。0066 迁移与旧注释都声称『daemon 定期 DELETE WHERE received_at < NOW-7d』," +
      "但全仓无任何 DELETE FROM wechat_audit —— 声明的 7d sweeper 从未实现(实际无界增长)。" +
      "且 received_at 是 BIGINT epoch-ms(非 timestamptz),用不了通用 TTL 策略,需 bespoke epoch-ms 清理。" +
      "7d 是否仍适用待 wechat 子系统确认后补真实 sweeper,再从 deferred 转 bespoke-sweeper。",
  },
};

function buildRetentionRegistry(): Readonly<Record<string, RetentionDisposition>> {
  const reg: Record<string, RetentionDisposition> = {};
  const claim = (table: string, d: RetentionDisposition): void => {
    const prev = reg[table];
    if (prev) {
      throw new Error(
        `[retentionRegistry] 表 ${table} 被重复登记(${prev.kind} vs ${d.kind});每张表只能有一个离场语义`,
      );
    }
    reg[table] = d;
  };
  // 引用聚合三个既有权威源(不搬实现):
  for (const p of AUDIT_RETENTION_POLICIES) claim(p.table, { kind: "ttl" });
  for (const t of PERMANENT_AUDIT_TABLES) claim(t, { kind: "permanent-compliance" });
  for (const t of PERMANENT_OPS_LEDGER_TABLES) claim(t, { kind: "permanent-ledger" });
  // 收编 bespoke sweeper / durable / deferred 三档:
  for (const [t, sweeper] of Object.entries(BESPOKE_SWEEPER_TABLES)) {
    claim(t, { kind: "bespoke-sweeper", sweeper });
  }
  for (const t of DURABLE_TABLES) claim(t, { kind: "durable" });
  for (const [t, meta] of Object.entries(DEFERRED_TABLES)) {
    claim(t, { kind: "deferred", ...meta });
  }
  return reg;
}

/** 全表 retention 离场语义单一权威(模块加载即校验无重复登记)。 */
export const RETENTION_REGISTRY: Readonly<Record<string, RetentionDisposition>> =
  buildRetentionRegistry();
