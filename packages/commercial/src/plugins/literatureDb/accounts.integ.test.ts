import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import sharp from 'sharp'
import { truncateAllForTest, useDedicatedTestDatabase } from '../../__tests__/helpers/db.js'
import { revokeDeclarativeConnection } from '../../connectors/engine/binding.js'
import { revokeConnection } from '../../connectors/store.js'
import { getPool } from '../../db/index.js'
import { query } from '../../db/queries.js'
import { installApprovedVersion, recordUninstall } from '../../marketplace/marketplaceDb.js'
import {
  LITERATURE_SESSION_MAX_MS,
  PluginAccountError,
  bindManagedBrowserPluginAccount,
  commitPluginAccountState,
  decryptLiteratureHttpAccountCredentials,
  decryptLiteratureHttpAccountEnvelope,
  decryptLiteratureHttpAccountInstanceId,
  decryptPluginAccountEnvelope,
  fencePluginAccountInvocation,
  getPluginAccount,
  markPluginAccountRelinkRequiredFenced,
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
import { sealLiteratureCredentials, serializeSealedLiteratureCredentials } from './credentials.js'
import { LiteratureError } from './errors.js'
import type { LiteratureLoginSession } from './login.js'
import { LITERATURE_SITE } from './policy.js'
import { LiteratureSetupService, type LiteratureSetupView } from './setupService.js'

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
function session(now = Date.now()) {
  return { sessionVerifiedAt: now - 1000, sessionExpiresAt: now + 60 * 60 * 1000 }
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
async function ready() {
  const f = await fixture()
  for (const userId of [f.a, f.b])
    await installApprovedVersion({
      userId,
      versionId: String(f.versionId),
      agentIds: ['main'],
      scopeMode: 'replace',
    })
  const verified = await loadVerifiedRuntimePluginContract(f.versionId, getPool(), { env })
  assert.equal(verified.pluginType, 'managed-browser')
  if (verified.pluginType !== 'managed-browser') throw new Error('fixture subtype')
  return { ...f, verified }
}
async function installed() {
  const f = await ready()
  const bound = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reject',
    literatureSession: session(),
    env,
  })
  const row = await getPluginAccount(bound.id, f.a, getPool())
  assert(row)
  return { ...f, bound, row }
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
  const altered = structuredClone(f.verified.contract)
  Reflect.deleteProperty(altered.runtime, 'transport')
  const downgraded = { ...f.verified, contract: altered }
  await assert.rejects(
    commitPluginAccountState({
      ...input,
      verified: downgraded,
      envelope: { ...envelope, storageState: { cookies: [], origins: [] } },
    }),
    code('INVALID_STATE'),
  )
  await assert.rejects(
    fencePluginAccountInvocation({
      connectionId: f.row.id,
      userId: f.a,
      expectedRevision: f.row.revision,
      verified: downgraded,
      runner: getPool(),
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

const password = (value = 'synthetic-password-one') => ({
  schemaVersion: 1,
  username: 'synthetic-lit-owner',
  password: value,
})
async function passwordAccount() {
  const f = await ready()
  const bound = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reject',
    literatureSession: session(),
    literatureCredentials: { action: 'set', credentials: password() },
    env,
  })
  const row = await getPluginAccount(bound.id, f.a, getPool())
  assert(row)
  return { ...f, bound, row }
}
async function readRow(id: string, userId: number, includeError = false) {
  const row = await getPluginAccount(id, userId, getPool(), { includeError })
  assert(row)
  return row
}

test('password creation binds its seal to the real returned account ID without public plaintext', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const secret = decryptLiteratureHttpAccountCredentials(f.row, f.verified.contract, env)
  assert.deepEqual(secret, password())
  const publicValues = JSON.stringify({
    result: f.bound,
    meta: f.row.meta,
    name: f.row.display_name,
  })
  for (const value of [password().username, password().password]) {
    assert(!publicValues.includes(value))
    assert(!f.row.secret_enc!.includes(Buffer.from(value)))
  }
  const other = await bindManagedBrowserPluginAccount({
    userId: f.b,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reject',
    literatureSession: session(),
    env,
  })
  // Outer AAD does not include connectionId; the independent inner seal must reject this swap.
  assert.throws(
    () =>
      decryptLiteratureHttpAccountCredentials({ ...f.row, id: other.id }, f.verified.contract, env),
    code('SECRET_INVALID'),
  )
  assert.throws(
    () =>
      decryptLiteratureHttpAccountCredentials({ ...f.row, user_id: f.b }, f.verified.contract, env),
    code('SECRET_INVALID'),
  )
})

test('failure while adding a password rolls back the newly inserted account atomically', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await ready()
  await query(`CREATE FUNCTION public.ocv5_524_fail_credential_update() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.provider = 'literature-db' THEN RAISE EXCEPTION 'synthetic credential update failure' USING ERRCODE = 'P5241'; END IF;
      RETURN NEW;
    END $$`)
  try {
    await query(`CREATE TRIGGER ocv5_524_fail_credential_update BEFORE UPDATE OF secret_enc,secret_nonce ON public.connections
      FOR EACH ROW EXECUTE FUNCTION public.ocv5_524_fail_credential_update()`)
    await assert.rejects(
      bindManagedBrowserPluginAccount({
        userId: f.a,
        versionId: f.versionId,
        storageState: state(),
        existing: 'reject',
        literatureSession: session(),
        literatureCredentials: { action: 'set', credentials: password() },
        env,
      }),
      (error: unknown) =>
        Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P5241'),
    )
    const rows = await query('SELECT id FROM connections WHERE user_id=$1 AND provider=$2', [
      f.a,
      'literature-db',
    ])
    assert.equal(rows.rowCount, 0)
  } finally {
    await query('DROP TRIGGER IF EXISTS ocv5_524_fail_credential_update ON public.connections')
    await query('DROP FUNCTION public.ocv5_524_fail_credential_update()')
  }
  const created = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'reject',
    literatureSession: session(),
    literatureCredentials: { action: 'set', credentials: password() },
    env,
  })
  const row = await readRow(created.id, f.a)
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password(),
  )
})

