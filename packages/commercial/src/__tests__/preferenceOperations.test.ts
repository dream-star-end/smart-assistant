import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SystemActionStore } from '../../../storage/src/systemActions.js'
import { preferenceOperations } from '../system-assistant/preferenceOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import { SystemActionsService } from '../system-assistant/service.js'
import { PreferencesError, resolvePreferencesPatch, type Preferences } from '../user/preferences.js'
import type { BrowserConfirmationPrincipal } from '../auth/browserConfirmation.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
const principal: BrowserConfirmationPrincipal = { id: '765', role: 'user', accessJti: 'synthetic-jti', accessExpiresAt: 9999999999, refreshFamilyId: randomUUID(), refreshSessionId: '19' }
function fixture(t: import('node:test').TestContext, initial: Preferences = { intelligent_ui: true }) {
  let prefs: Preferences = initial
  let version = 1
  let writes = 0
  let eligible = true
  let allowed = true
  let brokerReady = true
  let privacyReady = true
  const registry = new SystemOperationRegistry(preferenceOperations({
    authorize: async a => { assert.equal(a.userId, '765'); if (!allowed) throw new SystemOperationRejected('FORBIDDEN') },
    privacySupported: async () => privacyReady,
    effect: async (_actor, _execution, work) => work({ query: async () => { throw new Error('Unexpected PG use in isolated preference fixture') } }),
    backgroundApprovalReady: async () => brokerReady,
    read: async () => ({ prefs: { ...prefs }, version: String(version), updated_at: '2026-10-24T00:00:00Z' }),
    resolve: (uid, raw) => resolvePreferencesPatch(uid, raw, { feature: async () => ({ eligible, available: true }) }),
    write: async (uid, raw, expected, role) => {
      assert.equal(uid, '765'); assert.equal(role, 'user')
      if (expected !== String(version)) throw new PreferencesError('CONFLICT', 'synthetic stale tuple')
      writes++; version++; prefs = { ...prefs, ...raw as Preferences }
    },
  }))
  const ledger = new SystemActionStore({ dbPath: join(mkdtempSync(join(tmpdir(), 'oc-system-prefs-')), 'ledger.sqlite'), key: randomBytes(32) })
  t.after(() => ledger.close())
  const service = new SystemActionsService(ledger, registry, randomUUID())
  async function proposal(patch: unknown) {
    const idempotencyKey = randomUUID()
    const p = await service.prepare(actor, 'preferences.update', patch, idempotencyKey)
    const detail = service.detail('765', p.id)
    const deviceId = randomUUID()
    const { nonce } = service.challenge(principal, p.id, deviceId, detail.previewHash)
    return { id: p.id, idempotencyKey, detail, proof: { nonce, deviceId, previewHash: detail.previewHash } }
  }
  return { registry, service, proposal, writes: () => writes, prefs: () => prefs,
    intervene: () => { version++ }, revoke: () => { allowed = false }, loseEntitlement: () => { eligible = false }, stopBroker: () => { brokerReady = false }, losePrivacySupport: () => { privacyReady = false } }
}
test('a real preference adapter reads without mutation and needs browser approval before the atomic writer', async t => {
  const f = fixture(t)
  const view = await f.registry.read(actor, 'preferences.read', {}) as { prefs: Preferences }
  assert.equal(view.prefs.intelligent_ui, true)
  const p = await f.proposal({ intelligent_ui: false })
  assert.equal(p.detail.preview?.before[0]?.value, '开启')
  assert.equal(p.detail.preview?.after[0]?.value, '关闭')
  assert.equal(f.writes(), 0)
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'succeeded')
  assert.equal(f.prefs().intelligent_ui, false)
  await f.service.confirm(principal, p.id, p.proof)
  assert.equal(f.writes(), 1)
})
test('intervening setting edits invalidate the approval without overwriting the newer snapshot', async t => {
  const f = fixture(t); const p = await f.proposal({ intelligent_ui: false })
  f.intervene()
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'failed')
  assert.equal(f.writes(), 0)
})
test('current account permissions and Auto-Dream entitlement are rechecked after approval', async t => {
  const f = fixture(t)
  const p = await f.proposal({ auto_optimizer_enabled: true })
  assert.deepEqual(p.detail.preview?.after.map(r => r.label), ['后台记忆整理', '自进化与匿名平台发现上报'])
  assert.equal(p.detail.preview?.consequences.some(v => v.includes('匿名发现')), true)
  f.loseEntitlement()
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'failed')
  assert.equal(f.writes(), 0)
  const p2 = await f.proposal({ notify_email: false }); f.revoke()
  const result2 = await f.service.confirm(principal, p2.id, p2.proof)
  assert.equal('state' in result2 && result2.state, 'failed')
  assert.equal(f.writes(), 0)
})
test('unknown preference fields, an empty patch and unauthorized reads do not mutate', async t => {
  const f = fixture(t)
  await assert.rejects(f.proposal({ arbitrary_setting: true }))
  await assert.rejects(f.proposal({}))
  await assert.rejects(f.registry.read(actor, 'preferences.read', { keys: ['token'] }))
  f.revoke(); await assert.rejects(f.registry.read(actor, 'preferences.read', {}))
  assert.equal(f.writes(), 0)
})

