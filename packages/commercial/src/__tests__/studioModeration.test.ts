import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  buildModerationPrompt,
  moderationOutcome,
  parseModeration,
} from '../media-studio/orchestrator/moderation.js'

describe('brief moderation (OCV5-591 A2-1b-1)', () => {
  it('parses the verdict; anything broken is uncertain, never pass', () => {
    assert.deepEqual(parseModeration('{"verdict":"block","reason":"血腥"}'), {
      verdict: 'block',
      reason: '血腥',
    })
    assert.equal(parseModeration('ok').verdict, 'uncertain')
    assert.equal(parseModeration('{"verdict":"fine"}').verdict, 'uncertain')
  })

  it('unsure passes only while visual QA will judge every image', () => {
    assert.equal(moderationOutcome('pass', false), 'plan')
    assert.equal(moderationOutcome('block', true), 'fail')
    assert.equal(moderationOutcome('uncertain', true), 'plan')
    assert.equal(moderationOutcome('uncertain', false), 'draft')
    assert.equal(moderationOutcome('unavailable', true), 'plan')
    assert.equal(moderationOutcome('unavailable', false), 'draft')
  })

  it('the prompt carries the brief and asks for strict JSON', () => {
    const p = buildModerationPrompt('一只小狐狸在雪地里找朋友')
    assert.ok(p.includes('小狐狸') && p.includes('"verdict"'))
  })
})