test('fenced same-cookie password updates and clears persist, while ordinary refresh preserves the seal', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const change = (input: { action: 'set'; credentials: unknown } | { action: 'clear' }) =>
    bindManagedBrowserPluginAccount({
      userId: f.a,
      versionId: f.versionId,
      storageState: state(),
      existing: 'refresh-fenced',
      expectedExistingAccountInstanceId: f.bound.accountInstanceId,
      literatureCredentials: input,
      env,
    })
  const updated = await change({ action: 'set', credentials: password('synthetic-password-two') })
  assert.equal(updated.outcome, 'refreshed')
  let row = await readRow(f.row.id, f.a)
  assert(Number(row.secret_generation) > Number(f.row.secret_generation))
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password('synthetic-password-two'),
  )
  const originalSeal = decryptLiteratureHttpAccountEnvelope(
    row,
    f.verified.contract,
    env,
  ).credentialSeal
  await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state('synthetic-refresh-cookie'),
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    env,
  })
  row = await readRow(f.row.id, f.a)
  assert.deepEqual(
    decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env).credentialSeal,
    originalSeal,
  )
  await change({ action: 'clear' })
  row = await readRow(f.row.id, f.a)
  assert.equal(decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env), undefined)
})

test('cookie commits preserve the authoritative password and reject credential or instance changes', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  let row = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const envelope = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
  const { credentialSeal, ...cookieOnly } = envelope
  await commitPluginAccountState({
    row,
    verified: f.verified,
    envelope: cookieOnly,
    runner: getPool(),
    env,
  })
  row = await readRow(f.row.id, f.a)
  assert.deepEqual(
    decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env).credentialSeal,
    credentialSeal,
  )
  const injected = serializeSealedLiteratureCredentials(
    sealLiteratureCredentials(
      password('injected-synthetic-password'),
      { userId: f.a, accountId: row.id },
      env,
    ),
  )
  const unchanged = await snapshot(row.id)
  await assert.rejects(
    commitPluginAccountState({
      row,
      verified: f.verified,
      envelope: { ...envelope, credentialSeal: injected },
      runner: getPool(),
      env,
    }),
    code('INVALID_STATE'),
  )
  await assert.rejects(
    commitPluginAccountState({
      row,
      verified: f.verified,
      envelope: { ...envelope, accountInstanceId: randomUUID() },
      runner: getPool(),
      env,
    }),
    code('ACCOUNT_STALE'),
  )
  assert.deepEqual(await snapshot(row.id), unchanged)
  const old = await fencePluginAccountInvocation({
    connectionId: row.id,
    userId: f.a,
    expectedRevision: row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state(),
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    literatureCredentials: { action: 'set', credentials: password('newer-synthetic-password') },
    env,
  })
  const latest = await snapshot(row.id)
  await assert.rejects(
    commitPluginAccountState({
      row: old,
      verified: f.verified,
      envelope,
      runner: getPool(),
      env,
    }),
    code('ACCOUNT_STALE'),
  )
  assert.deepEqual(await snapshot(row.id), latest)
})

