import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { describe, test } from 'node:test'

import {
  BROWSER_HANDOFF_MAX_DELAY_MS,
  BROWSER_HANDOFF_MIN_DELAY_MS,
  CONTAINER_PREVIEW_PROTOCOL_VERSION,
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_BINARY_HEADER_BYTES,
  LIVE_BROWSER_BINARY_MAGIC,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_MAX_BINARY_FRAME_BYTES,
  LIVE_BROWSER_PROTOCOL_VERSION,
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  decodeLiveBrowserFrame,
  encodeLiveBrowserFrame,
  liveBrowserModifiersToBitmask,
  normalizeBrowserHandoffResumeWhen,
} from '../index.js'
import {
  ContainerPreviewAssertionError,
  LIVE_BROWSER_ASSERTION_KIND,
  LIVE_BROWSER_ASSERTION_MAX_TTL_MS,
  containerPreviewAssertionSigningInput,
  encodeContainerPreviewAssertion,
  signLiveBrowserAssertion,
  verifyContainerPreviewAssertion,
  verifyLiveBrowserAssertion,
} from '../containerPreviewAuth.js'

function makeEd25519Keypair(keyId = 'mak1_0123456789abcdef') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
  const rawPub = new Uint8Array(Buffer.from(jwk.x, 'base64url'))
  const keyring = new Map<string, Uint8Array>([[keyId, rawPub]])
  return { keyId, privateKey, keyring }
}

describe('liveBrowser protocol framing', () => {
  test('exports expected constants', () => {
    assert.equal(LIVE_BROWSER_PROTOCOL_VERSION, 1)
    assert.equal(LIVE_BROWSER_PUBLIC_WS_PATH, '/ws/live-browser')
    assert.equal(LIVE_BROWSER_INTERNAL_WS_PATH, '/ws/live-browser')
    assert.equal(LIVE_BROWSER_TICKET_PROTOCOL, 'live-browser-v1')
    assert.equal(LIVE_BROWSER_ASSERTION_HEADER, 'x-openclaude-live-browser-assertion')
    assert.equal(LIVE_BROWSER_BINARY_MAGIC, 'OCLB')
    assert.equal(LIVE_BROWSER_BINARY_HEADER_BYTES, 20)
    assert.equal(LIVE_BROWSER_MAX_BINARY_FRAME_BYTES, 8 * 1024 * 1024)
  })

  test('round-trips jpeg and png binary frames with exact 20-byte header layout', () => {
    const jpegPayload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02])
    const encoded = encodeLiveBrowserFrame({
      seq: 42,
      width: 1440,
      height: 900,
      format: 'jpeg',
      settled: true,
      payload: jpegPayload,
    })
    assert.equal(encoded.byteLength, 20 + jpegPayload.byteLength)
    assert.equal(Buffer.from(encoded.subarray(0, 4)).toString('ascii'), 'OCLB')
    const dv = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    assert.equal(dv.getUint32(4, false), 1)
    assert.equal(dv.getUint32(8, false), 42)
    assert.equal(dv.getUint16(12, false), 1440)
    assert.equal(dv.getUint16(14, false), 900)
    assert.equal(dv.getUint8(16), 1)
    assert.equal(dv.getUint8(17), 1)
    assert.equal(dv.getUint16(18, false), 0)

    const decoded = decodeLiveBrowserFrame(encoded)
    assert.equal(decoded.version, 1)
    assert.equal(decoded.seq, 42)
    assert.equal(decoded.width, 1440)
    assert.equal(decoded.height, 900)
    assert.equal(decoded.format, 'jpeg')
    assert.equal(decoded.settled, true)
    assert.equal(decoded.navGen, 0)
    assert.deepEqual(Array.from(decoded.payload), Array.from(jpegPayload))

    const encodedWithNavGen = encodeLiveBrowserFrame({
      seq: 43,
      width: 1440,
      height: 900,
      format: 'jpeg',
      settled: false,
      navGen: 0x10005, // wraps cleanly to u16 (5)
      payload: jpegPayload,
    })
    assert.equal(encodedWithNavGen.byteLength, 20 + jpegPayload.byteLength)
    const dvNav = new DataView(
      encodedWithNavGen.buffer,
      encodedWithNavGen.byteOffset,
      encodedWithNavGen.byteLength,
    )
    assert.equal(dvNav.getUint16(18, false), 5)
    assert.equal(decodeLiveBrowserFrame(encodedWithNavGen).navGen, 5)

    const pngPayload = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const encodedPng = encodeLiveBrowserFrame({
      seq: 0,
      width: 1280,
      height: 720,
      format: 'png',
      navGen: 17,
      payload: pngPayload,
    })
    const decodedPng = decodeLiveBrowserFrame(encodedPng.buffer)
    assert.equal(decodedPng.format, 'png')
    assert.equal(decodedPng.settled, false)
    assert.equal(decodedPng.navGen, 17)
    assert.deepEqual(Array.from(decodedPng.payload), Array.from(pngPayload))
  })

  test('rejects invalid magic, version, format, and truncated payloads', () => {
    const valid = encodeLiveBrowserFrame({
      seq: 1,
      width: 100,
      height: 100,
      format: 'jpeg',
      payload: new Uint8Array([1, 2, 3]),
    })
    assert.throws(() => decodeLiveBrowserFrame(valid.subarray(0, 20)), /truncated/)

    const badMagic = valid.slice()
    badMagic[0] = 0x58
    assert.throws(() => decodeLiveBrowserFrame(badMagic), /magic/)

    const badVer = valid.slice()
    new DataView(badVer.buffer).setUint32(4, 2, false)
    assert.throws(() => decodeLiveBrowserFrame(badVer), /version/)

    const badFormat = valid.slice()
    badFormat[16] = 9
    assert.throws(() => decodeLiveBrowserFrame(badFormat), /format/)

    assert.throws(
      () =>
        encodeLiveBrowserFrame({
          seq: 1,
          width: 100,
          height: 100,
          format: 'jpeg',
          payload: new Uint8Array(0),
        }),
      /empty/,
    )
  })

  test('converts structured modifiers to CDP bitmask', () => {
    assert.equal(liveBrowserModifiersToBitmask(undefined), 0)
    assert.equal(liveBrowserModifiersToBitmask({ alt: true }), 1)
    assert.equal(liveBrowserModifiersToBitmask({ ctrl: true, shift: true }), 10)
    assert.equal(liveBrowserModifiersToBitmask({ alt: true, ctrl: true, meta: true, shift: true }), 15)
    assert.equal(liveBrowserModifiersToBitmask(7), 7)
  })

  test('normalizes BrowserHandoffResumeWhen (camelCase + snake_case, bounds, backward compat)', () => {
    assert.equal(normalizeBrowserHandoffResumeWhen(undefined), undefined)
    assert.equal(normalizeBrowserHandoffResumeWhen(null), undefined)
    assert.equal(normalizeBrowserHandoffResumeWhen({}), undefined)
    assert.equal(normalizeBrowserHandoffResumeWhen('bad'), undefined)

    const snake = normalizeBrowserHandoffResumeWhen({
      url_leave: ['/login', '  /oauth  ', '', 123, 'bad\nline'],
      url_match: ['/dashboard'],
      selector_appear: ' [data-testid="user-menu"] ',
      selector_gone: 'input[type="password"]',
      wait_download: true,
      auto_resume_delay_ms: 4500,
    })
    assert.deepEqual(snake, {
      urlLeave: ['/login', '/oauth'],
      urlMatch: ['/dashboard'],
      selectorAppear: '[data-testid="user-menu"]',
      selectorGone: 'input[type="password"]',
      waitDownload: true,
      autoResumeDelayMs: 4500,
    })

    const clampedLow = normalizeBrowserHandoffResumeWhen({ autoResumeDelayMs: 50 })
    assert.equal(clampedLow?.autoResumeDelayMs, BROWSER_HANDOFF_MIN_DELAY_MS)
    const clampedHigh = normalizeBrowserHandoffResumeWhen({ autoResumeDelayMs: 99_999 })
    assert.equal(clampedHigh?.autoResumeDelayMs, BROWSER_HANDOFF_MAX_DELAY_MS)
  })
})

