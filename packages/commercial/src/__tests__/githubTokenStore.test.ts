/**
 * GitHub token store 单元测试 — 使用 mock pool + mock loadKmsKey。
 *
 * 覆盖:
 *   1. saveGithubLink: 新插入调用 INSERT ON CONFLICT DO UPDATE(只 1 次 query,无 SELECT 预检查)
 *   2. saveGithubLink: pg 23505 + constraint=github_links_github_user_id_unique → GITHUB_ACCOUNT_ALREADY_LINKED
 *   3. saveGithubLink: 其他 pg 错(非 23505)→ 原样抛出
 *   4. getGithubLinkWithToken: 找到行 → 解密并返回;找不到 → null
 *   5. getGithubLinkPublic: 不返回 token,只返回公开字段
 *   6. revokeGithubLink: 调用 UPDATE 设置 revoked_at
 *   7. touchTokenChecked: 调用 UPDATE 设置 token_last_checked_at
 *
 * 加密/解密用真实 aead.ts,但注入固定 test KMS key(32 bytes)。
 */

import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { encrypt } from '../crypto/aead.js'
import {
  getGithubLinkPublic,
  getGithubLinkWithToken,
  revokeGithubLink,
  saveGithubLink,
  touchTokenChecked,
} from '../github/tokenStore.js'

// ─── Test KMS key setup ───────────────────────────────────────────────
// Inject a fixed 32-byte test key into OPENCLAUDE_KMS_KEY env
// so loadKmsKey() works without real KMS
const TEST_KMS_KEY = Buffer.alloc(32, 0xab) // 32 bytes
const TEST_KMS_KEY_B64 = TEST_KMS_KEY.toString('base64')

before(() => {
  process.env.OPENCLAUDE_KMS_KEY = TEST_KMS_KEY_B64
})

// ─── Mock pool helpers ────────────────────────────────────────────────

interface MockQueryCall {
  sql: string
  params: unknown[]
}

interface MockQueryResult<T = Record<string, unknown>> {
  rowCount: number
  rows: T[]
}

/**
 * Build a mock pg.Pool that records calls and returns preset results.
 */
function makeMockPool(responses: MockQueryResult[]): {
  pool: { query: (sql: string, params: unknown[]) => Promise<MockQueryResult> }
  calls: MockQueryCall[]
} {
  const calls: MockQueryCall[] = []
  let idx = 0
  const pool = {
    async query(sql: string, params: unknown[]): Promise<MockQueryResult> {
      calls.push({ sql, params })
      const result = responses[idx]
      idx++
      if (result === undefined) {
        return { rowCount: 0, rows: [] }
      }
      return result
    },
  }
  return {
    pool: pool as unknown as {
      query: (sql: string, params: unknown[]) => Promise<MockQueryResult>
    },
    calls,
  }
}

// ─── Tests ────────────────────────────────────────────────────────────

describe('saveGithubLink', () => {
  test('calls INSERT ON CONFLICT DO UPDATE (single query, no SELECT precheck)', async () => {
    const { pool, calls } = makeMockPool([
      { rowCount: 1, rows: [] }, // upsert
    ])
    await saveGithubLink({
      pool: pool as never,
      userId: 1,
      profile: { githubUserId: 100, login: 'octocat', avatarUrl: null, scopes: 'repo' },
      accessToken: 'ghp_token',
    })
    assert.equal(calls.length, 1, 'should issue exactly one query (no precheck race)')
    assert.match(calls[0]!.sql, /INSERT INTO github_links/)
    assert.match(calls[0]!.sql, /ON CONFLICT \(user_id\) DO UPDATE/)
  })

  test('translates pg 23505 on github_user_id partial UNIQUE → GITHUB_ACCOUNT_ALREADY_LINKED', async () => {
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'github_links_github_user_id_unique',
    })
    const pool = {
      async query() {
        throw pgErr
      },
    }
    await assert.rejects(
      saveGithubLink({
        pool: pool as never,
        userId: 1,
        profile: { githubUserId: 100, login: 'octocat', avatarUrl: null, scopes: 'repo' },
        accessToken: 'ghp_token',
      }),
      (err: unknown) => err instanceof Error && err.message === 'GITHUB_ACCOUNT_ALREADY_LINKED',
    )
  })

  test('rethrows other pg errors verbatim (not 23505 / different constraint)', async () => {
    const pgErr = Object.assign(new Error('connection terminated'), {
      code: '08006',
    })
    const pool = {
      async query() {
        throw pgErr
      },
    }
    await assert.rejects(
      saveGithubLink({
        pool: pool as never,
        userId: 1,
        profile: { githubUserId: 100, login: 'octocat', avatarUrl: null, scopes: 'repo' },
        accessToken: 'ghp_token',
      }),
      (err: unknown) =>
        err instanceof Error &&
        err.message === 'connection terminated' &&
        (err as { code?: string }).code === '08006',
    )
  })

  test('rethrows 23505 on different constraint (defensive — not our case)', async () => {
    const pgErr = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'some_other_unique_index',
    })
    const pool = {
      async query() {
        throw pgErr
      },
    }
    await assert.rejects(
      saveGithubLink({
        pool: pool as never,
        userId: 1,
        profile: { githubUserId: 100, login: 'octocat', avatarUrl: null, scopes: 'repo' },
        accessToken: 'ghp_token',
      }),
      (err: unknown) => err instanceof Error && err.message === 'duplicate key',
    )
  })

  test('passes encrypted token to INSERT (not plaintext)', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 1, rows: [] }])
    await saveGithubLink({
      pool: pool as never,
      userId: 1,
      profile: { githubUserId: 100, login: 'octocat', avatarUrl: null, scopes: 'repo' },
      accessToken: 'sensitive_token',
    })
    // The 5th param to INSERT should be a Buffer (ciphertext), not the plaintext string
    const insertParams = calls[0]!.params
    assert.ok(Buffer.isBuffer(insertParams[4]), 'access_token_enc should be a Buffer')
    assert.notEqual(insertParams[4]!.toString(), 'sensitive_token')
  })
})