test('replacement drops prior credentials, accepts a new seal and cannot replay an old password over a newer one', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const first = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state('replacement-one'),
    existing: 'replace',
    literatureSession: session(),
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    replacementAccountInstanceId: randomUUID(),
    env,
  })
  let row = await readRow(first.id, f.a)
  assert.equal(decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env), undefined)
  const replacement = {
    userId: f.a,
    versionId: f.versionId,
    storageState: state('replacement-two'),
    existing: 'replace' as const,
    literatureSession: session(),
    expectedExistingAccountInstanceId: first.accountInstanceId,
    replacementAccountInstanceId: randomUUID(),
    literatureCredentials: {
      action: 'set' as const,
      credentials: password('replacement-synthetic-password'),
    },
    env,
  }
  const second = await bindManagedBrowserPluginAccount(replacement)
  await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state('replacement-two'),
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: second.accountInstanceId,
    literatureCredentials: { action: 'set', credentials: password('latest-synthetic-password') },
    env,
  })
  assert.equal((await bindManagedBrowserPluginAccount(replacement)).outcome, 'reused')
  row = await readRow(second.id, f.a)
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password('latest-synthetic-password'),
  )
})

test('cookie relink-required status preserves the remembered encrypted password', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const row = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const before = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env).credentialSeal
  await markPluginAccountRelinkRequiredFenced({ row, verified: f.verified, runner: getPool() })
  const expired = await readRow(row.id, f.a, true)
  assert.equal(expired.status, 'error')
  assert.deepEqual(
    decryptLiteratureHttpAccountEnvelope(expired, f.verified.contract, env).credentialSeal,
    before,
  )
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(expired, f.verified.contract, env),
    password(),
  )
})

for (const method of ['plugin', 'connector', 'declarative'] as const) {
  test(`password-bearing accounts are erased by ${method} revoke and late commits cannot revive them`, async (t) => {
    if (db.skipIfUnavailable(t)) return
    const f = await passwordAccount()
    const row = await fencePluginAccountInvocation({
      connectionId: f.row.id,
      userId: f.a,
      expectedRevision: f.row.revision,
      verified: f.verified,
      runner: getPool(),
    })
    const envelope = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
    if (method === 'plugin') await revokePluginAccountFenced({ row, runner: getPool() })
    else if (method === 'connector') await revokeConnection(row.id, f.a, getPool())
    else await revokeDeclarativeConnection(row.id, f.a, getPool())
    const erased = await snapshot(row.id)
    assert.equal(erased[0].secret_enc, null)
    assert.equal(erased[0].secret_nonce, null)
    await assert.rejects(
      commitPluginAccountState({
        row,
        verified: f.verified,
        envelope,
        runner: getPool(),
        env,
      }),
      code('ACCOUNT_STALE'),
    )
    assert.deepEqual(await snapshot(row.id), erased)
    await recordUninstall(f.a, 'literature-db')
    assert.deepEqual(await snapshot(row.id), erased)
  })
}

test('unfenced password mutation is rejected before changing the stored secret', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const unchanged = await snapshot(f.row.id)
  await assert.rejects(
    bindManagedBrowserPluginAccount({
      userId: f.a,
      versionId: f.versionId,
      storageState: state(),
      existing: 'reuse-identical',
      literatureCredentials: { action: 'set', credentials: password('must-not-be-saved') },
      env,
    }),
    code('INVALID_STATE'),
  )
  assert.deepEqual(await snapshot(f.row.id), unchanged)
})

