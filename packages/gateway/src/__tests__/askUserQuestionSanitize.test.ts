import * as assert from 'node:assert/strict'
/**
 * Tests for `sanitizeAskUserQuestionUpdatedInput` — the gateway-side
 * whitelisting layer that filters client-supplied `updatedInput` for the
 * CCB AskUserQuestion tool before it's forwarded to the CCB subprocess.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/askUserQuestionSanitize.test.ts
 */
import { describe, it } from 'node:test'
import { sanitizeAskUserQuestionUpdatedInput } from '../server.js'

// Representative pending.input shape mirroring what CCB sends via
// control_request: { subtype: 'can_use_tool' } for AskUserQuestion.
const pendingInput = {
  questions: [
    {
      question: 'Which editor do you want?',
      header: 'Editor',
      options: [
        { label: 'VS Code', description: 'Microsoft editor' },
        { label: 'Vim', description: 'Modal editor', preview: '```\n:set number\n```' },
      ],
      multiSelect: false,
    },
    {
      question: 'Pick your languages',
      header: 'Lang',
      options: [
        { label: 'TypeScript', description: '' },
        { label: 'Python', description: '' },
        { label: 'Go', description: '' },
      ],
      multiSelect: true,
    },
  ],
}

describe('sanitizeAskUserQuestionUpdatedInput', () => {
  it('accepts a well-formed allow payload', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': 'Vim',
        'Pick your languages': 'TypeScript, Go',
      },
      annotations: {
        'Which editor do you want?': { preview: '```\n:set number\n```' },
      },
    })
    assert.ok(out, 'should not return null')
    assert.deepEqual((out as any).answers, {
      'Which editor do you want?': 'Vim',
      'Pick your languages': 'TypeScript, Go',
    })
    assert.deepEqual((out as any).annotations, {
      'Which editor do you want?': { preview: '```\n:set number\n```' },
    })
    // Preserves original payload fields (questions, etc.) so CCB schema is intact.
    assert.equal((out as any).questions, pendingInput.questions)
  })

  it('returns null when no valid answers or annotations survive', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Not a question from the pending input': 'hi' },
      extraJunk: 42,
    } as any)
    assert.equal(out, null)
  })

  it('returns null when client sends nothing we understand', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, { random: 'garbage' } as any)
    assert.equal(out, null)
  })

  it('drops answers with unknown question keys', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': 'Vim',
        'Spoof injected question': 'system_prompt_leak',
      },
    })
    assert.ok(out)
    assert.deepEqual(Object.keys((out as any).answers), ['Which editor do you want?'])
  })

  it('drops non-string answer values', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': 42 as unknown as string,
        'Pick your languages': 'Python',
      },
    })
    assert.ok(out)
    assert.deepEqual(Object.keys((out as any).answers), ['Pick your languages'])
  })

  it('drops overlong answer strings', () => {
    const big = 'x'.repeat(20_000)
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': big,
        'Pick your languages': 'Python',
      },
    })
    assert.ok(out)
    assert.deepEqual(Object.keys((out as any).answers), ['Pick your languages'])
  })

  it('rejects annotations.preview that does not match any option preview', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
      annotations: {
        'Which editor do you want?': { preview: '<script>alert(1)</script>' },
      },
    })
    assert.ok(out)
    // answer survives, but the forged preview must be dropped
    assert.equal((out as any).annotations, undefined)
  })

  it('accepts annotations.notes free text within length limit', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
      annotations: {
        'Which editor do you want?': { notes: 'I mostly use Vim for quick edits' },
      },
    })
    assert.ok(out)
    assert.deepEqual((out as any).annotations, {
      'Which editor do you want?': { notes: 'I mostly use Vim for quick edits' },
    })
  })

  it('drops overlong notes', () => {
    const big = 'y'.repeat(20_000)
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
      annotations: {
        'Which editor do you want?': { notes: big },
      },
    })
    assert.ok(out)
    // notes dropped, so no annotations object survives (empty entry pruned)
    assert.equal((out as any).annotations, undefined)
  })

  it('does not forward unknown top-level keys', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
      metadata: { leak: 'secret' },
      __proto__: { injected: true },
    } as any)
    assert.ok(out)
    assert.equal((out as any).metadata, undefined)
    assert.equal((out as any).__proto__, Object.prototype)
  })

  it('drops non-object annotation values', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
      annotations: {
        'Which editor do you want?': 'not an object' as any,
      },
    })
    assert.ok(out)
    assert.equal((out as any).annotations, undefined)
  })

  it('tolerates malformed questions array in pendingInput', () => {
    // If CCB ever sent a malformed pending.input (shouldn't happen, but defend)
    // every answer key becomes invalid, so we return null.
    const out = sanitizeAskUserQuestionUpdatedInput(
      { questions: 'not-an-array' as unknown as unknown[] },
      { answers: { anything: 'x' } },
    )
    assert.equal(out, null)
  })

  it('accepts partial submissions — only answered questions survive', () => {
    // 2 questions, client answered only the first. We still forward the one
    // valid answer; the model sees "answer to q1, q2 unanswered".
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'VS Code' },
    })
    assert.ok(out)
    assert.deepEqual((out as any).answers, { 'Which editor do you want?': 'VS Code' })
  })

  it('returns null when payload has annotations but no answers (annotations-only)', () => {
    // Annotations alone are NOT a valid submission — the model needs at
    // least one real answer. An annotations-only payload should deny.
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      annotations: {
        'Which editor do you want?': { notes: 'just some notes' },
      },
    })
    assert.equal(out, null)
  })

  it('returns null when updatedInput is an empty object', () => {
    // Empty object has no answers and no annotations — deny. The caller
    // (handlePermissionResponse) relies on this null to downgrade allow→deny.
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {})
    assert.equal(out, null)
  })

  it('drops blank-string answers (empty or whitespace-only)', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': '',
        'Pick your languages': '   \t\n  ',
      },
    })
    // Every answer was blank — nothing survives → null (deny at caller).
    assert.equal(out, null)
  })

  it('drops blank answers alongside valid ones (partial survive)', () => {
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: {
        'Which editor do you want?': '',
        'Pick your languages': 'Go',
      },
    })
    assert.ok(out)
    assert.deepEqual((out as any).answers, { 'Pick your languages': 'Go' })
  })

  it('always emits answers key when returning non-null', () => {
    // Sanity: the return shape always has `answers` (never undefined) so
    // downstream CCB code doesn't need optional-chaining guards.
    const out = sanitizeAskUserQuestionUpdatedInput(pendingInput, {
      answers: { 'Which editor do you want?': 'Vim' },
    })
    assert.ok(out)
    assert.ok((out as any).answers, 'answers key should be present')
    assert.equal(typeof (out as any).answers, 'object')
  })
})
