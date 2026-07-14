import * as assert from 'node:assert/strict'
import { sign as cryptoSign, generateKeyPairSync } from 'node:crypto'
import { describe, it } from 'node:test'

import {
  CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS,
  ContainerPreviewAssertionError,
  type ContainerPreviewBridgeAssertionPayload,
  containerPreviewAssertionSigningInput,
  containerPreviewTargetHash,
  encodeContainerPreviewAssertion,
  verifyContainerPreviewAssertion,
} from '../containerPreviewAuth.js'
import {
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  canonicalContainerPreviewTarget,
  decodeContainerPreviewFrame,
  encodeContainerPreviewFrame,
  isAllowedContainerPreviewHttpRequest,
  isAllowedContainerPreviewNavigation,
  isAllowedContainerPreviewWebSocket,
  isContainerPreviewUrl,
  normalizeContainerPreviewUrl,
  normalizeContainerPreviewViewport,
} from '../index.js'

describe('container preview URL boundary', () => {
  it('canonicalizes exact loopback hosts, wildcard binds and fragments', () => {
    assert.deepEqual(normalizeContainerPreviewUrl(' http://LOCALHOST.:3000/a?q=1#frag '), {
      url: 'http://localhost:3000/a?q=1',
      origin: 'http://localhost:3000',
      protocol: 'http:',
      hostname: 'localhost',
      port: 3000,
    })
    assert.equal(normalizeContainerPreviewUrl('http://0.0.0.0:5173').url, 'http://127.0.0.1:5173/')
    assert.equal(normalizeContainerPreviewUrl('http://[::]:8080').url, 'http://[::1]:8080/')
    assert.equal(normalizeContainerPreviewUrl('http://127.1:4173').hostname, '127.0.0.1')
  })

  it('rejects non-local, lookalike, credentials, backslashes and encoded bypasses', () => {
    for (const raw of [
      'https://example.com',
      'http://evil.localhost:3000',
      'http://localhost.evil.test:3000',
      'http://user:pass@localhost:3000',
      'file:///tmp/index.html',
      'http:\\localhost:3000',
      'http://[::ffff:127.0.0.1]:3000',
    ]) {
      assert.equal(isContainerPreviewUrl(raw), false, raw)
    }
    // Standard URL parsing removes host percent-encoding before the exact
    // loopback check; accepting the canonical result is not a boundary bypass.
    assert.equal(
      normalizeContainerPreviewUrl('http://%31%32%37.0.0.1:3000').url,
      'http://127.0.0.1:3000/',
    )
  })

  it('rejects the platform registry, privileged and administrative ports', () => {
    for (const port of [22, 81, 443 + 1, 2375, 5432, 6379, 9222, 18_789, 27_017]) {
      assert.throws(() => normalizeContainerPreviewUrl(`http://localhost:${port}`), String(port))
    }
    assert.equal(normalizeContainerPreviewUrl('http://localhost').port, 80)
    assert.equal(normalizeContainerPreviewUrl('https://localhost').port, 443)
    assert.equal(normalizeContainerPreviewUrl('http://localhost:1024').port, 1024)
  })

  it('pins every loopback HTTP and WebSocket request to one exact origin', () => {
    const origin = 'http://127.0.0.1:5173'
    assert.equal(
      isAllowedContainerPreviewHttpRequest('http://127.0.0.1:5173/assets/app.js', origin),
      true,
    )
    assert.equal(
      isAllowedContainerPreviewHttpRequest('http://127.0.0.1:5174/private', origin),
      false,
    )
    assert.equal(
      isAllowedContainerPreviewHttpRequest('http://localhost:5173/private', origin),
      false,
    )
    assert.equal(
      isAllowedContainerPreviewHttpRequest('https://cdn.example.com/app.js', origin),
      false,
    )
    assert.equal(isAllowedContainerPreviewNavigation('https://cdn.example.com/', origin), false)
    assert.equal(isAllowedContainerPreviewNavigation('http://127.0.0.1:5173/next', origin), true)
    assert.equal(isAllowedContainerPreviewWebSocket('ws://127.0.0.1:5173/hmr', origin), true)
    assert.equal(isAllowedContainerPreviewWebSocket('ws://127.0.0.1:5174/hmr', origin), false)
    assert.equal(isAllowedContainerPreviewWebSocket('wss://events.example.com/ws', origin), false)
  })
})