test('HTTP first bind requires explicit fresh bounded proof and never creates rows for invalid proof', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await ready()
  const now = Date.now()
  const good = session(now)
  const invalid = [
    undefined,
    {},
    { ...good, extra: true },
    { ...good, sessionVerifiedAt: Number.NaN },
    { ...good, sessionExpiresAt: now },
    { sessionVerifiedAt: now + 1, sessionExpiresAt: now + 1000 },
    { sessionVerifiedAt: now, sessionExpiresAt: now + LITERATURE_SESSION_MAX_MS + 1 },
  ]
  t.mock.method(Date, 'now', () => now)
  for (const proof of invalid) {
    await assert.rejects(
      bindManagedBrowserPluginAccount({
        userId: f.a,
        versionId: f.versionId,
        storageState: state(),
        existing: 'reject',
        literatureSession: proof as typeof good,
        literatureCredentials: { action: 'set', credentials: password() },
        env,
      }),
      code('INVALID_STATE'),
    )
    assert.equal(
      (
        await query("SELECT id FROM connections WHERE user_id=$1 AND provider='literature-db'", [
          f.a,
        ])
      ).rowCount,
      0,
    )
  }
})

test('absolute HTTP expiry blocks active cookies at the boundary while preserving private relink identity and password', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const envelope = decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env)
  t.mock.method(Date, 'now', () => envelope.sessionExpiresAt - 1)
  assert.equal(
    decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env).sessionExpiresAt,
    envelope.sessionExpiresAt,
  )
  t.mock.method(Date, 'now', () => envelope.sessionExpiresAt)
  assert.throws(
    () => decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env),
    code('SESSION_EXPIRED'),
  )
  assert.equal(
    decryptLiteratureHttpAccountInstanceId(f.row, f.verified.contract, env),
    f.bound.accountInstanceId,
  )
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(f.row, f.verified.contract, env),
    password(),
  )
  assert.throws(
    () =>
      decryptLiteratureHttpAccountCredentials({ ...f.row, user_id: f.b }, f.verified.contract, env),
    code('SECRET_INVALID'),
  )
  assert.throws(
    () =>
      decryptLiteratureHttpAccountInstanceId(
        { ...f.row, secret_enc: null },
        f.verified.contract,
        env,
      ),
    code('ACCOUNT_REVOKED'),
  )
})

test('same-cookie fresh proof refreshes the encrypted lifetime and invalidates old worker generation', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const old = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const original = decryptLiteratureHttpAccountEnvelope(old, f.verified.contract, env)
  const proof = {
    sessionVerifiedAt: original.sessionVerifiedAt + 1,
    sessionExpiresAt: original.sessionExpiresAt + 1,
  }
  const refreshed = await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: original.storageState,
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    literatureSession: proof,
    env,
  })
  assert.equal(refreshed.outcome, 'refreshed')
  const current = decryptLiteratureHttpAccountEnvelope(
    await readRow(f.row.id, f.a),
    f.verified.contract,
    env,
  )
  assert.equal(current.sessionVerifiedAt, proof.sessionVerifiedAt)
  assert.equal(current.sessionExpiresAt, proof.sessionExpiresAt)
  await assert.rejects(
    commitPluginAccountState({
      row: old,
      verified: f.verified,
      envelope: original,
      runner: getPool(),
      env,
    }),
    code('ACCOUNT_STALE'),
  )
})

test('fenced cookie and password refresh without fresh proof preserve the original lifetime', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const original = decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env)
  await bindManagedBrowserPluginAccount({
    userId: f.a,
    versionId: f.versionId,
    storageState: state('changed-cookie'),
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    literatureCredentials: { action: 'set', credentials: password('changed-password') },
    env,
  })
  const current = decryptLiteratureHttpAccountEnvelope(
    await readRow(f.row.id, f.a),
    f.verified.contract,
    env,
  )
  assert.equal(current.sessionVerifiedAt, original.sessionVerifiedAt)
  assert.equal(current.sessionExpiresAt, original.sessionExpiresAt)
  assert(!JSON.stringify(f.row.meta).includes(String(original.sessionExpiresAt)))
})

