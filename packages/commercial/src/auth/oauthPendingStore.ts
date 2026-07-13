/**
 * OAuth pending state —— PG 短 TTL 存储(RFC-v5-dual-master-cohort §4 D7)。
 *
 * 背景:GitHub / LinuxDo OAuth 的 CSRF anti-replay state 原先各存进程内 Map,双 master
 * 蓝绿并存时 callback 可能落到与 start 不同的 slot(跨进程),进程内 Map 天然失配;
 * abort/drain 还会丢在飞绑定流程。迁 PG 后跨 slot callback 天然成立。
 *
 * 安全语义(RFC R2 M3,一处都不弱化):
 *   - **只存 hash,不存可直接使用的 bearer**:state_hash = sha256(provider + ':' + state)。
 *     库被读走也拿不到原始 state 去伪造 callback。
 *   - **原子单次消费**:consume = `DELETE ... WHERE state_hash AND expires_at>now()
 *     RETURNING payload`。删除即消费,天然防重放(第二次 DELETE 命中 0 行 → null);
 *     过期行 expires_at 条件挡住,也返 null。
 *   - **payload 加密**:verifier / userId 等敏感字段用 OPENCLAUDE_KMS_KEY(AES-256-GCM,
 *     crypto/aead)加密落库,AAD 绑定 state_hash 防跨行搬运密文。
 *   - handler 侧的 state-cookie / 用户绑定双校验保持不变(迁 PG 不替代 CSRF cookie,
 *     两道校验并存)。
 *
 * ── 集成契约:对齐 0135 迁移(Agent A 建表)的实际 schema ─────────────────────
 *   CREATE TABLE oauth_pending_states (
 *     state_hash TEXT PRIMARY KEY,   -- sha256(provider:state) hex,永不存原始 state
 *     payload    TEXT NOT NULL,      -- 加密后的 payload(见下:base64(nonce ‖ 密文‖tag))
 *     expires_at TIMESTAMPTZ NOT NULL
 *   );
 *   CREATE INDEX idx_oauth_pending_expires ON oauth_pending_states (expires_at);
 *
 * 注:表只有单 `payload TEXT` 列(无 provider / 无独立 nonce 列)。因此:
 *   - provider **烘进 state_hash**(sha256(provider:state)),跨 provider 天然不撞,无需列。
 *   - AES-256-GCM 的 nonce(12B)与密文‖tag 打包进同一 TEXT:base64(nonce ‖ ct‖tag)。
 *   - AAD 绑定 state_hash,防跨行搬运密文。
 */

import { createHash } from "node:crypto";
import { decryptToBuffer, encrypt } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";
import { query, type QueryRunner } from "../db/queries.js";
import { rootLogger } from "../logging/logger.js";

const log = rootLogger.child({ subsys: "oauthPendingStore" });

export type OAuthProvider = "github" | "linuxdo";

/** 默认 TTL:10min,与旧进程内 Map 的 PENDING_TTL_MS 对齐。 */
export const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/** state_hash = sha256(provider:state) hex —— provider 参与哈希,跨 provider 天然不撞。 */
function hashState(provider: OAuthProvider, state: string): string {
  return createHash("sha256").update(`${provider}:${state}`).digest("hex");
}

/** 把 AEAD 的 nonce 与密文打包成单 TEXT:base64(nonce(12B) ‖ ciphertext‖tag)。 */
function packPayload(ciphertext: Buffer, nonce: Buffer): string {
  return Buffer.concat([nonce, ciphertext]).toString("base64");
}

/** 拆包 packPayload 的 TEXT;格式非法/过短 → null(fail-closed)。 */
function unpackPayload(text: string): { ciphertext: Buffer; nonce: Buffer } | null {
  let raw: Buffer;
  try {
    raw = Buffer.from(text, "base64");
  } catch {
    return null;
  }
  if (raw.length < 12 + 16) return null; // 至少 nonce(12) + GCM tag(16)
  return { nonce: raw.subarray(0, 12), ciphertext: raw.subarray(12) };
}

