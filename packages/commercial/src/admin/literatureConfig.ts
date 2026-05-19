/**
 * 文献检索(DeepXiv)平台级配置 — admin CRUD。
 *
 * 单行表 `literature_deepxiv_config(id=1)`,见 0069 migration。
 *
 * ### 字段语义
 * - `enabled`:总开关。off → /v3/literature/search 直接 503,容器侧 skill 不渲染
 * - `base_url`:DeepXiv 服务根 URL,proxy 拼 `<base>/arxiv/?type=retrieve&query=...`
 * - `token`:Bearer token。**DB 上 AEAD (AES-256-GCM) 加密存** —— 与 OAuth token 同模式
 *   (`crypto/aead.ts` + `crypto/keys.ts`)。本模块内部只在加密/解密边界出现明文,
 *   admin 读 API 永远返 mask,**不**走 plaintext。
 * - `daily_cap`:UTC 自然日总尝试次数(不是 200 数);Redis 计数,DB 只持上限
 * - `default_size`:proxy 缺省 size 参数(LLM 不传时用),≤ 100
 * - `timeout_sec`:proxy 调上游超时
 *
 * ### Token 写入协议(显式 action)
 * 前端 PATCH 不再用 `tok***` 兜底字符串(歧义:是新写还是保持?),改成:
 *   ```
 *   { token: { action: "keep" } }     // 不改
 *   { token: { action: "set", value: "..." } }  // 写入新值
 *   { token: { action: "clear" } }    // 置 NULL
 *   ```
 * 这样 normalize 阶段就能区分三态,不会因为前端把 mask 字符串原样回传而误改。
 *
 * ### 审计
 * 同事务 admin_audit。token 字段**只写元信息**(`{set, len, last4}`),明文永不进 audit。
 *   - set:before 解密旧密文计 len/last4(解密失败 fallback `{set:true, len:null, last4:null}`)
 *     ,after 用刚归一化的 plaintext 计 len/last4
 *   - clear:before 同上;after `{set:false}`
 *   - keep:**根本不出现**在 before/after(等价没改)
 *
 * 明文 token 永远不进 admin_audit,合规红线。
 *
 * ### 热重载
 * 不走 LISTEN/NOTIFY:promptSlot 在每次容器 spawn / system prompt 重建时
 * 通过 {@link getLiteratureSkillConfig} 直接读 DB,proxy 路径也是 per-request
 * 实时 DB 读,所以 admin 改完下次 spawn 自然吃到新值。这避免了 0008_pricing
 * 那套 listener-without-reconnect 的技术债被复制到本模块。
 *
 * ### 最小权限分流
 * 渲染 SKILLS_LITERATURE prompt 块只需要"是否启用 + 是否配了 token + 默认 size",
 * **不需要** bearer plaintext。因此暴露两个读 API:
 *   - {@link getLiteratureSkillConfig} —— 不解密 token,只算 `token_set` 布尔
 *   - {@link getLiteratureConfig} —— 解密 token,只给 proxy / admin self-test 用
 * prompt 路径绝不调用后者,保证容器系统 prompt 构建链上**永远不物化** bearer。
 */

import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { encrypt, decryptToBuffer, AeadError } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";

// ─── Row & view ────────────────────────────────────────────────────

/**
 * 给本模块以外消费者(主要是 literatureProxy)使用的 row 形状。
 * `token` 是**已解密的明文**;DB 列 `token_ct`/`token_nonce` 是内部细节,不外泄。
 */
export interface LiteratureDeepxivConfigRow {
  id: 1;
  enabled: boolean;
  base_url: string;
  token: string | null;
  daily_cap: number;
  default_size: number;
  timeout_sec: number;
  updated_at: Date;
  updated_by: string | null;
}

/** DB 行的原始投影,带密文列。仅本模块内部使用。 */
interface LiteratureDeepxivConfigDbRow {
  id: 1;
  enabled: boolean;
  base_url: string;
  token_ct: Buffer | null;
  token_nonce: Buffer | null;
  daily_cap: number;
  default_size: number;
  timeout_sec: number;
  updated_at: Date;
  updated_by: string | null;
}

/** Admin API 暴露视图。token 永远是 mask。 */
export interface LiteratureDeepxivConfigView {
  enabled: boolean;
  base_url: string;
  token_set: boolean;
  /** mask 形式:`"****" + last 4 chars`,token 未设时为 null。 */
  token_hint: string | null;
  daily_cap: number;
  default_size: number;
  timeout_sec: number;
  updated_at: string;
  updated_by: string | null;
}

