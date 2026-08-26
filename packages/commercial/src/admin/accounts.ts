/**
 * T-60 — 超管账号池 CRUD 包装层。
 *
 * ### 与 account-pool/store 的分工
 * - store.ts 是底层 CRUD + AEAD 加解密
 * - 本文件只负责 "admin 上下文下触发 store + 落 admin_audit"
 *
 * ### 审计策略(非事务,best-effort)
 * store.ts 的 API 不是 tx-aware(内部用 `query()` 直连 pool),我们不想改它。
 * 因此超管 API 的流程是:
 *   1. 调 store.createAccount / updateAccount / deleteAccount
 *   2. 成功后调 writeAdminAudit(pool)
 *
 * 若 (2) 失败(极少见 — 审计表写入报错),admin 已完成的账号变更不会回滚:
 *   - 主要数据变更不能因为审计表抖动而回退(admin 期望行为已完成)
 *   - 审计失败会走两路上报:
 *     (a) `admin_audit_write_failures_total{action=...}` counter → Prometheus 告警
 *     (b) `ctx.onAuditError`(HTTP 未传 → stderr 兜底)→ 详细错误内容
 *
 * ### 审计内容
 * before/after 只保留 "admin 显式提交的字段"。原因:
 *   - 不把 oauth_expires_at / last_used_at / health_score 等 scheduler 写的字段混入
 *   - 避免密文/nonce Buffer 出现在 audit JSON —— 触发 JSON.stringify 乱码 + 泄密
 *
 * token / refresh 的明文 **永远不进 audit**;只记 `"token": "<redacted>"` 之类占位。
 */

import { getPool } from "../db/index.js";
import { query } from "../db/queries.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import {
  ACCOUNT_PLANS,
  ACCOUNT_PROVIDERS,
  ACCOUNT_STATUSES,
  AccountNotFoundError,
  createAccount as storeCreate,
  deleteAccount as storeDelete,
  getAccount as storeGet,
  listAccounts as storeList,
  updateAccount as storeUpdate,
  type AccountPlan,
  type AccountProvider,
  type AccountRow,
  type AccountStatus,
  type CreateAccountInput,
  type ListAccountsOptions,
  type UpdateAccountPatch,
} from "../account-pool/store.js";
import { normalizeCursorApiKey, scheduleCursorAuthSync } from "../account-pool/cursorMaterializer.js";
import { isCursorQuotaClass, type CursorQuotaClass } from "../account-pool/cursorQuota.js";
import { writeAdminAuditBestEffort as bestEffortAudit } from "./audit.js";
import {
  reassignEgressHost,
} from "../account-pool/egressAssignment.js";
import type { AccountHealthTracker } from "../account-pool/health.js";
import {
  fetchAnthropicAccountUuid,
} from "../account-pool/anthropicProfile.js";
import { getDispatcherForAccount } from "../account-pool/egressDispatcher.js";
import { getEgressProxyUrlPlaintext, getEgressProxyRegion } from "./egressProxies.js";
import {
  getAccountGroup,
  listAccountGroups,
  type AccountGroupRow,
} from "../account-pool/groups.js";

// getPool 已在文件顶部 import,不重复

export interface AdminAuditCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
  /** 可选:审计写失败回调(生产应挂监控)。默认 stderr。 */
  onAuditError?: (err: unknown) => void;
  /**
   * v1.0.120 feat/codex-disable-rebind:codex 账号被 admin 改成 disabled
   * 时主动触发 fanout actor —— 把仍绑该账号的活跃容器 rebind 到新 active 账号。
   *
   * 不在本模块直接 import `enqueueCodexDisableFanout` 是为了避免 admin 包反向
   * 依赖 account-pool 的运行时单例(fanout 依赖 selfHostId / putRemoteCodexAuth
   * 这些只能在 `registerCommercial` 启动期组装的 deps)。改由 index.ts wiring
   * 阶段闭包注入。
   *
   * 未注入 = 静默忽略(测试 / 单进程小型部署),由 acquire / M1 兜底。
   */
  triggerCodexDisableFanout?: (accountId: bigint) => void;
}

// bestEffortAudit 本地实现已收口到 audit.ts writeAdminAuditBestEffort(整改批:
// 五处复制粘贴的失败行为收敛为单一权威,action 收窄为注册表字面量类型)。

/**
 * 给 audit/UI 使用的代理 URL 脱敏:`http://user:****@host:port`。
 * 完整密码绝不进 audit 表(legal/合规)。
 */
export function maskEgressProxy(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const userInfo = u.username
      ? `${u.username}${u.password ? ":****" : ""}@`
      : "";
    const port = u.port ? `:${u.port}` : "";
    return `${u.protocol}//${userInfo}${u.hostname}${port}`;
  } catch {
    return "<invalid>";
  }
}

/** AccountRow 序列化到 audit 安全子集:固定字段,永远不含密文/nonce。 */
function snapshotForAudit(r: AccountRow): Record<string, unknown> {
  return {
    id: r.id.toString(),
    provider: r.provider,
    label: r.label,
    plan: r.plan,
    status: r.status,
    health_score: r.health_score,
    group_id: r.group_id !== null ? r.group_id.toString() : null,
    egress_proxy: maskEgressProxy(r.egress_proxy),
    egress_proxy_id: r.egress_proxy_id !== null ? r.egress_proxy_id.toString() : null,
    cursor_sand_enabled: r.provider === "cursor" ? r.cursor_sand_enabled : null,
  };
}


