import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { audioDurationMs, mp3Frame } from '../media-studio/music/audioLength.js'

/** A PCM WAV of `sec` seconds (default byte rate: 44.1 kHz, 16-bit stereo). */
function wav(
  sec: number,
  opts: { extraChunk?: boolean; unsetSize?: boolean; byteRate?: number } = {},
): Buffer {
  const byteRate = opts.byteRate ?? 176_400
  const data = Buffer.alloc(Math.round(sec * byteRate))
  const fmt = Buffer.alloc(24)
  fmt.write('fmt ', 0, 'ascii')
  fmt.writeUInt32LE(16, 4)
  fmt.writeUInt16LE(1, 8) // PCM
  fmt.writeUInt16LE(2, 10) // channels
  fmt.writeUInt32LE(44_100, 12)
  fmt.writeUInt32LE(byteRate, 16)
  fmt.writeUInt16LE(4, 20)
  fmt.writeUInt16LE(16, 22)
  const list = Buffer.alloc(8 + 5 + 1) // odd-sized chunk + pad byte
  list.write('LIST', 0, 'ascii')
  list.writeUInt32LE(5, 4)
  const dataHead = Buffer.alloc(8)
  dataHead.write('data', 0, 'ascii')
  dataHead.writeUInt32LE(opts.unsetSize ? 0xffffffff : data.length, 4)
  const body = Buffer.concat([fmt, ...(opts.extraChunk ? [list] : []), dataHead, data])
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'ascii')
  return Buffer.concat([head, body])
}

/** `n` MPEG-1 Layer III frames at `kbps` / 44.1 kHz (1152 samples each), after an optional ID3v2. */
function mp3(n: number, kbps: 128 | 320, opts: { id3?: number; vbrMix?: boolean } = {}): Buffer {
  const frame = (rate: 128 | 320) => {
    const idx = rate === 128 ? 9 : 14
    const len = Math.floor((144 * rate * 1000) / 44_100)
    const f = Buffer.alloc(len)
    f[0] = 0xff
    f[1] = 0xfb // MPEG-1, Layer III, no CRC
    f[2] = (idx << 4) | (0 << 2) // 44.1 kHz, no padding
    f[3] = 0x64
    return f
  }
  const frames = Array.from({ length: n }, (_, i) => frame(opts.vbrMix && i % 2 ? 320 : kbps))
  const parts: Buffer[] = []
  if (opts.id3) {
    const h = Buffer.alloc(10 + opts.id3)
    h.write('ID3', 0, 'ascii')
    h[3] = 4
    const s = opts.id3
    h[6] = (s >> 21) & 0x7f
    h[7] = (s >> 14) & 0x7f
    h[8] = (s >> 7) & 0x7f
    h[9] = s & 0x7f
    // Tag bytes that look like a frame sync must not be taken for audio.
    h[12] = 0xff
    h[13] = 0xfb
    parts.push(h)
  }
  const tag = Buffer.alloc(128)
  tag.write('TAG', 0, 'ascii')
  return Buffer.concat([...parts, ...frames, tag])
}

describe('uploaded track length (OCV5-591 M1)', () => {
  test('WAV: from the fmt byte rate and the data size, other chunks skipped', () => {
    assert.equal(audioDurationMs('audio/wav', wav(2.5)), 2500)
    assert.equal(audioDurationMs('audio/wav', wav(1, { extraChunk: true })), 1000)
    assert.equal(audioDurationMs('audio/wav', wav(1.5, { unsetSize: true })), 1500)
  })

  test('MP3: every frame counted (CBR and VBR), ID3v2 and ID3v1 tags skipped', () => {
    const spf = (1152 / 44_100) * 1000
    assert.equal(audioDurationMs('audio/mpeg', mp3(100, 128)), Math.round(100 * spf))
    assert.equal(
      audioDurationMs('audio/mpeg', mp3(80, 128, { vbrMix: true })),
      Math.round(80 * spf),
    )
    assert.equal(audioDurationMs('audio/mpeg', mp3(50, 320, { id3: 300 })), Math.round(50 * spf))
  })

  test('unknown or broken input is unknown, never a guess', () => {
    assert.equal(audioDurationMs('audio/mpeg', Buffer.from('not audio at all')), null)
    assert.equal(audioDurationMs('audio/wav', Buffer.from('RIFF\0\0\0\0WAVE')), null)
    assert.equal(audioDurationMs('audio/ogg', wav(1)), null)
    // Longer than 30 minutes does not fit the column: unknown.
    assert.equal(audioDurationMs('audio/wav', wav(1801, { byteRate: 100 })), null)
    assert.equal(audioDurationMs('audio/wav', wav(1799, { byteRate: 100 })), 1_799_000)
  })

  test('frame header: length and samples', () => {
    const f = mp3(2, 128).subarray(0, 4)
    assert.deepEqual(mp3Frame(Buffer.concat([f, Buffer.alloc(500)]), 0), {
      length: 417,
      seconds: 1152 / 44_100,
    })
    assert.equal(mp3Frame(Buffer.from([0xff, 0xfb, 0xf0, 0x64]), 0), null, 'bad bitrate index')
  })
})
