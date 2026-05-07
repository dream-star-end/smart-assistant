/**
 * GitHub OAuth token 存储 — 加密存取 github_links 表。
 *
 * access_token 使用 AES-256-GCM (crypto/aead.ts) 加密,key 来自 loadKmsKey()。
 * 与 account-pool/store.ts 相同的加密机制。
 *
 * 设计约束:
 *   - 每个 OpenClaude user 最多关联一个 GitHub 账号(PRIMARY KEY user_id)
 *   - 每个 GitHub 账号只能被一个 OpenClaude user 关联(UNIQUE INDEX on github_user_id WHERE revoked_at IS NULL)
 *   - revoke 保留行(便于审计);partial UNIQUE INDEX 允许 revoke 后重新关联
 *   - access_token 用完即清零(zeroBuffer)
 */

import type { Pool } from 'pg'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'

export interface GithubLinkProfile {
  githubUserId: number
  login: string
  avatarUrl: string | null
  scopes: string // 空格分隔,保持 GitHub 原始格式
}

/**
 * 保存 GitHub OAuth 关联(upsert by user_id)。
 *
 * 若 github_user_id 已被另一个未 revoke 的 user 关联,抛 Error('GITHUB_ACCOUNT_ALREADY_LINKED')。
 * 若当前 user 已有关联(包括已 revoke 的),UPDATE 覆盖(revoked_at 清空,重新激活)。
 */
export async function saveGithubLink(opts: {
  pool: Pool
  userId: number
  profile: GithubLinkProfile
  accessToken: string
}): Promise<void> {
  const { pool, userId, profile, accessToken } = opts
  const key = loadKmsKey()
  let tokenEnc: ReturnType<typeof encrypt> | null = null
  try {
    tokenEnc = encrypt(accessToken, key)

    // Upsert: INSERT or UPDATE (覆盖现有行,包括 revoked 状态的)
    // 唯一冲突权威源 = partial UNIQUE INDEX `github_links_github_user_id_unique`
    // (github_user_id WHERE revoked_at IS NULL)。捕获 pg 23505 即可,
    // 不再做 SELECT 预检查 — 预检查与 INSERT 之间存在并发窗口,partial index 才是真锁。
    try {
      await pool.query(
        `INSERT INTO github_links
           (user_id, github_user_id, login, avatar_url, access_token_enc, access_token_nonce, scopes, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, now())
         ON CONFLICT (user_id) DO UPDATE SET
           github_user_id    = EXCLUDED.github_user_id,
           login             = EXCLUDED.login,
           avatar_url        = EXCLUDED.avatar_url,
           access_token_enc  = EXCLUDED.access_token_enc,
           access_token_nonce = EXCLUDED.access_token_nonce,
           scopes            = EXCLUDED.scopes,
           revoked_at        = NULL,
           updated_at        = now()`,
        [
          userId,
          profile.githubUserId,
          profile.login,
          profile.avatarUrl,
          tokenEnc.ciphertext,
          tokenEnc.nonce,
          profile.scopes,
        ],
      )
    } catch (err) {
      const pgErr = err as { code?: string; constraint?: string }
      if (
        pgErr?.code === '23505' &&
        pgErr?.constraint === 'github_links_github_user_id_unique'
      ) {
        throw new Error('GITHUB_ACCOUNT_ALREADY_LINKED')
      }
      throw err
    }
  } finally {
    zeroBuffer(key)
  }
}

export interface DecryptedGithubLink {
  userId: number
  githubUserId: number
  login: string
  avatarUrl: string | null
  accessToken: string
  scopes: string
  revokedAt: Date | null
}

interface RawGithubLinkRow {
  user_id: string
  github_user_id: string
  login: string
  avatar_url: string | null
  access_token_enc: Buffer
  access_token_nonce: Buffer
  scopes: string
  revoked_at: Date | null
}

/**
 * 读取并解密 GitHub token。
 * 返回 null 当:没有关联行,或该关联已 revoke。
 */