test('ordinary reuse cannot renew proof and expired reuse or refresh cannot revive relink-required status', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  const original = decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env)
  const input = { userId: f.a, versionId: f.versionId, storageState: original.storageState, env }
  await assert.rejects(
    bindManagedBrowserPluginAccount({
      ...input,
      existing: 'reuse-identical',
      literatureSession: {
        sessionVerifiedAt: original.sessionVerifiedAt + 1,
        sessionExpiresAt: original.sessionExpiresAt + 1,
      },
    }),
    code('INVALID_STATE'),
  )
  await markPluginAccountRelinkRequiredFenced({
    row: f.row,
    verified: f.verified,
    runner: getPool(),
  })
  const before = await snapshot(f.row.id)
  t.mock.method(Date, 'now', () => original.sessionExpiresAt)
  await assert.rejects(
    bindManagedBrowserPluginAccount({ ...input, existing: 'reuse-identical' }),
    code('SESSION_EXPIRED'),
  )
  await assert.rejects(
    bindManagedBrowserPluginAccount({
      ...input,
      existing: 'refresh-fenced',
      expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    }),
    code('SESSION_EXPIRED'),
  )
  assert.deepEqual(await snapshot(f.row.id), before)
  assert.equal((await readRow(f.row.id, f.a, true)).status, 'error')
})

test('old replacement replay retains newer same-cookie proof and password even after old proof expires', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const p1 = { sessionVerifiedAt: now, sessionExpiresAt: now + 1000 }
  const replacement = {
    userId: f.a,
    versionId: f.versionId,
    storageState: state('replaced-cookie'),
    existing: 'replace' as const,
    expectedExistingAccountInstanceId: f.bound.accountInstanceId,
    replacementAccountInstanceId: randomUUID(),
    literatureSession: p1,
    literatureCredentials: { action: 'set' as const, credentials: password('old-replay-password') },
    env,
  }
  const replaced = await bindManagedBrowserPluginAccount(replacement)
  const p2 = { sessionVerifiedAt: now, sessionExpiresAt: now + 5000 }
  await bindManagedBrowserPluginAccount({
    ...replacement,
    existing: 'refresh-fenced',
    expectedExistingAccountInstanceId: replaced.accountInstanceId,
    replacementAccountInstanceId: undefined,
    literatureSession: p2,
    literatureCredentials: { action: 'set', credentials: password('newer-password') },
  })
  t.mock.method(Date, 'now', () => now + 1000)
  assert.equal((await bindManagedBrowserPluginAccount(replacement)).outcome, 'reused')
  const row = await readRow(f.row.id, f.a)
  const envelope = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
  assert.equal(envelope.sessionVerifiedAt, p2.sessionVerifiedAt)
  assert.equal(envelope.sessionExpiresAt, p2.sessionExpiresAt)
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password('newer-password'),
  )
  const before = await snapshot(row.id)
  t.mock.method(Date, 'now', () => p2.sessionExpiresAt)
  await assert.rejects(bindManagedBrowserPluginAccount(replacement), code('SESSION_EXPIRED'))
  assert.deepEqual(await snapshot(row.id), before)
})

test('Cookie CAS is non-sliding and rejects altered or expired proof without a database write', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await installed()
  let row = await fencePluginAccountInvocation({
    connectionId: f.row.id,
    userId: f.a,
    expectedRevision: f.row.revision,
    verified: f.verified,
    runner: getPool(),
  })
  const original = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
  const input = { verified: f.verified, runner: getPool(), env }
  const before = await snapshot(row.id)
  for (const changed of [
    { ...original, sessionExpiresAt: original.sessionExpiresAt + 1 },
    { ...original, sessionVerifiedAt: original.sessionVerifiedAt + 1 },
  ])
    await assert.rejects(
      commitPluginAccountState({ ...input, row, envelope: changed }),
      code('INVALID_STATE'),
    )
  assert.deepEqual(await snapshot(row.id), before)
  await commitPluginAccountState({
    ...input,
    row,
    envelope: { ...original, storageState: state('committed-cookie') },
  })
  row = await readRow(row.id, f.a)
  const current = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
  assert.equal(current.sessionExpiresAt, original.sessionExpiresAt)
  assert.equal(current.sessionVerifiedAt, original.sessionVerifiedAt)
  const unchanged = await snapshot(row.id)
  t.mock.method(Date, 'now', () => original.sessionExpiresAt)
  await assert.rejects(
    commitPluginAccountState({ ...input, row, envelope: current }),
    code('SESSION_EXPIRED'),
  )
  assert.deepEqual(await snapshot(row.id), unchanged)
})

