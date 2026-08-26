/**
 * T-30 — Claude 账号池存储层。
 *
 * 职责:
 *   - `createAccount` / `updateAccount` / `deleteAccount` — 管理 claude_accounts 行
 *   - `getTokenForUse(id)` — 读取并解密 OAuth token(仅在发请求瞬间调用)
 *   - `listAccounts` / `getAccount` — 查询元信息(**永远不返回 token 明文 / 密文**)
 *
 * 加密规约(见 03-DATA-MODEL §7, 05-SECURITY §10 §12):
 *   - access_token / refresh_token 使用 AES-256-GCM 加密,每条记录独立 12B nonce
 *   - 密文 + nonce 分别存于 `oauth_token_enc` / `oauth_nonce`(refresh 同理)
 *   - KMS key 每次调用新加载 Buffer,函数结束 `.fill(0)` 清零,不做进程级缓存
 *   - 解密失败(AeadError)直接透传给调用方 —— 调用方应视为「账号损坏」
 *
 * 运行时规约:
 *   - 所有返回 "列表" / "摘要" 的 API(listAccounts / getAccount)不查询任何 *_enc 列
 *     → 即便内存 dump / log 误打印都不会泄露密文
 *   - 只有 `getTokenForUse` 会读 *_enc 列并解密
 *   - 明文 Buffer 返回给调用方,调用方负责 `.fill(0)` 清零(见 docs T-30 Acceptance)
 *
 * 与 T-31/T-32 的边界:
 *   - 本模块不管健康度(那是 T-31 health.ts 的事)
 *   - 本模块不做调度(那是 T-32 scheduler.ts 的事)
 *   - 本模块只管 CRUD + 加密/解密
 */

import type { PoolClient, QueryResultRow } from "pg";
import { getPool } from "../db/index.js";
import { query, tx } from "../db/queries.js";
import { encrypt, decryptToBuffer, AeadError } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";
import type { RuntimeChannel } from "../runtimeChannel.js";
import { generatePersona, assertPersona } from "./persona.js";

/** 0098 — runtime_channel 合法值(与 migration CHECK IN ('v3','v5') 同源)。 */
const RUNTIME_CHANNELS: readonly RuntimeChannel[] = ["v3", "v5"];

export const ACCOUNT_PLANS = ["pro", "max", "team"] as const;
export type AccountPlan = (typeof ACCOUNT_PLANS)[number];

