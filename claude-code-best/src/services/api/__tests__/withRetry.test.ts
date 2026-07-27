import type Anthropic from '@anthropic-ai/sdk'
import { APIError } from '@anthropic-ai/sdk'
import { describe, expect, test } from 'bun:test'

import { CannotRetryError, withRetry } from '../withRetry.js'

function apiError(
  code: string,
  headers: Record<string, string> = {},
): APIError {
  return new APIError(
    409,
    { error: { code, message: code } },
    code,
    new Headers(headers),
  )
}

describe('withRetry model-authority 409', () => {
  test('MODEL_CONFIG_CHANGED_RETRY_TURN never retries, even when the header asks to retry', async () => {
    const original = apiError('MODEL_CONFIG_CHANGED_RETRY_TURN', {
      'x-should-retry': 'true',
    })
    let operationCalls = 0
    const generator = withRetry(
      async () => ({}) as Anthropic,
      async () => {
        operationCalls += 1
        throw original
      },
      {
        maxRetries: 3,
        model: 'test-model',
        thinkingConfig: { type: 'disabled' },
      },
    )

    let caught: unknown
    let yields = 0
    try {
      while (true) {
        const next = await generator.next()
        if (next.done) break
        yields += 1
      }
    } catch (error) {
      caught = error
    }

    expect(operationCalls).toBe(1)
    expect(yields).toBe(0)
    expect(caught).toBeInstanceOf(CannotRetryError)
    expect((caught as CannotRetryError).originalError).toBe(original)
  })

  test('other 409 errors keep their existing retry behavior', async () => {
    let operationCalls = 0
    const generator = withRetry(
      async () => ({}) as Anthropic,
      async () => {
        operationCalls += 1
        if (operationCalls === 1) throw apiError('LOCK_TIMEOUT')
        return 'ok'
      },
      {
        maxRetries: 1,
        model: 'test-model',
        thinkingConfig: { type: 'disabled' },
      },
    )

    let yields = 0
    let result: string | undefined
    while (true) {
      const next = await generator.next()
      if (next.done) {
        result = next.value
        break
      }
      yields += 1
    }

    expect(result).toBe('ok')
    expect(operationCalls).toBe(2)
    expect(yields).toBe(1)
  })
})