const CONFIG_COLS = `
  id,
  enabled,
  base_url,
  token_ct,
  token_nonce,
  daily_cap,
  default_size,
  timeout_sec,
  updated_at,
  updated_by
`;

/**
 * 解密 token 列;失败/为空返 null。**调用方负责持有/用完明文 string** —— 我们这里
 * 通过 decryptToBuffer 拿 Buffer 后 toString,toString 完立刻清零 Buffer。
 * 与 crypto/aead.ts 的 decrypt() 同样的 fill(0) 套路。
 */
function decryptTokenColumn(token_ct: Buffer | null, token_nonce: Buffer | null): string | null {
  if (token_ct === null || token_nonce === null) return null;
  const key = loadKmsKey();
  try {
    const pt = decryptToBuffer(token_ct, token_nonce, key);
    try {
      return pt.toString("utf8");
    } finally {
      zeroBuffer(pt);
    }
  } finally {
    zeroBuffer(key);
  }
}

/**
 * Mask token → `"****abcd"`。短于 4 字符的 token(几乎不可能合法)返 `"****"`。
 * 永远不返回明文片段长度信息。
 */
export function maskToken(token: string | null): string | null {
  if (token === null || token === "") return null;
  const last4 = token.length >= 4 ? token.slice(-4) : "";
  return `****${last4}`;
}

function dbRowToView(
  r: LiteratureDeepxivConfigDbRow,
  decryptedToken: string | null,
): LiteratureDeepxivConfigView {
  return {
    enabled: r.enabled,
    base_url: r.base_url,
    token_set: r.token_ct !== null,
    token_hint: maskToken(decryptedToken),
    daily_cap: r.daily_cap,
    default_size: r.default_size,
    timeout_sec: r.timeout_sec,
    updated_at: r.updated_at.toISOString(),
    updated_by: r.updated_by,
  };
}

// ─── Skill-prompt read (no decrypt) ────────────────────────────────

/**
 * Prompt-slot 专用的窄配置视图。**不解密 token**,只给"该不该渲染 SKILLS_LITERATURE
 * 段落 + 该写多少默认 size"用。token plaintext 不进入这条调用链,符合最小权限。
 *
 * 设计要点(2026-05-19 Codex P1):prompt 路径只关心"配置是否完备",不需要 bearer。
 * 之前临时打算直接复用 {@link getLiteratureConfig}`(false)` 会顺带解密 token 物化到
 * 进程内存,既无必要也扩大了 KMS-key 访问面;改成本函数 + SQL `token_ct IS NOT NULL`
 * 算 token_set 布尔即可。
 *
 * Row missing(理论永不发生,0069 已 seed)→ 全 false 默认,等同于 disabled。
 */
export interface LiteratureSkillConfig {
  enabled: boolean;
  token_set: boolean;
  default_size: number;
}

export async function getLiteratureSkillConfig(): Promise<LiteratureSkillConfig> {
  const r = await query<{ enabled: boolean; token_set: boolean; default_size: number }>(
    `SELECT enabled,
            (token_ct IS NOT NULL AND token_nonce IS NOT NULL) AS token_set,
            default_size
       FROM literature_deepxiv_config
      WHERE id = 1`,
  );
  if (r.rows.length === 0) {
    return { enabled: false, token_set: false, default_size: 10 };
  }
  const row = r.rows[0];
  return {
    enabled: row.enabled,
    token_set: row.token_set,
    default_size: row.default_size,
  };
}

// ─── Read ──────────────────────────────────────────────────────────

/**
 * 读取当前配置。
 *
 * `forApi=true`(admin 端点用)→ 返 mask 视图(token_set + token_hint)。
 *   解密 token 仅用于派生 last4(明文不离本函数;toString 完密文 Buffer 清零)。
 * `forApi=false`(**仅** literatureProxy 用)→ 返 row,token 字段已解密明文。
 *
 * **永远**不要把 forApi=false 的结果通过 HTTP 暴露出去。
 *
 * 注:promptSlot 路径不应调本函数 —— bearer 在那条链上不应物化,改用
 * {@link getLiteratureSkillConfig}。详见本文件头注释"最小权限分流"段。
 */
