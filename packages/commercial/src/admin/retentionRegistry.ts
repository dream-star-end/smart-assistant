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
import {
  isBoundedReadTimeout,
  withBoundedReadOnly,
  type BoundedReadPool,
} from "../db/boundedReadOnly.js";

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
  // OCV5-537(DAT-8):0066 声明却从未实现的 7 天清理,现由同一 tick 执行。
  wechat_audit: "auditRetentionSweeper.sweepWechatAudit (admin/auditRetention.ts)",
  // tape-projected live frames are unreachable once tape records exist;
  // pruneProjectedLiveFrames is the dedicated DELETE path (not age-based TTL).
  client_session_live_frames: "pruneProjectedLiveFrames (db/liveTurnFrames.ts)",
  client_session_live_unit_checkpoints: "deleteLiveUnitCheckpoints via pruneProjectedLiveFrames (db/liveUnitCheckpoints.ts)",
};

/**
 * 活体业务/运维状态表:靠实体删除 / 外键级联 / 软删 / 状态位 UPDATE / 手动运维清理,
 * **没有**基于时间的定期 sweep。它们的"离场"绑定实体生命周期,不是审计/事件流水。
 * (来自全表调研;新增此类表须显式补进本清单,反向门才放行。)
 */
export const DURABLE_TABLES: readonly string[] = [
  // OCV5-537(DAT-8):用户对单条响应的 👍/👎(含可选评论),随用户删除级联;是质量反馈信号,
  // 技能差评归因按 90 天窗口读取。体量小(个人版 331 行),不做时间 TTL。
  "response_rating",
  // OCV5-537(DAT-8):技能使用埋点。上架评分聚合按 trace_id 关联 response_rating 读**全部历史**
  // (marketplace/marketplaceDb.ts 的 catalog 与 detail 两处 rt 聚合),时间 TTL 会让已展示的评分
  // 消失;因此不做 TTL。要控体量,先把评分归因落成聚合表再谈清理(Phase 3)。个人版 2.4k 行。
  "marketplace_skill_usage_events",
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
  // Lifetime follows claude_accounts via ON DELETE CASCADE; rows are edited by the admin page, never swept by age.
  "box_claude_profiles",
  "chat_session_account_pin",
  "claude_accounts",
  "client_session_archive_chunks",
  "client_session_archived_ids",
  "client_session_turn_tape_model_records",
  "client_session_turn_tape_records",
  "client_session_turn_tapes",
  "turn_tape_recovery_links",
  "client_session_user_payloads",
  "client_sessions",
  "codex_route_contexts",
  "grok_route_contexts",
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
  // Persistent dispatch/idempotency evidence, like usage_records. User deletion
  // anonymizes the owner without refunding platform quota; no age-based sweep.
  "literature_captcha_requests",
  "literature_deepxiv_config",
  "marketplace_agent_capability_bindings",
  "marketplace_capability_requirements",
  "marketplace_catalog_revision",
  "marketplace_installs",
  "marketplace_skill_listings",
  "marketplace_skill_versions",
  // User-owned source media, durable jobs, projects, and shot history are retained
  // losslessly until the owning user is deleted; there is no silent age-based GC.
  "media_generation_inputs",
  "media_generation_job_inputs",
  "media_generation_jobs",
  "minimax_media_usage_records",
  "model_aliases",
  "model_authority_deploy_state",
  "model_catalog",
  "model_pricing",
  "model_runtime_requirements",
  "model_security_epoch",
  "model_visibility_grants",
  "muse_bridge_credentials",
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
  "topup_plans",
  // 0176 no longer reads/writes these projection-era tables, but retains the
  // physical data for rollback. Keep them registered until a later migration
  // actually drops the tables.
  "tape_chat_projection",
  "turn_dispatch_error_projections",
  // 精确轮次退款幂等栅栏兼具账务回溯凭据；与 credit_ledger/usage_records 同档，
  // 必须永久保留以阻止历史 turn_key 被重复退款，不按时间清理。
  "turn_waivers",
  // Durable execution/status evidence. Direct history reads depend on it and
  // financial/audit attribution must not silently expire with wall-clock age.
  "turn_dispatches",
  "turn_tape_cost_components",
  "usage_records",
  "user_api_keys",
  "user_preferences",
  "user_remote_hosts",
  "user_subscriptions",
  "users",
  "v5_migration_audit",
  "video_project_shots",
  "video_projects",
  "wechat_bindings",
  // 设计上永久保留(purgeSentTombstones/purgeFailedAged 均为 no-op,见 outboxStore.ts)。
  "wechat_outbox",
  "wechat_running_sessions",
  "wechat_session_pointer",
  // 2026-09-05 selfhost sync: 0260/0261 research + 0264 desktop live rows.
  "research_library_memberships",
  "research_fetch_attempts",
  "desktop_enrollments",
  "desktop_devices",
  "desktop_device_audit",
  // 2026-09-05 OCV5-113: schema tables that had no retention disposition.
  // Classification is by analogy with already-registered siblings; none of
  // these get a new time-based DELETE.
  "authority_turn_dispatches",
  "auto_dream_action_receipts",
  "auto_dream_platform_finding_occurrences",
  "auto_dream_platform_findings",
  "auto_dream_platform_raw_signals",
  "chat_projects",
  "client_session_live_streams",
  "community_tutorials",
  // 0321 经验分享 AI 审核:作业(每篇一行)与判定记录,FK community_tutorials ON DELETE CASCADE,
  // 随稿件离场;稿件本身无基于时间的清理。
  "community_tutorial_moderation_jobs",
  "community_tutorial_moderations",
  "cursor_external_usage_audit",
  "inbox_message_audience_snapshots",
  "ocr_jobs",
  "project_assets",
  "provider_quota_blocks",
  "qq_bind_attempts",
  "qq_bind_tokens",
  "qq_bot_bindings",
  "qq_outbox",
  "qq_running_sessions",
  "qq_session_pointer",
  "turn_control_requests",
  "turn_permission_requests",
  "turn_recovery_jobs",
  "turn_tape_materialization_jobs",
  "turn_tape_settlement_jobs",
  "tutorial_blob_refs",
  // 0320 经验分享图片上传者(FK tutorial_blobs/users ON DELETE CASCADE),随 blob 离场。
  "tutorial_blob_uploads",
  "tutorial_blobs",
  "tutorial_case_specs",
  "tutorial_compass_notes",
  "tutorial_eval_jobs",
  "zcode_external_usage_audit",
  // 2026-09-06 selfhost sync: 0273 per-user ChatGPT proxy credentials (FK users ON DELETE
  // CASCADE) and 0274 desktop tunnel owner registry (FK agent_containers ON DELETE CASCADE,
  // rows overwritten by heartbeat/attach). Live state, no time-based sweep.
  "chatgpt_proxy_credentials",
  "desktop_tunnel_owners",
  // 0285 content review (strike count, appeal, account ban): live moderation
  // state per user. A row changes by status UPDATE (revoked / decided) and is
  // read for the user's current count; there is no time-based sweep.
  "content_review_account_bans",
  "content_review_appeals",
  "content_review_strikes",
  // OCV5-424 / OCV5-415 migrations 0306–0308 (retention settled in the 2026-10-16 commercial
  // sync review, OCV5-445). Admin-managed pool members (pool_api_keys: env rows replaced by
  // fingerprint, admin rows edited/disabled on the 服务池 page; gemini_oauth_accounts:
  // Antigravity Google accounts), one affinity row per (service, user) overwritten on rebind
  // (expires_at is a logical expiry, not a sweep), and the Antigravity billing evidence
  // (per-call relay usage + per-turn admission record, read by settlement and kept like
  // cursor_external_usage_audit). No time-based DELETE.
  "pool_api_keys",
  "gemini_oauth_accounts",
  "pool_user_affinity",
  "antigravity_relay_usage",
  "antigravity_turns",
] as const;

