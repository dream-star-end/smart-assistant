import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

type RunResult = { code: number | null; stdout: string; stderr: string }
type Seen = {
  method: string
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

const CLI = resolve('packages/commercial/agent-sandbox/platform-runtime/bin/oc-h3.py')

function run(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn('python3', [CLI, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
  })
}

describe('oc-h3 durable async CLI', () => {
  let baseUrl = ''
  let seen: Seen[] = []
  let inputNumber = 0
  const resultBody = Buffer.from('streamed-h3-result')
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const path = req.url ?? '/'
      seen.push({ method: req.method ?? 'GET', path, headers: req.headers, body })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'PUT' && path.endsWith('/inputs')) {
        inputNumber += 1
        res.statusCode = 201
        res.end(JSON.stringify({ inputId: `input-${inputNumber}` }))
        return
      }
      if (req.method === 'POST' && path.endsWith('/jobs')) {
        res.statusCode = 202
        res.end(
          JSON.stringify({
            job: {
              id: '11111111-1111-4111-8111-111111111111',
              status: 'queued',
              phase: 'queued',
              queuePosition: 2,
            },
          }),
        )
        return
      }
      if (req.method === 'GET' && path.includes('/jobs/') && !path.endsWith('/result')) {
        res.end(
          JSON.stringify({
            job: {
              id: '11111111-1111-4111-8111-111111111111',
              status: 'completed',
              phase: 'completed',
            },
          }),
        )
        return
      }
      if (req.method === 'GET' && path.endsWith('/result')) {
        res.setHeader('content-type', 'video/mp4')
        res.setHeader('content-length', String(resultBody.length))
        res.setHeader('x-content-sha256', createHash('sha256').update(resultBody).digest('hex'))
        res.end(resultBody)
        return
      }
      if (req.method === 'POST' && path.endsWith('/projects')) {
        res.statusCode = 201
        res.end(
          JSON.stringify({
            project: {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'long video',
              rev: 1,
              status: 'draft',
              currentComposeJobId: null,
              shots: [],
              createdAt: 'x',
              updatedAt: 'x',
            },
          }),
        )
        return
      }
      if (
        req.method === 'POST' &&
        path.endsWith('/projects/22222222-2222-4222-8222-222222222222/start')
      ) {
        res.end(
          JSON.stringify({
            project: {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'long video',
              rev: 3,
              status: 'generating',
              currentComposeJobId: null,
              shots: [],
              createdAt: 'x',
              updatedAt: 'x',
            },
          }),
        )
        return
      }
      if (
        req.method === 'POST' &&
        path.endsWith('/projects/22222222-2222-4222-8222-222222222222/edit')
      ) {
        res.end(
          JSON.stringify({
            project: {
              id: '22222222-2222-4222-8222-222222222222',
              title: 'revised video',
              rev: 2,
              status: 'draft',
              currentComposeJobId: null,
              shots: [],
              createdAt: 'x',
              updatedAt: 'x',
            },
          }),
        )
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND' } }))
    })
  })

  before(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  beforeEach(() => {
    seen = []
    inputNumber = 0
  })

  function env(): NodeJS.ProcessEnv {
    return {
      OPENCLAUDE_V3_MASTER_BASE_URL: baseUrl,
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-token',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    }
  }

  test('streams reference and first/last frame bytes, then returns the queued job immediately', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-h3-cli-'))
    try {
      const first = join(work, 'first.png')
      const last = join(work, 'last.png')
      const reference = join(work, 'reference.png')
      writeFileSync(first, 'first-frame-bytes')
      writeFileSync(last, 'last-frame-bytes')
      writeFileSync(reference, 'reference-bytes')
      const result = await run(
        [
          'generate',
          '--prompt',
          'office scene',
          '--duration',
          '10',
          '--steps',
          '16',
          '--first-frame',
          first,
          '--last-frame',
          last,
          '--reference',
          reference,
          '--request-id',
          'exact-request-id',
        ],
        env(),
      )
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stdout, /queued phase=queued queue=2/)
      const uploads = seen.filter((entry) => entry.method === 'PUT')
      assert.deepEqual(
        uploads.map((entry) => entry.headers['x-input-kind']),
        ['first_frame', 'last_frame', 'reference_image'],
      )
      assert.deepEqual(
        uploads.map((entry) => entry.body.toString()),
        ['first-frame-bytes', 'last-frame-bytes', 'reference-bytes'],
      )
      for (const upload of uploads) {
        assert.equal(upload.headers.authorization, 'Bearer container-token')
        assert.equal(upload.headers['x-content-size'], String(upload.body.length))
        assert.equal(
          upload.headers['x-content-sha256'],
          createHash('sha256').update(upload.body).digest('hex'),
        )
      }
      const submitted = seen.find(
        (entry) => entry.method === 'POST' && entry.path.endsWith('/jobs'),
      )
      assert.ok(submitted)
      const payload = JSON.parse(submitted.body.toString()) as any
      assert.equal(payload.requestId, 'exact-request-id')
      assert.deepEqual(payload.inputIds, ['input-1', 'input-2', 'input-3'])
      assert.deepEqual(payload.options, { durationSeconds: 10, aspect: '16:9', steps: 16 })
      assert.equal(
        seen.some((entry) => entry.method === 'GET'),
        false,
        'default command must not block and poll',
      )
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('creates an idempotent storyboard project and downloads a streamed result with SHA verification', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-video-cli-'))
    try {
      const first = join(work, 'first.png')
      const last = join(work, 'last.png')
      const storyboard = join(work, 'storyboard.json')
      const output = join(work, 'result.mp4')
      writeFileSync(first, 'first')
      writeFileSync(last, 'last')
      writeFileSync(
        storyboard,
        JSON.stringify({
          shots: [
            { prompt: 'opening', durationSeconds: 10 },
            { prompt: 'continuation', durationSeconds: 15 },
          ],
        }),
      )
      const created = await run(
        [
          'project',
          'create',
          '--storyboard',
          storyboard,
          '--title',
          'long video',
          '--first-frame',
          first,
          '--last-frame',
          last,
          '--request-id',
          'project-request-id',
        ],
        env(),
      )
      assert.equal(created.code, 0, created.stderr)
      assert.match(created.stdout, /22222222-2222-4222-8222-222222222222/)
      const request = seen.find(
        (entry) => entry.method === 'POST' && entry.path.endsWith('/projects'),
      )
      assert.ok(request)
      const payload = JSON.parse(request.body.toString()) as any
      assert.equal(payload.requestId, 'project-request-id')
      assert.deepEqual(payload.inputIds, ['input-1', 'input-2'])
      assert.equal(payload.shots.length, 2)

      const edited = await run(
        [
          'project',
          'edit',
          '22222222-2222-4222-8222-222222222222',
          '--expected-rev',
          '1',
          '--storyboard',
          storyboard,
          '--title',
          'revised video',
        ],
        env(),
      )
      assert.equal(edited.code, 0, edited.stderr)
      assert.match(edited.stdout, /"rev": 2/)
      const editRequest = seen.find((entry) => entry.path.endsWith('/edit'))
      assert.ok(editRequest)
      assert.equal(JSON.parse(editRequest.body.toString()).expectedRev, 1)

      const started = await run(
        ['project', 'start', '22222222-2222-4222-8222-222222222222', '--expected-rev', '2'],
        env(),
      )
      assert.equal(started.code, 0, started.stderr)
      assert.match(started.stdout, /"rev": 3/)
      const startRequest = seen.find((entry) => entry.path.endsWith('/start'))
      assert.ok(startRequest)
      assert.equal(JSON.parse(startRequest.body.toString()).expectedRev, 2)

      const downloaded = await run(
        ['download', '11111111-1111-4111-8111-111111111111', '--out', output],
        env(),
      )
      assert.equal(downloaded.code, 0, downloaded.stderr)
      assert.equal(readFileSync(output, 'utf8'), resultBody.toString())
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
