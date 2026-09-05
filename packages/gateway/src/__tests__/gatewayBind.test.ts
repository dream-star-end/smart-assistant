import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolveGatewayListen } from '../gatewayBind.js'

describe('resolveGatewayListen — B2 OPENCLAUDE_GATEWAY_BIND', () => {
  it('keeps the configured bind and exclusive:false on Linux when env is unset', () => {
    const got = resolveGatewayListen('0.0.0.0', 18789, {}, 'linux')
    assert.deepEqual(got, { port: 18789, host: '0.0.0.0', exclusive: false })
  })

  it('keeps personal-edition 127.0.0.1 default when env is unset', () => {
    const got = resolveGatewayListen('127.0.0.1', 18789, {}, 'linux')
    assert.deepEqual(got, { port: 18789, host: '127.0.0.1', exclusive: false })
  })

  it('desktop env override binds 127.0.0.1 with exclusive:true', () => {
    const got = resolveGatewayListen('0.0.0.0', 18789, { OPENCLAUDE_GATEWAY_BIND: '127.0.0.1' }, 'linux')
    assert.deepEqual(got, { port: 18789, host: '127.0.0.1', exclusive: true })
  })

  it('win32 always uses exclusive:true even without the env', () => {
    const got = resolveGatewayListen('127.0.0.1', 18789, {}, 'win32')
    assert.deepEqual(got, { port: 18789, host: '127.0.0.1', exclusive: true })
  })

  it('trims the env override and ignores empty values', () => {
    assert.equal(
      resolveGatewayListen('0.0.0.0', 1, { OPENCLAUDE_GATEWAY_BIND: '  127.0.0.1  ' }, 'linux').host,
      '127.0.0.1',
    )
    assert.equal(
      resolveGatewayListen('0.0.0.0', 1, { OPENCLAUDE_GATEWAY_BIND: '   ' }, 'linux').host,
      '0.0.0.0',
    )
  })
})
