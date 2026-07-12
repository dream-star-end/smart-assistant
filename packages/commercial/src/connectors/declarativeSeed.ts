/**
 * 默认连接器 seed:把 DEFAULT_CONNECTORS 落成 security_approved 的 marketplace listing+version。
 *
 * 走**完整审计路径**(securityApprove,不旁路):平台首方内容也经编译+签名+状态机,loadVerifiedContract
 * 才认。用两个**幂等的系统用户**(author≠reviewer,reviewer 为 active admin)满足 reviewer 约束——
 * 不引第二套"信任旁路"机制。幂等:某 slug 已有 security_approved 版本 → 跳过。
 */

import type { Pool } from 'pg'
import { getPool } from '../db/index.js'
import { DEFAULT_CONNECTORS } from './defaults/index.js'
import { canonicalSha256Hex } from './spec/canonical.js'
import { securityApprove } from './spec/review.js'

const SEED_AUTHOR_EMAIL = 'connectors-seed-author@system.openclaude'
const SEED_REVIEWER_EMAIL = 'connectors-seed-reviewer@system.openclaude'

/** 幂等建/取系统用户;role 强制到期望值(reviewer 必 active admin)。 */
async function ensureSystemUser(email: string, role: 'user' | 'admin', pool: Pool): Promise<number> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role, status)
       VALUES ($1, 'x', TRUE, $2, 'active')
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, status = 'active'
     RETURNING id::text AS id`,
    [email, role],
  )
  return Number(r.rows[0]!.id)
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
    // 幂等:已有 security_approved 版本 → 跳过。
    const existing = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM marketplace_skill_versions
        WHERE slug = $1 AND security_review_state = 'security_approved'`,
      [slug],
    )
    if (Number(existing.rows[0]?.n ?? '0') > 0) {
      skipped.push(slug)
      continue
    }

    const raw = JSON.stringify(d.spec)
    const specHash = canonicalSha256Hex(d.spec)
    await pool.query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind)
         VALUES ($1, $2, 'connector') ON CONFLICT (slug) DO NOTHING`,
      [slug, author],
    )
    const v = await pool.query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash, embedding_hash, submitted_by, status)
       VALUES ($1, '1.0.0', $2, $3, $4, $5, $5, $6, 'pending')
       RETURNING id::text AS id`,
      [slug, d.spec.label, d.spec.description.slice(0, 2000), raw, specHash, author],
    )
    const versionId = Number(v.rows[0]!.id)
    await securityApprove({
      versionId,
      reviewerUserId: reviewer,
      securityDecision: d.decision,
      expectedSpecHash: specHash,
      pool,
    })
    seeded.push(slug)
  }
  return { seeded, skipped }
}