describe('container preview viewport and binary framing', () => {
  it('clamps viewport deterministically', () => {
    assert.deepEqual(
      normalizeContainerPreviewViewport({
        width: 99,
        height: 9_999,
        deviceScaleFactor: 4,
        isMobile: true,
      }),
      { width: 320, height: 1_200, deviceScaleFactor: 2, isMobile: true },
    )
    assert.equal(
      canonicalContainerPreviewTarget('http://localhost:3000/', {
        width: 390,
        height: 844,
        deviceScaleFactor: 2,
        isMobile: true,
      }),
      'http://localhost:3000/\n390x844@2\nmobile',
    )
    assert.deepEqual(
      normalizeContainerPreviewViewport({
        width: 1_920,
        height: 1_200,
        deviceScaleFactor: 2,
        isMobile: false,
      }),
      { width: 1_920, height: 1_200, deviceScaleFactor: 1.31, isMobile: false },
    )
  })

  it('round-trips an OCPF JPEG packet without copying the payload contract', () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const packet = encodeContainerPreviewFrame(
      {
        highQuality: true,
        pageRevision: 7,
        frameSequence: 42,
        pixelWidth: 780,
        pixelHeight: 1_688,
      },
      jpeg,
    )
    const decoded = decodeContainerPreviewFrame(packet)
    assert.deepEqual(decoded.header, {
      version: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      highQuality: true,
      pageRevision: 7,
      frameSequence: 42,
      pixelWidth: 780,
      pixelHeight: 1_688,
    })
    assert.deepEqual([...decoded.jpeg], [...jpeg])
    assert.throws(() => decodeContainerPreviewFrame(Uint8Array.from([1, 2, 3])))
  })
})

describe('container preview bridge assertion', () => {
  const now = 1_780_000_000_000
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publicRaw = Buffer.from(
    (publicKey.export({ format: 'jwk' }) as { x: string }).x,
    'base64url',
  )
  const keyId = 'mak1_0123456789abcdef'
  const keyring = new Map<string, Uint8Array>([[keyId, publicRaw]])
  const viewport = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true } as const

  function payload(
    over: Partial<ContainerPreviewBridgeAssertionPayload> = {},
  ): ContainerPreviewBridgeAssertionPayload {
    return {
      v: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      keyId,
      uid: 42,
      containerId: 7,
      sessionId: 'a'.repeat(32),
      targetHash: containerPreviewTargetHash('http://127.0.0.1:5173/', viewport),
      issuedAt: now,
      expiresAt: now + CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS,
      ...over,
    }
  }

  function sign(p: ContainerPreviewBridgeAssertionPayload): string {
    return encodeContainerPreviewAssertion(
      p,
      cryptoSign(null, containerPreviewAssertionSigningInput(p), privateKey),
    )
  }

  it('has a stable target hash and verifies a valid signed assertion', () => {
    assert.equal(
      containerPreviewTargetHash('http://127.0.0.1:5173/', viewport),
      '0ae6ec85cddc8a1dcd4a1fac8be6de42490b4809c0a5265f9705de564e7e133c',
    )
    assert.deepEqual(verifyContainerPreviewAssertion(sign(payload()), keyring, now + 1), payload())
  })

  it('rejects tampering, wrong keys, expiry and excessive TTL', () => {
    const signed = sign(payload())
    assert.throws(
      () => verifyContainerPreviewAssertion(signed, new Map(), now),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'UnknownKey',
    )
    assert.throws(
      () =>
        verifyContainerPreviewAssertion(
          signed,
          keyring,
          now + CONTAINER_PREVIEW_ASSERTION_MAX_TTL_MS,
        ),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'Expired',
    )
    assert.throws(
      () =>
        verifyContainerPreviewAssertion(sign(payload({ expiresAt: now + 30_001 })), keyring, now),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'BadShape',
    )

    const decoded = JSON.parse(Buffer.from(signed, 'base64url').toString('utf8')) as any
    decoded.payload.containerId = 8
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')
    assert.throws(
      () => verifyContainerPreviewAssertion(tampered, keyring, now),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'VerifyFail',
    )
  })
})
