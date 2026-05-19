/**
 * V3 CC 外接 plan Phase 1 — user_api_keys repo。
 *
 * 见 docs/V3_CC_EXTERNAL_ENDPOINT_PLAN_2026-05-18.md §3.2.1 / §3.2.2 / §4 / §7。
 *
 * 职责边界:
 *   - **只**负责 user_api_keys 的存取(create / findByPrefix / list / revoke / touchLastUsed)。
 *   - **不**负责认证 — secret hash 比对、错误码映射、log/metric 都在 Phase 2
 *     `ApiKeyIdentityStrategy` 里做。Phase 1 严格按"repo only" 收口,
 *     不偷渡 strategy 逻辑(Codex Phase 1 plan PASS 建议)。
 *
 * 关键不变量(plan §4):
 *   #1 No plaintext storage — `findByPrefix` 返 row 含 keyHash(strategy 内部用),
 *      但 `list` summary 严格剔除 keyHash 字段。明文 secret 只在 `create` 返一次。
 *   #3 Prefix collision retry — `create` ≤ 3 次 23505 重试,超出抛
 *      `PREFIX_COLLISION_RETRIES_EXHAUSTED`(理论上永不触发,熵 36^8 ≈ 2.82e12)。
 *
 * Hash 同型(关键):
 *   key_hash = SHA-256(Buffer.from(secretHex, "hex")) — 跟 containerIdentity.ts:111
 *   `hashSecret` 同型,绝不 hash UTF-8 hex 字符串。Phase 2 verify 必须用同样路径,
 *   否则跟容器实现长出第二套不一致行为。
 */

import { randomBytes, createHash } from "node:crypto";
import type { Pool } from "pg";

/** 8 字符 lowercase base36 字符集([0-9a-z],36 chars)。 */
const KEY_PREFIX_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/**
 * 用户面/strategy 直接吃的错误。
 *
 * code:
 *   LABEL_INVALID — 早 fail,DB CHECK 不必触发(repo 层 trim 后判 1..80)
 *   PREFIX_COLLISION_RETRIES_EXHAUSTED — 3 次 23505 仍未成功(理论上永不触发)
 */
export class ApiKeyRepoError extends Error {
  constructor(
    readonly code: "LABEL_INVALID" | "PREFIX_COLLISION_RETRIES_EXHAUSTED",
    message: string,
  ) {
    super(message);
    this.name = "ApiKeyRepoError";
  }
}

/**
 * `findByPrefix` 返回的完整 row。仅 Phase 2 strategy 内部消费(timing-safe hash 比对)。
 *
 * **不**对外(管理面)暴露 — 管理面用 `ApiKeySummary`,严格无 keyHash 字段。
 */
export interface ApiKeyRow {
  id: bigint;
  userId: bigint;
  label: string;
  keyPrefix: string;
  /** SHA-256(raw 24 bytes secret) = 32 字节 Buffer。**绝不**对外。 */
  keyHash: Buffer;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * 管理面 GET /api/me/api-keys 列表返回(plan §3.3)。
 *
 * **没有** keyHash 字段 — invariant #1 的 TS 层强约束。
 */
export interface ApiKeySummary {
  id: bigint;
  label: string;
  keyPrefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * `create` 返回 — 明文 token 仅此一次。
 *
 * `plaintext` 形如 `oc-cc.<8 base36>.<48 hex>`(plan §3.2.2)。
 * 用户必须立即保存,后端永远无法重新构造该字符串。
 */
export interface CreatedApiKey {
  id: bigint;
  /** 完整明文 token,**仅创建时返一次** */
  plaintext: string;
  keyPrefix: string;
  label: string;
  createdAt: Date;
}

export interface ApiKeyRepo {
  /** 创建新 key。label trim 后 1..80 字符;prefix 碰撞自动重试 ≤ 3 次。 */
  create(userId: bigint, label: string): Promise<CreatedApiKey>;