describe('getGithubLinkWithToken', () => {
  test('returns null when no row found', async () => {
    const { pool } = makeMockPool([{ rowCount: 0, rows: [] }])
    const result = await getGithubLinkWithToken(pool as never, 1)
    assert.equal(result, null)
  })

  test('returns decrypted token when row found', async () => {
    // Encrypt a test token with the test KMS key
    const { encrypt: aeadEncrypt } = await import('../crypto/aead.js')
    const { ciphertext, nonce } = aeadEncrypt('ghp_real_token', TEST_KMS_KEY)

    const { pool } = makeMockPool([
      {
        rowCount: 1,
        rows: [
          {
            user_id: '42',
            github_user_id: '999',
            login: 'devuser',
            avatar_url: 'https://avatars.example.com/u/1',
            access_token_enc: ciphertext,
            access_token_nonce: nonce,
            scopes: 'repo read:user',
            revoked_at: null,
          },
        ],
      },
    ])
    const link = await getGithubLinkWithToken(pool as never, 42)
    assert.ok(link !== null)
    assert.equal(link.userId, 42)
    assert.equal(link.githubUserId, 999)
    assert.equal(link.login, 'devuser')
    assert.equal(link.avatarUrl, 'https://avatars.example.com/u/1')
    assert.equal(link.accessToken, 'ghp_real_token')
    assert.equal(link.scopes, 'repo read:user')
    assert.equal(link.revokedAt, null)
  })
})

describe('getGithubLinkPublic', () => {
  test('returns linked=false when no row', async () => {
    const { pool } = makeMockPool([{ rowCount: 0, rows: [] }])
    const result = await getGithubLinkPublic(pool as never, 1)
    assert.deepEqual(result, { linked: false })
  })

  test('returns public fields without token', async () => {
    const { pool } = makeMockPool([
      {
        rowCount: 1,
        rows: [{ login: 'octocat', avatar_url: 'https://avatars.example.com/u/1', scopes: 'repo' }],
      },
    ])
    const result = await getGithubLinkPublic(pool as never, 1)
    assert.equal(result.linked, true)
    assert.equal(result.login, 'octocat')
    assert.equal(result.avatarUrl, 'https://avatars.example.com/u/1')
    assert.equal(result.scopes, 'repo')
    // No accessToken in result
    assert.ok(!('accessToken' in result))
  })
})

describe('revokeGithubLink', () => {
  test('calls UPDATE with revoked_at = now()', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 1, rows: [] }])
    await revokeGithubLink(pool as never, 5)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /UPDATE github_links/)
    assert.match(calls[0]!.sql, /revoked_at = now\(\)/)
    assert.deepEqual(calls[0]!.params, [5])
  })
})

describe('touchTokenChecked', () => {
  test('calls UPDATE with token_last_checked_at = now()', async () => {
    const { pool, calls } = makeMockPool([{ rowCount: 1, rows: [] }])
    await touchTokenChecked(pool as never, 7)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /UPDATE github_links/)
    assert.match(calls[0]!.sql, /token_last_checked_at = now\(\)/)
    assert.deepEqual(calls[0]!.params, [7])
  })
})