async function fixtureLoginSession(
  outcome: 'authenticated' | 'credentials_invalid' = 'authenticated',
): Promise<LiteratureLoginSession> {
  const data = await sharp({ create: { width: 47, height: 20, channels: 3, background: 'white' } })
    .png()
    .toBuffer()
  return {
    challenge: async () => ({ data, mediaType: 'image/png' }),
    submit: async () => outcome,
    probe: async () => outcome === 'authenticated',
    snapshot: async () => state('service-synthetic-cookie'),
    close: async () => {},
  }
}
const syntheticReader = () => [
  {
    provider: 'local-ocr' as const,
    model: 'ddddocr',
    usageApproved: true,
    recognize: async () => '1234',
  },
]
async function untilSetup(
  service: LiteratureSetupService,
  userId: number,
  id: string,
  expected: LiteratureSetupView['status'],
) {
  for (let n = 0; n < 200; n++) {
    const view = await service.status(userId, id)
    if (view.status === expected) return view
    if (!['running', 'manual_required'].includes(view.status))
      assert.fail(`Unexpected synthetic setup terminal ${view.status}/${view.errorCode}`)
    await nextTurn()
  }
  assert.fail('Synthetic setup did not reach its expected state')
}
function syntheticLeaseRedis() {
  const values = new Map<string, string | number>()
  return {
    async eval(script: string, _keys: number, ...args: Array<string | number>) {
      const key = String(args[0])
      const token = args[1]!
      if (script.includes("'NX'")) {
        if (values.has(key)) return 0
        values.set(key, token)
        return 1
      }
      if (values.get(key) !== token) return 0
      if (script.includes("'DEL'")) values.delete(key)
      return 1
    },
  }
}

test('private setup runs through a real encrypted bind and exposes no submitted credentials', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await ready()
  const service = new LiteratureSetupService({
    pool: getPool(),
    env,
    readers: syntheticReader,
    createSession: () => fixtureLoginSession(),
  })
  t.after(() => service.close())
  const started = await service.start(f.a, { ...password(), acceptTerms: true })
  const view = await untilSetup(service, f.a, started.operationId, 'authenticated')
  assert(view.accountId)
  assert.equal(view.agentReady, false)
  assert.equal(view.automaticSubmissions, 1)
  const row = await readRow(view.accountId, f.a)
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password(),
  )
  assert.equal(
    decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env).storageState.cookies[0]
      .value,
    'service-synthetic-cookie',
  )
  const serialized = JSON.stringify({ started, view, rowMeta: row.meta })
  for (const secret of [password().username, password().password, 'service-synthetic-cookie'])
    assert(!serialized.includes(secret))
  for (const action of [
    () => service.status(f.b, started.operationId),
    () => service.cancel(f.b, started.operationId),
    () => service.image(f.b, started.operationId, randomUUID()),
    () => service.answer(f.b, started.operationId, randomUUID(), '1234'),
  ])
    await assert.rejects(
      action,
      (e: unknown) => e instanceof LiteratureError && e.code === 'NOT_FOUND',
    )
  await revokePluginAccountFenced({ row, runner: getPool() })
  assert.equal((await service.status(f.a, started.operationId)).status, 'failed')
  assert.equal((await service.cancel(f.a, started.operationId)).status, 'failed')
})

test('manual setup image is owner-bound and an answer is consumed exactly once before saving', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await ready()
  let submitted = 0
  const service = new LiteratureSetupService({
    pool: getPool(),
    env,
    createSession: async () => {
      const session = await fixtureLoginSession()
      return {
        ...session,
        submit: async () => {
          submitted++
          return 'authenticated'
        },
      }
    },
  })
  t.after(() => service.close())
  const started = await service.start(f.a, { ...password(), acceptTerms: true })
  const manual = await untilSetup(service, f.a, started.operationId, 'manual_required')
  assert.equal(manual.automaticSubmissions, 0)
  assert(manual.challengeId)
  assert.equal(
    (await service.image(f.a, manual.operationId, manual.challengeId)).mediaType,
    'image/png',
  )
  await assert.rejects(
    () => service.image(f.b, manual.operationId, manual.challengeId!),
    (e: unknown) => e instanceof LiteratureError && e.code === 'NOT_FOUND',
  )
  await service.answer(f.a, manual.operationId, manual.challengeId, '1234')
  await assert.rejects(
    () => service.answer(f.a, manual.operationId, manual.challengeId!, '1234'),
    (e: unknown) => e instanceof LiteratureError && e.code === 'CHALLENGE_STALE',
  )
  await untilSetup(service, f.a, manual.operationId, 'authenticated')
  assert.equal(submitted, 1)
})