export async function getLiteratureConfig(forApi: true): Promise<LiteratureDeepxivConfigView>;
export async function getLiteratureConfig(forApi: false): Promise<LiteratureDeepxivConfigRow>;
export async function getLiteratureConfig(
  forApi: boolean,
): Promise<LiteratureDeepxivConfigView | LiteratureDeepxivConfigRow> {
  const r = await query<LiteratureDeepxivConfigDbRow>(
    `SELECT ${CONFIG_COLS} FROM literature_deepxiv_config WHERE id = 1`,
  );
  let dbRow: LiteratureDeepxivConfigDbRow;
  if (r.rows.length === 0) {
    // 0069 migration 已 INSERT id=1,理论永不到此分支。fail-closed 返 disabled 默认。
    dbRow = {
      id: 1,
      enabled: false,
      base_url: "https://data.rag.ac.cn",
      token_ct: null,
      token_nonce: null,
      daily_cap: 10000,
      default_size: 10,
      timeout_sec: 20,
      updated_at: new Date(0),
      updated_by: null,
    };
  } else {
    dbRow = r.rows[0];
  }
  // forApi=true:解密只为 last4;失败 fail-soft(token_hint=null + token_set 仍真实反映)
  // forApi=false:解密失败 → 直接抛(proxy 不应在解密坏密文情况下继续 fetch)
  if (forApi) {
    let plaintext: string | null = null;
    try {
      plaintext = decryptTokenColumn(dbRow.token_ct, dbRow.token_nonce);
    } catch {
      plaintext = null; // 解密失败时 hint 隐藏,view 仍返回(admin 可见 token_set=true 自行处理)
    }
    return dbRowToView(dbRow, plaintext);
  }
  const plaintext = decryptTokenColumn(dbRow.token_ct, dbRow.token_nonce);
  return {
    id: 1,
    enabled: dbRow.enabled,
    base_url: dbRow.base_url,
    token: plaintext,
    daily_cap: dbRow.daily_cap,
    default_size: dbRow.default_size,
    timeout_sec: dbRow.timeout_sec,
    updated_at: dbRow.updated_at,
    updated_by: dbRow.updated_by,
  };
}

// ─── PATCH ─────────────────────────────────────────────────────────

/** 显式 action,避免 mask 字符串歧义。 */
export type TokenPatch =
  | { action: "keep" }
  | { action: "set"; value: string }
  | { action: "clear" };

export interface PatchLiteratureConfigInput {
  enabled?: boolean;
  base_url?: string;
  token?: TokenPatch;
  daily_cap?: number;
  default_size?: number;
  timeout_sec?: number;
}

export interface PatchLiteratureConfigCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

/** base_url 校验:必须 http(s):// 起头,长度 ≤ 256,无空白。 */
const BASE_URL_RE = /^https?:\/\/[^\s]{1,253}$/;

/** token 字符集白名单:可见 ASCII(! ~),长度 8..256。jwt/base64/hex 都覆盖。 */
const TOKEN_RE = /^[\x21-\x7e]{8,256}$/;

/**
 * base_url 必须是 **纯 origin**(scheme + host + 可选 port),不允许 path/query/fragment/userinfo。
 *
 * 理由:proxy 在 literatureProxy.ts 里拼 `<base>/arxiv/?type=retrieve&...`。如果 admin
 * 输入 `https://x.com/extra` 或带 query,会被静默拼成 `https://x.com/extra/arxiv/?...`,
 * 行为偏离意图;带 userinfo(`https://u:p@host`)更是把凭据混进 URL,易被日志/审计回显。
 * 强制纯 origin 把这些路径都封死,任何"路径前缀"需求应通过新字段建模,而不是塞 base_url。
 */
export function normalizeBaseUrl(v: unknown): string {
  if (typeof v !== "string") throw new RangeError("invalid_base_url");
  const s = v.trim();
  if (!BASE_URL_RE.test(s)) throw new RangeError("invalid_base_url");
  // 显式 URL 构造再 normalize,避免 admin 输 `https://x.com//arxiv/` 这种边界
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new RangeError("invalid_base_url");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new RangeError("invalid_base_url");
  }
  // 纯 origin:path 必须是 "" 或 "/",无 query/hash/userinfo
  if (u.username !== "" || u.password !== "") throw new RangeError("invalid_base_url");
  if (u.search !== "" || u.hash !== "") throw new RangeError("invalid_base_url");
  if (u.pathname !== "" && u.pathname !== "/") throw new RangeError("invalid_base_url");
  // host 必须非空(`http://` 这种会被 URL ctor 抛,但显式 fail-closed)
  if (u.host === "") throw new RangeError("invalid_base_url");
  // 不保留 trailing slash;proxy 拼路径时自己加。`https://x.com/` → `https://x.com`
  return s.replace(/\/+$/, "");
}

export function normalizeTokenValue(v: unknown): string {
  if (typeof v !== "string") throw new RangeError("invalid_token");
  const s = v.trim();
  if (!TOKEN_RE.test(s)) throw new RangeError("invalid_token");
  return s;
}

