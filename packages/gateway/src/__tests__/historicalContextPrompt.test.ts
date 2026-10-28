/**
 * Run: npx tsx --test packages/gateway/src/__tests__/historicalContextPrompt.test.ts
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { buildHistoricalContextPrompt } from '../sessionManager.js'
import { fitHistoricalContextJsonPrompt, renderHistoricalContextJsonPrompt } from '../historicalContextPrompt.js'

const rows = Array.from({ length: 6 }, (_, i) => ({ role: i % 2 ? 'Assistant' : 'User', text: `entry-${i} <tag>` }))

describe('historical context JSON prompt', () => {
  test('sessionManager renders through the shared format', () => {
    const messages = [
      { role: 'user', text: 'first', status: 'completed' },
      { role: 'assistant', text: 'second', status: 'completed' },
    ]
    const built = buildHistoricalContextPrompt(messages, 'now', undefined, 10_000)
    assert.equal(built, renderHistoricalContextJsonPrompt([{ role: 'User', text: 'first' }, { role: 'Assistant', text: 'second' }], 'now'))
  })

  test('returns a fitting prompt unchanged', () => {
    const prompt = renderHistoricalContextJsonPrompt(rows, 'now')
    assert.deepEqual(fitHistoricalContextJsonPrompt(prompt, () => true), { prompt, dropped: 0 })
  })

  test('keeps the longest fitting suffix', () => {
    const prompt = renderHistoricalContextJsonPrompt(rows, 'now')
    const limit = Buffer.byteLength(renderHistoricalContextJsonPrompt(rows.slice(2), 'now'))
    const fitted = fitHistoricalContextJsonPrompt(prompt, (c) => Buffer.byteLength(c) <= limit)
    assert.deepEqual(fitted, { prompt: renderHistoricalContextJsonPrompt(rows.slice(2), 'now'), dropped: 2 })
  })

  test('falls back to the current message alone, then null', () => {
    const prompt = renderHistoricalContextJsonPrompt(rows, 'now')
    assert.deepEqual(fitHistoricalContextJsonPrompt(prompt, (c) => c === 'now'), { prompt: 'now', dropped: rows.length })
    assert.equal(fitHistoricalContextJsonPrompt(prompt, () => false), null)
  })

  test('does not touch prompts that are not a JSON history block', () => {
    assert.equal(fitHistoricalContextJsonPrompt('plain message', () => false), null)
    assert.deepEqual(fitHistoricalContextJsonPrompt('plain message', () => true), { prompt: 'plain message', dropped: 0 })
  })

  test('fits prepended history without dropping or truncating the following current blocks', () => {
    const tail = '\n\nquestion about the attached file\n\n[image: /uploads/picture.png]'
    const prompt = renderHistoricalContextJsonPrompt(rows, '') + tail
    const expected = renderHistoricalContextJsonPrompt(rows.slice(2), '') + tail
    const fitted = fitHistoricalContextJsonPrompt(prompt, (c) => Buffer.byteLength(c) <= Buffer.byteLength(expected))
    assert.deepEqual(fitted, { prompt: expected, dropped: 2 })
    assert.deepEqual(fitHistoricalContextJsonPrompt(prompt, (c) => c === tail), { prompt: tail, dropped: rows.length })
    assert.equal(fitHistoricalContextJsonPrompt(prompt, () => false), null)
  })
})
