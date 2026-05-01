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

import type { QueryResultRow } from "pg";
import { query } from "../db/queries.js";
import { encrypt, decryptToBuffer, AeadError } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";

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
export const ACCOUNT_PROVIDERS = ["claude", "codex"] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/** 不含任何加密 / nonce 列的账号元信息 —— 安全打 log / 返 admin UI。 */
export interface AccountRow {
  id: bigint;
  /** V3 provider:claude / codex(0051 migration 加,默认 'claude')。 */
  provider: AccountProvider;
  label: string;
  plan: AccountPlan;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
  oauth_expires_at: Date | null;
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
  created_at: Date;
  updated_at: Date;
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
  egress_proxy?: string | null;
  /**
   * 0053 引入。create 时 admin layer 校验互斥与存在性;store 层只做 INSERT。
   */
  egress_proxy_id?: bigint | string | null;
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
  token?: string;
  refresh?: string | null;
  /**
   * undefined = 不变;null = 清空(走本机出口);string = 设/换代理 URL。
   */
  egress_proxy?: string | null;
  /**
   * 0053 引入。undefined = 不变;null = 解绑代理池;bigint/string = 绑指定 entry。
   * provider 不在 patch — admin layer 显式拒绝 PATCH provider(decision R)。
   * 互斥与 entry 存在性校验在 admin layer。
   */
  egress_proxy_id?: bigint | string | null;
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
  label,
  plan,
  status,
  health_score,
  cooldown_until,
  oauth_expires_at,
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
  created_at,
  updated_at
`;

interface RawMetaRow extends QueryResultRow {
  id: string;
  provider: AccountProvider;
  label: string;
  plan: AccountPlan;
  status: AccountStatus;
  health_score: number;
  cooldown_until: Date | null;
  oauth_expires_at: Date | null;
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
  created_at: Date;
  updated_at: Date;
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
    label: row.label,
    plan: row.plan,
    status: row.status,
    health_score: row.health_score,
    cooldown_until: row.cooldown_until,
    oauth_expires_at: row.oauth_expires_at,
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
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * 校验 egress_proxy URL 形态。允许 http(s) scheme,主机非空,端口可选(默认 80/443)。
 * 不做联通性测试 —— 那是 admin 创建后人工/自动 health 检查的事。
 */
function validateEgressProxy(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new TypeError(`egress_proxy is not a valid URL: ${raw}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new TypeError(`egress_proxy must be http(s):// scheme, got ${u.protocol}`);
  }
  if (!u.hostname) {
    throw new TypeError("egress_proxy missing host");
  }
}

/**
 * 创建账号 —— 加密 token(+ 可选 refresh)后 INSERT。
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

    let egressProxy: string | null = null;
    if (input.egress_proxy !== undefined && input.egress_proxy !== null) {
      if (typeof input.egress_proxy !== "string" || input.egress_proxy.length === 0) {
        throw new TypeError("egress_proxy must be non-empty string or null/undefined");
      }
      validateEgressProxy(input.egress_proxy);
      egressProxy = input.egress_proxy;
    }

    let egressProxyId: string | null = null;
    if (input.egress_proxy_id !== undefined && input.egress_proxy_id !== null) {
      egressProxyId = String(input.egress_proxy_id);
    }

    const res = await query<RawMetaRow>(
      `INSERT INTO claude_accounts(
         provider, label, plan,
         oauth_token_enc, oauth_nonce,
         oauth_refresh_enc, oauth_refresh_nonce,
         oauth_expires_at,
         egress_proxy, egress_proxy_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${META_COLUMNS}`,
      [
        provider,
        input.label,
        input.plan,
        tok.ciphertext,
        tok.nonce,
        refEnc,
        refNonce,
        input.expires_at ?? null,
        egressProxy,
        egressProxyId,
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
   * 仅返这些 provider(不传 = 所有,等价 ['claude','codex'])。
   * V3 Phase 2 admin UI 默认按 provider tab 切换 list。
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
  const res = await query<RawMetaRow>(
    `SELECT ${META_COLUMNS}
     FROM claude_accounts
     ${where}
     ORDER BY id DESC
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
export async function getTokenForUse(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<AccountToken | null> {
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
  //     的 proxy 对已绑账号 = 视作未绑(等同 master 默认出口),与
  //     getEgressProxyUrlPlaintext() 语义一致(disabled → 不可用)。
  const res = await query<RawSecretRow>(
    `SELECT a.id::text AS id, a.plan,
       a.oauth_token_enc, a.oauth_nonce,
       a.oauth_refresh_enc, a.oauth_refresh_nonce,
       a.oauth_expires_at,
       a.egress_proxy,
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
     WHERE a.id = $1`,
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
  if (patch.egress_proxy !== undefined) {
    if (patch.egress_proxy === null) {
      push("egress_proxy", null);
    } else {
      if (typeof patch.egress_proxy !== "string" || patch.egress_proxy.length === 0) {
        throw new TypeError("egress_proxy must be non-empty string or null");
      }
      validateEgressProxy(patch.egress_proxy);
      push("egress_proxy", patch.egress_proxy);
    }
  }
  if (patch.egress_proxy_id !== undefined) {
    push("egress_proxy_id", patch.egress_proxy_id === null ? null : String(patch.egress_proxy_id));
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
    const res = await query<RawMetaRow>(
      `UPDATE claude_accounts SET ${sets.join(", ")}
       WHERE id = $${params.length}
       RETURNING ${META_COLUMNS}`,
      params,
    );
    if (res.rows.length === 0) return null;
    return parseMetaRow(res.rows[0]);
  } finally {
    if (key) zeroBuffer(key);
  }
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
}

export async function getCodexTokenSnapshot(
  id: bigint | string,
  keyFn: () => Buffer = loadKmsKey,
): Promise<CodexTokenSnapshot | null> {
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