test('replaying the original preparation after settings changed returns its original proposal and rejects a different patch', async t => {
  const f = fixture(t); const p = await f.proposal({ intelligent_ui: false })
  f.intervene()
  const replay = await f.service.prepare(actor, 'preferences.update', { intelligent_ui: false }, p.idempotencyKey)
  assert.equal(replay.id, p.id)
  assert.equal(replay.state, 'prepared')
  assert.deepEqual(f.service.detail('765', replay.id).preview, p.detail.preview)
  await assert.rejects(f.service.prepare(actor, 'preferences.update', { intelligent_ui: true }, p.idempotencyKey))
  assert.equal(f.writes(), 0)
})
test('a preparation replay after the write returns its completed receipt without computing a fresh effect', async t => {
  const f = fixture(t); const p = await f.proposal({ intelligent_ui: false })
  await f.service.confirm(principal, p.id, p.proof)
  const replay = await f.service.prepare(actor, 'preferences.update', { intelligent_ui: false }, p.idempotencyKey)
  assert.equal(replay.id, p.id)
  assert.equal(replay.state, 'succeeded')
  assert.equal(f.writes(), 1)
})

test('enabling background writers requires a broker that separately approves every future formal write', async t => {
  const f = fixture(t); const p = await f.proposal({ auto_dream_enabled: true })
  f.stopBroker()
  await assert.rejects(f.proposal({ auto_optimizer_enabled: true }), e => e instanceof SystemOperationRejected && e.code === 'UNAVAILABLE')
  const result = await f.service.confirm(principal, p.id, p.proof)
  assert.equal('state' in result && result.state, 'failed')
  assert.equal(f.writes(), 0)
  const disable = await f.proposal({ auto_dream_enabled: false })
  assert.equal('state' in await f.service.confirm(principal, disable.id, disable.proof), true)
  assert.equal(f.writes(), 1)
})

test('profile reads expose nickname only to the explicitly authorized session and default reads omit it', async t => {
  const f = fixture(t, { system_assistant_profile: { enabled: true, nickname: 'Synthetic Name', sessionId: actor.sessionId } })
  const normal = await f.registry.read(actor, 'preferences.read', {}) as { prefs: Record<string, unknown> }
  assert.equal('system_assistant_profile' in normal.prefs, false)
  const authorized = await f.registry.read(actor, 'preferences.read', { keys: ['system_assistant_profile'] }) as { prefs: Record<string, unknown> }
  assert.equal((authorized.prefs.system_assistant_profile as { nickname: string }).nickname, 'Synthetic Name')
  const other = await f.registry.read({ ...actor, sessionId: 'synthetic-other-session' }, 'preferences.read', { keys: ['system_assistant_profile'] }) as { prefs: Record<string, unknown> }
  assert.deepEqual(other.prefs.system_assistant_profile, { enabled: true, authorizedForCurrentSession: false })
  assert.equal(f.writes(), 0)
})
test('an actual runtime support change blocks new profile grants but still permits withdrawal', async t => {
  const f = fixture(t)
  const proposed = await f.proposal({ system_assistant_profile: { enabled: true, nickname: 'Synthetic Name', sessionId: actor.sessionId } })
  f.losePrivacySupport()
  const result = await f.service.confirm(principal, proposed.id, proposed.proof)
  assert.equal('state' in result && result.state, 'failed')
  assert.equal(f.writes(), 0)
  await assert.rejects(f.proposal({ system_assistant_profile: { enabled: true, nickname: 'Synthetic Name', sessionId: actor.sessionId } }))
  const withdraw = await f.proposal({ system_assistant_profile: null })
  const saved = await f.service.confirm(principal, withdraw.id, withdraw.proof)
  assert.equal('state' in saved && saved.state, 'succeeded')
  assert.equal(f.writes(), 1)
})

test('withdrawn profile grants never disclose a retained nickname or session even to the old session', async t => {
  const f = fixture(t, { system_assistant_profile: { enabled: false, nickname: 'Synthetic Private Name', sessionId: actor.sessionId } })
  for (const sessionId of [actor.sessionId, 'synthetic-other-session']) {
    const view = await f.registry.read({ ...actor, sessionId }, 'preferences.read', { keys: ['system_assistant_profile'] }) as { prefs: Record<string, unknown> }
    assert.deepEqual(view.prefs.system_assistant_profile, { enabled: false, authorizedForCurrentSession: false })
  }
  assert.equal(f.writes(), 0)
})