function isPositiveBigintId(id: unknown): id is string | number | bigint {
  if (typeof id === "bigint") return id > 0n;
  if (typeof id === "number") return Number.isInteger(id) && id > 0;
  if (typeof id === "string") return /^[1-9][0-9]{0,19}$/.test(id);
  return false;
}

function assertAccountGroupCompatible(group: AccountGroupRow, provider: AccountProvider): void {
  if (group.kind === "official_oauth" && group.provider === provider) return;
  throw new RangeError("unsupported_account_group_for_provider");
}

async function resolveDefaultOfficialOAuthGroupId(provider: AccountProvider): Promise<string | null> {
  const groups = await listAccountGroups();
  const g = groups.find((row) => row.kind === "official_oauth" && row.provider === provider);
  return g ? g.id.toString() : null;
}

async function normalizeGroupIdForAccount(
  provider: AccountProvider,
  raw: bigint | string | number | null | undefined,
  opts: { defaultOfficialOAuthGroup?: boolean } = {},
): Promise<string | null | undefined> {
  if (raw === undefined) {
    if (opts.defaultOfficialOAuthGroup === true) return resolveDefaultOfficialOAuthGroupId(provider);
    return undefined;
  }
  if (raw === null || raw === "") return null;
  if (!isPositiveBigintId(raw)) throw new RangeError("invalid_group_id");
  const group = await getAccountGroup(String(raw));
  if (!group) throw new RangeError("group_not_found");
  assertAccountGroupCompatible(group, provider);
  return String(raw);
}

// ─── 查询 ──────────────────────────────────────────────────────────

export async function adminListAccounts(opts: ListAccountsOptions = {}): Promise<AccountRow[]> {
  return storeList(opts);
}

export async function adminGetAccount(id: bigint | string): Promise<AccountRow | null> {
  return storeGet(id);
}

// ─── Create ────────────────────────────────────────────────────────

export interface AdminCreateAccountInput {
  /**
   * V3 provider(默认 'claude' 与 v2 行为一致)。
   * provider='codex' / 'grok' 必须有 oauth_refresh_token。
   */
  provider?: AccountProvider;
  label: string;
  plan: AccountPlan;
  oauth_token: string;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: Date | string | null;
  oauth_principal_type?: string | null;
  oauth_principal_id?: string | null;
  /**
   * 0064 — Anthropic 订阅周期到期日(可选,管理员手填)。
   *   - undefined / null → 不设置(列保持 NULL,scheduler 按中性 1.0 对待)
   *   - Date / ISO string → 解析后写入
   */
  subscription_end_at?: Date | string | null;
  /**
   * 0055 — claude/codex/grok 必填代理池 entry id。
   * provider='cursor' 走容器内 CLI 直连,允许省略。
   */
  egress_proxy_id?: bigint | string | null;
  /** Optional V1 account group binding. Claude accounts default to the first official OAuth group. */
  group_id?: bigint | string | null;
  cursor_sand_enabled?: boolean;
  cursor_quota_class?: CursorQuotaClass;
}

/**
 * 0055 — 代理池 entry 存在性预检。FK 23503 在 PG 层会变 500,提前 SELECT 给 400。
 * 不校验 status='active' / 不校验 url_enc 完整性 — 仅存在性。
 */
async function ensureEgressProxyExistsOrThrow(id: string): Promise<void> {
  const r = await getPool().query<{ id: string }>(
    `SELECT id::text AS id FROM egress_proxies WHERE id = $1::bigint`,
    [id],
  );
  if (r.rowCount === 0) throw new RangeError("invalid_egress_proxy_id_not_found");
}

/**
 * 0070 — 新建 claude 账号专用:同步获取 Anthropic OAuth account UUID。
 *
 * 1. 解密 egress proxy URL(同 status='active' 校验,disabled → 抛)
 * 2. 通过 `getDispatcherForAccount` 构造 dispatcher(sentinel id 不污染真实账号 cache)
 * 3. 调 helper 拿 uuid;失败抛 `RangeError(uuid_fetch_failed:${kind})`
 *
 * 为什么不复用 backfill 脚本的 fetchAccountUuid:
 *   - backfill 用真实 accountId 走真实 cache,本路径账号还没 INSERT,没 accountId
 *   - backfill 接受 fail-soft(返 outcome),本路径必须 fail-hard(否则 INSERT 会留 NULL)
 *
 * `retryOnTransient=true`:network/5xx 给 1 次重试(Anthropic 偶发抖动 vs admin
 * 直接看到 500);token_invalid/4xx/bad_shape 不重试,语义上没指望。
 */
async function fetchAccountUuidForCreate(
  oauthToken: string,
  egressProxyId: string,
): Promise<string> {
  // status='active' 才返 URL,disabled/不存在 → null;这里 ensureEgressProxyExistsOrThrow
  // 已确认存在,null 只可能是 disabled。
  const proxyUrl = await getEgressProxyUrlPlaintext(egressProxyId);
  if (proxyUrl === null) {
    throw new RangeError("egress_proxy_not_active");
  }
  const dispatcher = await getDispatcherForAccount(
    `admin-create:${egressProxyId}`,
    proxyUrl,
    null,
  );
  if (dispatcher === undefined) {
    // egressDispatcher 已 log warn(URL 解析挂);admin 路径不能 fall back 到默认
    // 出口(会造成 profile/chat IP 分叉),直接 400。
    throw new RangeError("egress_proxy_invalid");
  }
  const r = await fetchAnthropicAccountUuid(oauthToken, dispatcher, {
    retryOnTransient: true,
  });
  if (r.kind !== "ok") {
    // detail 已脱敏但不外露(避免泄露内部 kind 细节给 admin UI 之外的层);
    // 仅 kind 上 UI:token_invalid / http_4xx / http_5xx / network / bad_shape。
    throw new RangeError(`uuid_fetch_failed:${r.kind}`);
  }
  return r.uuid;
}

