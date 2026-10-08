import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SERVER_FEATURES_OFF,
  isEnvFlagOn,
  parseServerFeatures,
  readServerFeatures,
  serverFeatureContainerEnv,
} from '../serverFeatures.js'

test('isEnvFlagOn accepts 1/true/yes/on only', () => {
  for (const v of ['1', 'true', 'TRUE', ' yes ', 'On']) assert.equal(isEnvFlagOn(v), true, v)
  for (const v of [undefined, null, '', '0', 'false', 'off', 'no', 'enabled', '2']) {
    assert.equal(isEnvFlagOn(v), false, String(v))
  }
})

test('readServerFeatures maps each env flag', () => {
  assert.deepEqual(readServerFeatures({}), {
    chips: false,
    recipeSchedule: false,
    unfiledSuggest: false,
  })
  assert.deepEqual(
    readServerFeatures({ OC_P5_CHIPS: 'yes', OC_P5_RECIPE_SCHEDULE: '0', OC_P5_UNFILED_SUGGEST: 'on' }),
    { chips: true, recipeSchedule: false, unfiledSuggest: true },
  )
})

test('serverFeatureContainerEnv forwards only flags that are on, normalised to =1', () => {
  assert.deepEqual(serverFeatureContainerEnv({}), [])
  assert.deepEqual(
    serverFeatureContainerEnv({ OC_P5_CHIPS: 'true', OC_P5_RECIPE_SCHEDULE: 'nope', OC_P5_UNFILED_SUGGEST: '1' }),
    ['OC_P5_CHIPS=1', 'OC_P5_UNFILED_SUGGEST=1'],
  )
})

test('parseServerFeatures fails closed', () => {
  assert.deepEqual(parseServerFeatures(null), SERVER_FEATURES_OFF)
  assert.deepEqual(parseServerFeatures('x'), SERVER_FEATURES_OFF)
  assert.deepEqual(parseServerFeatures({}), SERVER_FEATURES_OFF)
  assert.deepEqual(parseServerFeatures({ features: 'on' }), SERVER_FEATURES_OFF)
  assert.deepEqual(
    parseServerFeatures({ features: { chips: true, recipeSchedule: 'true', unfiledSuggest: 1, other: true } }),
    { chips: true, recipeSchedule: false, unfiledSuggest: false },
  )
  assert.ok(Object.isFrozen(SERVER_FEATURES_OFF))
})
