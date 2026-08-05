import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

const ROOT = resolve('.')
const TSX = join(ROOT, 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'container-token'
let server: Server
let base = ''
let calls: Array<{ path: string; body: Buffer }> = []
const resultBytes = Buffer.from(`# OCR\n\n${'完整页面内容\n'.repeat(50_000)}`)

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0]
      const body = Buffer.concat(chunks)
      calls.push({ path, body })
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`)
      if (path === '/v3/ocr/submit') {
        res.writeHead(202, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ticket: 'ticket-1', status: 'queued' }))
      } else if (path === '/v3/ocr/status') {
        res.setHeader('content-type', 'application/json')
        res.end(
          JSON.stringify({
            ticket: 'ticket-1',
            status: 'completed',
            phase: 'completed',
            pages_done: 157,
            pages_total: 157,
          }),
        )
      } else if (path === '/v3/ocr/cancel') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ticket: 'ticket-1', status: 'running', phase: 'cancelling' }))
      } else if (path === '/v3/ocr/result') {
        res.writeHead(200, {
          'content-type': 'text/markdown',
          'content-length': String(resultBytes.length),
        })
        for (let offset = 0; offset < resultBytes.length; offset += 8192)
          res.write(resultBytes.subarray(offset, offset + 8192))
        res.end()
      } else {
        res.writeHead(404).end()
      }
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  base = `http://127.0.0.1:${address.port}`
})

after(async () => new Promise<void>((done) => server.close(() => done())))
beforeEach(() => {
  calls = []
})

function run(
  args: string[],
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done, reject) => {
    const env = {
      ...process.env,
      OPENCLAUDE_V3_MASTER_BASE_URL: base,
      OPENCLAUDE_V3_CONTAINER_TOKEN: TOKEN,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
    for (const key of [
      'HTTP_PROXY',
      'HTTPS_PROXY',
      'ALL_PROXY',
      'http_proxy',
      'https_proxy',
      'all_proxy',
    ])
      delete (env as any)[key]
    const child = spawn(
      process.execPath,
      [TSX, join(ROOT, 'packages/gateway/src/ocOcrCli.ts'), ...args],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

describe('oc-ocr CLI', () => {
  test('run streams upload, reports progress, and atomically preserves the complete large result', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-ocr-cli-'))
    const input = join(work, 'scan.pdf')
    const output = join(work, 'scan.ocr.md')
    writeFileSync(input, Buffer.from('fake scanned pdf'))
    try {
      const value = await run(
        ['run', input, '--out', output, '--mode', 'hybrid', '--fallback', '0.10'],
        work,
      )
      assert.equal(value.code, 0, value.stderr)
      assert.match(value.stderr, /ticket=ticket-1/)
      assert.match(value.stderr, /pages=157\/157/)
      assert.deepEqual(JSON.parse(value.stdout), {
        ticket: 'ticket-1',
        status: 'completed',
        output,
        format: 'markdown',
        pages: 157,
      })
      assert.equal(readFileSync(output).equals(resultBytes), true)
      assert.deepEqual(
        calls.map((call) => call.path),
        ['/v3/ocr/submit', '/v3/ocr/status', '/v3/ocr/result'],
      )
      assert.equal(calls[0].body.toString(), 'fake scanned pdf')
      assert.deepEqual(JSON.parse(calls[2].body.toString()), {
        ticket: 'ticket-1',
        format: 'markdown',
      })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('explicit cancel maps to the cancellable worker operation', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-ocr-cancel-'))
    try {
      const value = await run(['cancel', 'ticket-1'], work)
      assert.equal(value.code, 0, value.stderr)
      assert.equal(JSON.parse(value.stdout).phase, 'cancelling')
      assert.deepEqual(JSON.parse(calls[0].body.toString()), { ticket: 'ticket-1' })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
