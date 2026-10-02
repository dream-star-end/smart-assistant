import { describe, expect, test } from 'bun:test'
import {
  isTrustedBoxDeferredAnnouncement,
  processTrustsBoxDeferredAnnouncement,
} from './boxDeferredAnnouncement.js'

const MODEL = 'box-api-claude-opus-5-5'

function descriptor(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    canonicalModel: MODEL,
    contextWindow: 200000,
    capabilityZero: false,
    supportsThinking: true,
    supportsVision: true,
    supportedEfforts: ['low'],
    ...extra,
  })
}

describe('trusted box deferred announcement', () => {
  test('exact box descriptor announces and a side model does not', () => {
    const env = { OC_MODEL_EXECUTION_DESCRIPTOR: descriptor({ contextOwner: 'box-native-v1' }) }
    expect(isTrustedBoxDeferredAnnouncement(MODEL, env)).toBe(true)
    expect(isTrustedBoxDeferredAnnouncement('claude-sonnet-4-5', env)).toBe(false)
    expect(isTrustedBoxDeferredAnnouncement(undefined, env)).toBe(false)
    expect(processTrustsBoxDeferredAnnouncement(env)).toBe(true)
  })

  test('missing owner, missing descriptor, and a bad shape do not authorize', () => {
    expect(isTrustedBoxDeferredAnnouncement(MODEL, {})).toBe(false)
    expect(processTrustsBoxDeferredAnnouncement({})).toBe(false)
    const unsigned = { OC_MODEL_EXECUTION_DESCRIPTOR: descriptor() }
    expect(isTrustedBoxDeferredAnnouncement(MODEL, unsigned)).toBe(false)
    expect(processTrustsBoxDeferredAnnouncement(unsigned)).toBe(false)
    const malformed = { OC_MODEL_EXECUTION_DESCRIPTOR: '{' }
    expect(() => isTrustedBoxDeferredAnnouncement(MODEL, malformed)).toThrow(/not valid JSON/)
    expect(() => processTrustsBoxDeferredAnnouncement(malformed)).toThrow(/not valid JSON/)
    const shapeless = { OC_MODEL_EXECUTION_DESCRIPTOR: JSON.stringify({ canonicalModel: 1 }) }
    expect(() => processTrustsBoxDeferredAnnouncement(shapeless)).toThrow(/invalid shape/)
  })
})
