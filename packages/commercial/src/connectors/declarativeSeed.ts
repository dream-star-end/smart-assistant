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
import { tx } from '../db/queries.js'
import { approveMarketplaceConnectorVersionWithRunner } from '../marketplace/connectorReview.js'
import { DEFAULT_CONNECTORS } from './defaults/index.js'
import { canonicalSha256Hex } from './spec/canonical.js'

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

  for (const [index, d] of DEFAULT_CONNECTORS.entries()) {
    const slug = d.spec.id
    const raw = JSON.stringify(d.spec)
    const specHash = canonicalSha256Hex(d.spec)
    const version = `1.0.0+platform.${specHash.slice(0, 12)}`
    const changed = await tx(async (client) => {
      await client.query(
        `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind)
           VALUES ($1, $2, 'connector') ON CONFLICT (slug) DO NOTHING`,
        [slug, author],
      )
      await client.query(
        `INSERT INTO marketplace_skill_versions
           (slug, version, name, description, tags, raw_artifact, artifact_hash,
            embedding_hash, submitted_by, status, ai_review_state,
            category, use_cases, outcome_examples)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$7,$8,'pending',NULL,$9,$10::jsonb,'[]'::jsonb)
         ON CONFLICT (slug, version) DO NOTHING`,
        [
          slug,
          version,
          d.spec.label,
          d.spec.description.slice(0, 2000),
          JSON.stringify(d.tags),
          raw,
          specHash,
          author,
          d.category,
          JSON.stringify(d.useCases),
        ],
      )
      const before = await client.query<{
        id: string
        owner_user_id: string
        kind: string
        raw_artifact: string
        artifact_hash: string
        submitted_by: string
        status: string
        security_review_state: string
        functional_verify_state: string
        exec_revoked_at: Date | null
        current_approved_version_id: string | null
        state: string
      }>(
        `SELECT v.id::text, l.owner_user_id::text, l.kind, v.raw_artifact, v.artifact_hash,
                v.submitted_by::text, v.status, v.security_review_state,
                v.functional_verify_state, v.exec_revoked_at,
                l.current_approved_version_id::text, l.state
           FROM marketplace_skill_versions v
           JOIN marketplace_skill_listings l ON l.slug = v.slug
          WHERE v.slug = $1 AND v.version = $2`,
        [slug, version],
      )
      const row = before.rows[0]
      if (
        !row ||
        row.kind !== 'connector' ||
        Number(row.owner_user_id) !== author ||
        Number(row.submitted_by) !== author ||
        row.raw_artifact !== raw ||
        row.artifact_hash !== specHash ||
        row.exec_revoked_at !== null ||
        row.state === 'revoked'
      ) {
        throw new Error(`connector seed collision: ${slug}@${version}`)
      }
      const wasComplete =
        row.status === 'approved' &&
        row.security_review_state === 'security_approved' &&
        row.functional_verify_state === 'verified' &&
        row.current_approved_version_id === row.id &&
        row.state === 'active'

      // 同一外层事务内完成 version→listing 锁、编译签名、功能验收和 marketplace 上架；
      // 可从 security/function 已完成但 status 仍 pending 的历史半状态继续收敛。
      await approveMarketplaceConnectorVersionWithRunner(
        {
          versionId: row.id,
          reviewerUserId: reviewer,
          securityDecision: d.decision,
          expectedSpecHash: specHash,
          functionalVerified: true,
          note: 'platform-official connector seed',
          allowPlatformConvergence: true,
        },
        client,
      )
      await client.query(
        `UPDATE marketplace_skill_versions
            SET name = $2, description = $3, tags = $4::jsonb,
                category = $5, use_cases = $6::jsonb
          WHERE id = $1`,
        [
          row.id,
          d.spec.label,
          d.spec.description.slice(0, 2000),
          JSON.stringify(d.tags),
          d.category,
          JSON.stringify(d.useCases),
        ],
      )
      await client.query(
        `UPDATE marketplace_skill_listings
            SET featured_rank = $2, updated_at = NOW()
          WHERE slug = $1`,
        [slug, d.featured ? 100 + index : null],
      )
      return !wasComplete
    }, pool)
    ;(changed ? seeded : skipped).push(slug)
  }
  return { seeded, skipped }
}
