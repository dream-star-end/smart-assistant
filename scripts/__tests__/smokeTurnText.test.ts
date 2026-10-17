/**
 * OCV5-482: deploy smoke exact-answer normalization (scripts/lib/smoke-turn-text.mjs).
 * Run: npx tsx --test scripts/__tests__/smokeTurnText.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { answerTextForExactCheck } from '../lib/smoke-turn-text.mjs'

const NEXT = '```ui\n{"type":"next","text":"再算一下"}\n```'

describe('answerTextForExactCheck', () => {
  test('drops one trailing well-formed next block', () => {
    assert.equal(answerTextForExactCheck(`2\n\n${NEXT}`), '2')
    assert.equal(answerTextForExactCheck('2\n~~~~ui\n{"type":"next","text":"x"}\n~~~~'), '2')
  })

  test('keeps text with no block unchanged', () => {
    assert.equal(answerTextForExactCheck('2'), '2')
  })

  test('glued, middle, repeated, other-type and malformed blocks are not stripped', () => {
    for (const text of [
      '2```ui{"type":"next","text":"x"}\n```',
      `${NEXT}\n2`,
      `2\n${NEXT}\n${NEXT}`,
      '2\n```ui\n{"type":"choices","text":"x"}\n```',
      '2\n```ui\n{"type":"next","text":3}\n```',
      '2\n```ui\n{"type":"next","text":"x"\n```',
      '2\n```ui\n{"type":"next","text":"x"}\n````',
    ]) {
      assert.equal(answerTextForExactCheck(text), text, JSON.stringify(text))
    }
  })
})
