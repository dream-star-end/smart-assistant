/**
 * Generate mux golden vectors from the server encodeFrame / encodeJsonFrame.
 *
 *   cd <worktree>
 *   npx tsx apps/windows/scripts/gen-mux-golden.mjs
 *
 * Also safe to run as `node apps/windows/scripts/gen-mux-golden.mjs` —
 * it re-execs itself under tsx so the .ts import works.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const self = fileURLToPath(import.meta.url)
const windowsRoot = path.resolve(path.dirname(self), '..')
const repoRoot = path.resolve(windowsRoot, '../..')
const outDir = path.join(windowsRoot, 'test/fixtures/mux-golden')

if (!process.env.OC_MUX_GOLDEN_TSX) {
  const r = spawnSync('npx', ['tsx', self], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, OC_MUX_GOLDEN_TSX: '1' },
  })
  process.exit(r.status ?? 1)
}

const {
  FLAG_FIN,
  MAX_FRAME_PAYLOAD,
  MuxType,
  encodeFrame,
  encodeJsonFrame,
} = await import(pathToFileURL(path.join(repoRoot, 'packages/commercial/src/ws/desktopMux.ts')).href)

function hex(buf) {
  return Buffer.from(buf).toString('hex')
}

function writeVector(name, buf, extra = {}) {
  const body = {
    name,
    hex: hex(buf),
    length: buf.length,
    generatedFrom: 'packages/commercial/src/ws/desktopMux.ts',
    ...extra,
  }
  fs.writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`)
}

fs.mkdirSync(outDir, { recursive: true })
for (const existing of fs.readdirSync(outDir)) {
  if (existing.endsWith('.json')) fs.unlinkSync(path.join(outDir, existing))
}

const openHttp = encodeJsonFrame(MuxType.OPEN_HTTP, 1, {
  method: 'GET',
  path: '/healthz',
  headers: {},
  deadlineMs: 1,
})
writeVector('01-open-http-get-healthz', openHttp, { type: MuxType.OPEN_HTTP, streamId: 1 })

const openHttpPost = encodeJsonFrame(MuxType.OPEN_HTTP, 3, {
  method: 'POST',
  path: '/internal/v3/turn-reject-if-absent',
  headers: { 'content-type': 'application/json' },
  deadlineMs: 42,
})
writeVector('02-open-http-post', openHttpPost, { type: MuxType.OPEN_HTTP, streamId: 3 })

const startArr = encodeJsonFrame(MuxType.HTTP_RESPONSE_START, 1, {
  status: 200,
  headers: [{ k: 'content-type', v: 'text/plain' }],
})
writeVector('03-response-start-array-headers', startArr, { type: MuxType.HTTP_RESPONSE_START, streamId: 1 })

const startObj = encodeJsonFrame(MuxType.HTTP_RESPONSE_START, 1, {
  status: 201,
  headers: { 'content-type': 'application/json' },
})
writeVector('04-response-start-object-headers', startObj, { type: MuxType.HTTP_RESPONSE_START, streamId: 1 })

const emptyFin = encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0))
writeVector('05-http-data-empty-fin', emptyFin, { type: MuxType.HTTP_DATA, flags: FLAG_FIN, streamId: 1 })

const bodyFin = encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.from('pong', 'utf8'))
writeVector('06-http-data-body-fin', bodyFin, { type: MuxType.HTTP_DATA, flags: FLAG_FIN, streamId: 1 })

const bodyNoFin = encodeFrame(MuxType.HTTP_DATA, 0, 5, Buffer.from('ab'))
writeVector('07-http-data-no-fin', bodyNoFin, { type: MuxType.HTTP_DATA, flags: 0, streamId: 5 })

const httpEnd = encodeFrame(MuxType.HTTP_END, 0, 1, Buffer.alloc(0))
writeVector('08-http-end', httpEnd, { type: MuxType.HTTP_END, streamId: 1 })

const reset = encodeJsonFrame(MuxType.RESET_STREAM, 7, { code: 'PROTOCOL', message: 'nope' })
writeVector('09-reset-stream', reset, { type: MuxType.RESET_STREAM, streamId: 7 })

const openWs = encodeJsonFrame(MuxType.OPEN_WS, 9, { path: '/ws' })
writeVector('10-open-ws', openWs, { type: MuxType.OPEN_WS, streamId: 9 })

const wsData = encodeJsonFrame(MuxType.WS_DATA, 9, { opcode: 1, data: Buffer.from('hi').toString('base64') })
writeVector('11-ws-data', wsData, { type: MuxType.WS_DATA, streamId: 9 })

const wsClose = encodeJsonFrame(MuxType.WS_CLOSE, 9, { code: 1000, reason: 'bye' })
writeVector('12-ws-close', wsClose, { type: MuxType.WS_CLOSE, streamId: 9 })

const hb = encodeJsonFrame(MuxType.HEARTBEAT, 0, { ts: 1 })
writeVector('13-heartbeat', hb, { type: MuxType.HEARTBEAT, streamId: 0 })

const hbAck = encodeJsonFrame(MuxType.HEARTBEAT_ACK, 0, { ts: 1, serverNow: 2 })
writeVector('14-heartbeat-ack', hbAck, { type: MuxType.HEARTBEAT_ACK, streamId: 0 })

const goaway = encodeJsonFrame(MuxType.GOAWAY, 0, { message: 'too many streams' })
writeVector('15-goaway', goaway, { type: MuxType.GOAWAY, streamId: 0 })

const concat = Buffer.concat([
  encodeJsonFrame(MuxType.OPEN_HTTP, 1, { method: 'GET', path: '/', headers: {}, deadlineMs: 9 }),
  encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(0)),
])
writeVector('16-open-http-then-empty-data-fin', concat, { frames: 2, streamId: 1 })

const oddLarge = encodeJsonFrame(MuxType.OPEN_HTTP, 0x7ffffffd, {
  method: 'GET',
  path: '/x',
  headers: {},
  deadlineMs: 0,
})
writeVector('17-open-http-large-odd-stream', oddLarge, { type: MuxType.OPEN_HTTP, streamId: 0x7ffffffd })

const maxPayload = encodeFrame(MuxType.HTTP_DATA, FLAG_FIN, 1, Buffer.alloc(16, 0x5a))
writeVector('18-http-data-16-bytes', maxPayload, { type: MuxType.HTTP_DATA, streamId: 1 })

const unknown = encodeFrame(0x99, 0, 1, Buffer.from('nope'))
writeVector('19-unknown-type-0x99', unknown, { type: 0x99, streamId: 1, expectSession: 'fail-closed' })

const overflowHdr = Buffer.alloc(10)
overflowHdr.writeUInt8(MuxType.HTTP_DATA, 0)
overflowHdr.writeUInt8(0, 1)
overflowHdr.writeUInt32BE(1, 2)
overflowHdr.writeUInt32BE(MAX_FRAME_PAYLOAD + 1, 6)
writeVector('20-neg-payload-len-overflow', overflowHdr, {
  expectDecode: 'BODY_TOO_LARGE',
  declaredPayloadLen: MAX_FRAME_PAYLOAD + 1,
})

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.json')).sort()
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify({
  count: files.length,
  files,
  generatedAt: new Date().toISOString(),
}, null, 2)}\n`)

process.stdout.write(`wrote ${files.length} golden vectors to ${outDir}\n`)
