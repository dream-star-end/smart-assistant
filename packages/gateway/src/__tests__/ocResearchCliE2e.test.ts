import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

type Captured = {
  method: string
  url: string
  authorization?: string
  contentType?: string
  body: Buffer
}

type RunResult = { code: number | null; stdout: string; stderr: string }

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const TOKEN = 'oc-v5.test-container-token'

let server: Server
let baseUrl = ''
let captured: Captured[] = []

function jsonResponse(reqUrl: string): Record<string, unknown> {
  if (reqUrl === '/v3/research/blob') return { blobId: 'blob-1', sha256: 'abc', sizeBytes: 7 }
  if (reqUrl.startsWith('/internal/v3/marketplace/agent/search')) {
    return { results: [{ slug: 'demo-skill' }] }
  }
  if (reqUrl.startsWith('/internal/v3/marketplace/agent/detail')) {
    return { detail: { slug: 'demo-skill' } }
  }
  if (reqUrl === '/internal/v3/marketplace/agent/installed') return { installed: [] }
  if (reqUrl.startsWith('/internal/v3/marketplace/agent/')) return { ok: true }
  return { ok: true, route: reqUrl }
}

before(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const url = req.url ?? ''
      captured.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks),
      })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(jsonResponse(url)))
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

function assertBearer(): void {
  for (const request of captured) {
    assert.equal(request.authorization, `Bearer ${TOKEN}`, request.url)
  }
}