test('failed relink and cancelled manual relink leave the old encrypted account unchanged', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const before = await snapshot(f.row.id)
  const failed = new LiteratureSetupService({
    pool: getPool(),
    env,
    redis: syntheticLeaseRedis(),
    readers: syntheticReader,
    createSession: () => fixtureLoginSession('credentials_invalid'),
  })
  t.after(() => failed.close())
  const first = await failed.start(f.a, {
    ...password('new-but-failed'),
    acceptTerms: true,
    accountId: f.row.id,
  })
  const result = await untilSetup(failed, f.a, first.operationId, 'failed')
  assert.equal(result.errorCode, 'CREDENTIALS_INVALID')
  assert.deepEqual(await snapshot(f.row.id), before)
  const cancelled = new LiteratureSetupService({
    pool: getPool(),
    env,
    redis: syntheticLeaseRedis(),
    createSession: () => fixtureLoginSession(),
  })
  t.after(() => cancelled.close())
  const second = await cancelled.start(f.a, {
    ...password('not-saved'),
    acceptTerms: true,
    accountId: f.row.id,
  })
  await untilSetup(cancelled, f.a, second.operationId, 'manual_required')
  assert.equal((await cancelled.cancel(f.a, second.operationId)).status, 'cancelled')
  assert.deepEqual(await snapshot(f.row.id), before)
})

test('expired account can privately relink into a new instance with fresh proof and newly sealed password', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await passwordAccount()
  const old = decryptLiteratureHttpAccountEnvelope(f.row, f.verified.contract, env)
  t.mock.method(Date, 'now', () => old.sessionExpiresAt)
  const service = new LiteratureSetupService({
    pool: getPool(),
    env,
    redis: syntheticLeaseRedis(),
    readers: syntheticReader,
    createSession: () => fixtureLoginSession(),
  })
  t.after(() => service.close())
  const start = await service.start(f.a, {
    ...password('fresh-private-password'),
    acceptTerms: true,
    accountId: f.row.id,
  })
  const result = await untilSetup(service, f.a, start.operationId, 'authenticated')
  assert.equal(result.accountId, f.row.id)
  const row = await readRow(f.row.id, f.a)
  const current = decryptLiteratureHttpAccountEnvelope(row, f.verified.contract, env)
  assert.notEqual(current.accountInstanceId, old.accountInstanceId)
  assert.equal(current.sessionVerifiedAt, old.sessionExpiresAt)
  assert.equal(current.sessionExpiresAt - current.sessionVerifiedAt, LITERATURE_SESSION_MAX_MS)
  assert.deepEqual(
    decryptLiteratureHttpAccountCredentials(row, f.verified.contract, env),
    password('fresh-private-password'),
  )
})

test('withdrawn installation cancels the private session before a manual answer can be sent', async (t) => {
  if (db.skipIfUnavailable(t)) return
  const f = await ready()
  let submitted = 0
  let closed = 0
  const service = new LiteratureSetupService({
    pool: getPool(),
    env,
    createSession: async () => {
      const session = await fixtureLoginSession()
      return {
        ...session,
        submit: async () => {
          submitted++
          return 'authenticated'
        },
        close: async () => {
          closed++
        },
      }
    },
  })
  t.after(() => service.close())
  const start = await service.start(f.a, { ...password(), acceptTerms: true })
  const manual = await untilSetup(service, f.a, start.operationId, 'manual_required')
  await recordUninstall(f.a, 'literature-db')
  await assert.rejects(() => service.answer(f.a, start.operationId, manual.challengeId!, '1234'))
  assert.equal((await service.cancel(f.a, start.operationId)).status, 'cancelled')
  assert.equal(submitted, 0)
  assert.equal(closed, 1)
})
