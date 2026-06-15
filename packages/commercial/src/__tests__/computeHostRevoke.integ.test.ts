/**
 * A3 — compute-host revocation kill-switch 的真 SQL + 状态机终态不变量集成测试。
 *
 * 覆盖:
 *   - setRevoked: ready→revoked + 清 fingerprint + 写 admin.revoke audit;self 拒;
 *     不存在拒;idempotent
 *   - resolveServiceableHostTarget: revoked / 缺 fingerprint / 不存在 → HostNotServiceableError;
 *     ready+fp+有效 psk → 返回 target 且 requireFingerprint=true(B8)
 *   - 终态不变量:setQuarantined / setDraining / clearQuarantine / updateStatus 都不得把
 *     revoked 拉回其它状态(无声 un-revoke 防护)
 *   - migration 0081:status CHECK 接受 'revoked',且仍接受既有状态(superset,不回归)
 *
 * 本地运行:
 *   TEST_DATABASE_URL=postgres://octest:octest@127.0.0.1:5432/openclaude_commercial_test \
 *   REQUIRE_TEST_DB=1 npx tsx --test src/__tests__/computeHostRevoke.integ.test.ts
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

// crypto 在 call time 读 KMS key;必须在 import 任何 crypto-using 模块前注入。
process.env.OPENCLAUDE_KMS_KEY ??= Buffer.alloc(32, 0x3a).toString('base64')

import { listAuditEventsForHost } from '../compute-pool/audit.js'
import { encryptAgentPsk } from '../compute-pool/crypto.js'
import {
  HostNotServiceableError,
  resolveServiceableHostTarget,
} from '../compute-pool/nodeAgentClient.js'
import {
  clearQuarantine,
  getHostById,
  markBootstrapResult,
  setDraining,
  setQuarantined,
  setRevoked,
  updateCert,
  updateStatus,
} from '../compute-pool/queries.js'
import { closePool, createPool, getPool, resetPool, setPoolOverride } from '../db/index.js'
import { runMigrations } from '../db/migrate.js'
import { query } from '../db/queries.js'

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@127.0.0.1:55432/openclaude_test'
const REQUIRE_TEST_DB = process.env.CI === 'true' || process.env.REQUIRE_TEST_DB === '1'
const MISSING_UUID = '00000000-0000-0000-0000-000000000000'

let pgAvailable = false

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '')
  if (!dbName.endsWith('_test')) throw new Error(`refusing non-test database: ${dbName}`)
}

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
      /* ignore */
    }
    return false
  }
}

before(async () => {
  pgAvailable = await probe()
  if (!pgAvailable) {
    if (REQUIRE_TEST_DB) throw new Error('Postgres test fixture required')
    return
  }
  assertTestDatabase(TEST_DB_URL)
  await resetPool()
  setPoolOverride(createPool({ connectionString: TEST_DB_URL, max: 10 }))
  await query('DROP SCHEMA IF EXISTS public CASCADE')
  await query('CREATE SCHEMA public')
  await query('GRANT ALL ON SCHEMA public TO public')
  await runMigrations()
})

after(async () => {
  if (pgAvailable) await closePool()
})

beforeEach(async () => {
  if (!pgAvailable) return
  await query('TRUNCATE TABLE compute_host_audit RESTART IDENTITY CASCADE')
  await query(`DELETE FROM compute_hosts WHERE name <> 'self'`)
})

function skip(t: { skip: (r: string) => void }): boolean {
  if (!pgAvailable) {
    t.skip('pg not available')
    return true
  }
  return false
}

/**
 * 插一台 host(非 self)。AEAD 字段先填非空占位满足 compute_hosts_aead_nonempty;
 * validPsk=true 时再用 encryptAgentPsk 回写真正可解密的 psk(供 hostRowToTarget 用)。
 */
async function insertHost(
  name: string,
  opts: { status?: string; withFingerprint?: boolean; validPsk?: boolean } = {},
): Promise<string> {
  const status = opts.status ?? 'ready'
  const fp = opts.withFingerprint === false ? null : 'aa:bb:cc:dd'
  const r = await query<{ id: string }>(
    `INSERT INTO compute_hosts(
       name, host, ssh_port, ssh_user, agent_port,
       ssh_password_nonce, ssh_password_ct, agent_psk_nonce, agent_psk_ct,
       max_containers, bridge_cidr, status, agent_cert_fingerprint_sha256
     ) VALUES (
       $1, '10.0.0.9', 22, 'root', 9443,
       '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea, '\\x01'::bytea,
       10, '172.30.9.0/24', $2, $3
     ) RETURNING id`,
    [name, status, fp],
  )
  const id = r.rows[0]!.id
  if (opts.validPsk) {
    const enc = encryptAgentPsk(id, randomBytes(32))
    await query(`UPDATE compute_hosts SET agent_psk_nonce = $2, agent_psk_ct = $3 WHERE id = $1`, [
      id,
      enc.nonce,
      enc.ciphertext,
    ])
  }
  return id
}

