/**
 * oc-lit fetch / fetch-batch / job-status CLI e2e(回环 master;R5 Phase A)。
 * 同 ocResearchCliE2e.test.ts 模式:起本地 HTTP server 捕获请求,tsx 直跑 CLI 入口。
 * 覆盖:identifier→records、records 文件、--request-id 透传、job-status 路由、
 * help 快路径文案、FETCH_DISABLED 禁用文案透传、oc-lit.sh usage 行。
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type Captured = {
  method: string
  url: string
  body: Buffer
}

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'oc-v5.test-container-token'

let server: Server
let baseUrl = ''
let captured: Captured[] = []
let fetchDisabled = false

function jsonResponse(reqUrl: string): { status: number; body: Record<string, unknown> } {
  if (reqUrl === '/v3/research/lit/fetch' && fetchDisabled) {
    return {
      status: 404,
      body: {
        error: {
          code: 'FETCH_DISABLED',
          message: 'fulltext fetch disabled (research_config fetch.enabled)',
        },
      },
    }
  }
  if (reqUrl === '/v3/research/lit/fetch') {
    return {
      status: 200,
      body: { results: [{ id: 'arxiv:2301.01234', status: 'fetched', docId: 'doc-1' }] },
    }
  }
  if (reqUrl === '/v3/research/lit/fetch-batch') {
    return {
      status: 200,
      body: { job: { requestId: 'rid-1', kind: 'research_task', status: 'queued' } },
    }
  }
  if (reqUrl === '/v3/research/job/status') {
    return { status: 200, body: { requestId: 'rid-1', kind: 'research_task', status: 'completed' } }
  }
  return { status: 200, body: { ok: true, route: reqUrl } }
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const url = req.url ?? ''
      captured.push({ method: req.method ?? '', url, body: Buffer.concat(chunks) })
      const { status, body } = jsonResponse(url)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((done) => server.close(() => done()))
})

beforeEach(() => {
  captured = []
  fetchDisabled = false
})

function runCli(entry: string, args: string[]): Promise<RunResult> {
  return new Promise((done, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OPENCLAUDE_V3_MASTER_BASE_URL: baseUrl,
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
    ]) {
      delete env[key]
    }
    const child = spawn(process.execPath, [TSX, join(REPO_ROOT, entry), ...args], {
      cwd: REPO_ROOT,
      env,
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

function bodyJson(index: number): any {
  return JSON.parse(captured[index].body.toString('utf8'))
}

describe('oc-lit fetch/fetch-batch/job-status CLI', () => {
  test('fetch <doi> → POST lit/fetch,body.records 含 doi 且 ingest 默认 true', async () => {
    const result = await runCli('packages/gateway/src/ocLitCli.ts', [
      'fetch',
      '10.1371/journal.pone.0026140',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(captured[0].url, '/v3/research/lit/fetch')
    const body = bodyJson(0)
    assert.equal(body.records.length, 1)
    assert.equal(body.records[0].doi, '10.1371/journal.pone.0026140')
    assert.equal(body.ingest, true)
    assert.equal(JSON.parse(result.stdout).results[0].docId, 'doc-1')
  })

  test('fetch <arxiv-id> → arxivId 记录;--no-ingest 透传 false', async () => {
    const result = await runCli('packages/gateway/src/ocLitCli.ts', [
      'fetch',
      'arxiv:2301.01234',
      '--no-ingest',
    ])
    assert.equal(result.code, 0, result.stderr)
    const body = bodyJson(0)
    assert.equal(body.records[0].arxivId, '2301.01234')
    assert.equal(body.ingest, false)
  })

  test('fetch <records.json> → 文件数组进 body.records', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-lit-fetch-'))
    const file = join(work, 'records.json')
    writeFileSync(
      file,
      JSON.stringify([
        { id: 'a', doi: '10.1/a' },
        { id: 'b', arxivId: '2301.01234' },
      ]),
    )
    try {
      const result = await runCli('packages/gateway/src/ocLitCli.ts', [
        'fetch',
        file,
        '--project',
        'p1',
      ])
      assert.equal(result.code, 0, result.stderr)
      const body = bodyJson(0)
      assert.equal(body.records.length, 2)
      assert.equal(body.projectId, 'p1')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('fetch <bad-identifier> → usage 错误,不发请求', async () => {
    const result = await runCli('packages/gateway/src/ocLitCli.ts', ['fetch', 'not-an-id'])
    assert.notEqual(result.code, 0)
    assert.match(result.stderr, /doi|arXiv|records/)
    assert.equal(captured.length, 0)
  })

  test('fetch-batch <file> --request-id → POST lit/fetch-batch(200 条上限裁剪)', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-lit-batch-'))
    const file = join(work, 'records.json')
    writeFileSync(
      file,
      JSON.stringify(Array.from({ length: 205 }, (_, i) => ({ id: `r${i}`, doi: `10.1/${i}` }))),
    )
    try {
      const result = await runCli('packages/gateway/src/ocLitCli.ts', [
        'fetch-batch',
        file,
        '--request-id',
        'topic-slug-1',
      ])
      assert.equal(result.code, 0, result.stderr)
      assert.equal(captured[0].url, '/v3/research/lit/fetch-batch')
      const body = bodyJson(0)
      assert.equal(body.requestId, 'topic-slug-1')
      assert.equal(body.records.length, 200)
      assert.equal(JSON.parse(result.stdout).job.status, 'queued')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('fetch-batch 缺 --request-id → usage 错误', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-lit-batch2-'))
    const file = join(work, 'records.json')
    writeFileSync(file, JSON.stringify([{ id: 'a' }]))
    try {
      const result = await runCli('packages/gateway/src/ocLitCli.ts', ['fetch-batch', file])
      assert.notEqual(result.code, 0)
      assert.match(result.stderr, /--request-id/)
      assert.equal(captured.length, 0)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('job-status <rid> → POST job/status', async () => {
    const result = await runCli('packages/gateway/src/ocLitCli.ts', ['job-status', 'rid-1'])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(captured[0].url, '/v3/research/job/status')
    assert.deepEqual(bodyJson(0), { requestId: 'rid-1' })
    assert.equal(JSON.parse(result.stdout).status, 'completed')
  })

  test('FETCH_DISABLED(平台 flag 关)→ CLI exit 1 + 明确禁用文案', async () => {
    fetchDisabled = true
    const result = await runCli('packages/gateway/src/ocLitCli.ts', [
      'fetch',
      '10.1371/journal.pone.0026140',
    ])
    assert.equal(result.code, 1)
    assert.match(result.stderr, /fulltext fetch disabled/)
    assert.match(result.stderr, /fetch\.enabled/)
  })

  test('--help 快路径:usage 含 fetch/fetch-batch/job-status', async () => {
    const result = await runCli('packages/gateway/src/ocLitCli.ts', ['--help'])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /fetch <id\|records\.json>/)
    assert.match(result.stdout, /fetch-batch/)
    assert.match(result.stdout, /job-status/)
    assert.equal(captured.length, 0, 'help 不发网络请求')
  })

  test('oc-lit.sh help(不启 tsx)usage 同步新子命令', async () => {
    const sh = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin/oc-lit.sh')
    const out = await new Promise<string>((done, reject) => {
      execFile('sh', [sh, 'help'], (err, stdout) => (err ? reject(err) : done(String(stdout))))
    })
    assert.match(out, /fetch <id\|records\.json>/)
    assert.match(out, /fetch-batch/)
    assert.match(out, /job-status/)
  })
})
