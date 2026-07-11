/**
 * 连接器 Contract 内核 · 审核状态机 + 载入即验签 集成测试(真 PG)。
 *
 * 覆盖(RFC §1.1/§6.1/§8b + 审计整改 P0/P1):
 *   - reviewer=author → REVIEWER_IS_AUTHOR;reviewer 非 admin → REVIEWER_NOT_ADMIN(P0-3)
 *   - securityApprove:同事务写 exec_contract/hash/签名/state=security_approved
 *   - artifact_hash 绑定 / expectedSpecHash TOCTOU(P0-3);spec.id≠slug 拒
 *   - kind 是 DB 事实:skill/agent version 调必败;kind 篡改后载入必败(P0-2)
 *   - loadVerifiedContract 返回等价 ExecContract(含 params/result,P0-4)
 *   - markFunctionalVerified 状态迁移;exec_revoked_at 后 → EXEC_REVOKED
 *   - policy 下限只能抬高,传 0 不能绕过 stale;传 >CURRENT 模拟升级 → POLICY_STALE(P0-1)
 *   - 篡改 exec_contract JSONB / hash 列 → HASH_MISMATCH;篡改 signature → SIGNATURE_INVALID
 *
 * 无 PG → skip(REQUIRE_TEST_DB=1 时硬失败),照仓内 integ 惯例。
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

// KMS key 必须在任何 sign/verify 前就位。
process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import {
  CURRENT_SECURITY_POLICY_VERSION,
  loadVerifiedContract,
  markFunctionalVerified,
  revokeExecVersion,
  securityApprove,
} from '../connectors/spec/review.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'

let pgAvailable = false

async function probe(): Promise<boolean> {
  const p = createPool({ connectionString: TEST_DB_URL, max: 2, connectionTimeoutMillis: 1500 })
  try {
    await p.query('SELECT 1')
    await p.end()
    return true
  } catch {
    try {
      await p.end()
    } catch {
      /* */
    }
    return false
  }
}

async function dropAllTables(): Promise<void> {
  const db = await query<{ db: string }>('SELECT current_database() AS db')
  const name = db.rows[0]?.db ?? ''
  if (!/_test$/.test(name)) throw new Error(`refusing to drop tables on non-test database: ${name}`)
  await query(`
    DO $$ DECLARE r RECORD;
    BEGIN
      FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
        EXECUTE 'DROP TABLE IF EXISTS public.' || quote_ident(r.tablename) || ' CASCADE';
      END LOOP;
    END $$;
  `)
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('CREATE SCHEMA IF NOT EXISTS public')
  await dropAllTables()
  await runMigrations() // 全量迁移含 0132 —— 顺带验证迁移可干净 apply
})

after(async () => {
  if (pgAvailable) {
    try {
      await dropAllTables()
    } catch {
      /* */
    }
    await closePool()
  }
})

