import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { truncateAllForTest, useDedicatedTestDatabase } from '../../__tests__/helpers/db.js'
import { getPool } from '../../db/index.js'
import { query } from '../../db/queries.js'
import { installApprovedVersion } from '../../marketplace/marketplaceDb.js'
import {
  PluginAccountError,
  bindManagedBrowserPluginAccount,
  commitPluginAccountState,
  decryptLiteratureHttpAccountEnvelope,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
  revokePluginAccountFenced,
} from '../accounts.js'
import {
  approveOfficialRuntimePluginVersion,
  approveRuntimePluginVersion,
  loadVerifiedRuntimePluginContract,
} from '../review.js'
import {
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
} from './accountState.js'
import { LITERATURE_PLUGIN_ARTIFACT } from './builtinArtifact.js'
import { COMPILED_LITERATURE_PLUGIN, LITERATURE_PLUGIN_CONTRACT } from './builtinContract.js'
import { LITERATURE_SITE } from './policy.js'

const db = useDedicatedTestDatabase('ocv5_literature_accounts_test')
const env = { ...process.env, OPENCLAUDE_KMS_KEY: randomBytes(32).toString('base64') }
const previousKms = process.env.OPENCLAUDE_KMS_KEY
const previousChannel = process.env.OC_RUNTIME_CHANNEL
before(() => {
  process.env.OPENCLAUDE_KMS_KEY = env.OPENCLAUDE_KMS_KEY
  process.env.OC_RUNTIME_CHANNEL = 'v5'
})
after(() => {
  if (previousKms === undefined) Reflect.deleteProperty(process.env, 'OPENCLAUDE_KMS_KEY')
  else process.env.OPENCLAUDE_KMS_KEY = previousKms
  if (previousChannel === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
  else process.env.OC_RUNTIME_CHANNEL = previousChannel
})
beforeEach(async () => {
  if (db.available) await truncateAllForTest(['marketplace_skill_listings'])
})
const code = (expected: string) => (error: unknown) =>
  error instanceof PluginAccountError && error.code === expected
function state(value = 'synthetic-private-cookie') {
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, `sid=${value}; Path=/; HttpOnly`, LITERATURE_SITE, Date.now())
  return exportJieyouAccountState(jar)
}
async function user(role = 'user') {
  const r = await query<{ id: string }>(
    `INSERT INTO users(email,password_hash,email_verified,role) VALUES ($1,'fixture',TRUE,$2) RETURNING id::text`,
    [`${randomUUID()}@lit.test`, role],
  )
  return Number(r.rows[0]!.id)
}
async function fixture(official = true) {
  const owner = await user()
  const admin = await user('admin')
  const a = await user()
  const b = await user()
  await query(
    `INSERT INTO marketplace_skill_listings(slug,owner_user_id,kind,plugin_type,state) VALUES ('literature-db',$1,'connector','managed-browser','unlisted')`,
    [owner],
  )
  const r = await query<{ id: string }>(
    `INSERT INTO marketplace_skill_versions(slug,version,name,description,raw_artifact,artifact_hash,embedding_hash,submitted_by) VALUES ('literature-db','0.1.0','Fixture literature','Synthetic only',$1,$2,$2,$3) RETURNING id::text`,
    [JSON.stringify(LITERATURE_PLUGIN_ARTIFACT), COMPILED_LITERATURE_PLUGIN.artifactHash, owner],
  )
  const versionId = Number(r.rows[0]!.id)
  // True describes only this synthetic fixture, never real website verification.
  if (official)
    await approveOfficialRuntimePluginVersion({
      versionId,
      ownerUserId: owner,
      expectedArtifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
      functionalVerified: true,
      env,
      pool: getPool(),
    })
  else
    await approveRuntimePluginVersion({
      versionId,
      reviewerUserId: admin,
      expectedArtifactHash: COMPILED_LITERATURE_PLUGIN.artifactHash,
      functionalVerified: true,
      env,
      pool: getPool(),
    })
  return { a, b, versionId }
}
async function installed() {
  const f = await fixture()
  for (const userId of [f.a, f.b])
    await installApprovedVersion({
      userId,
      versionId: f.versionId,
      agentIds: ['main'],
      scopeMode: 'replace',
    })
  const verified = await loadVerifiedRuntimePluginContract(f.versionId, getPool(), { env })
  assert.equal(verified.pluginType, 'managed-browser')
  if (verified.pluginType !== 'managed-browser') throw new Error('fixture subtype')
  const bound = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reject',
    env,
  })
  const row = await getPluginAccount(bound.id, f.a, getPool())
  assert(row)
  return { ...f, verified, bound, row }
}
async function snapshot(id: string) {
  return (
    await query(
      'SELECT secret_enc,secret_nonce,aad_seed::text,revision,secret_generation::text FROM connections WHERE id=$1',
      [id],
    )
  ).rows
}

test('signed HTTP account binds encrypted cookies without leaking them into metadata or browser state', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const envelope = decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env)
  assert.deepEqual(envelope.storageState, state())
  assert.equal(envelope.accountInstanceId, f.bound.accountInstanceId)
  assert(!JSON.stringify(f.row.meta).includes('synthetic-private-cookie'))
  assert(!f.row.secret_enc!.includes(Buffer.from('synthetic-private-cookie')))
  assert.throws(
    () => decryptPluginAccountEnvelope(f.row, f.verified.contract, env),
    code('SECRET_INVALID'),
  )
  const reused = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reuse-identical',
    env,
  })
  assert.equal(reused.outcome, 'reused')
})

