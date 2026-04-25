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

/** 不含任何加密 / nonce 列的账号元信息 —— 安全打 log / 返 admin UI。 */
export interface AccountRow {
  id: bigint;
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
}

export interface CreateAccountInput {
  label: string;
  plan: AccountPlan;
  token: string;
  refresh?: string | null;
  expires_at?: Date | null;
  egress_proxy?: string | null;
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
  created_at,
  updated_at
`;

interface RawMetaRow extends QueryResultRow {
  id: string;
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
}

function parseMetaRow(row: RawMetaRow): AccountRow {
  return {
    id: BigInt(row.id),
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

    const res = await query<RawMetaRow>(
      `INSERT INTO claude_accounts(
         label, plan,
         oauth_token_enc, oauth_nonce,
         oauth_refresh_enc, oauth_refresh_nonce,
         oauth_expires_at,
         egress_proxy
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${META_COLUMNS}`,
      [
        input.label,
        input.plan,
        tok.ciphertext,
        tok.nonce,
        refEnc,
        refNonce,
        input.expires_at ?? null,
        egressProxy,
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
  const res = await query<RawSecretRow>(
    `SELECT id::text AS id, plan,
       oauth_token_enc, oauth_nonce,
       oauth_refresh_enc, oauth_refresh_nonce,
       oauth_expires_at,
       egress_proxy
     FROM claude_accounts WHERE id = $1`,
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
    const out: AccountToken = {
      id: BigInt(row.id),
      plan: row.plan,
      token,
      refresh,
      expires_at: row.oauth_expires_at,
      egress_proxy: row.egress_proxy,
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
 * 注意:usage_records.account_id FK `ON DELETE RESTRICT`,
 * 若存在历史流水 DB 会抛错(错误透传给调用方)。运维应先把账号
 * 标记为 `disabled`,保留历史。
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
