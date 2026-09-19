import './helpers/subprocessRunnerSpawnEnvIsolate.js'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  assertCcbSpawnWiring,
  assertNotInheritedWrongValues,
  inspectCcbSpawnWiring,
  spawnAndReadChildEnv,
  variantProviderAfterSession,
  variantWrongSessionAlias,
} from './helpers/subprocessRunnerSpawnWiring.js'

const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')

test('CCB spawn stamps both session aliases from its own session, after provider overrides', () => {
  const wiring = assertCcbSpawnWiring(src)
  assert.equal(wiring.ocSessionKeyCount, 1)
  assert.ok(wiring.providerSpreadIndex < wiring.ocSessionKeyIndex)
  assert.ok(wiring.providerSpreadIndex < wiring.openclaudeSessionKeyIndex)
})

test('oracle rejects a wrong session alias source', () => {
  const mutated = variantWrongSessionAlias(src)
  const result = inspectCcbSpawnWiring(mutated)
  if (result.ok) assert.fail('expected oracle to reject wrong session alias')
  assert.match(result.reason, /this\.opts\.sessionKey/)
})

test('oracle rejects provider spread after session aliases', () => {
  const mutated = variantProviderAfterSession(src)
  const result = inspectCcbSpawnWiring(mutated)
  if (result.ok) assert.fail('expected oracle to reject provider-after-session')
  assert.match(result.reason, /finalizedProviderEnv must spread before both session aliases/)
})

test('real LocalBackend child receives runner session aliases, not parent or provider values', async () => {
  const sessionKey = 'a9-runner-session-aliases'
  const { probe, childPid } = await spawnAndReadChildEnv({
    sessionKey,
    traceId: 'a9-trace-session-case',
    caseMarker: 'session-aliases',
  })
  assert.ok(childPid !== process.pid)
  assert.equal(probe.OC_SESSION_KEY, sessionKey)
  assert.equal(probe.OPENCLAUDE_SESSION_KEY, sessionKey)
  assertNotInheritedWrongValues(probe)
})
