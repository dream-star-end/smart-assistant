import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import {
  type AtomicWriteFsDeps,
  type JsonResponseLike,
  asRecord,
  atomicWriteJson,
  errMsg,
  isRecord,
  readBoundedJson,
  sendJson,
  sha256Hex,
  sleep,
} from '../index.js'

function nodeSha256(input: string | Uint8Array): string {
  const h = createHash('sha256')
  if (typeof input === 'string') h.update(input, 'utf8')
  else h.update(input)
  return h.digest('hex')
}

async function* chunkStream(parts: ReadonlyArray<string | Uint8Array>): AsyncGenerator<string | Uint8Array> {
  for (const part of parts) {
    await Promise.resolve()
    yield part
  }
}

describe('sharedUtils: sha256Hex', () => {
  test('matches node:crypto across empty, ASCII, UTF-8 multibyte, block boundaries and subarrays', () => {
    const samples: Array<string | Uint8Array> = [
      '',
      'a',
      'abc',
      'message digest',
      'OpenClaude V5 园艺闭环 🚀✨🧠',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(65),
      'x'.repeat(127),
      'x'.repeat(128),
      'x'.repeat(129),
      '0123456789abcdef'.repeat(200),
      Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]),
    ]
    for (const s of samples) {
      assert.equal(sha256Hex(s), nodeSha256(s))
    }

    const backing = new Uint8Array([9, 9, 1, 2, 3, 4, 5, 9, 9])
    const sub = backing.subarray(2, 7)
    assert.equal(sha256Hex(sub), nodeSha256(sub))
  })
})

describe('sharedUtils: isRecord / asRecord / errMsg', () => {
  test('isRecord and asRecord accept plain and null-proto objects, reject null/arrays/primitives', () => {
    const plain = { a: 1 }
    const nullProto = Object.assign(Object.create(null) as Record<string, unknown>, { k: 'v' })
    assert.equal(isRecord(plain), true)
    assert.equal(isRecord(nullProto), true)
    assert.equal(asRecord(plain), plain)
    assert.equal(asRecord(nullProto), nullProto)

    for (const nonRec of [null, undefined, [], [1, 2], 'str', 42, true, () => 1]) {
      assert.equal(isRecord(nonRec), false)
      assert.equal(asRecord(nonRec), null)
    }
  })

  test('errMsg extracts Error.message and stringifies non-Error values deterministically', () => {
    assert.equal(errMsg(new Error('boom')), 'boom')
    assert.equal(errMsg(new TypeError('bad type')), 'bad type')
    assert.equal(errMsg('plain error'), 'plain error')
    assert.equal(errMsg(404), '404')
    assert.equal(errMsg(null), 'null')
    assert.equal(errMsg(undefined), 'undefined')
  })
})

describe('sharedUtils: sleep', () => {
  test('resolves after delay, clamps non-positive values, and rejects on pre/mid abort', async () => {
    await sleep(0)
    await sleep(-10)
    await sleep(5)

    const preAborted = new AbortController()
    preAborted.abort(new Error('already-cancelled'))
    await assert.rejects(() => sleep(1000, preAborted.signal), /already-cancelled/)

    const midAbort = new AbortController()
    const pending = sleep(5000, midAbort.signal)
    setTimeout(() => midAbort.abort('stop-now'), 5)
    await assert.rejects(pending, /stop-now/)
  })
})

describe('sharedUtils: atomicWriteJson', () => {
  test('creates parent dirs, writes formatted JSON atomically, and leaves no temp files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'kernel-atomic-'))
    try {
      const target = path.join(dir, 'nested', 'state.json')
      await atomicWriteJson(target, { ok: true, count: 3, items: ['a', 'b'] })
      const raw = await readFile(target, 'utf8')
      assert.equal(raw.endsWith('\n'), true)
      assert.deepEqual(JSON.parse(raw), { ok: true, count: 3, items: ['a', 'b'] })

      await atomicWriteJson(target, { ok: false, count: 4 }, { indent: 0 })
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { ok: false, count: 4 })

      const entries = await readdir(path.join(dir, 'nested'))
      assert.deepEqual(entries, ['state.json'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('cleans up temporary file when rename fails and rejects undefined root value', async () => {
    await assert.rejects(() => atomicWriteJson('/tmp/x.json', undefined), TypeError)

    const unlinked: string[] = []
    const fakeFs: AtomicWriteFsDeps = {
      mkdir: async () => undefined,
      open: async () => ({
        writeFile: async () => undefined,
        sync: async () => undefined,
        close: async () => undefined,
      }),
      rename: async () => {
        throw new Error('EXDEV simulated failure')
      },
      unlink: async (p) => {
        unlinked.push(p)
      },
    }
    await assert.rejects(
      () => atomicWriteJson('/virtual/dir/out.json', { a: 1 }, { fs: fakeFs, syncDir: false }),
      /EXDEV simulated failure/,
    )
    assert.equal(unlinked.length, 1)
    assert.match(unlinked[0]!, /^\/virtual\/dir\/out\.json\.tmp-/)
  })
})

describe('sharedUtils: readBoundedJson & sendJson', () => {
  test('readBoundedJson parses chunked UTF-8 JSON and enforces maxBytes and non-empty body', async () => {
    const emojiBytes = Buffer.from(JSON.stringify({ greeting: '你好🌍', n: 7 }), 'utf8')
    const parsed = await readBoundedJson(
      chunkStream([emojiBytes.subarray(0, 13), emojiBytes.subarray(13)]),
      1024,
    )
    assert.deepEqual(parsed, { greeting: '你好🌍', n: 7 })

    await assert.rejects(() => readBoundedJson(chunkStream([]), 64), /empty body/)
    await assert.rejects(
      () => readBoundedJson(chunkStream(['{"data":"', 'x'.repeat(100), '"}']), 32),
      (err: unknown) =>
        err instanceof RangeError &&
        (err as { code?: string }).code === 'PAYLOAD_TOO_LARGE' &&
        /exceeds 32 bytes/.test(err.message),
    )
  })

  test('sendJson writes status, Content-Type, extra headers, and skips when headersSent', () => {
    const headers: Record<string, string | number> = {}
    let endedBody = ''
    const res: JsonResponseLike = {
      headersSent: false,
      statusCode: 200,
      setHeader(name, value) {
        headers[name] = value
      },
      end(chunk) {
        endedBody = chunk ?? ''
      },
    }
    sendJson(res, 201, { created: true }, { 'X-Request-Id': 'req-1' })
    assert.equal(res.statusCode, 201)
    assert.equal(headers['Content-Type'], 'application/json; charset=utf-8')
    assert.equal(headers['X-Request-Id'], 'req-1')
    assert.deepEqual(JSON.parse(endedBody), { created: true })

    let calledAfterSent = false
    sendJson(
      {
        headersSent: true,
        end() {
          calledAfterSent = true
        },
      },
      500,
      { error: 'ignored' },
    )
    assert.equal(calledAfterSent, false)
  })
})
