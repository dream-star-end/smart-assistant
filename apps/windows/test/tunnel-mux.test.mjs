import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FLAG_FIN,
  FRAME_HEADER_SIZE,
  MAX_FRAME_PAYLOAD,
  MuxProtocolError,
  MuxType,
  createMuxDecoder,
  decodeFrames,
  encodeFrame,
  encodeJsonFrame,
  isKnownMuxType,
} from '../src/tunnel/mux.mjs'
import { attachMuxHttpServer } from '../src/tunnel/muxHttpServer.mjs'
import { createMuxLoopbackPair } from '../src/tunnel/mux.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const goldenDir = path.join(here, 'fixtures/mux-golden')

function loadGolden() {
  const manifest = JSON.parse(fs.readFileSync(path.join(goldenDir, 'manifest.json'), 'utf8'))
  const vectors = []
  for (const file of manifest.files) {
    if (file === 'manifest.json') continue
    const v = JSON.parse(fs.readFileSync(path.join(goldenDir, file), 'utf8'))
    v.file = file
    vectors.push(v)
  }
  return { manifest, vectors }
}

test('golden manifest lists committed vectors', () => {
  const { manifest, vectors } = loadGolden()
  assert.ok(manifest.count >= 16, `expected >=16 golden vectors, got ${manifest.count}`)
  assert.equal(vectors.length, manifest.count)
})

test('golden vectors decode then re-encode byte-equal (except declared negatives)', () => {
  const { vectors } = loadGolden()
  let roundTrips = 0
  for (const v of vectors) {
    const raw = Buffer.from(v.hex, 'hex')
    if (v.expectDecode) {
      assert.throws(
        () => decodeFrames(raw),
        (e) => e instanceof MuxProtocolError && e.code === v.expectDecode,
        v.name,
      )
      continue
    }
    const { frames, rest } = decodeFrames(raw)
    assert.equal(rest.length, 0, v.name)
    assert.ok(frames.length >= 1, v.name)
    const rebuilt = Buffer.concat(frames.map((f) => encodeFrame(f.type, f.flags, f.streamId, f.payload)))
    assert.equal(rebuilt.toString('hex'), v.hex, v.name)
    roundTrips += 1
  }
  assert.ok(roundTrips >= 16, `round-tripped ${roundTrips}`)
})

test('unknown type 0x99 is not a known mux type', () => {
  const { vectors } = loadGolden()
  const v = vectors.find((x) => x.name === '19-unknown-type-0x99')
  assert.ok(v)
  const { frames } = decodeFrames(Buffer.from(v.hex, 'hex'))
  assert.equal(frames[0].type, 0x99)
  assert.equal(isKnownMuxType(0x99), false)
})

test('cap overflow declared payloadLen throws BODY_TOO_LARGE', () => {
  const hdr = Buffer.alloc(FRAME_HEADER_SIZE)
  hdr.writeUInt8(MuxType.HTTP_DATA, 0)
  hdr.writeUInt32BE(1, 2)
  hdr.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 6)
  assert.throws(
    () => decodeFrames(hdr),
    (e) => e instanceof MuxProtocolError && e.code === 'BODY_TOO_LARGE',
  )
})

test('encodeFrame rejects payload above 64KiB', () => {
  assert.throws(
    () => encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(MAX_FRAME_PAYLOAD + 1)),
    (e) => e instanceof MuxProtocolError && e.code === 'BODY_TOO_LARGE',
  )
})

test('encodeFrame rejects bad streamId', () => {
  assert.throws(
    () => encodeFrame(MuxType.HTTP_DATA, 0, -1, Buffer.alloc(0)),
    (e) => e instanceof MuxProtocolError && e.code === 'PROTOCOL',
  )
})

test('fragmented decode across pushes', () => {
  const frame = encodeJsonFrame(MuxType.HEARTBEAT, 0, { ts: 99 })
  const dec = createMuxDecoder()
  assert.deepEqual(dec.push(frame.subarray(0, 4)), [])
  const rest = dec.push(frame.subarray(4))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].type, MuxType.HEARTBEAT)
})

test('unknown type fail-closes the mux http server', async () => {
  const pair = createMuxLoopbackPair()
  let closed = false
  const server = attachMuxHttpServer({
    transport: pair.desktop,
    handler: async () => ({ status: 200, headers: [], body: '' }),
    onFailClosed: () => { closed = true },
  })
  pair.master.send(encodeFrame(0x99, 0, 1, Buffer.from('nope')))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(closed, true)
  assert.equal(server.closed, true)
})

test('bad header payloadLen fail-closes the mux http server', async () => {
  const pair = createMuxLoopbackPair()
  let closed = false
  attachMuxHttpServer({
    transport: pair.desktop,
    handler: async () => ({ status: 200, headers: [], body: '' }),
    onFailClosed: () => { closed = true },
  })
  const hdr = Buffer.alloc(10)
  hdr.writeUInt8(MuxType.HTTP_DATA, 0)
  hdr.writeUInt32BE(1, 2)
  hdr.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 6)
  pair.master.send(hdr)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(closed, true)
})
