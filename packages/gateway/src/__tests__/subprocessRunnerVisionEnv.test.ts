import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildOpenClaudeVisionMcpEnv } from '../subprocessRunner.js'

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

describe('buildOpenClaudeVisionMcpEnv', () => {
  it('passes commercial vision env only to the vision MCP process', async () => {
    await withEnv(
      {
        OPENCLAUDE_HOME: '/home/agent/.openclaude',
        OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.30.0.1:18791',
        OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3-secret',
      },
      async () => {
        const env = buildOpenClaudeVisionMcpEnv('main')
        assert.equal(env.OPENCLAUDE_AGENT_ID, 'main')
        assert.equal(env.OPENCLAUDE_HOME, '/home/agent/.openclaude')
        assert.equal(env.OPENCLAUDE_V3_MASTER_BASE_URL, 'http://172.30.0.1:18791')
        assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN, 'oc-v3-secret')
      },
    )
  })

  it('does not invent commercial vision env outside v3 containers', async () => {
    await withEnv(
      {
        OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
        OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
      },
      async () => {
        const env = buildOpenClaudeVisionMcpEnv('main')
        assert.equal(env.OPENCLAUDE_V3_MASTER_BASE_URL, undefined)
        assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined)
      },
    )
  })
})
