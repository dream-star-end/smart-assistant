import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  LOCAL_BRIDGE_HEADER,
  LOCAL_BRIDGE_TOKEN_ENV,
  checkLocalBridge,
  isHealthzFileProxyReady,
  isLoopbackRemoteAddress,
} from '../localBridgeAuth.js'

const TOKEN = 'a'.repeat(64)
const OTHER = 'b'.repeat(64)

function req(
  remoteAddress: string | undefined,
  header?: string,
): Parameters<typeof checkLocalBridge>[0] {
  return {
    socket: { remoteAddress },
    headers: header === undefined ? {} : { [LOCAL_BRIDGE_HEADER]: header },
  }
}

describe('checkLocalBridge — B1 local-bridge token branch', () => {
  it('allows loopback + matching 64-hex token when env is set', () => {
    const env = { [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }
    assert.equal(checkLocalBridge(req('127.0.0.1', TOKEN), env), true)
    assert.equal(checkLocalBridge(req('::1', TOKEN), env), true)
    assert.equal(checkLocalBridge(req('::ffff:127.0.0.1', TOKEN), env), true)
  })

  it('rejects a wrong token (falls through to the original auth chain)', () => {
    const env = { [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }
    assert.equal(checkLocalBridge(req('127.0.0.1', OTHER), env), false)
  })

  it('rejects a non-loopback source even with a matching token', () => {
    const env = { [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }
    assert.equal(checkLocalBridge(req('172.31.0.1', TOKEN), env), false)
    assert.equal(checkLocalBridge(req('10.0.0.8', TOKEN), env), false)
    assert.equal(checkLocalBridge(req('192.168.1.5', TOKEN), env), false)
  })

  it('does not participate when env is unset (even with a well-formed header)', () => {
    assert.equal(checkLocalBridge(req('127.0.0.1', TOKEN), {}), false)
    assert.equal(checkLocalBridge(req('127.0.0.1', TOKEN), { [LOCAL_BRIDGE_TOKEN_ENV]: '' }), false)
  })

  it('rejects malformed env or header tokens', () => {
    assert.equal(checkLocalBridge(req('127.0.0.1', TOKEN), { [LOCAL_BRIDGE_TOKEN_ENV]: 'short' }), false)
    assert.equal(
      checkLocalBridge(req('127.0.0.1', 'not-hex'), { [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }),
      false,
    )
    assert.equal(checkLocalBridge(req('127.0.0.1'), { [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }), false)
  })

  it('is case-insensitive on hex and never reads TRUST_BRIDGE_IP', () => {
    const env = {
      [LOCAL_BRIDGE_TOKEN_ENV]: 'Ab'.repeat(32),
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
    }
    assert.equal(checkLocalBridge(req('127.0.0.1', 'aB'.repeat(32)), env), true)
    assert.equal(checkLocalBridge(req('172.31.0.1', 'aB'.repeat(32)), env), false)
  })
})

describe('isLoopbackRemoteAddress', () => {
  it('accepts IPv4, IPv6, and mapped IPv4 loopback only', () => {
    assert.equal(isLoopbackRemoteAddress('127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('::1'), true)
    assert.equal(isLoopbackRemoteAddress('::ffff:127.0.0.1'), true)
    assert.equal(isLoopbackRemoteAddress('127.0.0.2'), false)
    assert.equal(isLoopbackRemoteAddress(undefined), false)
  })
})

describe('W4 healthz file-proxy-v1 must stay off in local-bridge mode', () => {
  it('does not advertise file-proxy-v1 when only LOCAL_BRIDGE_TOKEN is set', () => {
    assert.equal(
      isHealthzFileProxyReady({ [LOCAL_BRIDGE_TOKEN_ENV]: TOKEN }),
      false,
    )
  })

  it('still requires the docker three-pack (unchanged Linux predicate)', () => {
    assert.equal(
      isHealthzFileProxyReady({
        OPENCLAUDE_TRUST_BRIDGE_IP: '172.30.0.1',
        OC_CONTAINER_ID: '12',
        OC_BRIDGE_NONCE: TOKEN,
      }),
      true,
    )
    assert.equal(
      isHealthzFileProxyReady({
        OPENCLAUDE_TRUST_BRIDGE_IP: '999.999.999.999',
        OC_CONTAINER_ID: '12',
        OC_BRIDGE_NONCE: TOKEN,
      }),
      false,
    )
    assert.equal(isHealthzFileProxyReady({}), false)
  })
})
