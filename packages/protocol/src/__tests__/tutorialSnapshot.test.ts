import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPrivatePublicReplayField, TUTORIAL_SANITIZER_VERSION } from '../tutorialSnapshot.js'

test('private replay field names are canonicalized', () => {
  assert.equal(isPrivatePublicReplayField('session_id'), true)
  assert.equal(isPrivatePublicReplayField('sourceSessionId'), true)
  assert.equal(isPrivatePublicReplayField('text'), false)
  assert.equal(TUTORIAL_SANITIZER_VERSION.startsWith('tutorial-sanitizer-'), true)
})