export const ACCOUNT_STATUSES = ["active", "cooldown", "disabled", "banned"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

/**
 * V3 account provider — claude (claude.ai OAuth) or codex (auth.openai.com OAuth).
 *
 * 决定 OAuth 流程、scheduler 分区、容器内 auth 写法。`provider` 在 create 后
 * 不可改(admin layer 拒 PATCH provider,见 decision R)。
 *
 * 默认值('claude'):
 *   - 存量 claude_accounts 行通过 0051 migration DEFAULT 自动 backfill
 *   - 所有不传 provider 的调用方(scheduler.pick / listAccounts / createAccount)
 *     默认按 'claude' 走,与 v2 行为一致
 */
export const ACCOUNT_PROVIDERS = ["claude", "codex", "grok", "cursor"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/** 不含任何加密 / nonce 列的账号元信息 —— 安全打 log / 返 admin UI。 */
export interface AccountRow {
  id: bigint;
  /** V3 provider:claude / codex(0051 migration 加,默认 'claude')。 */
  provider: AccountProvider;
  group_id: bigint | null;
  label: string;
  plan: AccountPlan;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
  oauth_expires_at: Date | null;
  /**
   * 0064 — Anthropic 订阅周期到期日。管理员在 admin UI 手填(Anthropic OAuth/API
   * 未暴露此信息)。NULL = 未维护,WRH 权重函数按"中性 1.0"看待,不让"字段未填"
   * 成为隐式降权。
   *
   * 注意:此字段跟 oauth_expires_at(OAuth access token 1h 刷新)语义完全无关。
   * 前者刻画"账号本身的订阅生命周期",后者刻画"当前持有 token 的可用窗口"。
   */
  subscription_end_at: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  success_count: bigint;
  fail_count: bigint;
  quota_remaining: number | null;
  /**
   * M9 配额可见性 — 由 anthropicProxy.ts 上行响应头被动写入。
   * NUMERIC(5,2) 在 pg 默认返 string,SELECT 时 cast ::float8,所以这里是 number|null。
   * 见 quota.ts。
   */
  quota_5h_pct: number | null;
  quota_5h_resets_at: Date | null;
  quota_7d_pct: number | null;
  quota_7d_resets_at: Date | null;
  quota_updated_at: Date | null;
  /**
   * 出口代理 URL,形如 `http://user:pass@host:port`。
   * NULL = 走本机出口(默认/旧账号兼容)。
   * 由 chat orchestrator 构造 undici ProxyAgent 注入到 fetch dispatcher。
   */
  egress_proxy: string | null;
  /**
   * 0053 — 引用代理池(0052 egress_proxies)的 entry id。
   * NULL = 未绑代理池,回落到 raw `egress_proxy` 文本列;非 NULL 时 HTTP 层
   * 互斥校验拒绝同时设 raw `egress_proxy`(decision R)。
   * 运行时 getTokenForUse 优先用 pool URL;codex 路径本 PR 不接(decision U)。
   */
  egress_proxy_id: bigint | null;
  /**
   * 0038 — 自动分配的 compute_host id(UUID 字符串)。
   * NULL = 未分配,走 master 默认出口或 admin 手填的 egress_proxy。
   * 列表/详情都要返回,admin UI 拿来显示绑定状态 + 触发重分配。
   */
  egress_host_uuid: string | null;
  /**
   * 是否存有 refresh token(密文 + nonce 都非空)。
   * admin UI 用来区分"过期可自愈"和"过期需人工"两种 chip 语义 ——
   * lazy refresh 触发条件见 anthropicProxy.ts:1417 / shouldRefresh()。
   */
  has_refresh_token: boolean;
  /**
   * 0098 — runtime channel 归属(v3|v5)。codex 账号池的 channel 划分权威:
   * refresh actor / scheduler / groups 均按它过滤(单账号单刷新权威)。
   */
  runtime_channel: RuntimeChannel;
  created_at: Date;
  updated_at: Date;
  /** 0226 — Cursor two-pool class. Non-cursor rows stay unknown and are ignored. */
  cursor_quota_class: import("./cursorQuota.js").CursorQuotaClass;
  cursor_sand_enabled: boolean;
}

/**
 * 解密后的 token 对象 —— 调用方用完 **必须** 调 `.fill(0)`:
 *
 * ```ts
 * const t = await getTokenForUse(id);
 * try { await callClaudeApi(t.token); }
 * finally { t.token.fill(0); t.refresh?.fill(0); }
 * ```
 */
export interface AccountToken {
  id: bigint;
  plan: AccountPlan;
  token: Buffer;
  refresh: Buffer | null;
  expires_at: Date | null;
  /** 出口代理(明文 URL,内含密码) —— 仅在调用 fetch 时构造 dispatcher 用。 */
  egress_proxy: string | null;
  /**
   * mTLS forward proxy 自动分配的 compute_host 出口(0038 引入)。
   *
   * 仅在 `egress_proxy` 为 null + account 已绑定 host + host 满足以下条件时非 null:
   *   - compute_hosts.status = 'ready'
   *   - compute_hosts.egress_proxy_endpoint IS NOT NULL(:9444 探活通过)
   *   - compute_hosts.agent_cert_fingerprint_sha256 IS NOT NULL(fail-closed)
   *
   * 任一条件不满足 → null,fallback 到 master 默认出口(已知的稳定性退化)。
   *
   * 字段全部由同一条 JOIN SQL 取出;callers 不再回查 DB。
   * 加密 PSK 字段(nonce + ct)随结构体过界,在 egressDispatcher cache miss 时才解密。
   */
  egress_target: {
    /** discriminant — 与 egressDispatcher.EgressTargetMtls 对齐(目前唯一种类) */
    kind: 'mtls';
    hostUuid: string;
    host: string;
    port: number;
    fingerprint: string;
    pskNonce: Buffer;
    pskCt: Buffer;
  } | null;
  /**
   * 出口绑定**权威源**(account 自身列,不被 JOIN 的 active-filter 清空)。
   *
   * 与上面的 `egress_proxy`/`egress_target`(已解析、池/host 不可用时被 SQL 置 null)
   * 区分:`egress_proxy_id`/`egress_host_uuid` 表示"这个账号*应该*绑了出口",
   * 即使绑的 proxy 被 disabled / host 未 ready 也仍非 null。
   *
   * 用途:出口 fail-closed 判定(A2)。已绑账号若解析不出 dispatcher 必须拒发,
   * 绝不退默认出口(去匿名化泄露)。0055 起 claude 账号 egress_proxy_id 恒 NOT NULL。
   */
  egress_proxy_id: bigint | null;
  egress_host_uuid: string | null;
}

export interface CreateAccountInput {
  label: string;
  /**
   * V3 provider(默认 'claude' 与 v2 行为一致)。
   * provider='codex' 必须有 refresh_token(refresh actor 依赖,plan 决策 Q);
   * 校验在 admin layer (account-pool/admin.ts) 实施,store 层不强制以保留灵活性。
   */
  provider?: AccountProvider;
  plan: AccountPlan;
  token: string;
  refresh?: string | null;
  expires_at?: Date | null;
  oauth_principal_type?: string | null;
  oauth_principal_id?: string | null;
  cursor_sand_enabled?: boolean;
  /**
   * 0064 — 订阅到期日(可选)。undefined / null = 不设置(列保持 NULL)。
   * 解析由 admin layer 完成,store 层只透传 Date | null。
   */
  subscription_end_at?: Date | null;
  /**
   * 0055 — claude/codex/grok 必须引用 egress_proxies 池条目。
   * provider='cursor' 走容器内 CLI 直连,不经过 egress,允许省略。
   */
  egress_proxy_id?: bigint | string | null;
  /**
   * 0070 — Anthropic OAuth account UUID(Phase 6 anti-fraud anchor)。
   *
   *   - provider='claude':admin 新建路径在 INSERT 前同步调
   *     `/api/oauth/profile` 拿到 uuid 后传入,让 Phase 6 fail_closed scheduler
   *     立刻能选中(否则 2026-05 P1 复现:NULL uuid 行被静默剔除)。
   *   - provider='codex' 或 admin 路径 fetch 失败兜底回退:undefined / null →
   *     INSERT 写 NULL,需要靠 `scripts/backfill-account-uuid.ts` 后补。
   *
   * 校验/获取由 admin layer 负责,store 仅落库;非 UUID 形字符串会被 PG `uuid`
   * 类型拒绝(`invalid input syntax for type uuid`)— store 不二次校验。
   */
  account_uuid?: string | null;
  /**
   * 反封复盘 2026-08(#1)— 出口代理地域码(见 persona.ts REGION_ACCEPT_LANGUAGE)。
   * admin layer 从绑定的 egress_proxies.region 读出后传入,驱动 persona 的
   * accept_language / timezone 与代理国一致。undefined/null → persona 随机地域(旧行为)。
   */
  persona_region?: string | null;
  /** Optional group binding. Admin layer validates provider/kind compatibility. */
  group_id?: bigint | string | null;
  /**
   * 0098(P0-2 修复)—— 账号 runtime channel 归属,**必填**(不允许静默吃 DB
   * DEFAULT 'v3':v5 实例建号如果落 'v3',codex refresh actor / scheduler /
   * groups 按 channel 过滤后该行对 v5 不可见 → v5 池子静默为空;而 v3 leader
   * 会去刷这条本该归 v5 的 refresh 链,双 master 共刷同链会触发 OAuth family
   * 吊销)。
   *
   * 调用方(admin layer)一律传 getRuntimeChannel() —— 本实例建的号归本实例;
   * 跨 channel 迁移是显式 admin 操作(整行改 runtime_channel),不在 create 面。
   */
  runtime_channel: RuntimeChannel;
}

/**
 * UpdateAccountPatch —— 只提供的字段会被写入。
 *
 * 敏感字段语义:
 *   - `token`: 提供即重新加密,更新 oauth_token_enc + oauth_nonce
 *   - `refresh`:
 *       - 提供字符串 → 重新加密
 *       - 显式 `null` → 清空 oauth_refresh_enc + oauth_refresh_nonce
 *       - 不提供(undefined)→ 保持不变
 */
export interface UpdateAccountPatch {
  label?: string;
  plan?: AccountPlan;
  status?: AccountStatus;
  cooldown_until?: Date | null;
  last_used_at?: Date | null;
  last_error?: string | null;
  success_count?: bigint;
  fail_count?: bigint;
  quota_remaining?: number | null;
  health_score?: number;
  oauth_expires_at?: Date | null;
  /**
   * 0064 — 订阅到期日。
   *   - undefined → 不动
   *   - Date → 写入
   *   - null  → 显式清空(设回 NULL)
   */
  subscription_end_at?: Date | null;
  token?: string;
  refresh?: string | null;
  /**
   * 0055 — undefined = 不变;bigint/string = 换池 entry。
   * 不允许 null:CHECK constraint 要求账号生命周期内 egress_proxy_id 永远 NOT NULL。
   * raw `egress_proxy` 文本列在 store 层不再暴露(由 0055 CHECK 锁死为 NULL)。
   * provider 不在 patch — admin layer 显式拒绝 PATCH provider(decision R)。
   * entry 存在性校验在 admin layer。
   */
  egress_proxy_id?: bigint | string;
  /** Optional group binding. undefined = no change; null = unassign. */
  group_id?: bigint | string | null;
  cursor_quota_class?: import("./cursorQuota.js").CursorQuotaClass;
  cursor_sand_enabled?: boolean;
}

export class AccountNotFoundError extends Error {
  constructor(id: bigint | string) {
    super(`claude_account not found: id=${String(id)}`);
    this.name = "AccountNotFoundError";
  }
}

// 上层如果想基于 decrypt 异常单独分类,可用 AeadError 捕获;此处只做 re-export 方便。
export { AeadError } from "../crypto/aead.js";

/** 可重用的列清单 —— 明确不含 *_enc / *_nonce。 */
const META_COLUMNS = `
  id::text AS id,
  provider,
  group_id::text AS group_id,
  label,
  plan,
  status,
  health_score,
  cooldown_until,
  oauth_expires_at,
  subscription_end_at,
  last_used_at,
  last_error,
  success_count::text AS success_count,
  fail_count::text AS fail_count,
  quota_remaining,
  quota_5h_pct::float8       AS quota_5h_pct,
  quota_5h_resets_at,
  quota_7d_pct::float8       AS quota_7d_pct,
  quota_7d_resets_at,
  quota_updated_at,
  egress_proxy,
  egress_proxy_id::text AS egress_proxy_id,
  egress_host_uuid::text AS egress_host_uuid,
  (oauth_refresh_enc IS NOT NULL AND oauth_refresh_nonce IS NOT NULL) AS has_refresh_token,
  runtime_channel,
  created_at,
  updated_at,
  COALESCE(cursor_quota_class, 'unknown') AS cursor_quota_class,
  COALESCE(cursor_sand_enabled, FALSE) AS cursor_sand_enabled
`;

interface RawMetaRow extends QueryResultRow {
  id: string;
  provider: AccountProvider;
  group_id: string | null;
  label: string;
  plan: AccountPlan;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
  oauth_expires_at: Date | null;
  subscription_end_at: Date | null;
  last_used_at: Date | null;
  last_error: string | null;
  success_count: string;
  fail_count: string;
  quota_remaining: number | null;
  quota_5h_pct: number | null;
  quota_5h_resets_at: Date | null;
  quota_7d_pct: number | null;
  quota_7d_resets_at: Date | null;
  quota_updated_at: Date | null;
  egress_proxy: string | null;
  egress_proxy_id: string | null;
  egress_host_uuid: string | null;
  has_refresh_token: boolean;
  runtime_channel: RuntimeChannel;
  created_at: Date;
  updated_at: Date;
  cursor_quota_class: string;
  cursor_sand_enabled: boolean;
}

interface RawSecretRow extends QueryResultRow {
  id: string;
  plan: AccountPlan;
  oauth_token_enc: Buffer;
  oauth_nonce: Buffer;
  oauth_refresh_enc: Buffer | null;
  oauth_refresh_nonce: Buffer | null;
  oauth_expires_at: Date | null;
  egress_proxy: string | null;
  // A2 — 出口绑定权威源(account 自身列,不受 JOIN active-filter 影响)
  egress_proxy_id: string | null;
  egress_host_uuid: string | null;
  // 0038 — JOIN compute_hosts 取的字段;LEFT JOIN + 全字段非 NULL 才落地
  egress_host_id: string | null;
  egress_host: string | null;
  egress_host_fp: string | null;
  egress_host_psk_nonce: Buffer | null;
  egress_host_psk_ct: Buffer | null;
  // 0052/0053 — JOIN egress_proxies 拿 pool URL 密文。LEFT JOIN + status='active'
  // 才落地;NULL 表示账号没绑代理池或绑的 entry 已 disabled(等同未绑)。
  pool_url_enc: Buffer | null;
  pool_url_nonce: Buffer | null;
}

/**
 * node-agent forward proxy 固定端口。
 *
 * compute_hosts.agent_port 是 :9443(RPC mTLS),与此处的 forward proxy 端口分离 ——
 * forward proxy 不复用 RPC 信任面,SAN 校验 + 仅放行 api.anthropic.com:443 是其独立设计。
 * 所以这里硬编码,不读 schema 列,也不 parse compute_hosts.egress_proxy_endpoint(那只是
 * 探活成败 marker)。
 */
const EGRESS_FORWARD_PROXY_PORT = 9444;

function parseMetaRow(row: RawMetaRow): AccountRow {
  return {
    id: BigInt(row.id),
    provider: row.provider,
    group_id: row.group_id !== null ? BigInt(row.group_id) : null,
    label: row.label,
    plan: row.plan,
    status: row.status,
    health_score: row.health_score,
    cooldown_until: row.cooldown_until,
    oauth_expires_at: row.oauth_expires_at,
    subscription_end_at: row.subscription_end_at,
    last_used_at: row.last_used_at,
    last_error: row.last_error,
    success_count: BigInt(row.success_count),
    fail_count: BigInt(row.fail_count),
    quota_remaining: row.quota_remaining,
    quota_5h_pct: row.quota_5h_pct,
    quota_5h_resets_at: row.quota_5h_resets_at,
    quota_7d_pct: row.quota_7d_pct,
    quota_7d_resets_at: row.quota_7d_resets_at,
    quota_updated_at: row.quota_updated_at,
    egress_proxy: row.egress_proxy,
    egress_proxy_id: row.egress_proxy_id !== null ? BigInt(row.egress_proxy_id) : null,
    egress_host_uuid: row.egress_host_uuid,
    has_refresh_token: row.has_refresh_token,
    runtime_channel: row.runtime_channel,
    created_at: row.created_at,
    updated_at: row.updated_at,
    cursor_quota_class: (row.cursor_quota_class === "other_ok" || row.cursor_quota_class === "cursor_only")
      ? row.cursor_quota_class
      : "unknown",
    cursor_sand_enabled: row.cursor_sand_enabled === true,
  };
}

/**
 * 创建账号 —— 加密 token(+ 可选 refresh)后 INSERT。
 *
 * 0055:egress_proxy raw 文本列写死 NULL,egress_proxy_id 必须 NOT NULL
 * (CHECK constraint 强制)。raw 列保留只为 backup restore 兼容,不再当业务字段。
 *
 * @returns 新行的元信息(不含任何密文)
 */
export async function createAccount(
  input: CreateAccountInput,
  keyFn: () => Buffer = loadKmsKey,
): Promise<AccountRow> {
  const provider: AccountProvider = input.provider ?? "claude";
  if (!ACCOUNT_PROVIDERS.includes(provider)) {
    throw new TypeError(`invalid provider: ${String(input.provider)}`);
  }
  if (!ACCOUNT_PLANS.includes(input.plan)) {
    throw new TypeError(`invalid plan: ${input.plan}`);
  }
  if (typeof input.token !== "string" || input.token.length === 0) {
    throw new TypeError("token must be non-empty string");
  }
  // 0055:claude/codex/grok 必填;cursor 直连 CLI,允许省略。
  if (provider !== "cursor" && (input.egress_proxy_id === undefined || input.egress_proxy_id === null)) {
    throw new TypeError("egress_proxy_id is required (0055)");
  }
  const egressProxyId = input.egress_proxy_id == null ? null : String(input.egress_proxy_id);
  // 0098(P0-2):runtime_channel 必填 —— 不允许静默吃 DB DEFAULT 'v3'
  // (v5 建号落 'v3' = v5 池子静默为空 + v3/v5 双 master 共刷同一 refresh 链)。
  // 与 provider/plan 同款 runtime 兜底,防 JS 调用方绕过 TS 签名。
  if (!RUNTIME_CHANNELS.includes(input.runtime_channel)) {
    throw new TypeError(
      `invalid runtime_channel: ${String((input as { runtime_channel?: unknown }).runtime_channel)} (expect 'v3'|'v5')`,
    );
  }

  const key = keyFn();
  try {
    const tok = encrypt(input.token, key);
    let refEnc: Buffer | null = null;
    let refNonce: Buffer | null = null;
    if (input.refresh !== undefined && input.refresh !== null) {
      if (typeof input.refresh !== "string" || input.refresh.length === 0) {
        throw new TypeError("refresh must be non-empty string or null/undefined");
      }
      const r = encrypt(input.refresh, key);
      refEnc = r.ciphertext;
      refNonce = r.nonce;
    }

    // 0070 — account_uuid 由 admin layer 拿到后传入(provider='claude' 时强制)。
    // 不在 store 层 fetch 是为了保持 store 职责单一(DB 落盘),HTTP/解析逻辑在
    // account-pool/anthropicProfile.ts。$11 占位允许 NULL(codex / fetch fail 回退)。
    const accountUuid = input.account_uuid ?? null;

    // v3 反关联根治 0073/0074 — 每个新建账号必须自带 persona 列。0074 把 column
    // 设为 NOT NULL,如果 INSERT 不传 persona 会被 DB 直接拒。生成阶段调
    // assertPersona() 自洽校验,失败抛 TypeError(generatePersona 当前实现永远
    // 返合法值,assert 是防御性兜底,捕未来 variants 池 refactor 悄默破坏 shape)。
    // 反封复盘 2026-08(#1):代理地域驱动 persona —— 传入 persona_region 让
    // accept_language/timezone 与出口代理国一致(null → 随机地域,旧行为)。
    const persona = generatePersona(undefined, input.persona_region ?? null);
    assertPersona(persona);

    const res = await query<RawMetaRow>(
      `INSERT INTO claude_accounts(
         provider, group_id, label, plan,
         oauth_token_enc, oauth_nonce,
         oauth_refresh_enc, oauth_refresh_nonce,
         oauth_expires_at,
         subscription_end_at,
         egress_proxy, egress_proxy_id,
         account_uuid,
         persona,
         runtime_channel,
         oauth_principal_type, oauth_principal_id,
         cursor_sand_enabled
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, $12, $13::jsonb, $14, $15, $16, $17)
       RETURNING ${META_COLUMNS}`,
      [
        provider,
        input.group_id === undefined || input.group_id === null ? null : String(input.group_id),
        input.label,
        input.plan,
        tok.ciphertext,
        tok.nonce,
        refEnc,
        refNonce,
        input.expires_at ?? null,
        input.subscription_end_at ?? null,
        egressProxyId,
        accountUuid,
        JSON.stringify(persona),
        input.runtime_channel,
        input.oauth_principal_type ?? null,
        input.oauth_principal_id ?? null,
        input.cursor_sand_enabled === true,
      ],
    );
    return parseMetaRow(res.rows[0]);
  } finally {
    zeroBuffer(key);
  }
}

/** 单条元信息(不含密文);不存在返 null。 */
export async function getAccount(id: bigint | string): Promise<AccountRow | null> {
  const res = await query<RawMetaRow>(
    `SELECT ${META_COLUMNS} FROM claude_accounts WHERE id = $1`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  return parseMetaRow(res.rows[0]);
}

export interface ListAccountsOptions {
  /** 仅返这些状态(不传 = 所有) */
  status?: AccountStatus | AccountStatus[];
  /**
   * 仅返这些 provider(不传 = 所有)。
   * Admin UI 按 Cursor / CCB / Codex 分组展示。
   */
  provider?: AccountProvider | AccountProvider[];
  /** 默认 100,最大 500 —— 防止无界扫描 */
  limit?: number;
  offset?: number;
}

/** 列表(不含任何密文);默认 id DESC,最多 500。 */
export async function listAccounts(
  opts: ListAccountsOptions = {},
): Promise<AccountRow[]> {
  const rawLimit = opts.limit ?? 100;
  const limit = Math.min(Math.max(1, Math.floor(rawLimit)), 500);
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const params: unknown[] = [];
  const whereParts: string[] = [];
  if (opts.status !== undefined) {
    const arr = Array.isArray(opts.status) ? opts.status : [opts.status];
    if (arr.length > 0) {
      params.push(arr);
      whereParts.push(`status = ANY($${params.length}::text[])`);
    }
  }
  if (opts.provider !== undefined) {
    const arr = Array.isArray(opts.provider) ? opts.provider : [opts.provider];
    if (arr.length > 0) {
      params.push(arr);
      whereParts.push(`provider = ANY($${params.length}::text[])`);
    }
  }
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  // ORDER BY claude_accounts.id —— META_COLUMNS 含 \`id::text AS id\`,PG 对
  // ORDER BY simple-name 优先解析为输出列别名(text);qualify 列名强制按 bigint 实排
  // 同型 bug 见 admin/users.ts:279(账号池一旦超 99 条会出现 99>100 错位)。
  const res = await query<RawMetaRow>(
    `SELECT ${META_COLUMNS}
     FROM claude_accounts
     ${where}
     ORDER BY claude_accounts.id DESC
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );
  return res.rows.map(parseMetaRow);
}

/**
 * 解密 OAuth token 供上游使用。
 *
 * ⚠️ **重要**:返回的 Buffer 是明文 —— 调用方必须:
 *   1. 用完立即 `.fill(0)` 清零(`token` 和 `refresh` 均需)
 *   2. 不把 Buffer 放进 log / 序列化 / 异步长生命周期对象
 *
 * @returns null 若账号不存在
 * @throws AeadError 若密文已损坏(视为账号不可用,应触发 disable + 告警)
 */
/**
 * 选项:`requireActiveStatus = true` 让 SQL 在 WHERE 里加 `AND a.status='active'`,
 * 把"已被另一进程 ban/disabled 的账号"在 token 读取这一步即 fail-closed(返 null)。
 *
 * 默认 false 保留旧契约 —— refresh.ts 和 backfill 仍要能读 cooldown/disabled
 * 账号的密文(刷 refresh_token / 重算 account_uuid 等管理路径)。**hot path**
 * (scheduler 的 runWRHLoop / pickPinnedAccount)必须显式传 true,把 SELECT
 * status='active' → token decrypt 之间的 race 窗口收紧到单一 SELECT 的 MVCC 快照,
 * 防止"A 进程 select pool 后 B 进程 ban 该账号,A 仍能拿到 token 发上游"的
 * 风控外泄(P0,Codex 终审 BLOCKER 1)。
 */
export async function getTokenForUse(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
  opts: { requireActiveStatus?: boolean } = {},
): Promise<AccountToken | null> {
  const requireActive = opts.requireActiveStatus === true;
  // 0038 — JOIN compute_hosts 一次拿出 mTLS forward proxy 信息(避免 chat 路径再回查):
  //   - LEFT JOIN: 账号未分配 host(egress_host_uuid IS NULL)→ 所有 ch.* 都是 NULL,
  //     egress_target 在 mapper 里也置 null,fallback 到 master 默认出口
  //   - WHERE 部分(JOIN 条件):仅当 host status='ready' + endpoint 探活通过 +
  //     fingerprint 已落库 时才返字段。任一缺失 → ch.* 视为 NULL,fallback。
  //     这是 fail-closed 设计:与其用半就绪 host 出口让 mTLS 握手必败,不如退回默认出口
  //     让请求过(代价是 IP 不稳,但 chat 不报错)。
  //
  //   - egress_proxy_endpoint 不解析 host:port,master 端用 ch.host + 固定 9444 构造
  //     EgressTarget;endpoint 列只是探活成败的 marker。
  //
  // 0052/0053 — LEFT JOIN egress_proxies(代理池):
  //   - egress_proxy_id IS NOT NULL 且 entry status='active' → 拿 url_enc/url_nonce,
  //     decrypt 后**覆盖** legacy a.egress_proxy 列(优先级:池 > raw 列)
  //   - egress_proxy_id IS NULL / entry status='disabled' / entry 被删 →
  //     ep.* 字段全 NULL,落到 a.egress_proxy(legacy raw 列)。意味着 disabled
  //     的 proxy 对已绑账号 → 解析出的 egress_proxy 为 null。
  //
  //   ⚠️ A2:此处"解析为 null"**不再等于走默认出口**。chat 路径用
  //   resolveAccountEgressDispatcher,凭权威源 egress_proxy_id/egress_host_uuid 判定
  //   "账号本应有出口",解析为 null → fail-closed 拒发,绝不退默认出口(去匿名化)。
  //   因此本 JOIN 额外取出 a.egress_proxy_id / a.egress_host_uuid 两个权威列。
  const res = await query<RawSecretRow>(
    `SELECT a.id::text AS id, a.plan,
       a.oauth_token_enc, a.oauth_nonce,
       a.oauth_refresh_enc, a.oauth_refresh_nonce,
       a.oauth_expires_at,
       a.egress_proxy,
       a.egress_proxy_id::text              AS egress_proxy_id,
       a.egress_host_uuid::text             AS egress_host_uuid,
       ch.id::text                          AS egress_host_id,
       ch.host                              AS egress_host,
       ch.agent_cert_fingerprint_sha256     AS egress_host_fp,
       ch.agent_psk_nonce                   AS egress_host_psk_nonce,
       ch.agent_psk_ct                      AS egress_host_psk_ct,
       ep.url_enc                           AS pool_url_enc,
       ep.url_nonce                         AS pool_url_nonce
     FROM claude_accounts a
     LEFT JOIN compute_hosts ch
       ON ch.id = a.egress_host_uuid
       AND ch.status = 'ready'
       AND ch.egress_proxy_endpoint IS NOT NULL
       AND ch.agent_cert_fingerprint_sha256 IS NOT NULL
       AND octet_length(ch.agent_psk_nonce) > 0
       AND octet_length(ch.agent_psk_ct)    > 0
     LEFT JOIN egress_proxies ep
       ON ep.id = a.egress_proxy_id
       AND ep.status = 'active'
     WHERE a.id = $1${requireActive ? " AND a.status = 'active'" : ''}`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];

  const key = keyFn();
  let token: Buffer | null = null;
  let refresh: Buffer | null = null;
  try {
    token = decryptToBuffer(row.oauth_token_enc, row.oauth_nonce, key);
    if (row.oauth_refresh_enc && row.oauth_refresh_nonce) {
      refresh = decryptToBuffer(row.oauth_refresh_enc, row.oauth_refresh_nonce, key);
    }
    // egress_target 组装:JOIN 命中(所有 ch.* 字段都非 NULL)→ 给值;否则 null。
    // SQL JOIN 已加 octet_length 守门,这里 null check 仅作 TS 类型收窄。
    let egressTarget: AccountToken["egress_target"] = null;
    if (
      row.egress_host_id != null &&
      row.egress_host != null &&
      row.egress_host_fp != null &&
      row.egress_host_psk_nonce != null &&
      row.egress_host_psk_ct != null
    ) {
      egressTarget = {
        kind: 'mtls',
        hostUuid: row.egress_host_id,
        host: row.egress_host,
        port: EGRESS_FORWARD_PROXY_PORT,
        fingerprint: row.egress_host_fp,
        pskNonce: row.egress_host_psk_nonce,
        pskCt: row.egress_host_psk_ct,
      };
    }
    // 0052/0053 — 代理池 URL 解密。LEFT JOIN 命中(active entry)→ 用池 URL 覆盖
    // legacy a.egress_proxy 列。disabled entry 的 url_enc/url_nonce 已被 SQL
    // status='active' filter 拦掉(返 NULL),自动 fallback 到 row.egress_proxy。
    let resolvedEgressProxy: string | null = row.egress_proxy;
    if (row.pool_url_enc !== null && row.pool_url_nonce !== null) {
      const poolUrlBuf = decryptToBuffer(row.pool_url_enc, row.pool_url_nonce, key);
      try {
        resolvedEgressProxy = poolUrlBuf.toString("utf8");
      } finally {
        zeroBuffer(poolUrlBuf);
      }
    }
    const out: AccountToken = {
      id: BigInt(row.id),
      plan: row.plan,
      token,
      refresh,
      expires_at: row.oauth_expires_at,
      egress_proxy: resolvedEgressProxy,
      egress_target: egressTarget,
      // A2 — 绑定权威源:直接来自 account 列,不经 active-filter。
      // 用 `!= null` 同时挡 null 与 undefined(prod PG 恒返该列;undefined 仅出现在
      // 省略字段的测试 mock,按"未绑"处理而非 BigInt(undefined) 抛错)。
      egress_proxy_id: row.egress_proxy_id != null ? BigInt(row.egress_proxy_id) : null,
      egress_host_uuid: row.egress_host_uuid ?? null,
    };
    // 成功路径:token/refresh 交给调用方,不在 finally 清零
    token = null;
    refresh = null;
    return out;
  } catch (err) {
    // 失败路径:已申请的明文 Buffer 就地清零
    if (token) zeroBuffer(token);
    if (refresh) zeroBuffer(refresh);
    throw err instanceof AeadError ? err : new AeadError("decryption failed", { cause: err });
  } finally {
    zeroBuffer(key);
  }
}

/**
 * 更新账号:只更新 patch 里显式给的字段。
 *
 * - 空 patch(所有字段都 undefined)→ 不发 SQL,直接返当前行
 * - 不存在的 id → 返 null
 */
export async function updateAccount(
  id: bigint | string,
  patch: UpdateAccountPatch,
  keyFn: () => Buffer = loadKmsKey,
): Promise<AccountRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, val: unknown): void => {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  };

  if (patch.label !== undefined) push("label", patch.label);
  if (patch.plan !== undefined) {
    if (!ACCOUNT_PLANS.includes(patch.plan)) {
      throw new TypeError(`invalid plan: ${patch.plan}`);
    }
    push("plan", patch.plan);
  }
  if (patch.status !== undefined) {
    if (!ACCOUNT_STATUSES.includes(patch.status)) {
      throw new TypeError(`invalid status: ${patch.status}`);
    }
    push("status", patch.status);
  }
  if (patch.cooldown_until !== undefined) push("cooldown_until", patch.cooldown_until);
  if (patch.last_used_at !== undefined) push("last_used_at", patch.last_used_at);
  if (patch.last_error !== undefined) push("last_error", patch.last_error);
  if (patch.success_count !== undefined) push("success_count", patch.success_count.toString());
  if (patch.fail_count !== undefined) push("fail_count", patch.fail_count.toString());
  if (patch.quota_remaining !== undefined) push("quota_remaining", patch.quota_remaining);
  if (patch.health_score !== undefined) {
    if (patch.health_score < 0 || patch.health_score > 100) {
      throw new RangeError(`health_score out of range [0,100]: ${patch.health_score}`);
    }
    push("health_score", patch.health_score);
  }
  if (patch.oauth_expires_at !== undefined) push("oauth_expires_at", patch.oauth_expires_at);
  if (patch.subscription_end_at !== undefined) {
    // 0064:undefined = 不动;Date / null 直传 — null 显式清空。
    push("subscription_end_at", patch.subscription_end_at);
  }
  if (patch.group_id !== undefined) {
    push("group_id", patch.group_id === null ? null : String(patch.group_id));
  }
  if (patch.cursor_quota_class !== undefined) {
    if (patch.cursor_quota_class !== "unknown" && patch.cursor_quota_class !== "other_ok" && patch.cursor_quota_class !== "cursor_only") {
      throw new TypeError(`invalid cursor_quota_class: ${patch.cursor_quota_class}`);
    }
    push("cursor_quota_class", patch.cursor_quota_class);
  }
  if (patch.cursor_sand_enabled !== undefined) {
    if (typeof patch.cursor_sand_enabled !== "boolean") {
      throw new TypeError(`invalid cursor_sand_enabled: ${patch.cursor_sand_enabled}`);
    }
    push("cursor_sand_enabled", patch.cursor_sand_enabled);
  }

  if (patch.egress_proxy_id !== undefined) {
    // 0055:NULL 不再接受(CHECK constraint 与生命周期强约束)。类型已锁住,
    // 这里 runtime 兜底防 JS 调用方绕过 TS。
    // raw `egress_proxy` 列在 0055 后必须 NULL,store 层不再暴露其 setter。
    if (patch.egress_proxy_id === null) {
      throw new TypeError("egress_proxy_id cannot be null (0055)");
    }
    push("egress_proxy_id", String(patch.egress_proxy_id));
  }

  let key: Buffer | null = null;
  try {
    if (patch.token !== undefined) {
      if (typeof patch.token !== "string" || patch.token.length === 0) {
        throw new TypeError("token must be non-empty string");
      }
      if (!key) key = keyFn();
      const tok = encrypt(patch.token, key);
      push("oauth_token_enc", tok.ciphertext);
      push("oauth_nonce", tok.nonce);
    }
    if (patch.refresh !== undefined) {
      if (patch.refresh === null) {
        push("oauth_refresh_enc", null);
        push("oauth_refresh_nonce", null);
      } else {
        if (typeof patch.refresh !== "string" || patch.refresh.length === 0) {
          throw new TypeError("refresh must be non-empty string or null");
        }
        if (!key) key = keyFn();
        const r = encrypt(patch.refresh, key);
        push("oauth_refresh_enc", r.ciphertext);
        push("oauth_refresh_nonce", r.nonce);
      }
    }

    if (sets.length === 0) {
      // noop —— 避免发一条 `SET updated_at = NOW()` 的空 UPDATE
      return getAccount(id);
    }
    sets.push("updated_at = NOW()");

    params.push(String(id));
    const sql = `UPDATE claude_accounts SET ${sets.join(", ")}
       WHERE id = $${params.length}
       RETURNING ${META_COLUMNS}`;

    // v3 反关联根治 cascade:
    //   account → 'banned' / 'disabled' 时,把所有指向该账号的 csap 行翻成
    //   status='unbound'。这样下一次该 (user, session) 走 scheduler.pick 会撞
    //   SessionPinUnboundError(409,前端必须 reset_session),**强制对话历史从
    //   "Anthropic 已知风险账号" 上断开,而不是把同一对话扩散到新干净账号**。
    //
    //   不 cascade 的状态:
    //     - 'cooldown'   transient 1-5 min,pin 留着,前端 503 retry
    //     - 'active'     恢复路径,pin 当然要留
    //
    //   原子性:UPDATE accounts + UPDATE csap 必须同一 tx — 防止只翻了账号没翻
    //   pin(crash 或 conn drop)导致 cascade 不完整 → 后续 pick 走 active pin
    //   命中 banned 账号 → 抛 SessionPinTemporarilyUnavailableError 让前端反复
    //   retry 不解。
    const shouldCascade = patch.status === "banned" || patch.status === "disabled";
    if (shouldCascade) {
      return tx(async (client) => {
        const res = await client.query<RawMetaRow>(sql, params);
        if (res.rows.length === 0) return null;
        // cascade — 仅翻还没 unbound 的 active 行(幂等)
        await client.query(
          `UPDATE chat_session_account_pin
              SET status = 'unbound', updated_at = NOW()
            WHERE account_id = $1 AND status = 'active'`,
          [String(id)],
        );
        return parseMetaRow(res.rows[0]);
      });
    }

    const res = await query<RawMetaRow>(sql, params);
    if (res.rows.length === 0) return null;
    return parseMetaRow(res.rows[0]);
  } finally {
    if (key) zeroBuffer(key);
  }
}

/**
 * v3 反关联根治 — 状态专用 transition API。
 *
 * 等价于 `updateAccount(id, { status, last_error: reason ?? undefined })` 但语义更窄,
 * 让 caller 直接表达"我只想改状态",避免误传其他 patch 字段。
 *
 * cascade 行为 inherited from updateAccount:
 *   - status='banned' / 'disabled' → csap 同 tx 翻 unbound
 *   - status='active'  / 'cooldown' → 无 cascade
 *
 * `reason` 写入 `last_error`(最多 500 chars,与 updateAccount 现有 max 一致;
 * 调用方应主动 .slice 到 500)— 给 ops 排查 ban 来源。
 *
 * @returns 更新后的账号行;`id` 不存在返 null。
 */
export async function transitionAccountStatus(
  id: bigint | string,
  status: AccountStatus,
  reason?: string | null,
): Promise<AccountRow | null> {
  const patch: UpdateAccountPatch = { status };
  if (reason !== undefined) patch.last_error = reason;
  return updateAccount(id, patch);
}

/**
 * v3 反关联根治 — pin 命中"账号当前不可用"时,告诉 scheduler 该账号到底是
 * 永久死(terminal)还是短暂 cooldown(transient),以及还要多久才能恢复。
 *
 * 设计动机:
 *   pick() 命中 active pin 但账号不在 active pool 时,需要区分两种情况:
 *     - account.status='banned'/'disabled' → 终态,csap 应被 cascade 但还没翻
 *       (race:csap=active + account=banned),scheduler 必须 self-heal 把
 *       csap 翻 'unbound' 然后抛 SessionPinUnboundError(409 reset_session)。
 *     - account.status='cooldown' + cooldown_until 未到 → 真瞬时,scheduler 抛
 *       SessionPinTemporarilyUnavailableError(retryAfterMs = cooldown_until - now)
 *       让 HTTP 层下发 Retry-After + retry_after_ms,客户端 backoff retry。
 *
 *   只读 SELECT(无 UPDATE),纯查询语义,scheduler 负责把读到的 hint 翻译成
 *   控制流(self-heal cascade / 503 retry / 409 throw)。
 *
 * @returns null 若账号不存在(已被删 race);否则返三种 hint 之一。
 */
export type AccountRecoveryHint =
  | { kind: "terminal"; status: "banned" | "disabled" }
  | { kind: "transient"; status: "cooldown"; retryAfterMs: number }
  | { kind: "ready"; status: "active" };

export async function readAccountRecoveryHint(
  id: bigint | string,
  now: () => Date = () => new Date(),
): Promise<AccountRecoveryHint | null> {
  const res = await query<{ status: AccountStatus; cooldown_until: Date | null }>(
    `SELECT status, cooldown_until
       FROM claude_accounts
      WHERE id = $1`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.status === "banned" || row.status === "disabled") {
    return { kind: "terminal", status: row.status };
  }
  if (row.status === "cooldown") {
    // cooldown_until 缺失或已过期 → 视为"几乎可用",retryAfterMs=0 让 scheduler
    // immediateRetries 路径吞掉,不让客户端拿到 Retry-After=0 这种奇怪值。
    const deadline = row.cooldown_until?.getTime() ?? 0;
    const remain = deadline - now().getTime();
    return {
      kind: "transient",
      status: "cooldown",
      retryAfterMs: remain > 0 ? remain : 0,
    };
  }
  // status='active' — 账号其实是好的,pick 把它过滤出去多半是 inflight cap / pool
  // 刚刷新;不属于终态也不属于瞬时态,scheduler 走"短 backoff retry"路径。
  return { kind: "ready", status: "active" };
}

/**
 * 删除账号。
 *
 * 注意:usage_records.account_id FK `ON DELETE SET NULL`(0044 migration),
 * 删除账号后历史 usage_records 行保留 user_id/cost_credits/request_id/timing
 * 等计费核心字段,仅 account_id 置 NULL 表示"已删除账号"。
 * account_refresh_events FK 是 CASCADE,会随账号一起删。
 *
 * @returns true 删了一行,false 未找到
 */
export async function deleteAccount(id: bigint | string): Promise<boolean> {
  const res = await query<RawMetaRow>(
    `DELETE FROM claude_accounts WHERE id = $1 RETURNING id::text AS id`,
    [String(id)],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Codex 账号 token 快照 —— 仅供 v3 codex provision / refresh actor / lazy migrate 使用。
 *
 * 与 `getTokenForUse` 的区别:
 *   - 不接 inflight / health(provision 不是真实 API 调用,refresh actor 也不算 turn)
 *   - 不解析 egress_target / egress_proxy(codex 容器内 CLI 直连 OpenAI,
 *     egress 暂不进容器运行时,见 plan 决策 U)
 *   - 加 provider 校验:非 codex 账号 → 抛错(防误用 claude 账号)
 *
 * **token / refresh Buffer 调用方用完必须 .fill(0)**(同 getTokenForUse 契约)。
 *
 * @returns null 若账号不存在
 * @throws TypeError 若账号 provider !== 'codex'(防 claude 账号误进 codex 路径)
 * @throws AeadError 若密文损坏(调用方应视为账号损坏,触发 disable + 告警)
 */
export interface CodexTokenSnapshot {
  id: bigint;
  /** 解密后的 OAuth access token —— **调用方用完必须 .fill(0)** */
  token: Buffer;
  /** 解密后的 refresh token —— Phase 1 codex 账号必有,但 Phase 2 active 状态可能缺;**调用方用完必须 .fill(0)** */
  refresh: Buffer | null;
  expires_at: Date | null;
}

interface RawCodexSecretRow extends QueryResultRow {
  id: string;
  provider: AccountProvider;
  oauth_token_enc: Buffer;
  oauth_nonce: Buffer;
  oauth_refresh_enc: Buffer | null;
  oauth_refresh_nonce: Buffer | null;
  oauth_expires_at: Date | null;
  oauth_principal_type?: string | null;
  oauth_principal_id?: string | null;
}

/**
 * In-tx 版本 —— 用调用方持有的 `PoolClient` 跑 SELECT,**不申请第二个 pool
 * client**。callers:
 *   - M2 `codexDisableFanout` 的 migrate tx(tx 内 snapshot + write + UPDATE
 *     强一致路径,N=4 限流,可接受持锁 IO)
 *
 * 旧的 `getCodexTokenSnapshot(id)` 改为 thin wrapper,保留给 tx 外路径
 * (provision / refresh actor / M1 in-turn lazy migrate 的 post-commit
 * fetch)使用。
 */
export async function getCodexTokenSnapshotInTx(
  client: PoolClient,
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<CodexTokenSnapshot | null> {
  const res = await client.query<RawCodexSecretRow>(
    `SELECT id::text AS id, provider,
       oauth_token_enc, oauth_nonce,
       oauth_refresh_enc, oauth_refresh_nonce,
       oauth_expires_at
     FROM claude_accounts
     WHERE id = $1`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.provider !== "codex") {
    throw new TypeError(
      `getCodexTokenSnapshot called on non-codex account ${String(id)} (provider=${row.provider})`,
    );
  }

  const key = keyFn();
  let token: Buffer | null = null;
  let refresh: Buffer | null = null;
  try {
    token = decryptToBuffer(row.oauth_token_enc, row.oauth_nonce, key);
    if (row.oauth_refresh_enc && row.oauth_refresh_nonce) {
      refresh = decryptToBuffer(row.oauth_refresh_enc, row.oauth_refresh_nonce, key);
    }
    const out: CodexTokenSnapshot = {
      id: BigInt(row.id),
      token,
      refresh,
      expires_at: row.oauth_expires_at,
    };
    // 成功路径:token/refresh 交给调用方,不在 finally 清零
    token = null;
    refresh = null;
    return out;
  } catch (err) {
    if (token) zeroBuffer(token);
    if (refresh) zeroBuffer(refresh);
    throw err instanceof AeadError ? err : new AeadError("decryption failed", { cause: err });
  } finally {
    zeroBuffer(key);
  }
}

export interface GrokTokenSnapshot extends CodexTokenSnapshot {
  principal_type: string | null;
  principal_id: string | null;
}

/** Grok uses the same encrypted OAuth columns but is never mounted into a container. */
export async function getGrokTokenSnapshotInTx(
  client: PoolClient,
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<GrokTokenSnapshot | null> {
  const res = await client.query<RawCodexSecretRow>(
    `SELECT id::text AS id, provider,
       oauth_token_enc, oauth_nonce,
       oauth_refresh_enc, oauth_refresh_nonce,
       oauth_expires_at,
       oauth_principal_type, oauth_principal_id
     FROM claude_accounts
     WHERE id = $1`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.provider !== "grok") {
    throw new TypeError(`getGrokTokenSnapshot called on non-grok account ${String(id)} (provider=${row.provider})`);
  }
  const key = keyFn();
  let token: Buffer | null = null;
  let refresh: Buffer | null = null;
  try {
    token = decryptToBuffer(row.oauth_token_enc, row.oauth_nonce, key);
    if (row.oauth_refresh_enc && row.oauth_refresh_nonce) {
      refresh = decryptToBuffer(row.oauth_refresh_enc, row.oauth_refresh_nonce, key);
    }
    const out: GrokTokenSnapshot = {
      id: BigInt(row.id),
      token,
      refresh,
      expires_at: row.oauth_expires_at,
      principal_type: row.oauth_principal_type ?? null,
      principal_id: row.oauth_principal_id ?? null,
    };
    token = null;
    refresh = null;
    return out;
  } catch (err) {
    if (token) zeroBuffer(token);
    if (refresh) zeroBuffer(refresh);
    throw err instanceof AeadError ? err : new AeadError("decryption failed", { cause: err });
  } finally {
    zeroBuffer(key);
  }
}

/**
 * Update a Codex OAuth token snapshot using the caller's client. Intended for
 * refresh paths that already hold a cross-process advisory lock on the same
 * client; do not use for general admin patching.
 */
export async function updateCodexTokenSnapshotInTx(
  client: PoolClient,
  id: bigint | string,
  patch: { token: string; refresh?: string | null; expires_at: Date; last_error?: string | null },
  keyFn: () => Buffer = loadKmsKey,
): Promise<boolean> {
  if (typeof patch.token !== "string" || patch.token.length === 0) {
    throw new TypeError("token must be non-empty string");
  }
  const key = keyFn();
  try {
    const tok = encrypt(patch.token, key);
    let refEnc: Buffer | null | undefined;
    let refNonce: Buffer | null | undefined;
    if (patch.refresh !== undefined) {
      if (patch.refresh === null) {
        refEnc = null;
        refNonce = null;
      } else {
        if (typeof patch.refresh !== "string" || patch.refresh.length === 0) {
          throw new TypeError("refresh must be non-empty string or null");
        }
        const r = encrypt(patch.refresh, key);
        refEnc = r.ciphertext;
        refNonce = r.nonce;
      }
    }

    const sets = [
      "oauth_token_enc = $2",
      "oauth_nonce = $3",
      "oauth_expires_at = $4",
      "last_error = $5",
      "updated_at = NOW()",
    ];
    const params: unknown[] = [
      String(id),
      tok.ciphertext,
      tok.nonce,
      patch.expires_at,
      patch.last_error ?? null,
    ];
    if (patch.refresh !== undefined) {
      params.push(refEnc ?? null, refNonce ?? null);
      sets.push(`oauth_refresh_enc = $${params.length - 1}`);
      sets.push(`oauth_refresh_nonce = $${params.length}`);
    }
    const res = await client.query(
      `UPDATE claude_accounts
          SET ${sets.join(", ")}
        WHERE id = $1 AND provider = 'codex'`,
      params,
    );
    return (res.rowCount ?? 0) > 0;
  } finally {
    zeroBuffer(key);
  }
}

export async function updateGrokTokenSnapshotInTx(
  client: PoolClient,
  id: bigint | string,
  patch: { token: string; refresh?: string | null; expires_at: Date; last_error?: string | null },
  keyFn: () => Buffer = loadKmsKey,
): Promise<boolean> {
  if (!patch.token) throw new TypeError("token must be non-empty string");
  const key = keyFn();
  try {
    const tok = encrypt(patch.token, key);
    const params: unknown[] = [String(id), tok.ciphertext, tok.nonce, patch.expires_at, patch.last_error ?? null];
    const sets = ["oauth_token_enc = $2", "oauth_nonce = $3", "oauth_expires_at = $4", "last_error = $5", "updated_at = NOW()"];
    if (patch.refresh !== undefined) {
      let enc: Buffer | null = null;
      let nonce: Buffer | null = null;
      if (patch.refresh !== null) {
        if (!patch.refresh) throw new TypeError("refresh must be non-empty string or null");
        const ref = encrypt(patch.refresh, key);
        enc = ref.ciphertext;
        nonce = ref.nonce;
      }
      params.push(enc, nonce);
      sets.push(`oauth_refresh_enc = $${params.length - 1}`, `oauth_refresh_nonce = $${params.length}`);
    }
    const res = await client.query(
      `UPDATE claude_accounts SET ${sets.join(", ")} WHERE id = $1 AND provider = 'grok'`,
      params,
    );
    return (res.rowCount ?? 0) > 0;
  } finally {
    zeroBuffer(key);
  }
}

export async function getGrokTokenSnapshot(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<GrokTokenSnapshot | null> {
  const client = await getPool().connect();
  try { return await getGrokTokenSnapshotInTx(client, id, keyFn); }
  finally { client.release(); }
}

/**
 * Thin wrapper —— 不在 tx 上下文中使用。自申请 pool client、释放。
 * tx 内绝不要调用此函数,改用 `getCodexTokenSnapshotInTx`。
 */
export async function getCodexTokenSnapshot(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<CodexTokenSnapshot | null> {
  const client = await getPool().connect();
  try {
    return await getCodexTokenSnapshotInTx(client, id, keyFn);
  } finally {
    client.release();
  }
}

export interface CursorTokenSnapshot {
  id: bigint;
  /** 解密后的 Cursor API key —— **调用方用完必须 .fill(0)** */
  token: Buffer;
}

/**
 * Cursor API key snapshot. Same encrypted columns as OAuth tokens; never
 * logged. Caller must zero the buffer.
 */
export async function getCursorTokenSnapshot(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<CursorTokenSnapshot | null> {
  const res = await query<RawCodexSecretRow>(
    `SELECT id::text AS id, provider,
       oauth_token_enc, oauth_nonce,
       oauth_refresh_enc, oauth_refresh_nonce,
       oauth_expires_at
     FROM claude_accounts
     WHERE id = $1`,
    [String(id)],
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  if (row.provider !== "cursor") {
    throw new TypeError(`getCursorTokenSnapshot called on non-cursor account ${String(id)} (provider=${row.provider})`);
  }
  const key = keyFn();
  let token: Buffer | null = null;
  try {
    token = decryptToBuffer(row.oauth_token_enc, row.oauth_nonce, key);
    const out: CursorTokenSnapshot = { id: BigInt(row.id), token };
    token = null;
    return out;
  } catch (err) {
    if (token) zeroBuffer(token);
    throw err instanceof AeadError ? err : new AeadError("decryption failed", { cause: err });
  } finally {
    zeroBuffer(key);
  }
}