export function normalizeIntInRange(v: unknown, min: number, max: number, errcode: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new RangeError(errcode);
  if (v < min || v > max) throw new RangeError(errcode);
  return v;
}

/**
 * 修改配置。同事务写 admin_audit。空 patch → 直接返当前视图,不写 audit。
 *
 * token=keep 时**完全不出现在 audit**(等价于没动);set/clear 时只写元信息。
 */
export async function patchLiteratureConfig(
  patch: PatchLiteratureConfigInput,
  ctx: PatchLiteratureConfigCtx,
): Promise<LiteratureDeepxivConfigView> {
  // 归一化(同步抛错优先,避免开 tx 才发现 input 烂)
  const normalized: {
    enabled?: boolean;
    base_url?: string;
    token?: { action: "set"; value: string } | { action: "clear" };
    daily_cap?: number;
    default_size?: number;
    timeout_sec?: number;
  } = {};
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new RangeError("invalid_enabled");
    normalized.enabled = patch.enabled;
  }
  if (patch.base_url !== undefined) {
    normalized.base_url = normalizeBaseUrl(patch.base_url);
  }
  if (patch.token !== undefined) {
    if (patch.token.action === "set") {
      normalized.token = { action: "set", value: normalizeTokenValue(patch.token.value) };
    } else if (patch.token.action === "clear") {
      normalized.token = { action: "clear" };
    } else if (patch.token.action === "keep") {
      // no-op
    } else {
      throw new RangeError("invalid_token_action");
    }
  }
  if (patch.daily_cap !== undefined) {
    normalized.daily_cap = normalizeIntInRange(patch.daily_cap, 1, 1_000_000, "invalid_daily_cap");
  }
  if (patch.default_size !== undefined) {
    normalized.default_size = normalizeIntInRange(patch.default_size, 1, 100, "invalid_default_size");
  }
  if (patch.timeout_sec !== undefined) {
    normalized.timeout_sec = normalizeIntInRange(patch.timeout_sec, 3, 120, "invalid_timeout_sec");
  }

  const touched =
    normalized.enabled !== undefined ||
    normalized.base_url !== undefined ||
    normalized.token !== undefined ||
    normalized.daily_cap !== undefined ||
    normalized.default_size !== undefined ||
    normalized.timeout_sec !== undefined;

  if (!touched) {
    return getLiteratureConfig(true);
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<LiteratureDeepxivConfigDbRow>(
      `SELECT ${CONFIG_COLS} FROM literature_deepxiv_config WHERE id = 1 FOR UPDATE`,
    );
    if (before.rows.length === 0) {
      // 防御性 INSERT:0069 应已 seed,但若被人 TRUNCATE 也要能恢复
      await client.query(
        `INSERT INTO literature_deepxiv_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`,
      );
      const reread = await client.query<LiteratureDeepxivConfigDbRow>(
        `SELECT ${CONFIG_COLS} FROM literature_deepxiv_config WHERE id = 1 FOR UPDATE`,
      );
      if (reread.rows.length === 0) throw new Error("literature_deepxiv_config row missing");
      before.rows = reread.rows;
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (normalized.enabled !== undefined) push("enabled", normalized.enabled);
    if (normalized.base_url !== undefined) push("base_url", normalized.base_url);
    // token AEAD 写入:set 时加密一次,token_ct/token_nonce 同位 push;clear 时双 NULL
    if (normalized.token !== undefined) {
      if (normalized.token.action === "set") {
        const key = loadKmsKey();
        try {
          const { ciphertext, nonce } = encrypt(normalized.token.value, key);
          push("token_ct", ciphertext);
          push("token_nonce", nonce);
        } finally {
          zeroBuffer(key);
        }
      } else {
        push("token_ct", null);
        push("token_nonce", null);
      }
    }
    if (normalized.daily_cap !== undefined) push("daily_cap", normalized.daily_cap);
    if (normalized.default_size !== undefined) push("default_size", normalized.default_size);
    if (normalized.timeout_sec !== undefined) push("timeout_sec", normalized.timeout_sec);
    sets.push("updated_at = NOW()");
    params.push(String(ctx.adminId));
    sets.push(`updated_by = $${params.length}`);

    const after = await client.query<LiteratureDeepxivConfigDbRow>(
      `UPDATE literature_deepxiv_config SET ${sets.join(", ")} WHERE id = 1 RETURNING ${CONFIG_COLS}`,
      params,
    );

    const b = before.rows[0];
    const a = after.rows[0];
    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};
    if (normalized.enabled !== undefined) {
      changedBefore.enabled = b.enabled;
      changedAfter.enabled = a.enabled;
    }
    if (normalized.base_url !== undefined) {
      changedBefore.base_url = b.base_url;
      changedAfter.base_url = a.base_url;
    }
    if (normalized.token !== undefined) {
      // audit 永远只放元信息,不放明文。before 解密旧密文计 len/last4;若 KMS key
      // 错配/密文损坏导致 AeadError,fallback 到 `{set:true, len:null, last4:null,
      // error:"decrypt_failed"}` —— 不阻塞 patch 提交(admin 仍能 set 新 token 自救)。
      if (b.token_ct === null || b.token_nonce === null) {
        changedBefore.token = { set: false };
      } else {
        try {
          const oldPlain = decryptTokenColumn(b.token_ct, b.token_nonce);
          changedBefore.token = oldPlain === null
            ? { set: false }
            : { set: true, len: oldPlain.length, last4: oldPlain.slice(-4) };
        } catch (err) {
          if (err instanceof AeadError) {
            changedBefore.token = { set: true, len: null, last4: null, error: "decrypt_failed" };
          } else {
            throw err;
          }
        }
      }
      if (normalized.token.action === "set") {
        changedAfter.token = {
          set: true,
          len: normalized.token.value.length,
          last4: normalized.token.value.slice(-4),
        };
      } else {
        changedAfter.token = { set: false };
      }
    }
    if (normalized.daily_cap !== undefined) {
      changedBefore.daily_cap = b.daily_cap;
      changedAfter.daily_cap = a.daily_cap;
    }
    if (normalized.default_size !== undefined) {
      changedBefore.default_size = b.default_size;
      changedAfter.default_size = a.default_size;
    }
    if (normalized.timeout_sec !== undefined) {
      changedBefore.timeout_sec = b.timeout_sec;
      changedAfter.timeout_sec = a.timeout_sec;
    }

    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "literature_config.patch",
      target: "literature_deepxiv_config:1",
      before: changedBefore,
      after: changedAfter,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    // RETURNING 拿到 after 行,再解密一次给 view(同 getLiteratureConfig forApi=true 语义)
    let afterPlain: string | null = null;
    try {
      afterPlain = decryptTokenColumn(a.token_ct, a.token_nonce);
    } catch {
      afterPlain = null;
    }
    return dbRowToView(a, afterPlain);
  });
}