export async function getGithubLinkWithToken(
  pool: Pool,
  userId: number,
): Promise<DecryptedGithubLink | null> {
  const res = await pool.query<RawGithubLinkRow>(
    `SELECT user_id::text AS user_id,
            github_user_id::text AS github_user_id,
            login, avatar_url,
            access_token_enc, access_token_nonce,
            scopes, revoked_at
       FROM github_links
      WHERE user_id = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [userId],
  )
  if (res.rowCount === 0) return null
  const row = res.rows[0]!

  const key = loadKmsKey()
  let tokenBuf: Buffer | null = null
  try {
    tokenBuf = decryptToBuffer(row.access_token_enc, row.access_token_nonce, key)
    const accessToken = tokenBuf.toString('utf8')
    return {
      userId: Number(row.user_id),
      githubUserId: Number(row.github_user_id),
      login: row.login,
      avatarUrl: row.avatar_url,
      accessToken,
      scopes: row.scopes,
      revokedAt: row.revoked_at,
    }
  } finally {
    zeroBuffer(key)
    if (tokenBuf) zeroBuffer(tokenBuf)
  }
}

interface PublicGithubLinkRow {
  linked: boolean
  login?: string
  avatarUrl?: string | null
  scopes?: string
}

/**
 * 返回 GitHub 关联的公开展示字段(不解密 token)。
 */
export async function getGithubLinkPublic(
  pool: Pool,
  userId: number,
): Promise<PublicGithubLinkRow> {
  const res = await pool.query<{ login: string; avatar_url: string | null; scopes: string }>(
    `SELECT login, avatar_url, scopes
       FROM github_links
      WHERE user_id = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [userId],
  )
  if (res.rowCount === 0) return { linked: false }
  const row = res.rows[0]!
  return {
    linked: true,
    login: row.login,
    avatarUrl: row.avatar_url,
    scopes: row.scopes,
  }
}

/**
 * 撤销 GitHub 关联:UPDATE revoked_at = now()。
 * 保留行便于审计;UNIQUE INDEX (github_user_id WHERE revoked_at IS NULL) 不冲突,
 * 撤销后可重新关联。
 */
export async function revokeGithubLink(pool: Pool, userId: number): Promise<void> {
  await pool.query(
    `UPDATE github_links
        SET revoked_at = now(), updated_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [userId],
  )
}

/**
 * 撤销 + 级联清理:在同一事务里 revoke link + 把该 user 全部活跃 session 选择
 * 设为 'cleared',error_code = $errorCode。
 *
 * 调用场景:
 *   1. 用户主动 DELETE /api/me/github(errorCode='user_revoked')
 *   2. GitHub 返 401 Token Invalid 时(errorCode='link_revoked')
 *
 * 返回受影响的会话行数(便于日志 + 测试断言)。
 *
 * 注意:这里用 BEGIN/COMMIT 显式事务而不是 pool.query 单 statement —
 * 因为 revoke + clear-all 必须原子,不允许"link 撤了但 session 没清"这种半成品状态。
 * 用 client.query('BEGIN'/'ROLLBACK')pattern,失败时回滚。
 */
export async function revokeGithubLinkAndClearSessions(
  pool: Pool,
  userId: number,
  errorCode: string,
): Promise<{ sessionsCleared: number }> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `UPDATE github_links
          SET revoked_at = now(), updated_at = now()
        WHERE user_id = $1
          AND revoked_at IS NULL`,
      [userId],
    )
    // 语义变化才 UPDATE — status / error_code / error_message 任一不收敛都视为变化。
    // 与 sessionWorkspaces.clearAllSessionSelections 保持一致(权威源同一段 SQL)。
    const r = await client.query(
      `UPDATE github_session_workspaces
          SET status            = 'cleared',
              error_code        = $2,
              error_message     = NULL,
              selection_version = selection_version + 1,
              updated_at        = now()
        WHERE user_id = $1
          AND (status <> 'cleared'
               OR error_code IS DISTINCT FROM $2
               OR error_message IS NOT NULL)`,
      [userId, errorCode],
    )
    await client.query('COMMIT')
    return { sessionsCleared: r.rowCount ?? 0 }
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // best-effort rollback
    }
    throw err
  } finally {
    client.release()
  }
}

/**
 * 更新 token_last_checked_at = now()(token 有效性探活后调用)。
 */
export async function touchTokenChecked(pool: Pool, userId: number): Promise<void> {
  await pool.query(
    `UPDATE github_links
        SET token_last_checked_at = now(), updated_at = now()
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [userId],
  )
}
