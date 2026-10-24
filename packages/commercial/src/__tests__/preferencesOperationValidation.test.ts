import assert from 'node:assert/strict'
import test from 'node:test'
import { resolvePreferencesPatch, PreferencesError } from '../user/preferences.js'
test('both settings paths enforce optimizer entitlement and the existing mutually-exclusive modes', async () => {
  const normalized = await resolvePreferencesPatch('765', { auto_optimizer_enabled: true }, { feature: async () => ({ eligible: true, available: true }) })
  assert.deepEqual(normalized, { auto_optimizer_enabled: true, auto_dream_enabled: false })
  await assert.rejects(resolvePreferencesPatch('765', { auto_dream_enabled: true }, { feature: async () => ({ eligible: false, available: true }) }), e => e instanceof PreferencesError && e.code === 'FORBIDDEN')
  await assert.rejects(resolvePreferencesPatch('765', { auto_optimizer_enabled: true }, { feature: async () => ({ eligible: true, available: false }) }), e => e instanceof PreferencesError && e.code === 'UNAVAILABLE')
})
test('turning features off needs no entitlement read and unknown input never reaches a business check', async () => {
  let reads = 0
  const deps = { feature: async () => { reads++; return { eligible: false, available: false } } }
  assert.deepEqual(await resolvePreferencesPatch('765', { auto_optimizer_enabled: false }, deps), { auto_optimizer_enabled: false, auto_dream_enabled: false })
  await assert.rejects(resolvePreferencesPatch('765', { auto_optimizer_enabled: true, userId: '765' }, deps), e => e instanceof PreferencesError && e.code === 'VALIDATION')
  assert.equal(reads, 0)
})