export interface PutOAuthPendingStateOpts {
  provider: OAuthProvider;
  /** 原始 state(hex);仅用于计算 hash,绝不落库。 */
  state: string;
  /** 敏感 payload(如 {userId} / {verifier});加密后落库。 */
  payload: Record<string, unknown>;
  ttlMs?: number;
  runner?: QueryRunner;
  /** 测试注入 KMS key;省略时 loadKmsKey() 并在用完后清零。 */
  key?: Buffer;
  now?: () => number;
}

/**
 * 写入一条 pending state(OAuth start 时调用)。加密 payload、计算 hash、落 PG。
 * 附带懒 GC:best-effort 清理已过期行(OAuth start 是人为低频动作,多一条带索引的
 * DELETE 可忽略;GC 失败绝不影响本次 put)。
 */
export async function putOAuthPendingState(opts: PutOAuthPendingStateOpts): Promise<void> {
  const ttlMs = opts.ttlMs ?? OAUTH_PENDING_TTL_MS;
  const now = opts.now ?? Date.now;
  const stateHash = hashState(opts.provider, opts.state);
  const key = opts.key ?? loadKmsKey();
  try {
    const enc = encrypt(JSON.stringify(opts.payload), key, Buffer.from(stateHash));
    const expiresAt = new Date(now() + ttlMs);
    await query(
      `INSERT INTO oauth_pending_states (state_hash, payload, expires_at)
       VALUES ($1, $2, $3)`,
      [stateHash, packPayload(enc.ciphertext, enc.nonce), expiresAt],
      opts.runner,
    );
  } finally {
    if (!opts.key) zeroBuffer(key);
  }
  // 懒 GC:清过期行,best-effort。
  try {
    await gcExpiredOAuthPendingStates(opts.runner, now);
  } catch (err) {
    log.warn("oauth_pending_gc_failed", { err: (err as Error).message });
  }
}

export interface ConsumeOAuthPendingStateOpts {
  provider: OAuthProvider;
  state: string;
  runner?: QueryRunner;
  key?: Buffer;
}

/**
 * 原子消费一条 pending state(OAuth callback 时调用)。
 * 返回解密后的 payload;命中 0 行(不存在 / 已过期 / 已被消费过 = 重放)→ null。
 * 解密失败(密文被篡改 / KMS key 不匹配)→ null(fail-closed,当作无效 state)。
 */
export async function consumeOAuthPendingState(
  opts: ConsumeOAuthPendingStateOpts,
): Promise<Record<string, unknown> | null> {
  const stateHash = hashState(opts.provider, opts.state);
  // provider 已烘进 state_hash,DELETE 谓词无需 provider 列(对齐 0135 实际 schema)。
  const r = await query<{ payload: string }>(
    `DELETE FROM oauth_pending_states
      WHERE state_hash = $1 AND expires_at > now()
      RETURNING payload`,
    [stateHash],
    opts.runner,
  );
  const row = r.rows[0];
  if (!row) return null;
  const unpacked = unpackPayload(row.payload);
  if (!unpacked) {
    log.warn("oauth_pending_payload_malformed", { provider: opts.provider });
    return null;
  }
  const key = opts.key ?? loadKmsKey();
  try {
    const pt = decryptToBuffer(unpacked.ciphertext, unpacked.nonce, key, Buffer.from(stateHash));
    try {
      return JSON.parse(pt.toString("utf8")) as Record<string, unknown>;
    } finally {
      pt.fill(0);
    }
  } catch {
    // 密文异常不外泄细节;当作无效 state(state 行已被 DELETE 消费,不留复用窗口)。
    log.warn("oauth_pending_decrypt_failed", { provider: opts.provider });
    return null;
  } finally {
    if (!opts.key) zeroBuffer(key);
  }
}

/** 懒清理过期行,返回删除条数。可由集成者挂到既有 GC 调度里定期跑。 */
export async function gcExpiredOAuthPendingStates(
  runner?: QueryRunner,
  now: () => number = Date.now,
): Promise<number> {
  const r = await query(
    `DELETE FROM oauth_pending_states WHERE expires_at <= $1`,
    [new Date(now())],
    runner,
  );
  return r.rowCount ?? 0;
}