/**
 * 0070 — 判断 pg error 是否为 account_uuid 唯一索引冲突。
 *
 * unique partial index `idx_ca_account_uuid_uq`(0070 migration)在 admin 重复
 * 录入同一 Anthropic 账号时报 23505。本函数不读 message(可能含 uuid 明文),
 * 仅靠 code + constraint name 判断,避免日志/异常路径泄露 uuid。
 */
function isAccountUuidUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown };
  if (e.code !== "23505") return false;
  // pg driver 在 unique index 冲突时把 index 名放 constraint
  return typeof e.constraint === "string" && e.constraint === "idx_ca_account_uuid_uq";
}

/**
 * 反封 #1 — 判断是否命中"claude 一号一代理"唯一索引(0250
 * idx_claude_accounts_egress_proxy_uniq)。命中 = 该住宅代理已被另一个 claude 账号占用。
 */
function isEgressProxyUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return (
    e.code === "23505" &&
    typeof e.constraint === "string" &&
    e.constraint === "idx_claude_accounts_egress_proxy_uniq"
  );
}

/**
 * 反封 #1 — claude 一号一代理预检:同一 egress_proxy_id 已绑其它 active/非删除
 * 的 claude 账号时,给出友好错误(DB 唯一索引是最终兜底,这里是提前拦 + 明确报错)。
 */