test('HTTP state remains tenant-bound in lookup, fence and encrypted envelope', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  assert.equal(await getPluginAccount(f.row.id, f.b, getPool()), null)
  assert.throws(
    () =>
      decryptLiteratureHttpAccountEnvelope({ ...f.row, user_id: f.b }, f.verified.contract, env),
    code('SECRET_INVALID'),
  )
  await assert.rejects(
    fencePluginAccountInvocation({
      connectionId: f.row.id,
      userId: f.b,
      expectedRevision: f.row.revision,
      verified: f.verified,
      runner: getPool(),
    }),
    code('ACCOUNT_STALE'),
  )
})

test('HTTP cookie commits require the newest generation and exact wrapper hash', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const fence = () =>
    fencePluginAccountInvocation({
      connectionId: f.row.id,
      userId: f.a,
      expectedRevision: f.row.revision,
      verified: f.verified,
      runner: getPool(),
    })
  const old = await fence()
  const current = await fence()
  const envelope = decryptLiteratureHttpAccountEnvelope(current, f.verified.contract, env)
  const input = { row: current, verified: f.verified, envelope, runner: getPool(), env }
  const unchanged = await snapshot(f.row.id)
  await assert.rejects(commitPluginAccountState({ ...input, row: old }), code('ACCOUNT_STALE'))
  await assert.rejects(
    commitPluginAccountState({
      ...input,
      verified: { ...f.verified, execContractHash: 'a'.repeat(64) },
    }),
    code('INVALID_STATE'),
  )
  assert.deepEqual(await snapshot(f.row.id), unchanged)
  await commitPluginAccountState(input)
  await assert.rejects(commitPluginAccountState(input), code('ACCOUNT_STALE'))
})

test('fenced HTTP refresh prevents an older worker from overwriting newly bound cookies', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const old = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const envelope = decryptLiteratureHttpAccountEnvelope(old, f.verified.contract, env)
  await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    storageState: state('synthetic-new-cookie'),
    env,
  })
  const unchanged = await snapshot(f.row.id)
  await assert.rejects(
    commitPluginAccountState({ row: old, verified: f.verified, envelope, runner: getPool(), env }),
    code('ACCOUNT_STALE'),
  )
  assert.deepEqual(await snapshot(f.row.id), unchanged)
  const fresh = await getPluginAccount(f.row.id, f.a, getPool())
  assert(fresh)
  assert.equal(
    decryptLiteratureHttpAccountEnvelope(fresh, f.verified.contract, env).storageState.cookies[0]
      .value,
    'synthetic-new-cookie',
  )
})

test('ordinary human review does not grant the platform-only HTTP exception', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await fixture(false)
  await assert.rejects(
    loadVerifiedRuntimePluginContract(f.versionId, getPool(), { env }),
    (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'NOT_SECURITY_APPROVED',
  )
})

test('uninstall, listing disable, version revoke and lost platform source reject late HTTP commits', async (t) => {
  if (db.skipIfUnavailable(t)) return
  for (const mutation of [
    {
      sql: "UPDATE marketplace_installs SET uninstalled_at=NOW() WHERE user_id=$1 AND slug='literature-db'",
      target: 'user',
    },
    {
      sql: "UPDATE marketplace_skill_listings SET state='unlisted' WHERE slug='literature-db'",
      target: 'none',
    },
    {
      sql: 'UPDATE marketplace_skill_versions SET exec_revoked_at=NOW() WHERE id=$1',
      target: 'version',
    },
    {
      sql: "UPDATE marketplace_skill_versions SET review_source='human' WHERE id=$1",
      target: 'version',
    },
  ] as const) {
    await truncateAllForTest(['marketplace_skill_listings'])
    const f = await installed()
    const row = await fencePluginAccountInvocation({
      connectionId: f.row.id,
      userId: f.a,
      expectedRevision: f.row.revision,
      verified: f.verified,
      runner: getPool(),
    })
    const envelope = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
    await query(
      mutation.sql,
      mutation.target === 'version' ? [f.versionId] : mutation.target === 'user' ? [f.a] : [],
    )
    const unchanged = await snapshot(row.id)
    await assert.rejects(
      commitPluginAccountState({ row, verified: f.verified, envelope, runner: getPool(), env }),
      code('ACCOUNT_STALE'),
    )
    assert.deepEqual(await snapshot(row.id), unchanged)
  }
})

test('revoked HTTP credentials cannot be resurrected by a late state commit', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const row = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const envelope = decryptLiteratureHttpAccountEnvelope(row, LITERATURE_PLUGIN_CONTRACT, env)
  await revokePluginAccountFenced({ row, runner: getPool() })
  const unchanged = await snapshot(row.id)
  await assert.rejects(
    commitPluginAccountState({ row, verified: f.verified, envelope, runner: getPool(), env }),
    code('ACCOUNT_STALE'),
  )
  assert.deepEqual(await snapshot(row.id), unchanged)
  assert.equal(unchanged[0].secret_enc, null)
  assert.equal(unchanged[0].secret_nonce, null)
})
