import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseGatewayPortOverride, resolveGatewayListen } from '../gatewayBind.js'

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

describe('resolveGatewayListen — S3c OPENCLAUDE_GATEWAY_PORT', () => {
  it('keeps config.port on Linux when the port env is unset (zero regression)', () => {
    const got = resolveGatewayListen('0.0.0.0', 18789, {}, 'linux')
    assert.equal(got.port, 18789)
    assert.equal(got.exclusive, false)
  })

  it('desktop Host port env overrides config.port without changing bind semantics', () => {
    const got = resolveGatewayListen(
      '0.0.0.0',
      18789,
      { OPENCLAUDE_GATEWAY_BIND: '127.0.0.1', OPENCLAUDE_GATEWAY_PORT: '19111' },
      'linux',
    )
    assert.deepEqual(got, { port: 19111, host: '127.0.0.1', exclusive: true })
  })

  it('ignores empty, non-integer, and out-of-range port overrides', () => {
    assert.equal(parseGatewayPortOverride(''), null)
    assert.equal(parseGatewayPortOverride('  '), null)
    assert.equal(parseGatewayPortOverride('abc'), null)
    assert.equal(parseGatewayPortOverride('0'), null)
    assert.equal(parseGatewayPortOverride('65536'), null)
    assert.equal(parseGatewayPortOverride('18789'), 18789)
    assert.equal(
      resolveGatewayListen('127.0.0.1', 18789, { OPENCLAUDE_GATEWAY_PORT: 'nope' }, 'linux').port,
      18789,
    )
  })
})