async function ensureEgressProxyNotBoundToOtherClaude(proxyId: string): Promise<void> {
  const r = await getPool().query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM claude_accounts
      WHERE provider = 'claude' AND egress_proxy_id = $1::bigint`,
    [proxyId],
  );
  if (r.rows[0] && r.rows[0].c !== "0") {
    throw new RangeError("egress_proxy_already_bound_to_claude");
  }
}

export async function adminCreateAccount(
  input: AdminCreateAccountInput,
  ctx: AdminAuditCtx,
): Promise<AccountRow> {
  const provider: AccountProvider = input.provider ?? "claude";
  if (!ACCOUNT_PROVIDERS.includes(provider)) throw new RangeError("invalid_provider");
  if (!ACCOUNT_PLANS.includes(input.plan)) throw new RangeError("invalid_plan");
  if (typeof input.label !== "string" || input.label.trim().length === 0 || input.label.length > 120) {
    throw new RangeError("invalid_label");
  }
  if (typeof input.oauth_token !== "string" || input.oauth_token.length === 0) {
    throw new RangeError("invalid_oauth_token");
  }
  const oauthToken = provider === "cursor" ? normalizeCursorApiKey(input.oauth_token) : input.oauth_token;
  let expiresAt: Date | null = null;
  if (input.oauth_expires_at !== undefined && input.oauth_expires_at !== null) {
    const d = typeof input.oauth_expires_at === "string"
      ? new Date(input.oauth_expires_at)
      : input.oauth_expires_at;
    if (Number.isNaN(d.getTime())) throw new RangeError("invalid_oauth_expires_at");
    expiresAt = d;
  }
  let subscriptionEndAt: Date | null = null;
  if (input.subscription_end_at !== undefined && input.subscription_end_at !== null) {
    const d = typeof input.subscription_end_at === "string"
      ? new Date(input.subscription_end_at)
      : input.subscription_end_at;
    if (Number.isNaN(d.getTime())) throw new RangeError("invalid_subscription_end_at");
    subscriptionEndAt = d;
  }
  const refresh =
    input.oauth_refresh_token === null || input.oauth_refresh_token === undefined
      ? null
      : input.oauth_refresh_token;
  if (refresh !== null && (typeof refresh !== "string" || refresh.length === 0)) {
    throw new RangeError("invalid_oauth_refresh_token");
  }
  // Official OAuth account pools must be able to rotate short-lived access tokens.
  if ((provider === "codex" || provider === "grok") && refresh === null) {
    throw new RangeError(`${provider}_account_requires_refresh_token`);
  }
  const principalType = input.oauth_principal_type ?? null;
  const principalId = input.oauth_principal_id ?? null;
  if (
    (principalType !== null || principalId !== null) &&
    (
      provider !== "grok" ||
      typeof principalType !== "string" || principalType.length === 0 ||
      typeof principalId !== "string" || principalId.length === 0
    )
  ) {
    throw new RangeError("invalid_oauth_principal");
  }
  let egressProxyId: string | null = null;
  if (provider !== "cursor") {
    if (input.egress_proxy_id === undefined || input.egress_proxy_id === null) {
      throw new RangeError("invalid_egress_proxy_id_missing");
    }
    egressProxyId = String(input.egress_proxy_id);
    if (!/^[1-9][0-9]{0,19}$/.test(egressProxyId)) {
      throw new RangeError("invalid_egress_proxy_id");
    }
    await ensureEgressProxyExistsOrThrow(egressProxyId);
    // 反封 #1 — claude 一号一代理:同一住宅代理不得被多个 claude 账号共用。
    if (provider === "claude") {
      await ensureEgressProxyNotBoundToOtherClaude(egressProxyId);
    }
  }

  // 反封 #1 — 出口代理地域驱动 persona:读代理 region(可空),建号时传给 store
  // 让 accept_language/timezone 与代理国一致。非 claude / 未设 region → null(随机)。
  const personaRegion =
    provider === "claude" && egressProxyId !== null
      ? await getEgressProxyRegion(egressProxyId)
      : null;

  const normalizedGroupId = await normalizeGroupIdForAccount(provider, input.group_id, { defaultOfficialOAuthGroup: true });

  // 0070 — Phase 6 fail_closed 根治:provider='claude' 新建必须同步获取 Anthropic
  // OAuth account UUID,作为 scheduler 候选锚点。否则 NULL 行被静默剔除
  // (2026-05 P1 复现 ×2:账号 14、47)。
  //
  // 设计:
  //   - profile fetch 走账号未来的 plain proxy(避免"先默认出口验 profile + 之后
  //     sticky proxy 跑 chat"的 IP 漂移痕迹)
  //   - sentinel accountId `admin-create:${proxyId}` 复用 dispatcher cache,
  //     不污染真实账号 cache 空间
  //   - retryOnTransient=true 给 1 次 network/5xx 重试
  //   - 任一错误 → RangeError(`uuid_fetch_failed:${kind}`) 让 admin UI 区分
  //     "token 输入错"(token_invalid) vs "Anthropic 抖动"(http_5xx/network)
  //   - codex 跳过(Phase 6 hook 只盯 claude;backfill 脚本同语义)
  let accountUuid: string | null = null;
  if (provider === "claude") {
    accountUuid = await fetchAccountUuidForCreate(input.oauth_token, String(egressProxyId));
  }

  const createInput: CreateAccountInput = {
    provider,
    label: input.label.trim(),
    plan: input.plan,
    token: oauthToken,
    refresh,
    expires_at: expiresAt,
    subscription_end_at: subscriptionEndAt,
    egress_proxy_id: egressProxyId,
    account_uuid: accountUuid,
    persona_region: personaRegion,
    group_id: normalizedGroupId ?? null,
    // 0098(P0-2)—— 本实例建号一律归本实例 channel(v5 实例 admin 建/导入
    // codex 账号强制 runtime_channel='v5';v3 实例落 'v3',与 DB DEFAULT 同值,
    // 现网零变化)。跨 channel 迁移是显式 admin 操作,不在 create 面。
    runtime_channel: getRuntimeChannel(),
    oauth_principal_type: principalType,
    oauth_principal_id: principalId,
    cursor_sand_enabled: input.cursor_sand_enabled === true,
  };
  let row: AccountRow;
  try {
    row = await storeCreate(createInput);
  } catch (err) {
    // 0070 unique partial index `idx_ca_account_uuid_uq` 命中 → admin 重复录入
    // 同一 Anthropic 账号。转 RangeError 让 HTTP 层返 400 而非 500。
    if (isAccountUuidUniqueViolation(err)) {
      throw new RangeError("account_uuid_already_exists");
    }
    // 反封 #1 — 一号一代理唯一索引兜底(预检与 INSERT 之间的并发窗口)。
    if (isEgressProxyUniqueViolation(err)) {
      throw new RangeError("egress_proxy_already_bound_to_claude");
    }
    throw err;
  }

  // 0055:account 必有 egress_proxy_id 池引用,运行时优先用池 URL,host 字段已无意义。
  // 不再在 create 路径自动分配 egress_host_uuid(0038 路径退化为 admin 手动 patch 触发)。

  await bestEffortAudit(
    ctx,
    "account.create",
    `account:${row.id}`,
    null,
    {
      ...snapshotForAudit(row),
      has_refresh_token: refresh !== null,
      // 不记明文 token / proxy 密码 —— snapshotForAudit 已 mask
    },
  );
  if (row.provider === "cursor") scheduleCursorAuthSync("account.create");
  return row;
}

// ─── Patch ────────────────────────────────────────────────────────

export interface AdminPatchAccountInput {
  /**
   * provider 不可改 — admin layer 显式拒绝(决策 R);store 层 UpdateAccountPatch
   * 也未把 provider 列暴露,本字段仅用于让 HTTP 早期 reject。
   */
  provider?: never;
  label?: string;
  plan?: AccountPlan;
  status?: AccountStatus;
  health_score?: number;
  oauth_token?: string;
  oauth_refresh_token?: string | null;
  oauth_expires_at?: Date | string | null;
  /**
   * 0064 — 订阅周期到期日。
   *   - undefined → 不动
   *   - Date / ISO string → 解析后写入
   *   - null → 显式清空
   */
  subscription_end_at?: Date | string | null;
  /**
   * 0055 — undefined = 不动;bigint/string = 换池 entry id。
   * 不接受 null:CHECK constraint 要求账号生命周期内 egress_proxy_id 永远 NOT NULL。
   * raw `egress_proxy` 文本字段已不再支持(由 0055 锁死为 NULL)。
   */
  egress_proxy_id?: bigint | string;
  /** Optional group binding. undefined = no change; null = unassign. */
  group_id?: bigint | string | null;
  /**
   * 0038 — 重新分配 egress host。
   *   - undefined = 不动
   *   - null = 清空(账号 egress 由 dispatcher 决定:plain proxy > egress_target mTLS > master)
   *   - "auto" = 走 pickAndAssignEgressHost(选最少账号的合格 host)
   *   - "<uuid>" = 直接绑该 host(校验必须 ready+endpoint+cert+psk 齐全)
   */
  egress_host_uuid?: string | null;
  cursor_sand_enabled?: boolean;
  cursor_quota_class?: CursorQuotaClass;
}

export async function adminPatchAccount(
  id: bigint | string,
  patch: AdminPatchAccountInput,
  ctx: AdminAuditCtx,
): Promise<AccountRow> {
  // 前置校验
  if (patch.cursor_quota_class !== undefined && !isCursorQuotaClass(patch.cursor_quota_class)) {
    throw new RangeError("invalid_cursor_quota_class");
  }
  if (patch.plan !== undefined && !ACCOUNT_PLANS.includes(patch.plan)) {
    throw new RangeError("invalid_plan");
  }
  if (patch.status !== undefined && !ACCOUNT_STATUSES.includes(patch.status)) {
    throw new RangeError("invalid_status");
  }
  if (patch.health_score !== undefined) {
    if (!Number.isInteger(patch.health_score) || patch.health_score < 0 || patch.health_score > 100) {
      throw new RangeError("invalid_health_score");
    }
  }
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || patch.label.trim().length === 0 || patch.label.length > 120) {
      throw new RangeError("invalid_label");
    }
  }
  if (patch.oauth_token !== undefined) {
    if (typeof patch.oauth_token !== "string" || patch.oauth_token.length === 0) {
      throw new RangeError("invalid_oauth_token");
    }
  }
  if (patch.oauth_refresh_token !== undefined && patch.oauth_refresh_token !== null) {
    if (typeof patch.oauth_refresh_token !== "string" || patch.oauth_refresh_token.length === 0) {
      throw new RangeError("invalid_oauth_refresh_token");
    }
  }
  let normalizedEgressProxyId: string | undefined = undefined;
  if (patch.egress_proxy_id !== undefined) {
    // 0055:NULL 不再接受(CHECK constraint + 生命周期强约束)。
    // 类型已锁,这里 runtime 兜底防 JS 调用方绕过 TS。
    if (patch.egress_proxy_id === null) {
      throw new RangeError("invalid_egress_proxy_id_unset");
    }
    const s = String(patch.egress_proxy_id);
    if (!/^[1-9][0-9]{0,19}$/.test(s)) {
      throw new RangeError("invalid_egress_proxy_id");
    }
    // 存在性预检 — 不存在的 FK 在 store 层会冒成 23503 → 500。
    await ensureEgressProxyExistsOrThrow(s);
    normalizedEgressProxyId = s;
  }
  if (patch.egress_host_uuid !== undefined && patch.egress_host_uuid !== null) {
    if (typeof patch.egress_host_uuid !== "string" || patch.egress_host_uuid.length === 0) {
      throw new RangeError("invalid_egress_host_uuid");
    }
    // "auto" 不验,reassignEgressHost 处理;UUID 形态走宽松正则
    if (
      patch.egress_host_uuid !== "auto" &&
      !/^[0-9a-fA-F-]{36}$/.test(patch.egress_host_uuid)
    ) {
      throw new RangeError("invalid_egress_host_uuid");
    }
    // 显式 UUID 必须 eligible(ready + endpoint + cert + psk)。预校验避免 storeUpdate
    // 跑完后再因 reassignEgressHost throw 导致半写(label/token 已落库 + egress 没改)。
    // 'auto' 不预校验:pickAndAssign 不抛,只可能返 null(无合格 host)。
    // null 不预校验:仅清空,不查 host 表。
    if (
      patch.egress_host_uuid !== "auto" &&
      patch.egress_host_uuid !== null
    ) {
      const r = await getPool().query<{ id: string }>(
        `SELECT id FROM compute_hosts
          WHERE id = $1
            AND status = 'ready'
            AND egress_proxy_endpoint IS NOT NULL
            AND agent_cert_fingerprint_sha256 IS NOT NULL
            AND octet_length(agent_psk_nonce) > 0
            AND octet_length(agent_psk_ct)    > 0
          LIMIT 1`,
        [patch.egress_host_uuid],
      );
      if (r.rowCount === 0) {
        throw new RangeError("egress_host_not_eligible");
      }
    }
  }
  let expiresAt: Date | null | undefined = undefined;
  if (patch.oauth_expires_at !== undefined) {
    if (patch.oauth_expires_at === null) {
      expiresAt = null;
    } else {
      const d = typeof patch.oauth_expires_at === "string"
        ? new Date(patch.oauth_expires_at)
        : patch.oauth_expires_at;
      if (Number.isNaN(d.getTime())) throw new RangeError("invalid_oauth_expires_at");
      expiresAt = d;
    }
  }
  let subscriptionEndAt: Date | null | undefined = undefined;
  if (patch.subscription_end_at !== undefined) {
    if (patch.subscription_end_at === null) {
      subscriptionEndAt = null;
    } else {
      const d = typeof patch.subscription_end_at === "string"
        ? new Date(patch.subscription_end_at)
        : patch.subscription_end_at;
      if (Number.isNaN(d.getTime())) throw new RangeError("invalid_subscription_end_at");
      subscriptionEndAt = d;
    }
  }

  const touched =
    patch.label !== undefined ||
    patch.plan !== undefined ||
    patch.status !== undefined ||
    patch.health_score !== undefined ||
    patch.oauth_token !== undefined ||
    patch.oauth_refresh_token !== undefined ||
    patch.egress_proxy_id !== undefined ||
    patch.group_id !== undefined ||
    patch.egress_host_uuid !== undefined ||
    patch.cursor_sand_enabled !== undefined ||
    patch.cursor_quota_class !== undefined ||
    expiresAt !== undefined ||
    subscriptionEndAt !== undefined;
  if (!touched) {
    const cur = await storeGet(id);
    if (!cur) throw new AccountNotFoundError(id);
    return cur;
  }

  const before = await storeGet(id);
  if (!before) throw new AccountNotFoundError(id);

  const normalizedPatchGroupId = await normalizeGroupIdForAccount(before.provider, patch.group_id);

  const storePatch: UpdateAccountPatch = {};
  if (patch.label !== undefined) storePatch.label = patch.label.trim();
  if (patch.plan !== undefined) storePatch.plan = patch.plan;
  if (patch.status !== undefined) storePatch.status = patch.status;
  if (patch.health_score !== undefined) storePatch.health_score = patch.health_score;
  if (patch.oauth_token !== undefined) {
    storePatch.token = before.provider === "cursor" ? normalizeCursorApiKey(patch.oauth_token) : patch.oauth_token;
  }
  if (patch.oauth_refresh_token !== undefined) storePatch.refresh = patch.oauth_refresh_token;
  if (normalizedEgressProxyId !== undefined) storePatch.egress_proxy_id = normalizedEgressProxyId;
  if (normalizedPatchGroupId !== undefined) storePatch.group_id = normalizedPatchGroupId;
  if (expiresAt !== undefined) storePatch.oauth_expires_at = expiresAt;
  if (subscriptionEndAt !== undefined) storePatch.subscription_end_at = subscriptionEndAt;
  if (patch.cursor_sand_enabled !== undefined) storePatch.cursor_sand_enabled = patch.cursor_sand_enabled;
  if (patch.cursor_quota_class !== undefined) storePatch.cursor_quota_class = patch.cursor_quota_class;

  let after: AccountRow | null;
  try {
    after = await storeUpdate(id, storePatch);
  } catch (err) {
    // 反封 #1 — reassign 到已被其它 claude 账号占用的代理 → 一号一代理唯一索引 23505。
    if (isEgressProxyUniqueViolation(err)) {
      throw new RangeError("egress_proxy_already_bound_to_claude");
    }
    throw err;
  }
  if (!after) throw new AccountNotFoundError(id);

  // v1.0.120 feat/codex-disable-rebind:status active→disabled 且 provider='codex'
  // → 触发 fanout actor 把绑该账号的容器 rebind。
  //
  // 触发条件刻意收紧到 active→disabled(非 disabled→任意 / cooldown→disabled 等):
  //   - active→disabled 是"用户主动停用"的语义信号,需要主动 fanout
  //   - cooldown/banned→disabled 不需要(账号本来就不可用,acquire/M1 已在兜底)
  //   - 重复 disabled→disabled 不触发(idempotent 保护)
  //
  // 仅 codex provider —— claude 账号 disable 后 anthropic 直连路径有自己的 retry
  // + scheduler 重选机制,不需要主动 fanout。
  //
  // ctx.triggerCodexDisableFanout 未注入(单测 / 早期 boot)→ 静默 skip。
  if (
    after.provider === "codex"
    && patch.status === "disabled"
    && before.status === "active"
    && ctx.triggerCodexDisableFanout !== undefined
  ) {
    try {
      ctx.triggerCodexDisableFanout(after.id);
    } catch (err) {
      // 严格 fire-and-forget — 触发失败不能影响 admin patch 主流程
      // eslint-disable-next-line no-console
      console.warn("[admin/accounts] triggerCodexDisableFanout threw:", err);
    }
  }

  // 0038 — egress_host_uuid 在 storeUpdate 之后(独立 SQL 不进 store.ts patch 路径)。
  // 显式 UUID 的 eligibility 已在前文预校验,此处只剩极低概率 race(校验后 host
  // 变 broken)。race 时 reassignEgressHost 抛 RangeError,admin 看到 4xx,
  // 此时 storeUpdate 已落库 → 半写,但 admin 知道 egress 没改,可手动 retry;
  // 这比为 race window 加事务更轻(见 KISS)。
  let egressHostBefore: string | null | undefined;
  let egressHostAfter: string | null | undefined;
  if (patch.egress_host_uuid !== undefined) {
    // 用 raw SQL 取 before(store 不暴露此列;不为它加方法,见 KISS)
    const beforeRow = await getPool().query<{ egress_host_uuid: string | null }>(
      `SELECT egress_host_uuid FROM claude_accounts WHERE id = $1`,
      [String(id)],
    );
    egressHostBefore = beforeRow.rowCount === 0 ? null : beforeRow.rows[0]!.egress_host_uuid;
    egressHostAfter = await reassignEgressHost(id, patch.egress_host_uuid);
  }

  // audit: 只记 admin 显式改的字段,密文字段只记 "*_changed" 布尔
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  if (patch.label !== undefined) { changedBefore.label = before.label; changedAfter.label = after.label; }
  if (patch.plan !== undefined) { changedBefore.plan = before.plan; changedAfter.plan = after.plan; }
  if (patch.status !== undefined) { changedBefore.status = before.status; changedAfter.status = after.status; }
  if (patch.health_score !== undefined) {
    changedBefore.health_score = before.health_score;
    changedAfter.health_score = after.health_score;
  }
  if (patch.oauth_token !== undefined) {
    changedBefore.oauth_token_changed = true;
    changedAfter.oauth_token_changed = true;
  }
  if (patch.oauth_refresh_token !== undefined) {
    changedBefore.oauth_refresh_token_changed = true;
    changedAfter.oauth_refresh_token = patch.oauth_refresh_token === null ? "<cleared>" : "<rotated>";
  }
  if (expiresAt !== undefined) {
    changedBefore.oauth_expires_at = before.oauth_expires_at?.toISOString() ?? null;
    changedAfter.oauth_expires_at = after.oauth_expires_at?.toISOString() ?? null;
  }
  if (subscriptionEndAt !== undefined) {
    changedBefore.subscription_end_at = before.subscription_end_at?.toISOString() ?? null;
    changedAfter.subscription_end_at = after.subscription_end_at?.toISOString() ?? null;
  }
  if (patch.egress_proxy_id !== undefined) {
    changedBefore.egress_proxy_id = before.egress_proxy_id !== null ? before.egress_proxy_id.toString() : null;
    changedAfter.egress_proxy_id = after.egress_proxy_id !== null ? after.egress_proxy_id.toString() : null;
  }
  if (patch.group_id !== undefined) {
    changedBefore.group_id = before.group_id !== null ? before.group_id.toString() : null;
    changedAfter.group_id = after.group_id !== null ? after.group_id.toString() : null;
  }
  if (patch.egress_host_uuid !== undefined) {
    changedBefore.egress_host_uuid = egressHostBefore ?? null;
    changedAfter.egress_host_uuid = egressHostAfter ?? null;
  }
  if (patch.cursor_sand_enabled !== undefined && before.cursor_sand_enabled !== after.cursor_sand_enabled) {
    changedBefore.cursor_sand_enabled = before.cursor_sand_enabled;
    changedAfter.cursor_sand_enabled = after.cursor_sand_enabled;
  }
  if (patch.cursor_quota_class !== undefined && before.cursor_quota_class !== after.cursor_quota_class) {
    changedBefore.cursor_quota_class = before.cursor_quota_class;
    changedAfter.cursor_quota_class = after.cursor_quota_class;
  }

  await bestEffortAudit(ctx, "account.patch", `account:${String(id)}`, changedBefore, changedAfter);
  if (after.provider === "cursor") scheduleCursorAuthSync("account.patch");
  return after;
}

// ─── Reset cooldown ───────────────────────────────────────────────
//
// R3:accounts tab 快捷动作。语义"释放冷却",目标:让 scheduler 下一轮能重新
// 选到这个账号。
//
// 历史 bug(2026-05-06):旧版只清 `cooldown_until` + `last_error`,**故意不动
// status**(担心覆盖人工 disabled 的账号)。但这造成了 `status='cooldown' ∧
// cooldown_until=NULL` 的不可恢复中间态 —— halfOpen 的 SQL 有 `cooldown_until
// IS NOT NULL` 守卫,永远扫不到这种行,scheduler 又只选 `status='active'`,
// 账号永久卡死。
//
// 修复:**只在 status='cooldown' 时,把 status 一并恢复成 active**,通过
// `health.recoverFromCooldown(id)` 复用 halfOpen 同款语义(active+health=50,
// Redis healthKey=50+failKey 清)。disabled / banned / 已是 active 的账号原样
// 保留 status,只清 cooldown_until + last_error —— 守住"不偷偷救人工 disabled"
// 的原意,同时关掉永久卡死路径。
//
// 审计:action='account.reset_cooldown',before/after 只记**实际改了的**字段
// (cooldown_until / last_error 总是带,status / health_score 仅在 cooldown 分支带)。
export async function adminResetCooldown(
  id: bigint | string,
  ctx: AdminAuditCtx,
  health: AccountHealthTracker,
): Promise<AccountRow> {
  const before = await storeGet(id);
  if (!before) throw new AccountNotFoundError(id);

  let after: AccountRow | null;
  if (before.status === "cooldown") {
    // recoverFromCooldown 内部已 SET status='active' + health_score=50 +
    // cooldown_until=NULL + 写 Redis;再补一发 storeUpdate 单清 last_error
    // (recoverFromCooldown 不动 last_error,语义更纯)。
    const recovered = await health.recoverFromCooldown(id);
    if (!recovered) {
      // 极少:before/recover 之间状态被改,例如另一管理员同时 patch 成 disabled。
      // 退回原"只清两字段"路径,保留对方变更;语义=幂等。
      after = await storeUpdate(id, { cooldown_until: null, last_error: null });
    } else {
      after = await storeUpdate(id, { last_error: null });
    }
  } else {
    after = await storeUpdate(id, { cooldown_until: null, last_error: null });
  }
  if (!after) throw new AccountNotFoundError(id);

  const auditBefore: Record<string, unknown> = {
    cooldown_until: before.cooldown_until?.toISOString() ?? null,
    last_error: before.last_error,
  };
  const auditAfter: Record<string, unknown> = {
    cooldown_until: null,
    last_error: null,
  };
  if (before.status !== after.status) {
    auditBefore.status = before.status;
    auditAfter.status = after.status;
  }
  if (before.health_score !== after.health_score) {
    auditBefore.health_score = before.health_score;
    auditAfter.health_score = after.health_score;
  }
  if (before.cursor_quota_class !== after.cursor_quota_class) {
    auditBefore.cursor_quota_class = before.cursor_quota_class;
    auditAfter.cursor_quota_class = after.cursor_quota_class;
  }

  await bestEffortAudit(
    ctx,
    "account.reset_cooldown",
    `account:${String(id)}`,
    auditBefore,
    auditAfter,
  );
  if (after.provider === "cursor") scheduleCursorAuthSync("account.reset_cooldown");
  return after;
}

// ─── Delete ──────────────────────────────────────────────────────

/**
 * 删除被 active per-container codex 容器引用的 codex 账号会让容器进无法访问的
 * 死状态(plan v3 决策 B / migration 0054 RESTRICT 兜底说明)。
 * adminDeleteAccount 抛此 Error 时,HTTP 应返 409。
 */
export class AccountHasActiveCodexBindingsError extends Error {
  readonly code = "ACCOUNT_HAS_ACTIVE_CODEX_BINDINGS";
  readonly active_binding_count: number;
  constructor(active_binding_count: number) {
    super(`codex account has ${active_binding_count} active container binding(s); cannot delete`);
    this.name = "AccountHasActiveCodexBindingsError";
    this.active_binding_count = active_binding_count;
  }
}

/**
 * Force-cascade: codex 账号 stopped/vanished 容器仍在 agent_containers 表里
 * 持有 codex_account_id FK(因 RESTRICT FK,直接 DELETE 会 23503)。
 * force=true 时本函数先把它们的 codex_account_id 置 NULL,再 DELETE。
 *
 * **永不 cascade-clear active 容器**:active row 上的 NULL = mount 错位,后续
 * GPT 请求容器内 codex CLI 找不到 auth → 静默坏。Active count > 0 时仍抛
 * AccountHasActiveCodexBindingsError;admin 必须先 disable + 等容器 stop。
 */
export async function adminDeleteAccount(
  id: bigint | string,
  ctx: AdminAuditCtx,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  const before = await storeGet(id);
  if (!before) return false;

  // 决策 B + migration 0054:codex 账号若有 active 容器绑定,先返 409 阻止
  if (before.provider === "codex") {
    // P1d 防御:删 codex 账号的绑定计数 + force 清绑都按本实例 channel —— 否则 v3 admin 删账号
    // 会被 v5 active 绑定阻塞、force 还会清掉 v5 非 active 行的 codex_account_id(跨 channel 变更)。
    const activeCount = await query<{ c: string }>(
      `SELECT COUNT(*)::text AS c
       FROM agent_containers
       WHERE codex_account_id = $1 AND state = 'active' AND runtime_channel = $2`,
      [String(id), getRuntimeChannel()],
    );
    const n = Number(activeCount.rows[0]?.c ?? "0");
    if (n > 0) {
      throw new AccountHasActiveCodexBindingsError(n);
    }
    // force=true:把 stopped/vanished 容器的 codex_account_id 置 NULL,
    // 让 RESTRICT FK 不再阻挡 DELETE。
    if (opts.force === true) {
      await query(
        `UPDATE agent_containers
         SET codex_account_id = NULL
         WHERE codex_account_id = $1 AND state <> 'active' AND runtime_channel = $2`,
        [String(id), getRuntimeChannel()],
      );
    }
  }

  const deleted = await storeDelete(id);
  if (!deleted) return false;

  await bestEffortAudit(
    ctx,
    "account.delete",
    `account:${String(id)}`,
    snapshotForAudit(before),
    null,
  );
  if (before.provider === "cursor") scheduleCursorAuthSync("account.delete");
  return true;
}

// ─── Recent users (cross-tab deeplink) ─────────────────────────────

export interface AccountRecentUserView {
  user_id: string;
  email: string | null;
  request_count: number;
  last_used_at: string;
}

/**
 * 列出最近 `hours` 小时内"使用过这个账号"的用户(按请求量倒序)。
 *
 * 走 idx_ur_account (account_id, created_at DESC)(0002 建)。
 * COUNT(*) 在 PG 是 int8 — node-pg 默认转字符串,这里 ::int 强制返回 number,
 * 避免前端 `=== 0` 严格比较失效。
 */
export async function getAccountRecentUsers(
  accountId: bigint | string,
  hours = 24,
  limit = 20,
): Promise<AccountRecentUserView[]> {
  const id = typeof accountId === "bigint" ? accountId.toString() : accountId;
  if (!/^[1-9][0-9]{0,19}$/.test(id)) {
    throw new RangeError("invalid_account_id");
  }
  const h = Number.isInteger(hours) && hours > 0 && hours <= 24 * 30 ? hours : 24;
  const lim = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 20;
  const r = await query<{
    user_id: string;
    email: string | null;
    request_count: number;
    last_used_at: Date;
  }>(
    `SELECT u.id::text AS user_id,
            u.email,
            COUNT(*)::int AS request_count,
            MAX(ur.created_at) AS last_used_at
       FROM usage_records ur
       JOIN users u ON u.id = ur.user_id
      WHERE ur.account_id = $1::bigint
        AND ur.created_at > NOW() - ($2::int || ' hours')::interval
   GROUP BY u.id, u.email
   ORDER BY request_count DESC
      LIMIT $3::int`,
    [id, h, lim],
  );
  return r.rows.map((row) => ({
    user_id: row.user_id,
    email: row.email,
    request_count: Number(row.request_count),
    last_used_at: row.last_used_at.toISOString(),
  }));
}