describe('setRevoked', () => {
  test('ready → revoked + 清 fingerprint + 写 admin.revoke audit', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-rev-1', { withFingerprint: true })
    const ok = await setRevoked(id, { actor: 'admin:1', operationId: 'op-rev-1' })
    assert.equal(ok, true)
    const row = await getHostById(id)
    assert.equal(row!.status, 'revoked')
    assert.equal(row!.agent_cert_fingerprint_sha256, null)
    const events = await listAuditEventsForHost(getPool(), id)
    assert.ok(events.some((e) => e.operation === 'admin.revoke'))
  })

  test('idempotent:已 revoked 再 revoke 仍 true', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-rev-2', { withFingerprint: true })
    assert.equal(await setRevoked(id, { actor: 'admin:1' }), true)
    assert.equal(await setRevoked(id, { actor: 'admin:1' }), true)
    assert.equal((await getHostById(id))!.status, 'revoked')
  })

  test('self host 不可吊销 → false 且状态不变 revoked', async (t) => {
    if (skip(t)) return
    const self = await query<{ id: string }>(`SELECT id FROM compute_hosts WHERE name = 'self'`)
    const selfId = self.rows[0]!.id
    assert.equal(await setRevoked(selfId, { actor: 'admin:1' }), false)
    assert.notEqual((await getHostById(selfId))!.status, 'revoked')
  })

  test('不存在的 host → false', async (t) => {
    if (skip(t)) return
    assert.equal(await setRevoked(MISSING_UUID, { actor: 'admin:1' }), false)
  })
})

describe('resolveServiceableHostTarget (A3 service-path resolver)', () => {
  test('revoked host → HostNotServiceableError(revoked)', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-svc-1', { withFingerprint: true, validPsk: true })
    await setRevoked(id, { actor: 'admin:1' })
    await assert.rejects(
      () => resolveServiceableHostTarget(id),
      (e: unknown) => {
        assert.ok(e instanceof HostNotServiceableError)
        assert.equal(e.reason, 'revoked')
        return true
      },
    )
  })

  test('缺 fingerprint host → HostNotServiceableError(no pinned fingerprint)', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-svc-2', { withFingerprint: false, validPsk: true })
    await assert.rejects(
      () => resolveServiceableHostTarget(id),
      (e: unknown) => {
        assert.ok(e instanceof HostNotServiceableError)
        assert.equal(e.reason, 'no pinned fingerprint')
        return true
      },
    )
  })

  test('不存在 host → HostNotServiceableError(host not found)', async (t) => {
    if (skip(t)) return
    await assert.rejects(() => resolveServiceableHostTarget(MISSING_UUID), HostNotServiceableError)
  })

  test('ready + fingerprint + 有效 psk → 返回 target 且 requireFingerprint=true', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-svc-3', { withFingerprint: true, validPsk: true })
    const target = await resolveServiceableHostTarget(id)
    assert.equal(target.hostId, id)
    assert.equal(target.requireFingerprint, true)
    assert.equal(target.expectedFingerprint, 'aa:bb:cc:dd')
    target.psk?.fill(0)
  })
})

describe('终态不变量:revoked 不可被无声拉回', () => {
  test('setQuarantined(revoked) → applied:false,status 仍 revoked', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-1', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    const r = await setQuarantined(id, {
      reason: 'health-poll-fail',
      detail: 'x',
      operationId: 'op-q',
      actor: 'system:test',
    })
    assert.equal(r.applied, false)
    assert.equal((await getHostById(id))!.status, 'revoked')
  })

  test('setDraining(revoked) → false,status 仍 revoked', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-2', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    assert.equal(await setDraining(id, { actor: 'admin:1' }), false)
    assert.equal((await getHostById(id))!.status, 'revoked')
  })

  test('clearQuarantine(revoked) → false,status 仍 revoked', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-3', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    assert.equal(await clearQuarantine(id, { actor: 'admin:1' }), false)
    assert.equal((await getHostById(id))!.status, 'revoked')
  })

  test('updateStatus(revoked→ready) → no-op;→revoked 同态幂等可写', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-4', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    await updateStatus(id, 'ready')
    assert.equal((await getHostById(id))!.status, 'revoked')
    await updateStatus(id, 'revoked')
    assert.equal((await getHostById(id))!.status, 'revoked')
  })

  test('updateCert(revoked) → fingerprint 不被写回(B8 + 防 renew 竞态)', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-5', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    assert.equal((await getHostById(id))!.agent_cert_fingerprint_sha256, null)
    // 模拟 maybeRenewCert 持旧 row 在 revoke 后续签:WHERE status<>'revoked' 让其 no-op。
    await updateCert({
      id,
      certPem: 'PEM',
      fingerprintSha256: 'ff:ee:dd',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    })
    const row = await getHostById(id)
    assert.equal(row!.status, 'revoked')
    assert.equal(row!.agent_cert_fingerprint_sha256, null)
  })

  test('markBootstrapResult(revoked) → status 仍 revoked(防绕过入口直调)', async (t) => {
    if (skip(t)) return
    const id = await insertHost('h-term-6', { withFingerprint: true })
    await setRevoked(id, { actor: 'admin:1' })
    const r = await markBootstrapResult(id, {
      success: true,
      loadedImage: { id: 'sha256:zzz', tag: 't' },
      operationId: 'op-mb-rev',
      actor: 'system:test',
    })
    assert.equal(r.status, 'revoked')
    assert.equal((await getHostById(id))!.status, 'revoked')
  })
})

describe('migration 0081 — compute_hosts status CHECK', () => {
  test("接受 'revoked' 且仍接受既有状态(superset,不回归)", async (t) => {
    if (skip(t)) return
    const rid = await insertHost('h-chk-revoked', { status: 'revoked', withFingerprint: false })
    assert.equal((await getHostById(rid))!.status, 'revoked')
    for (const s of ['bootstrapping', 'ready', 'quarantined', 'draining', 'broken']) {
      const sid = await insertHost(`h-chk-${s}`, { status: s, withFingerprint: true })
      assert.equal((await getHostById(sid))!.status, s)
    }
    await assert.rejects(() => insertHost('h-chk-bad', { status: 'zombie' }))
  })
})
