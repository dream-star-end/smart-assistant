import * as assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
const { runOcWebCli } = process.env.OC_UX_SEARCH_OLD_CLI ? await import(process.env.OC_UX_SEARCH_OLD_CLI) : await import('../ocWebCli.js')
const identity = 'fixture-container-identity'
const organic = [{ title: '今日科技新闻', url: 'https://example.test/news', snippet: '已验证的搜索结果', date: '2026-10-18' }]

type Request = { path: string; body: unknown; auth: string | undefined }
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => void, body: (env: NodeJS.ProcessEnv, requests: Request[], dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'oc-web-search-'))
  const requests: Request[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    requests.push({ path: req.url ?? '', body: raw ? JSON.parse(raw) : null, auth: req.headers.authorization })
    handler(req, res)
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const address = server.address(); assert.ok(address && typeof address === 'object')
  const env = { OPENCLAUDE_HOME: dir, HOME: dir, OPENCLAUDE_V3_MASTER_BASE_URL: `http://127.0.0.1:${address.port}`, OPENCLAUDE_V3_CONTAINER_TOKEN: identity }
  try { await body(env, requests, dir) } finally { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(dir, { recursive: true, force: true }) }
}
function ok(res: ServerResponse) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ organic })) }

test('OCV5-510 oc-web search returns source URLs through the authenticated master proxy', async () => {
  await fixture((_req, res) => ok(res), async (env, requests) => {
    const result = await runOcWebCli(['search', '今日科技新闻', '--json'], env)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).results[0].url, organic[0].url)
    assert.match(result.stdout, /今日科技新闻/)
    assert.deepEqual(requests, [{ path: '/internal/v3/minimax-search', body: { q: '今日科技新闻' }, auth: `Bearer ${identity}` }])
    assert.ok(!result.stdout.includes(identity))
  })
})

for (const scenario of ['http-error', 'empty', 'invalid-json', 'invalid-urls', 'timeout']) {
  test(`search falls back to Grok after MiniMax ${scenario}`, async () => {
    await fixture((req, res) => {
      if (req.url === '/internal/v3/grok-search') return ok(res)
      if (scenario === 'http-error') { res.writeHead(503); res.end('private upstream error'); return }
      if (scenario === 'timeout') return // Hold this response open until the caller aborts it.
      res.end(scenario === 'empty' ? '{"organic":[]}' : scenario === 'invalid-urls' ? '{"organic":[{"title":"bad","url":"javascript:alert(1)"}]}' : 'not json')
    }, async (env, requests) => {
      const result = await runOcWebCli(['search', 'news', '--timeout-ms', scenario === 'timeout' ? '1000' : '2000'], env)
      assert.equal(result.exitCode, 0, result.stderr)
      assert.match(result.stdout, /https:\/\/example.test\/news/)
      assert.deepEqual(requests.map((r) => r.path), ['/internal/v3/minimax-search', '/internal/v3/grok-search'])
    })
  })
}

test('search fails explicitly without disclosing response bodies or identity', async () => {
  await fixture((_req, res) => { res.writeHead(500); res.end(`${identity} private upstream detail`) }, async (env, requests) => {
    const result = await runOcWebCli(['search', 'news', '--json'], env)
    assert.equal(result.exitCode, 1)
    assert.equal(JSON.parse(result.stdout).ok, false)
    assert.ok(!result.stdout.includes(identity)); assert.ok(!result.stdout.includes('private upstream detail'))
    assert.equal(requests.length, 2)
  })
})

test('Codex scrubbed env uses the paired container auth file; partial env never mixes identities', async () => {
  await fixture((_req, res) => ok(res), async (env, requests, dir) => {
    await mkdir(join(dir, '.openclaude'));
    await writeFile(join(dir, '.openclaude', 'container-auth.json'), JSON.stringify({ masterBaseUrl: env.OPENCLAUDE_V3_MASTER_BASE_URL, containerToken: identity }))
    const scrubbed = { HOME: dir, OPENCLAUDE_V3_MASTER_BASE_URL: 'http://127.0.0.1:1' }
    const result = await runOcWebCli(['search', 'news'], scrubbed)
    assert.equal(result.exitCode, 0, result.stderr)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].auth, `Bearer ${identity}`)
  })
})

test('search supports token files and never issues requests without container identity', async () => {
  await fixture((_req, res) => ok(res), async (env, requests, dir) => {
    const tokenFile = join(dir, 'fixture-token'); await writeFile(tokenFile, identity)
    const fileEnv = { ...env, OPENCLAUDE_V3_CONTAINER_TOKEN: '', OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: tokenFile }
    assert.equal((await runOcWebCli(['search', 'news'], fileEnv)).exitCode, 0)
    assert.equal(requests.length, 1)
    assert.equal((await runOcWebCli(['search', 'news'], { HOME: dir, OPENCLAUDE_HOME: dir })).exitCode, 1)
    assert.equal(requests.length, 1)
  })
})

test('search rejects invalid input and help advertises search without starting network', async () => {
  await fixture((_req, res) => ok(res), async (env, requests) => {
    for (const args of [['search'], ['search', ' '], ['search', 'a'.repeat(1001)], ['search', 'one', 'two'], ['search', 'news', '--timeout-ms=0'], ['search', 'news', '--timeout-ms=NaN'], ['search', 'news', '--max-chars=0']]) assert.equal((await runOcWebCli(args, env)).exitCode, 2)
    assert.match((await runOcWebCli(['--help'], env)).stdout, /search <query>/)
    const wrapper = fileURLToPath(new URL('../../../commercial/agent-sandbox/platform-runtime/bin/oc-web.sh', import.meta.url))
    assert.match(execFileSync('sh', [wrapper, '--help'], { encoding: 'utf8' }), /search <query>/)
    assert.equal(requests.length, 0)
  })
})

for (const format of ['json', 'markdown']) {
  test(`search keeps Grok source-only URLs after MiniMax failure in ${format}`, async () => {
    const sourceUrl = 'https://www.pbc.gov.cn/a'
    await fixture((req, res) => {
      if (req.url !== '/internal/v3/grok-search') {
        res.writeHead(503); res.end(`${identity} private upstream detail`); return
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ organic: [
        { title: '', url: sourceUrl, snippet: '' },
        { title: '', url: '', snippet: '' },
        { title: '', url: 'javascript:alert(1)', snippet: '' },
      ] }))
    }, async (env, requests) => {
      const result = await runOcWebCli(['search', 'news', ...(format === 'json' ? ['--json'] : [])], env)
      assert.equal(result.exitCode, 0, result.stderr)
      if (format === 'json') {
        assert.deepEqual(JSON.parse(result.stdout).results, [{ title: sourceUrl, url: sourceUrl, snippet: '' }])
      } else {
        assert.ok(result.stdout.includes(`1. ${sourceUrl}\n${sourceUrl}`))
      }
      assert.deepEqual(requests.map((r) => r.path), ['/internal/v3/minimax-search', '/internal/v3/grok-search'])
      assert.ok(!result.stdout.includes('javascript:'))
      assert.ok(!result.stdout.includes(identity))
      assert.ok(!result.stdout.includes('private upstream detail'))
    })
  })
}
