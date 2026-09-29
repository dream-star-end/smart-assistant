import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { boxNativeRemoteContextOwnsHistory } from '../boxNativeRemoteContext.js'

const ENV = 'OC_MODEL_EXECUTION_DESCRIPTOR'
const descriptor = {
  canonicalModel: 'box-api-claude-opus-5-5',
  contextWindow: 200_000,
  capabilityZero: false,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: ['high'],
  contextOwner: 'box-native-v1',
}

describe('box native remote context', () => {
  afterEach(() => {
    delete process.env[ENV]
    delete process.env.OC_BOX_CONTEXT_OWNER
  })

  it('exact signed box model owns sdk and repl history only', () => {
    process.env[ENV] = JSON.stringify(descriptor)
    process.env.OC_BOX_CONTEXT_OWNER = 'box-native-v1'
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), true)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'repl_main_thread',
    }), true)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'compact',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'agent:worker',
    }), false)
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'claude-3-5-haiku-latest',
      querySource: 'sdk',
    }), false)
  })

  it('no cap, wrong model, and a fake token do not own history', () => {
    process.env.OC_BOX_CONTEXT_OWNER = 'box-native-v1'
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), false)
    process.env[ENV] = JSON.stringify({ ...descriptor, canonicalModel: 'glm-5.2' })
    assert.equal(boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), false)
    process.env[ENV] = JSON.stringify({ ...descriptor, contextOwner: 'fake' })
    assert.throws(() => boxNativeRemoteContextOwnsHistory({
      model: 'box-api-claude-opus-5-5',
      querySource: 'sdk',
    }), /invalid shape/)
  })
})
