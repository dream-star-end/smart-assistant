import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  _buildPinnedLookup,
  detectBlockedContent,
  fetchWebContextUrl,
  isPublicIpAddress,
  looksOoxml,
  normalizeHttpUrl,
  sniffWebContextContent,
} from '../webContextSafety.js'

function fakeLookup(address: string, family: 4 | 6 = 4): any {
  return async () => [{ address, family }]
}

describe('_buildPinnedLookup (Node autoSelectFamily contract)', () => {
  const pinned = { address: '203.0.113.7', family: 4 as const }

  it('returns an ARRAY under { all: true } (Node ≥18.13 lookupAndConnectMultiple)', () => {
    // Regression: the legacy triplet under {all:true} made Node read a bare
    // string as an address array → ERR_INVALID_IP_ADDRESS "Invalid IP address:
    // undefined", which broke every oc-web extract on Node 20.
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let received: unknown
    let err: unknown
    lookup('example.com', { all: true }, (e, addr) => {
      err = e
      received = addr
    })
    assert.equal(err, null)
    assert.deepEqual(received, [{ address: '203.0.113.7', family: 4 }])
  })

  it('returns the legacy (address, family) triplet when all is absent', () => {
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let addr: unknown
    let fam: unknown
    lookup('example.com', undefined, (_e, a, f) => {
      addr = a
      fam = f
    })
    assert.equal(addr, '203.0.113.7')
    assert.equal(fam, 4)
  })

  it('errors when the connect host drifts from the vetted host (SSRF guard)', () => {
    const lookup = _buildPinnedLookup(pinned, 'example.com')
    let err: unknown
    lookup('evil.example.net', { all: true }, (e) => {
      err = e
    })
    assert.ok(err instanceof Error)
    assert.match((err as Error).message, /unexpected hostname/)
  })
})

describe('webContextSafety', () => {
  it('rejects non-http, credentials, localhost and non-public IPs', () => {
    assert.throws(() => normalizeHttpUrl('file:///etc/passwd'), /http\/https/)
    assert.throws(() => normalizeHttpUrl('https://u:p@example.com'), /credentials/)
    assert.throws(() => normalizeHttpUrl('http://localhost:3000'), /localhost/)
    assert.equal(isPublicIpAddress('127.0.0.1'), false)
    assert.equal(isPublicIpAddress('10.0.0.1'), false)
    assert.equal(isPublicIpAddress('169.254.169.254'), false)
    assert.equal(isPublicIpAddress('::1'), false)
    assert.equal(isPublicIpAddress('fc00::1'), false)
    assert.equal(isPublicIpAddress('fd12::1'), false)
    assert.equal(isPublicIpAddress('fe80::1'), false)
    assert.equal(isPublicIpAddress('fec0::1'), false)
    assert.equal(isPublicIpAddress('ff00::1'), false)
    assert.equal(isPublicIpAddress('64:ff9b::0808:0808'), false)
    assert.equal(isPublicIpAddress('100::1'), false)
    assert.equal(isPublicIpAddress('2001::1'), false)
    assert.equal(isPublicIpAddress('2001:db8::1'), false)
    assert.equal(isPublicIpAddress('2002::1'), false)
    assert.equal(isPublicIpAddress('[::1]'), false)
    assert.equal(isPublicIpAddress('2001:4860:4860::8888'), true)
    assert.equal(isPublicIpAddress('[2001:4860:4860::8888]'), true)
    assert.equal(isPublicIpAddress('::ffff:127.0.0.1'), false)
    assert.equal(isPublicIpAddress('[::ffff:7f00:1]'), false)
    assert.equal(isPublicIpAddress('[::ffff:a9fe:a9fe]'), false)
    assert.equal(isPublicIpAddress('[::ffff:0808:0808]'), true)
    assert.equal(isPublicIpAddress('8.8.8.8'), true)
  })

  it('sniffs safe text/html/pdf content and rejects binary mismatches', () => {
    assert.deepEqual(
      sniffWebContextContent(
        Buffer.from('<!doctype html><html><body>x</body></html>'),
        'text/html',
        'https://example.com/a',
      ),
      { kind: 'html', reason: 'html_mime' },
    )
    assert.deepEqual(
      sniffWebContextContent(
        Buffer.from('{"ok":true}'),
        'application/json',
        'https://example.com/a.json',
      ),
      { kind: 'text', reason: 'text_mime' },
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from('not a pdf'),
        'application/pdf',
        'https://example.com/a.pdf',
      ).kind,
      null,
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from([0xff, 0xd8, 0xff, 0x00]),
        'image/jpeg',
        'https://example.com/a.jpg',
      ).kind,
      null,
    )
  })

  it('requires OOXML markers before accepting Office zip documents', () => {
    const docxish = Buffer.from('PK\x03\x04xxxx[Content_Types].xmlxxxxword/document.xml', 'latin1')
    assert.equal(looksOoxml(docxish, 'docx'), true)
    assert.deepEqual(
      sniffWebContextContent(
        docxish,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'https://example.com/a.docx',
      ),
      { kind: 'docx', reason: 'ooxml_magic' },
    )
    assert.equal(
      sniffWebContextContent(
        Buffer.from('PK\x03\x04plain zip', 'latin1'),
        'application/zip',
        'https://example.com/a.zip',
      ).kind,
      null,
    )
  })

  it('detects common anti-bot blocks without bypassing them', () => {
    assert.equal(detectBlockedContent(403, Buffer.from('ok')), 'http_403')
    assert.equal(
      detectBlockedContent(200, Buffer.from('Checking your browser before accessing')),
      'blocked_phrase:checking your browser',
    )
  })

  it('refuses to fetch a host that resolves to a private address', async () => {
    await assert.rejects(
      () => fetchWebContextUrl('http://example.com/', { lookup: fakeLookup('127.0.0.1') }),
      /resolve to a public IP address/,
    )
  })
})