function skipIfNoDb(t: { skip: (reason: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

function isCode(code: string) {
  return (err: unknown) => err instanceof ConnectorSpecError && err.code === code
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function validSpec(id: string): Record<string, unknown> {
  return {
    id,
    label: 'Notion',
    description: 'read notion',
    authMode: 'static-token',
    auth: {
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
    },
    actions: [
      {
        id: 'get_page',
        description: 'get a page',
        request: { method: 'GET', pathTemplate: '/v1/pages', query: { pageId: '/params/pageId' } },
        params: { type: 'object', additionalProperties: false },
        result: { type: 'object', additionalProperties: false },
        usesSlot: 'api-token',
      },
    ],
  }
}

const decision = {
  audience: {
    authorizationOrigins: [],
    tokenOrigins: [],
    apiOrigins: ['https://api.notion.com:443'],
    unauthenticatedUploadOrigins: [],
  },
  actions: {},
}

let userSeq = 0
async function mkUser(role: 'user' | 'admin' = 'user'): Promise<number> {
  userSeq += 1
  const r = await query<{ id: string }>(
    `INSERT INTO users(email, password_hash, email_verified, role)
     VALUES ($1, 'x', TRUE, $2) RETURNING id::text AS id`,
    [`spec-u${userSeq}-${Date.now()}@t.local`, role],
  )
  return Number(r.rows[0]!.id)
}
const mkAdmin = () => mkUser('admin')

let slugSeq = 0
async function mkVersion(
  submittedBy: number,
  opts: { kind?: string; spec?: Record<string, unknown> } = {},
): Promise<{ versionId: number; slug: string; spec: Record<string, unknown>; specHash: string }> {
  slugSeq += 1
  const kind = opts.kind ?? 'connector'
  const slug = `conn-${slugSeq}-${Date.now()}`
  const theSpec = opts.spec ?? validSpec(slug)
  const raw = JSON.stringify(theSpec)
  // artifact_hash = canonical sha256 of the spec(与 compiler.spec_hash 同定义)。
  const specHash = canonicalSha256Hex(theSpec)
  await query(
    'INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind) VALUES ($1, $2, $3)',
    [slug, submittedBy, kind],
  )
  const r = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions
       (slug, version, name, description, raw_artifact, artifact_hash, embedding_hash, submitted_by, status)
     VALUES ($1, '1.0.0', $2, 'd', $3, $4, $4, $5, 'pending')
     RETURNING id::text AS id`,
    [slug, slug, raw, specHash, submittedBy],
  )
  return { versionId: Number(r.rows[0]!.id), slug, spec: theSpec, specHash }
}

function approve(
  versionId: number,
  reviewer: number,
  specHash: string,
): ReturnType<typeof securityApprove> {
  return securityApprove({
    versionId,
    reviewerUserId: reviewer,
    securityDecision: decision,
    expectedSpecHash: specHash,
    pool: getPool(),
  })
}

async function stateOf(versionId: number): Promise<Record<string, unknown>> {
  const r = await query<Record<string, unknown>>(
    `SELECT security_review_state, functional_verify_state, exec_revoked_at,
            security_reviewed_by::text AS security_reviewed_by, security_policy_version,
            compiler_version, key_id,
            (exec_contract IS NOT NULL) AS has_contract,
            (signature IS NOT NULL) AS has_sig,
            (exec_contract_hash IS NOT NULL) AS has_hash
       FROM marketplace_skill_versions WHERE id = $1`,
    [versionId],
  )
  return r.rows[0]!
}

// ─── securityApprove ─────────────────────────────────────────────────────────

describe('securityApprove', () => {
  test('happy path:同事务写 contract+hash+签名+state', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, spec, specHash } = await mkVersion(author)
    const res = await approve(versionId, reviewer, specHash)
    const local = compileSpec(spec, decision)
    assert.equal(res.execContractHash, local.execContractHash)
    assert.equal(res.specHash, local.specHash)
    assert.equal(res.policyVersion, CURRENT_SECURITY_POLICY_VERSION)

    const s = await stateOf(versionId)
    assert.equal(s.security_review_state, 'security_approved')
    assert.equal(s.has_contract, true)
    assert.equal(s.has_sig, true)
    assert.equal(s.has_hash, true)
    assert.equal(Number(s.security_reviewed_by), reviewer)
    assert.equal(Number(s.security_policy_version), CURRENT_SECURITY_POLICY_VERSION)
  })

  test('reviewer=author → REVIEWER_IS_AUTHOR,行留 draft(事务回滚)', async (t) => {
    if (skipIfNoDb(t)) return
    // author 本人恰是 admin,但仍不能自审。
    const author = await mkAdmin()
    const { versionId, specHash } = await mkVersion(author)
    await assert.rejects(approve(versionId, author, specHash), isCode('REVIEWER_IS_AUTHOR'))
    const s = await stateOf(versionId)
    assert.equal(s.security_review_state, 'draft')
    assert.equal(s.has_contract, false)
  })

  test('reviewer 非 admin → REVIEWER_NOT_ADMIN(P0-3)', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const nonAdmin = await mkUser() // role='user'
    const { versionId, specHash } = await mkVersion(author)
    await assert.rejects(approve(versionId, nonAdmin, specHash), isCode('REVIEWER_NOT_ADMIN'))
    assert.equal((await stateOf(versionId)).security_review_state, 'draft')
  })

  test('banned admin(status≠active)→ REVIEWER_NOT_ADMIN', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    await query(`UPDATE users SET status='banned' WHERE id=$1`, [reviewer])
    const { versionId, specHash } = await mkVersion(author)
    await assert.rejects(approve(versionId, reviewer, specHash), isCode('REVIEWER_NOT_ADMIN'))
  })

  test('skill/agent version 调本函数 → WRONG_ARTIFACT_KIND(P0-2)', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, specHash } = await mkVersion(author, { kind: 'skill' })
    await assert.rejects(approve(versionId, reviewer, specHash), isCode('WRONG_ARTIFACT_KIND'))
  })

  test('expectedSpecHash 不符 → SPEC_HASH_MISMATCH(TOCTOU,P0-3)', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId } = await mkVersion(author)
    await assert.rejects(approve(versionId, reviewer, 'f'.repeat(64)), isCode('SPEC_HASH_MISMATCH'))
  })

  test('raw 被改致 artifact_hash 不符 → ARTIFACT_HASH_MISMATCH(P0-3)', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, slug, specHash } = await mkVersion(author)
    // 篡改 raw_artifact(仍是合法 connector spec,但内容变 → canonical hash 变),
    // artifact_hash 列仍是旧值 → 编译 spec_hash ≠ artifact_hash。
    const tampered = validSpec(slug)
    tampered.description = 'TAMPERED'
    await query('UPDATE marketplace_skill_versions SET raw_artifact=$2 WHERE id=$1', [
      versionId,
      JSON.stringify(tampered),
    ])
    await assert.rejects(approve(versionId, reviewer, specHash), isCode('ARTIFACT_HASH_MISMATCH'))
  })

  test('spec.id ≠ slug → SPEC_ID_MISMATCH', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    // slug 与 spec.id 故意不同;artifact_hash/expectedSpecHash 都按该 spec 算(先过前两闸)。
    const spec = validSpec('some-other-id')
    const slug = `conn-x-${Date.now()}`
    const raw = JSON.stringify(spec)
    const h = canonicalSha256Hex(spec)
    await query(
      `INSERT INTO marketplace_skill_listings(slug, owner_user_id, kind) VALUES ($1,$2,'connector')`,
      [slug, author],
    )
    const r = await query<{ id: string }>(
      `INSERT INTO marketplace_skill_versions
         (slug, version, name, description, raw_artifact, artifact_hash, embedding_hash, submitted_by, status)
       VALUES ($1,'1.0.0',$1,'d',$2,$3,$3,$4,'pending') RETURNING id::text AS id`,
      [slug, raw, h, author],
    )
    const versionId = Number(r.rows[0]!.id)
    await assert.rejects(approve(versionId, reviewer, h), isCode('SPEC_ID_MISMATCH'))
  })

  test('非 draft 再审 → NOT_DRAFT', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, specHash } = await mkVersion(author)
    await approve(versionId, reviewer, specHash)
    await assert.rejects(approve(versionId, reviewer, specHash), isCode('NOT_DRAFT'))
  })

  test('VERSION_NOT_FOUND', async (t) => {
    if (skipIfNoDb(t)) return
    const reviewer = await mkAdmin()
    await assert.rejects(approve(999999999, reviewer, 'a'.repeat(64)), isCode('VERSION_NOT_FOUND'))
  })
})

// ─── loadVerifiedContract ────────────────────────────────────────────────────

describe('loadVerifiedContract', () => {
  async function approved(): Promise<{
    versionId: number
    slug: string
    spec: Record<string, unknown>
  }> {
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, slug, spec, specHash } = await mkVersion(author)
    await approve(versionId, reviewer, specHash)
    return { versionId, slug, spec }
  }

  test('approved → 返回等价 ExecContract(含 params/result)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, spec } = await approved()
    const loaded = await loadVerifiedContract(versionId, getPool())
    assert.deepEqual(loaded, compileSpec(spec, decision).execContract)
    // P0-4:params/result 已签进 contract。
    assert.equal(loaded.actions[0]?.params !== undefined, true)
    assert.equal(loaded.actions[0]?.result !== undefined, true)
  })

  test('draft → NOT_SECURITY_APPROVED', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const { versionId } = await mkVersion(author)
    await assert.rejects(
      loadVerifiedContract(versionId, getPool()),
      isCode('NOT_SECURITY_APPROVED'),
    )
  })

  test('kind 被篡改成 skill → WRONG_ARTIFACT_KIND(P0-2)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId, slug } = await approved()
    await query(`UPDATE marketplace_skill_listings SET kind='skill' WHERE slug=$1`, [slug])
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('WRONG_ARTIFACT_KIND'))
  })

  test('exec_revoked_at 置位 → EXEC_REVOKED(fail-closed)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    await revokeExecVersion(versionId, getPool())
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('EXEC_REVOKED'))
  })

  test('policy 下限只能抬高:传 minPolicyVersion=0 仍不能绕过 stale(P0-1)', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    // 模拟一个 policy 低于当前的旧 contract(存列被降到 0)。
    await query('UPDATE marketplace_skill_versions SET security_policy_version=0 WHERE id=$1', [
      versionId,
    ])
    // 默认 → floor=CURRENT → stale
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('POLICY_STALE'))
    // 恶意传 0 想压低下限 → clamp 后 floor 仍=CURRENT → 依旧 stale
    await assert.rejects(
      loadVerifiedContract(versionId, getPool(), { minPolicyVersion: 0 }),
      isCode('POLICY_STALE'),
    )
  })

  test('模拟策略升级:minPolicyVersion>CURRENT → POLICY_STALE', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    await assert.rejects(
      loadVerifiedContract(versionId, getPool(), {
        minPolicyVersion: CURRENT_SECURITY_POLICY_VERSION + 1,
      }),
      isCode('POLICY_STALE'),
    )
  })

  test('篡改 exec_contract JSONB → HASH_MISMATCH', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    await query(
      `UPDATE marketplace_skill_versions
          SET exec_contract = exec_contract || '{"authMode":"oauth2-auth-code"}'::jsonb
        WHERE id = $1`,
      [versionId],
    )
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('HASH_MISMATCH'))
  })

  test('篡改 exec_contract_hash 列 → HASH_MISMATCH', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    await query(
      `UPDATE marketplace_skill_versions SET exec_contract_hash = decode(repeat('00',32),'hex') WHERE id = $1`,
      [versionId],
    )
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('HASH_MISMATCH'))
  })

  test('篡改 signature → SIGNATURE_INVALID', async (t) => {
    if (skipIfNoDb(t)) return
    const { versionId } = await approved()
    await query(
      `UPDATE marketplace_skill_versions SET signature = decode(repeat('00',32),'hex') WHERE id = $1`,
      [versionId],
    )
    await assert.rejects(loadVerifiedContract(versionId, getPool()), isCode('SIGNATURE_INVALID'))
  })

  test('VERSION_NOT_FOUND', async (t) => {
    if (skipIfNoDb(t)) return
    await assert.rejects(loadVerifiedContract(888888888, getPool()), isCode('VERSION_NOT_FOUND'))
  })
})

// ─── markFunctionalVerified / revokeExecVersion ──────────────────────────────

describe('markFunctionalVerified / revokeExecVersion', () => {
  test('security_approved → verified', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, specHash } = await mkVersion(author)
    await approve(versionId, reviewer, specHash)
    await markFunctionalVerified(versionId, getPool())
    assert.equal((await stateOf(versionId)).functional_verify_state, 'verified')
  })

  test('draft 不能直接 verified → INVALID_STATE', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const { versionId } = await mkVersion(author)
    await assert.rejects(markFunctionalVerified(versionId, getPool()), isCode('INVALID_STATE'))
  })

  test('revokeExecVersion 幂等', async (t) => {
    if (skipIfNoDb(t)) return
    const author = await mkUser()
    const reviewer = await mkAdmin()
    const { versionId, specHash } = await mkVersion(author)
    await approve(versionId, reviewer, specHash)
    await revokeExecVersion(versionId, getPool())
    await revokeExecVersion(versionId, getPool()) // 二次 no-op
    assert.notEqual((await stateOf(versionId)).exec_revoked_at, null)
  })

  test('revokeExecVersion 未知 version → VERSION_NOT_FOUND', async (t) => {
    if (skipIfNoDb(t)) return
    await assert.rejects(revokeExecVersion(777777777, getPool()), isCode('VERSION_NOT_FOUND'))
  })
})
