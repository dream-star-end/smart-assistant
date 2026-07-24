import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Gateway } from '../server.js'

const structuredOutput = {
  summary: 'ok',
  done: true,
  userProposals: [],
  platformFindings: [],
}

function makeGateway(model: string) {
  const gateway = Object.create(Gateway.prototype) as any
  const calls = {
    getOrCreate: [] as any[],
    submit: [] as any[],
    destroy: [] as string[],
  }
  gateway.deps = { config: { defaults: { model: 'glm-5.2' } } }
  gateway._getAgentsConfig = async () => ({
    default: 'main',
    agents: [{ id: 'main', model: 'glm-5.2' }],
  })
  gateway.sessions = {
    getOrCreate: async (input: any) => {
      calls.getOrCreate.push(input)
      return { model, runner: { engineId: model === 'deepseek-v4-flash' ? 'ccb' : 'codex' } }
    },
    submit: async (
      _session: unknown,
      _prompt: string,
      onEvent: (event: any) => void,
      _effort: string,
      _model: string,
      requestId?: string,
      _parent?: unknown,
      _mode?: string,
      options?: unknown,
    ) => {
      calls.submit.push({ requestId, options })
      if (model === 'gpt-5.6-terra') {
        onEvent({
          kind: 'codex_billing',
          requestId: 'a'.repeat(32),
          engineSessionId: `oceng-${'b'.repeat(48)}`,
          status: 'success',
          durationMs: 10,
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      }
      onEvent({ kind: 'final', meta: { structuredOutput } })
    },
    destroySession: async (sessionKey: string) => {
      calls.destroy.push(sessionKey)
    },
  }
  return { gateway, calls }
}

function makeClient() {
  const calls = {
    admit: 0,
    retryPending: 0,
    stageBilling: 0,
    settleStaged: 0,
    abandon: 0,
  }
  return {
    calls,
    client: {
      admit: async () => {
        calls.admit++
        return {
          requestId: 'a'.repeat(32),
          engineSessionId: `oceng-${'b'.repeat(48)}`,
          routeFrame: { baseUrl: 'http://relay.invalid' },
        }
      },
      retryPending: async () => {
        calls.retryPending++
      },
      stageBilling: async () => {
        calls.stageBilling++
        return 'durable'
      },
      settleStaged: async () => {
        calls.settleStaged++
      },
      abandon: async () => {
        calls.abandon++
      },
    } as any,
  }
}

describe('Gateway Auto-Dream optimizer model runner', () => {
  test('DeepSeek V4 Flash uses CCB proxy billing without Codex admission', async () => {
    const { gateway, calls } = makeGateway('deepseek-v4-flash')
    const { client, calls: clientCalls } = makeClient()
    const output = await gateway._runAutoDreamOptimizerModel(
      {
        runId: '00000000-0000-4000-8000-000000000001',
        callId: '00000000-0000-4000-8000-000000000001:0',
        agentId: 'main',
        userId: '247',
        model: 'deepseek-v4-flash',
        prompt: 'audit',
        phase: 'map',
      },
      client,
    )

    assert.deepEqual(JSON.parse(output), structuredOutput)
    assert.equal(calls.getOrCreate[0]?.userId, '247')
    assert.equal(calls.getOrCreate[0]?.hermeticNoTools, true)
    assert.ok(calls.getOrCreate[0]?.structuredOutputSchema)
    assert.deepEqual(calls.submit, [{ requestId: undefined, options: undefined }])
    assert.deepEqual(clientCalls, {
      admit: 0,
      retryPending: 1,
      stageBilling: 0,
      settleStaged: 0,
      abandon: 0,
    })
    assert.equal(calls.destroy.length, 1)
  })

  test('Terra keeps Codex admission and durable billing settlement', async () => {
    const { gateway, calls } = makeGateway('gpt-5.6-terra')
    const { client, calls: clientCalls } = makeClient()
    await gateway._runAutoDreamOptimizerModel(
      {
        runId: '00000000-0000-4000-8000-000000000002',
        callId: '00000000-0000-4000-8000-000000000002:0',
        agentId: 'main',
        userId: '247',
        model: 'gpt-5.6-terra',
        prompt: 'audit',
        phase: 'map',
      },
      client,
    )

    assert.equal(calls.getOrCreate[0]?.userId, undefined)
    assert.equal(calls.submit[0]?.requestId, 'a'.repeat(32))
    assert.deepEqual(calls.submit[0]?.options, {
      codexRoute: { baseUrl: 'http://relay.invalid' },
    })
    assert.deepEqual(clientCalls, {
      admit: 1,
      retryPending: 0,
      stageBilling: 1,
      settleStaged: 1,
      abandon: 0,
    })
  })
})