// ─── Test (real probe) ─────────────────────────────────────────────

export interface TestLiteratureResult {
  ok: boolean;
  /** upstream HTTP status, or null if no response (network error / timeout) */
  status: number | null;
  /** results.length from upstream JSON, null if unparseable */
  result_count: number | null;
  /** elapsed ms */
  elapsed_ms: number;
  /** 失败时的简短错误 reason,成功时 null */
  error?: string;
}

export interface TestLiteratureDeps {
  fetchImpl?: typeof fetch;
}

/**
 * 实际 probe 一次 DeepXiv,query=transformers&size=1。不消耗 daily_cap(daily_cap 在
 * proxy 那层计;admin 自检不应被业务计数挤掉)。
 *
 * 失败原因不暴露 stack/原始 message,只给短描述。
 */
export async function testLiteratureConfig(
  deps: TestLiteratureDeps = {},
): Promise<TestLiteratureResult> {
  const cfg = await getLiteratureConfig(false);
  if (!cfg.enabled) {
    return { ok: false, status: null, result_count: null, elapsed_ms: 0, error: "disabled" };
  }
  if (cfg.token === null || cfg.token === "") {
    return { ok: false, status: null, result_count: null, elapsed_ms: 0, error: "token_missing" };
  }
  const fetchFn = deps.fetchImpl ?? fetch;
  const url = `${cfg.base_url}/arxiv/?type=retrieve&query=transformers&size=1`;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), Math.min(cfg.timeout_sec, 15) * 1000);
  try {
    const r = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: ctrl.signal,
    });
    const elapsed_ms = Date.now() - t0;
    if (!r.ok) {
      return { ok: false, status: r.status, result_count: null, elapsed_ms, error: `upstream_${r.status}` };
    }
    let parsed: { results?: unknown[] } | null = null;
    try {
      parsed = (await r.json()) as { results?: unknown[] };
    } catch {
      return { ok: false, status: r.status, result_count: null, elapsed_ms, error: "bad_json" };
    }
    const count = Array.isArray(parsed?.results) ? parsed.results.length : null;
    return { ok: true, status: r.status, result_count: count, elapsed_ms };
  } catch (err) {
    const elapsed_ms = Date.now() - t0;
    const aborted = (err as { name?: string })?.name === "AbortError";
    return {
      ok: false,
      status: null,
      result_count: null,
      elapsed_ms,
      error: aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(to);
  }
}
