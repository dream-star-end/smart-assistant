import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isCliHelpArg } from '../ocResearchClient.js'

describe('isCliHelpArg', () => {
  test('only explicit help tokens count; empty argv stays a usage error', () => {
    assert.equal(isCliHelpArg(undefined), false)
    assert.equal(isCliHelpArg(''), false)
    assert.equal(isCliHelpArg('search'), false)
    assert.equal(isCliHelpArg('help'), true)
    assert.equal(isCliHelpArg('--help'), true)
    assert.equal(isCliHelpArg('-h'), true)
  })
})
