/**
 * 默认连接器 seed:把 DEFAULT_CONNECTORS 落成 security_approved 的 marketplace listing+version。
 *
 * 走**完整审计路径**(securityApprove,不旁路):平台首方内容也经编译+签名+状态机,loadVerifiedContract
 * 才认。用两个**幂等的系统用户**(author≠reviewer,reviewer 为 active admin)满足 reviewer 约束——
 * 不引第二套"信任旁路"机制。系统主体冲突时绝不接管已有账号；每个默认 spec 用其 hash
 * 生成确定性 semver，崩溃在 insert/签名/功能验收任一点都可从原状态继续。
 */

import type { Pool } from 'pg'
import { getPool } from '../db/index.js'
import { DEFAULT_CONNECTORS } from './defaults/index.js'
import { canonicalSha256Hex } from './spec/canonical.js'
import { markFunctionalVerified, securityApprove } from './spec/review.js'

const SEED_AUTHOR_EMAIL = 'connectors-seed-author@system.openclaude'
const SEED_REVIEWER_EMAIL = 'connectors-seed-reviewer@system.openclaude'
const SYSTEM_PASSWORD_SENTINEL = '!openclaude-system-principal:connector-seed:v1!'

/** 幂等建/取系统用户；冲突账号必须逐字段证明就是预置主体，绝不提升/激活既有用户。 */
async function ensureSystemUser(
  email: string,
  role: 'user' | 'admin',
  pool: Pool,
): Promise<number> {
  await pool.query(
    `INSERT INTO users(email, password_hash, email_verified, role, status)
       VALUES ($1, $2, TRUE, $3, 'active')
     ON CONFLICT (email) DO NOTHING`,
    [email, SYSTEM_PASSWORD_SENTINEL, role],
  )
  const r = await pool.query<{
    id: string
    password_hash: string
    email_verified: boolean
    role: string
    status: string
  }>(
    `SELECT id::text AS id, password_hash, email_verified, role, status
       FROM users WHERE email = $1`,
    [email],
  )
  const row = r.rows[0]
  if (
    !row ||
    row.password_hash !== SYSTEM_PASSWORD_SENTINEL ||
    row.email_verified !== true ||
    row.role !== role ||
    row.status !== 'active'
  ) {
    throw new Error(`connector seed service principal collision: ${email}`)
  }
  return Number(row.id)
}

export interface SeedResult {
  seeded: string[]
  skipped: string[]
}

export async function seedDefaultConnectors(pool: Pool = getPool()): Promise<SeedResult> {
  const author = await ensureSystemUser(SEED_AUTHOR_EMAIL, 'user', pool)
  const reviewer = await ensureSystemUser(SEED_REVIEWER_EMAIL, 'admin', pool)
  const seeded: string[] = []
  const skipped: string[] = []

  for (const d of DEFAULT_CONNECTORS) {
    const slug = d.spec.id
    const raw = JSON.stringify(d.spec)
    const specHash = canonicalSha256Hex(d.spec)
    // 只跳过“当前字节 + 两阶段验收完成 + 未撤销”的版本；旧 spec 不能永久卡住升级。
    const existing = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketplace_skill_versions
        WHERE slug = $1
          AND artifact_hash = $2
          AND security_review_state = 'security_approved'
          AND functional_verify_state = 'verified'
          AND exec_revoked_at IS NULL`,
      [slug, specHash],
    )
    if (Number(existing.rows[0]?.n ?? '0') > 0) {
      skipped.push(slug)
      continue
    }

    await pool.query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind)
         VALUES ($1, $2, 'connector') ON CONFLICT (slug) DO NOTHING`,
      [slug, author],
    )
    const listing = await pool.query<{ owner_user_id: string; kind: string }>(
      `SELECT owner_user_id::text AS owner_user_id, kind
         FROM marketplace_skill_listings WHERE slug = $1`,
      [slug],
    )
    if (
      listing.rows[0]?.kind !== 'connector' ||
      Number(listing.rows[0]?.owner_user_id) !== author
    ) {
      throw new Error(`connector seed listing collision: ${slug}`)
    }

    const version = `1.0.0+platform.${specHash.slice(0, 12)}`
    await pool.query(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash, embedding_hash, submitted_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'pending')
       ON CONFLICT (slug, version) DO NOTHING`,
      [slug, version, d.spec.label, d.spec.description.slice(0, 2000), raw, specHash, author],
    )
    const v = await pool.query<{
      id: string
      raw_artifact: string
      artifact_hash: string
      submitted_by: string
      security_review_state: string
      functional_verify_state: string
      exec_revoked_at: Date | null
    }>(
      `SELECT id::text AS id, raw_artifact, artifact_hash, submitted_by::text AS submitted_by,
              security_review_state, functional_verify_state, exec_revoked_at
         FROM marketplace_skill_versions WHERE slug = $1 AND version = $2`,
      [slug, version],
    )
    const row = v.rows[0]
    if (
      !row ||
      row.raw_artifact !== raw ||
      row.artifact_hash !== specHash ||
      Number(row.submitted_by) !== author ||
      row.exec_revoked_at !== null
    ) {
      throw new Error(`connector seed version collision: ${slug}@${version}`)
    }
    const versionId = Number(row.id)
    if (row.security_review_state === 'draft') {
      await securityApprove({
        versionId,
        reviewerUserId: reviewer,
        securityDecision: d.decision,
        expectedSpecHash: specHash,
        pool,
      })
    } else if (row.security_review_state !== 'security_approved') {
      throw new Error(`connector seed version cannot resume: ${slug}@${version}`)
    }
    if (row.functional_verify_state === 'unverified') {
      await markFunctionalVerified(versionId, reviewer, pool)
    }
    seeded.push(slug)
  }
  return { seeded, skipped }
}
