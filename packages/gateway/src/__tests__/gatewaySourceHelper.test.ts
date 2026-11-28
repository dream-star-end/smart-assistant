import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  GATEWAY_SOURCE_FILES,
  gatewayMethodBody,
  readGatewaySource,
} from './helpers/gatewaySource.js'

describe('OCV5-928 gatewaySource aggregator', () => {
  it('deduplicates base files and recursively discovers routes/*.ts submodules', () => {
    assert.equal(
      new Set(GATEWAY_SOURCE_FILES).size,
      GATEWAY_SOURCE_FILES.length,
      'GATEWAY_SOURCE_FILES must not contain duplicate paths',
    )
    assert.ok(GATEWAY_SOURCE_FILES.includes('server.ts'))
    assert.ok(GATEWAY_SOURCE_FILES.includes('routes/clientSessions.ts'))
    assert.ok(GATEWAY_SOURCE_FILES.includes('routes/chatProjects.ts'))
    assert.ok(GATEWAY_SOURCE_FILES.includes('routes/projectAssets.ts'))
    assert.equal(
      GATEWAY_SOURCE_FILES.some((f) => f.endsWith('.test.ts') || f.endsWith('.d.ts')),
      false,
    )
  })

  it('readGatewaySource and gatewayMethodBody cover split-out modules and server.ts', () => {
    const src = readGatewaySource()
    assert.match(src, /handleClientSessionsHttp/)
    assert.match(src, /export async function dispatchInbound/)
    assert.match(gatewayMethodBody('dispatchInbound'), /^export async function dispatchInbound\(/)
    assert.match(gatewayMethodBody('bootAutoResume'), /^export async function bootAutoResume\(/)
  })
})
