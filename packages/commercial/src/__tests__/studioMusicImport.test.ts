/**
 * OCV5-591 M1: the catalog import manifest — only commercially usable licences, CC BY with its
 * attribution, https sources and files that stay inside the manifest directory.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseCatalogManifest } from '../media-studio/music/catalogImport.js'

const entry = (over: Record<string, unknown> = {}) => ({
  source: 'incompetech',
  sourceTrackId: 'USUAN1200076',
  title: 'Easy Lemon',
  artist: 'Kevin MacLeod',
  landingUrl: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1200076',
  license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
  durationMs: 126380,
  bpm: 82,
  moods: ['宁静', '轻快'],
  mime: 'audio/mpeg',
  audioPath: 'tracks/USUAN1200076.mp3',
  audioSha: 'a'.repeat(64),
  evidencePath: 'evidence/USUAN1200076.png',
  evidenceSha: 'b'.repeat(64),
  verifiedAt: '2026-10-23T06:56:16.472Z',
  verifiedBy: 'claude',
  ...over,
})

describe('parseCatalogManifest (OCV5-591 M1)', () => {
  it('accepts a verified CC BY entry and fills defaults', () => {
    const [e] = parseCatalogManifest([entry()])
    assert.equal(e!.license, 'CC-BY-4.0')
    assert.deepEqual(e!.genres, [])
    assert.equal(e!.vocals, false)
  })

  it('refuses what the catalog must never hold', () => {
    for (const [why, over] of [
      ['non-commercial licence', { license: 'CC-BY-NC-4.0' }],
      ['CC BY without attribution', { attributionText: '' }],
      ['plain http source', { landingUrl: 'http://incompetech.com/x' }],
      ['file outside the manifest dir', { audioPath: '../secret.mp3' }],
      ['absolute file path', { evidencePath: '/etc/passwd' }],
      ['bad sha', { audioSha: 'xyz' }],
      ['too short', { durationMs: 10 }],
    ] as const) {
      assert.throws(() => parseCatalogManifest([entry(), entry(over)]), /manifest entry 1/, why)
    }
  })

  it('CC0 needs no attribution text', () => {
    const [e] = parseCatalogManifest([
      entry({
        license: 'CC0-1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        attributionText: '',
      }),
    ])
    assert.equal(e!.attributionText, '')
  })
})