describe('research oc-* CLI public operations against a loopback master', () => {
  test('oc-cite verify/format/check/fix map to exact routes and bodies', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-cite-e2e-'))
    const manifest = join(work, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({ claims: [] }))
    try {
      for (const args of [
        ['verify', '10.1000/a', 'arXiv:1234.5678'],
        ['format', '10.1000/a', '--style', 'apa'],
        ['check', '--manifest', manifest],
        ['fix', '--manifest', manifest, '--docs', 'doc-1, doc-2'],
      ]) {
        const result = await runCli('packages/gateway/src/ocCiteCli.ts', args)
        assert.equal(result.code, 0, result.stderr)
        assert.equal(JSON.parse(result.stdout).ok, true)
      }
      assert.deepEqual(
        captured.map((request) => request.url),
        [
          '/v3/research/cite/verify',
          '/v3/research/cite/format',
          '/v3/research/cite/check',
          '/v3/research/cite/fix',
        ],
      )
      assert.deepEqual(bodyJson(0), { identifiers: ['10.1000/a', 'arXiv:1234.5678'] })
      assert.deepEqual(bodyJson(1), { identifier: '10.1000/a', style: 'apa' })
      assert.deepEqual(bodyJson(2), { manifest: { claims: [] } })
      assert.deepEqual(bodyJson(3), {
        manifest: { claims: [] },
        docIds: ['doc-1', 'doc-2'],
      })
      assertBearer()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-ingest parse uploads bytes before requesting authoritative parse', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-ingest-e2e-'))
    const input = join(work, 'paper.md')
    writeFileSync(input, '# paper')
    try {
      const result = await runCli('packages/gateway/src/ocIngestCli.ts', ['parse', input])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(
        captured.map((request) => request.url),
        ['/v3/research/blob', '/v3/research/ingest/parse'],
      )
      assert.equal(captured[0].body.toString('utf8'), '# paper')
      assert.equal(captured[0].contentType, 'text/markdown')
      assert.deepEqual(bodyJson(1), { blobId: 'blob-1', filename: 'paper.md' })
      assertBearer()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  test('oc-lit search and snowball preserve documented filters', async () => {
    let result = await runCli('packages/gateway/src/ocLitCli.ts', [
      'search',
      'graph',
      'neural',
      'networks',
      '--sources',
      'openalex, arxiv',
      '--size',
      '12',
      '--year-min',
      '2024',
      '--lang',
      'en',
    ])
    assert.equal(result.code, 0, result.stderr)
    result = await runCli('packages/gateway/src/ocLitCli.ts', [
      'snowball',
      '10.1000/seed',
      '--direction',
      'both',
      '--size',
      '8',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual(
      captured.map((request) => request.url),
      ['/v3/research/lit/search', '/v3/research/lit/snowball'],
    )
    assert.deepEqual(bodyJson(0), {
      query: 'graph neural networks',
      sources: ['openalex', 'arxiv'],
      size: 12,
      yearMin: 2024,
      lang: 'en',
    })
    assert.deepEqual(bodyJson(1), { seed: '10.1000/seed', direction: 'both', size: 8 })
    assertBearer()
  })

  test('oc-litrag query carries doc ids and top-k', async () => {
    const result = await runCli('packages/gateway/src/ocLitragCli.ts', [
      'query',
      'what',
      'changed',
      '--docs',
      'doc-1, doc-2',
      '--top-k',
      '6',
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(captured[0].url, '/v3/research/litrag/query')
    assert.deepEqual(bodyJson(0), {
      query: 'what changed',
      docIds: ['doc-1', 'doc-2'],
      topK: 6,
    })
    assertBearer()
  })
})

describe('oc-market gateway operations against a loopback master', () => {
  test('search/detail/installed/install/uninstall use their exact methods and routes', async () => {
    for (const args of [
      ['search', 'writer', '--kind', 'plugin'],
      ['detail', 'demo-skill'],
      ['installed'],
      ['install', 'demo-skill'],
      ['uninstall', 'demo-skill'],
    ]) {
      const result = await runCli('packages/gateway/src/ocMarketCli.ts', args)
      assert.equal(result.code, 0, result.stderr)
      assert.doesNotThrow(() => JSON.parse(result.stdout))
    }
    assert.deepEqual(
      captured.map(({ method, url }) => ({ method, url })),
      [
        {
          method: 'GET',
          url: '/internal/v3/marketplace/agent/search?q=writer&kind=connector',
        },
        {
          method: 'GET',
          url: '/internal/v3/marketplace/agent/detail?slug=demo-skill',
        },
        { method: 'GET', url: '/internal/v3/marketplace/agent/installed' },
        { method: 'POST', url: '/internal/v3/marketplace/agent/install' },
        { method: 'POST', url: '/internal/v3/marketplace/agent/uninstall' },
      ],
    )
    assert.deepEqual(bodyJson(3), { slug: 'demo-skill' })
    assert.deepEqual(bodyJson(4), { slug: 'demo-skill' })
    assertBearer()
  })

  test('publish-skill and publish-agent send complete storefront payloads', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-market-e2e-'))
    const bodyFile = join(work, 'SKILL.md')
    const personaFile = join(work, 'persona.md')
    writeFileSync(bodyFile, '# skill body')
    writeFileSync(personaFile, '# persona')
    try {
      let result = await runCli('packages/gateway/src/ocMarketCli.ts', [
        'publish-skill',
        '--slug',
        'writer',
        '--name',
        'Writer',
        '--version',
        '1.0.0',
        '--description',
        'Writes',
        '--body-file',
        bodyFile,
        '--category',
        'office-docs',
        '--use-cases',
        'draft;polish',
        '--visibility',
        'org',
      ])
      assert.equal(result.code, 0, result.stderr)
      result = await runCli('packages/gateway/src/ocMarketCli.ts', [
        'publish-agent',
        '--slug',
        'agent-writer',
        '--name',
        'Agent Writer',
        '--version',
        '1.0.0',
        '--description',
        'Writes',
        '--model',
        'glm-5.2',
        '--toolsets',
        'core,web_context',
        '--persona-file',
        personaFile,
        '--category',
        'office-docs',
        '--use-cases',
        'draft',
      ])
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(
        captured.map(({ method, url }) => ({ method, url })),
        [
          { method: 'POST', url: '/internal/v3/marketplace/agent/publish' },
          { method: 'POST', url: '/internal/v3/marketplace/agent/publish' },
        ],
      )
      assert.deepEqual(bodyJson(0), {
        kind: 'skill',
        slug: 'writer',
        name: 'Writer',
        version: '1.0.0',
        description: 'Writes',
        category: 'office-docs',
        tags: [],
        useCases: ['draft', 'polish'],
        outcomeExamples: [],
        body: '# skill body',
        visibility: 'org',
      })
      assert.deepEqual(bodyJson(1), {
        kind: 'agent',
        slug: 'agent-writer',
        name: 'Agent Writer',
        version: '1.0.0',
        description: 'Writes',
        category: 'office-docs',
        model: 'glm-5.2',
        toolsets: ['core', 'web_context'],
        capabilities: [],
        skillDeps: [],
        tags: [],
        useCases: ['draft'],
        outcomeExamples: [],
        persona: '# persona',
      })
      assertBearer()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
