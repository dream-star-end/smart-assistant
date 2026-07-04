/**
 * oc-market CLI endpoint resolution tests.
 * Run: npx tsx --test packages/gateway/src/__tests__/ocMarketCli.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  resolveLocalGatewayBase,
  resolveMarketplaceEndpoint,
} from '../ocMarketCli.js'

function reader(files: Record<string, string>) {
  return (path: string) => {
    const v = files[path]
    if (v === undefined) throw new Error(`missing ${path}`)
    return v
  }
}

describe('ocMarketCli endpoint resolution', () => {
  test('uses direct master endpoint when master base and token are present', () => {
    const ep = resolveMarketplaceEndpoint({
      OPENCLAUDE_V3_MASTER_BASE_URL: 'http://172.31.0.1:18892///',
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.secret',
      HOME: '/home/agent',
    })
    assert.deepEqual(ep, {
      baseUrl: 'http://172.31.0.1:18892/internal/v3/marketplace/agent',
      token: 'oc-v3.1.secret',
      mode: 'master',
    })
  })

  test('falls back to local gateway config when OPENCLAUDE_* env is scrubbed', () => {
    const readFile = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({ gateway: { port: 18789 } }),
    }) as any
    assert.equal(
      resolveLocalGatewayBase({ HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:18789/internal/v3/marketplace/agent-local',
    )
    assert.deepEqual(resolveMarketplaceEndpoint({ HOME: '/home/agent' }, readFile), {
      baseUrl: 'http://127.0.0.1:18789/internal/v3/marketplace/agent-local',
      mode: 'local',
    })
  })

  test('OPENCLAUDE_HOME wins over HOME for local gateway config', () => {
    const readFile = reader({
      '/custom/openclaude.json': JSON.stringify({ gateway: { port: '19999' } }),
    }) as any
    assert.equal(
      resolveLocalGatewayBase({ OPENCLAUDE_HOME: '/custom', HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:19999/internal/v3/marketplace/agent-local',
    )
  })
})
