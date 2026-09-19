import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collabConfigVersionOf,
  collabModeToTeamMode,
  normalizeCollabMode,
} from '../collaboration.js'

test('normalizeCollabMode: explicit collabMode wins over teamMode', () => {
  assert.equal(normalizeCollabMode({}), 'solo')
  assert.equal(normalizeCollabMode({ teamMode: true }), 'team')
  assert.equal(normalizeCollabMode({ collabMode: 'advisor', teamMode: true }), 'advisor')
  assert.equal(normalizeCollabMode({ collabMode: 'solo', teamMode: true }), 'solo')
  assert.equal(normalizeCollabMode({ collabMode: 'team' }), 'team')
  assert.equal(normalizeCollabMode({ collabMode: 'nope', teamMode: false }), 'solo')
})

test('collabModeToTeamMode only true for team', () => {
  assert.equal(collabModeToTeamMode('team'), true)
  assert.equal(collabModeToTeamMode('advisor'), false)
  assert.equal(collabModeToTeamMode('solo'), false)
})

test('collabConfigVersionOf is stable and ignores advisor model outside advisor mode', () => {
  assert.equal(
    collabConfigVersionOf({ mode: 'advisor', advisorModel: 'gpt-6-astra' }),
    'v1:advisor:gpt-6-astra',
  )
  assert.equal(collabConfigVersionOf({ mode: 'solo', advisorModel: 'gpt-6-astra' }), 'v1:solo:')
  assert.equal(collabConfigVersionOf({ mode: 'team', advisorModel: 'x' }), 'v1:team:')
})