  /**
   * 按 prefix 查 **active**(未撤销)key。
   *
   * 返 null:prefix 不存在 OR 已撤销(`revoked_at IS NOT NULL`)。
   * 两种情况合并成单一返回路径 — Phase 2 strategy 统一抛同一类
   * `IdentityError("API_KEY_INVALID")`,不区分 "no such key" / "revoked"
   * (Codex Phase 1 plan PASS:目前两者错误码一致,保留区分无收益)。
   *
   * 严格格式 [0-9a-z]{8},不符合直接返 null,不查 DB。
   */
  findByPrefix(keyPrefix: string): Promise<ApiKeyRow | null>;

  /** 列当前用户**未撤销** key,按 created_at DESC。**不**返 keyHash。 */
  list(userId: bigint): Promise<ApiKeySummary[]>;

  /**
   * 软删除 — 设 `revoked_at = now()`。
   *
   * 返 true 表示成功撤销一行;false = 不存在 OR 已撤销 OR 不属于该 user
   * (`WHERE user_id=$1 AND id=$2 AND revoked_at IS NULL`)。
   * caller 据此返 200 vs 404。
   */
  revoke(userId: bigint, id: bigint): Promise<boolean>;

  /**
   * 更新 `last_used_at = now()`。Phase 2 strategy fire-and-forget 调用。
   *
   * repo 内**不**catch 错误 — 让 caller 决定 best-effort 策略
   * (语义显式,且 strategy 层会接到错误 .catch 写 log.warn)。
   * Phase 2 策略会在 strategy 层加 5min in-process LRU 节流,避免 SSE 高频热写。
   */
  touchLastUsed(id: bigint): Promise<void>;
}

/**
 * 生成新的 prefix + secret 组合。
 *
 * - prefix:8 字符 [0-9a-z],`randomBytes` 取字节后 `% 36`。
 *   小偏置(byte 256 mod 36 → 余数 0..3 多一次,熵从 41.36 bit 略降至 ~41 bit)
 *   可接受 — UNIQUE + retry 才是碰撞防线,不做拒绝采样换"纯度",见 Codex plan PASS。
 * - secret:24 字节随机 → 48 hex 字符。熵 192 bit,远超 NIST 128-bit 建议。
 * - plaintext:`oc-cc.<prefix>.<secretHex>`,跟容器 `oc-v3.<id>.<64hex>` 同型但 prefix 不同。
 */
function generateApiKeySecret(): { prefix: string; secretHex: string; plaintext: string } {
  const prefixBytes = randomBytes(8);
  let prefix = "";
  for (let i = 0; i < 8; i++) {
    prefix += KEY_PREFIX_ALPHABET[prefixBytes[i]! % 36];
  }
  const secretHex = randomBytes(24).toString("hex");
  const plaintext = `oc-cc.${prefix}.${secretHex}`;
  return { prefix, secretHex, plaintext };
}

/**
 * Hash secret — 入库(create)和 verify(Phase 2 strategy)都走这一个函数。
 *
 * **必须**对 `Buffer.from(secretHex, "hex")`(24 字节 raw)做 SHA-256,
 * **绝不**对 UTF-8 hex 字符串做 hash — 跟容器实现 `auth/containerIdentity.ts:111`
 * `hashSecret` 同型;两者必须一致,否则容器/外接两条认证路径会长出不一致行为。
 *
 * 暴露为命名 export(Phase 2 起):apiKeyIdentity strategy verify 时复用同函数,
 * 让 "存入的 hash" 和 "验签算的 hash" 永远走同一代码路径,杜绝实现漂移。
 */
export function hashApiKeySecret(secretHex: string): Buffer {
  return createHash("sha256").update(Buffer.from(secretHex, "hex")).digest();
}

interface DbRowFull {
  id: string;
  user_id: string;
  label: string;
  key_prefix: string;
  key_hash: Buffer;
  created_at: Date;
  last_used_at: Date | null;
}

interface DbRowSummary {
  id: string;
  label: string;
  key_prefix: string;
  created_at: Date;
  last_used_at: Date | null;
}

function mapFullRow(r: DbRowFull): ApiKeyRow {
  return {
    id: BigInt(r.id),
    userId: BigInt(r.user_id),
    label: r.label,
    keyPrefix: r.key_prefix,
    keyHash: r.key_hash,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

function mapSummaryRow(r: DbRowSummary): ApiKeySummary {
  return {
    id: BigInt(r.id),
    label: r.label,
    keyPrefix: r.key_prefix,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

/**
 * Postgres 实现。注入 Pool 让单测能用 mock pool(同 Phase 0 baseline 风格)。
 */
export function makePgApiKeyRepo(pool: Pool): ApiKeyRepo {
  return {
    async create(userId, label) {
      const trimmed = typeof label === "string" ? label.trim() : "";
      if (trimmed.length < 1 || trimmed.length > 80) {
        throw new ApiKeyRepoError(
          "LABEL_INVALID",
          "label must be 1..80 chars after trim",
        );
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        const { prefix, secretHex, plaintext } = generateApiKeySecret();
        const keyHash = hashApiKeySecret(secretHex);
        try {
          const r = await pool.query<{ id: string; created_at: Date }>(
            `INSERT INTO user_api_keys(user_id, label, key_prefix, key_hash)
             VALUES ($1, $2, $3, $4)
             RETURNING id, created_at`,
            [userId.toString(), trimmed, prefix, keyHash],
          );
          const row = r.rows[0]!;
          return {
            id: BigInt(row.id),
            plaintext,
            keyPrefix: prefix,
            label: trimmed,
            createdAt: row.created_at,
          };
        } catch (err) {
          // 仅 PG unique_violation(23505)且约束名匹配 key_prefix 才重试。
          // 其它错(FK / NOT NULL / 连接挂)直接 throw,绝不吞。
          const e = err as { code?: string; constraint?: string };
          const isPrefixCollision =
            e?.code === "23505" &&
            typeof e.constraint === "string" &&
            /key_prefix/.test(e.constraint);
          if (isPrefixCollision) continue;
          throw err;
        }
      }
      throw new ApiKeyRepoError(
        "PREFIX_COLLISION_RETRIES_EXHAUSTED",
        "failed to create unique key_prefix after 3 attempts",
      );
    },

    async findByPrefix(keyPrefix) {
      // 严格 [0-9a-z]{8} 格式校验;不符合直接返 null,不查 DB(节省查询)。
      if (!/^[0-9a-z]{8}$/.test(keyPrefix)) return null;
      const r = await pool.query<DbRowFull>(
        `SELECT id, user_id, label, key_prefix, key_hash, created_at, last_used_at
         FROM user_api_keys
         WHERE key_prefix = $1 AND revoked_at IS NULL
         LIMIT 1`,
        [keyPrefix],
      );
      if (r.rows.length === 0) return null;
      return mapFullRow(r.rows[0]!);
    },

    async list(userId) {
      // 严格 SELECT 列白名单,**不** SELECT key_hash — invariant #1 SQL 层钉子。
      const r = await pool.query<DbRowSummary>(
        `SELECT id, label, key_prefix, created_at, last_used_at
         FROM user_api_keys
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY created_at DESC`,
        [userId.toString()],
      );
      return r.rows.map(mapSummaryRow);
    },

    async revoke(userId, id) {
      const r = await pool.query(
        `UPDATE user_api_keys
         SET revoked_at = now()
         WHERE user_id = $1 AND id = $2 AND revoked_at IS NULL`,
        [userId.toString(), id.toString()],
      );
      return (r.rowCount ?? 0) > 0;
    },

    async touchLastUsed(id) {
      await pool.query(
        `UPDATE user_api_keys SET last_used_at = now() WHERE id = $1`,
        [id.toString()],
      );
    },
  };
}