/**
 * 离场语义**待裁定**的表:门不放过(必须显式登记),但不逼本批做产品裁定。
 * 每条必须带 owner + 到期日 + 说明,由反向对账门持续盯住。
 */
export const DEFERRED_TABLES: Readonly<
  Record<string, { owner: string; dueDate: string; note: string }>
> = {
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

/** Creation source is independent of retention; metadata never grants permanent identity. */
export interface HistoricalManualTable {
  source: "historical-manual";
  owner: string;
  evidence: string;
}

/** Exact historical presence exceptions, not a prefix/regex backup allowlist.
 * Creation SQL is not known; do not manufacture this table on fresh installs.
 * Permanent identity continues to come only from PERMANENT_OPS_LEDGER_TABLES.
 */
export const HISTORICAL_MANUAL_TABLES: Readonly<Record<string, HistoricalManualTable>> = Object.freeze({
  model_pricing_0903_cw_backup: Object.freeze({
    source: "historical-manual" as const,
    owner: "selfhost-ops",
    evidence: "OCV5-180 C live-table audit; permanent registration 3ec290e1; presence contract approved 2026-09-09. Creation SQL unverified.",
  }),
});

/** Fail closed on stale/invalid metadata; all other registered tables are migration-owned. */
export function buildFreshRetentionTables(
  registry: Readonly<Record<string, RetentionDisposition>> = RETENTION_REGISTRY,
  historical: Readonly<Record<string, HistoricalManualTable>> = HISTORICAL_MANUAL_TABLES,
  ttlTables: readonly string[] = AUDIT_RETENTION_POLICIES.map((p) => p.table),
): readonly string[] {
  const ttl = new Set(ttlTables);
  for (const [table, meta] of Object.entries(historical)) {
    if (!Object.hasOwn(registry, table)) {
      throw new Error(`[retentionRegistry] historical source is not registered: ${table}`);
    }
    if (registry[table]?.kind !== "permanent-ledger" || ttl.has(table)) {
      throw new Error(`[retentionRegistry] historical source must already be permanent-ledger and not TTL: ${table}`);
    }
    if (meta?.source !== "historical-manual" ||
        typeof meta.owner !== "string" || !meta.owner.trim() ||
        typeof meta.evidence !== "string" || !meta.evidence.trim()) {
      throw new Error(`[retentionRegistry] invalid historical source/owner/evidence: ${table}`);
    }
  }
  return Object.freeze(Object.keys(registry).filter((table) => !Object.hasOwn(historical, table)).sort());
}

/** Derived from the full registry and validated on module load, never a second table inventory. */
export const FRESH_RETENTION_TABLES = buildFreshRetentionTables();

/** Fresh schema rejects unknown physical tables and missing migration-owned tables.
 * Live coverage below deliberately still uses the FULL registry, not this fresh subset.
 */
export function compareFreshRetentionCoverage(dbTables: Iterable<string>): {
  undeclared: string[];
  phantom: string[];
} {
  const physical = new Set(dbTables);
  return {
    undeclared: [...physical].filter((table) => !Object.hasOwn(RETENTION_REGISTRY, table)).sort(),
    phantom: FRESH_RETENTION_TABLES.filter((table) => !physical.has(table)),
  };
}

/**
 * Live-only coverage: public base tables present in `pool` but missing from
 * RETENTION_REGISTRY. Read-only; never DROP/TTL. Handmade live tables such as
 * model_pricing_0903_cw_backup must be claimed as permanent-ledger so this
 * returns []. Timeouts/errors must not be reported as an empty (green) set.
 */
export async function auditLiveRetentionCoverage(
  pool: BoundedReadPool,
  options?: { statementTimeoutMs?: number },
): Promise<{ unregistered: string[] | null; unknown: boolean; reason?: string }> {
  try {
    return await withBoundedReadOnly(pool, options?.statementTimeoutMs ?? 5_000, async (client) => {
      const live = await client.query<{ table_name: string }>(
        `SELECT table_name
           FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      const registered = new Set(Object.keys(RETENTION_REGISTRY));
      const unregistered = live.rows
        .map((row) => row.table_name)
        .filter((name) => !registered.has(name))
        .sort();
      return { unregistered, unknown: false as const };
    });
  } catch (err) {
    return {
      unregistered: null,
      unknown: true,
      reason: isBoundedReadTimeout(err) ? "timeout" : ((err as Error)?.message ?? String(err)),
    };
  }
}