describe('liveBrowser bridge assertion', () => {
  test('signs and verifies Ed25519 live-browser assertion and isolates from container-preview', () => {
    const { keyId, privateKey, keyring } = makeEd25519Keypair()
    const now = 1_700_000_000_000
    const payload = {
      v: LIVE_BROWSER_PROTOCOL_VERSION,
      keyId,
      uid: 42,
      containerId: 1001,
      agentId: 'main',
      sessionId: '0123456789abcdef0123456789abcdef',
      issuedAt: now,
      expiresAt: now + LIVE_BROWSER_ASSERTION_MAX_TTL_MS,
    } as const

    const envelope = signLiveBrowserAssertion(payload, privateKey)
    assert.equal(LIVE_BROWSER_ASSERTION_KIND, 'live-browser')

    const verified = verifyLiveBrowserAssertion(envelope, keyring, now + 1_000)
    assert.deepEqual(verified, payload)

    // Expired
    assert.throws(
      () => verifyLiveBrowserAssertion(envelope, keyring, now + LIVE_BROWSER_ASSERTION_MAX_TTL_MS),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'Expired',
    )

    // Unknown key
    assert.throws(
      () => verifyLiveBrowserAssertion(envelope, new Map(), now + 1_000),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'UnknownKey',
    )

    // Domain isolation: live-browser envelope must not verify as container-preview
    assert.throws(
      () => verifyContainerPreviewAssertion(envelope, keyring, now + 1_000),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'BadShape',
    )

    // Domain isolation: container-preview envelope must not verify as live-browser
    const previewPayload = {
      v: CONTAINER_PREVIEW_PROTOCOL_VERSION,
      keyId,
      uid: 42,
      containerId: 1001,
      sessionId: '0123456789abcdef0123456789abcdef',
      targetHash: 'a'.repeat(64),
      issuedAt: now,
      expiresAt: now + 10_000,
    } as const
    const previewSig = signLiveBrowserAssertion(payload, privateKey)
    assert.ok(previewSig.length > 0)
    const previewEnv = encodeContainerPreviewAssertion(
      previewPayload,
      Buffer.alloc(64, 1),
    )
    assert.throws(
      () => verifyLiveBrowserAssertion(previewEnv, keyring, now + 1_000),
      (err: unknown) => err instanceof ContainerPreviewAssertionError && err.code === 'BadShape',
    )
    assert.ok(containerPreviewAssertionSigningInput(previewPayload).byteLength > 0)
  })
})
