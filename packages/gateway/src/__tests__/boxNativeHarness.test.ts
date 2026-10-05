import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  BoxNativeHarnessError,
  applyBoxNativeHarness,
  projectCcbExecutionDescriptor,
  type CcbExecutionDescriptor,
} from '../subprocessRunner.js'

const base = {
  canonicalModel: 'box-api-claude-opus-5-5',
  contextWindow: 200_000,
  supportsVision: false,
  supportedEfforts: ['high'],
  capabilityProfile: {
    ccb: { capabilityZero: false, supportsThinking: true, contextOwner: 'box-native-v1' },
  },
}

describe('box native harness', () => {
  test('ready projection keeps the model and forces a new runner onto ccb', () => {
    const descriptor = projectCcbExecutionDescriptor(base)
    assert.equal(descriptor.contextOwner, 'box-native-v1')
    assert.equal(descriptor.canonicalModel, 'box-api-claude-opus-5-5')
    assert.equal(descriptor.contextWindow, 200_000)
    const harness = applyBoxNativeHarness({
      model: 'box-api-claude-opus-5-5',
      descriptor,
      harness: 'official-cc',
      spawned: false,
    })
    assert.equal(harness, 'ccb')
  })

  test('missing token keeps official harness; wrong model and a live official process reject', () => {
    const plain = projectCcbExecutionDescriptor({
      ...base,
      capabilityProfile: { ccb: { capabilityZero: false, supportsThinking: true } },
    })
    assert.equal(plain.contextOwner, undefined)
    assert.equal(applyBoxNativeHarness({
      model: 'box-api-claude-opus-5-5',
      descriptor: plain,
      harness: 'official-cc',
      spawned: false,
    }), 'official-cc')
    assert.throws(
      () => projectCcbExecutionDescriptor({ ...base, canonicalModel: 'glm-5.2' }),
      (err: unknown) => err instanceof BoxNativeHarnessError && err.code === 'BOX_NATIVE_CONTEXT_MISMATCH',
    )
    const descriptor: CcbExecutionDescriptor = {
      canonicalModel: 'box-api-claude-opus-5-5',
      contextWindow: 200_000,
      capabilityZero: false,
      supportsThinking: true,
      supportsVision: false,
      supportedEfforts: ['high'],
      contextOwner: 'box-native-v1',
    }
    assert.throws(
      () => applyBoxNativeHarness({
        model: 'glm-5.2',
        descriptor,
        harness: undefined,
        spawned: false,
      }),
      (err: unknown) => err instanceof BoxNativeHarnessError && err.code === 'BOX_NATIVE_CONTEXT_MISMATCH',
    )
    assert.throws(
      () => applyBoxNativeHarness({
        model: 'box-api-claude-opus-5-5',
        descriptor,
        harness: 'official-cc',
        spawned: true,
      }),
      (err: unknown) => err instanceof BoxNativeHarnessError && err.code === 'BOX_NATIVE_HARNESS_LOCKED',
    )
  })
})

describe('box native harness: every listed model', () => {
  for (const model of ['box-api-claude-sonnet-5-5', 'box-api-claude-haiku-4-5']) {
    test(`${model} carries the token and runs on ccb`, () => {
      const descriptor = projectCcbExecutionDescriptor({ ...base, canonicalModel: model })
      assert.equal(descriptor.contextOwner, 'box-native-v1')
      assert.equal(applyBoxNativeHarness({ model, descriptor, harness: 'official-cc', spawned: false }), 'ccb')
    })
  }

  test('a descriptor of one listed model does not cover a turn on another', () => {
    const descriptor = projectCcbExecutionDescriptor(base)
    assert.throws(
      () => applyBoxNativeHarness({ model: 'box-api-claude-sonnet-5-5', descriptor, harness: undefined, spawned: false }),
      (err: unknown) => err instanceof BoxNativeHarnessError && err.code === 'BOX_NATIVE_CONTEXT_MISMATCH',
    )
    assert.throws(
      () => projectCcbExecutionDescriptor({ ...base, canonicalModel: 'box-api-claude-sonnet-5' }),
      (err: unknown) => err instanceof BoxNativeHarnessError && err.code === 'BOX_NATIVE_CONTEXT_MISMATCH',
    )
  })
})
