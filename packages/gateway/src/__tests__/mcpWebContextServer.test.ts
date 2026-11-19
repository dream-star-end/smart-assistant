import * as assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import * as net from 'node:net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, it } from 'node:test'
import { extractUrl, resolveSafeParseFile } from '../mcpWebContextServer.js'
import { resolveWebContextBrowserExecutable } from '../webContextBrowser.js'

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

async function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T | Promise<T>) {
  const old = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(patch)) {
    old.set(key, process.env[key])
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of old) {
      if (value === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = value
    }
  }
}

function createFakeParserBin(dir: string): string {
  const bin = join(dir, 'fake-oc-web-context')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
if (payload.op === 'health_check') {
  console.log(JSON.stringify({ ok: true, checks: { trafilatura: { ok: true } } }));
  process.exit(0);
}
const html = fs.readFileSync(payload.file_path, 'utf8');
const text = html
  .replace(/<script[\\s\\S]*?<\\/script>/gi, ' ')
  .replace(/<style[\\s\\S]*?<\\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/\\s+/g, ' ')
  .trim();
console.log(JSON.stringify({
  ok: Boolean(text),
  extractor: 'test-html-stripper',
  markdown: text,
  chars: text.length,
  truncated: false,
}));
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

describe('mcpWebContextServer safe parse file resolution', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('allows a file under an existing safe root even if another configured root is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-webctx-safe-root-'))
    dirs.push(root)
    const file = join(root, 'note.txt')
    writeFileSync(file, 'hello web context')
    await withEnv(
      { OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS: `/missing/openclaude-webctx-root:${root}` },
      () => {
        const out = resolveSafeParseFile({ file_path: file })
        assert.equal(out.filePath, file)
      },
    )
  })

  it('rejects files outside the configured safe roots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-webctx-safe-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'oc-webctx-outside-'))
    dirs.push(root, outside)
    const file = join(outside, 'note.txt')
    writeFileSync(file, 'outside')
    await withEnv({ OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS: root }, () => {
      assert.throws(() => resolveSafeParseFile({ file_path: file }), /under uploads, generated/)
    })
  })
})

describe('mcpWebContextServer guarded browser rendering & auto SPA fallback', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('extracts JS-rendered SPA content in auto and browser modes while static fails, and leaves normal pages on static', async () => {
    assert.ok(resolveWebContextBrowserExecutable(), 'expected Chromium executable for browser tests')
    const dir = mkdtempSync(join(tmpdir(), 'oc-webctx-spa-'))
    dirs.push(dir)
    const bin = createFakeParserBin(dir)

    const spaBody =
      'Client-side JavaScript fetched this complete article payload after initial DOM mount and rendered structured paragraphs for verification.'
    const staticBody =
      'Pre-rendered static article content delivered directly in the initial HTML payload so static mode completes without launching headless Chromium.'

    const server = createServer((req, res) => {
      if (req.url === '/spa') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><html><body><div id="app"></div><script>
            fetch('/api/article').then(r => r.json()).then(d => {
              document.getElementById('app').innerHTML = '<h1>' + d.title + '</h1><p>' + d.body + '</p>';
            });
          </script></body></html>`,
        )
        return
      }
      if (req.url === '/api/article') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ title: 'Dynamic SPA Title', body: spaBody }))
        return
      }
      if (req.url === '/static') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><body><article><h1>Static Title</h1><p>${staticBody}</p></article></body></html>`)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const serverPort = (server.address() as net.AddressInfo).port

    const proxyOptions = {
      lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      connectSocket: ({ host, port }: { host: string; port: number }) => {
        if (host !== '93.184.216.34') throw new Error(`blocked non-public host ${host}`)
        return net.connect({ host: '127.0.0.1', port: serverPort })
      },
    }

    try {
      await withEnv({ OPENCLAUDE_WEB_CONTEXT_BIN: bin }, async () => {
        const staticRes = await extractUrl({
          url: 'http://spa.example.test/spa',
          mode: 'static',
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(staticRes.ok, false)
        assert.equal(staticRes.rendered_via, 'static')

        const browserRes = await extractUrl({
          url: 'http://spa.example.test/spa',
          mode: 'browser',
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(browserRes.ok, true)
        assert.equal(browserRes.rendered_via, 'browser')
        assert.match(String(browserRes.markdown), /Dynamic SPA Title/)
        assert.match(String(browserRes.markdown), /Client-side JavaScript fetched/)

        const autoSpaRes = await extractUrl({
          url: 'http://spa.example.test/spa',
          mode: 'auto',
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(autoSpaRes.ok, true)
        assert.equal(autoSpaRes.mode, 'auto')
        assert.equal(autoSpaRes.rendered_via, 'browser')
        assert.match(String(autoSpaRes.markdown), /Dynamic SPA Title/)

        const autoStaticRes = await extractUrl({
          url: 'http://spa.example.test/static',
          mode: 'auto',
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(autoStaticRes.ok, true)
        assert.equal(autoStaticRes.mode, 'auto')
        assert.equal(autoStaticRes.rendered_via, 'static')
        assert.match(String(autoStaticRes.markdown), /Static Title/)
      })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('blocks browser subrequests, WebSockets, popups, and DNS rebinding, and never leaks proxy credentials to HTTP 401 sites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-webctx-ssrf-'))
    dirs.push(dir)
    const bin = createFakeParserBin(dir)

    let honeypotHits = 0
    let wsUpgradeHits = 0
    let popupTargetHits = 0
    let rebindSecretHits = 0
    let auth401Challenges = 0
    const siteReceivedAuthHeaders: string[] = []
    const honeypot = createServer((_req, res) => {
      honeypotHits += 1
      res.end('TOP_SECRET_LOCAL')
    })
    honeypot.on('upgrade', (_req, sock) => {
      wsUpgradeHits += 1
      sock.destroy()
    })
    await new Promise<void>((done) => honeypot.listen(0, '127.0.0.1', done))
    const honeypotPort = (honeypot.address() as net.AddressInfo).port

    const fixture = createServer((req, res) => {
      if (req.url === '/popup-target') {
        popupTargetHits += 1
        res.end('POPUP_SHOULD_NOT_REQUEST')
        return
      }
      if (req.url === '/secret') {
        rebindSecretHits += 1
        res.end('REBOUND_SECRET')
        return
      }
      if (req.url === '/401-trap') {
        auth401Challenges += 1
        if (req.headers.authorization) siteReceivedAuthHeaders.push(req.headers.authorization)
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="trap"',
          'content-type': 'text/plain',
        })
        res.end('unauthorized')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><html><body><a id="pop" href="http://spa.example.test/popup-target" target="_blank">open</a><div id="app"></div><script>
        try { window.open('http://spa.example.test/popup-target'); } catch {}
        try { document.getElementById('pop').click(); } catch {}
        const wsCheck = new Promise((resolve) => {
          try {
            const ws = new WebSocket('ws://127.0.0.1:${honeypotPort}/ws');
            ws.onerror = () => resolve('blocked');
            ws.onclose = () => resolve('closed');
            setTimeout(() => resolve('timeout'), 400);
          } catch { resolve('threw'); }
        });
        Promise.allSettled([
          wsCheck,
          fetch('http://127.0.0.1:${honeypotPort}/secret'),
          fetch('http://localhost:${honeypotPort}/secret'),
          fetch('http://169.254.169.254/latest/meta-data/'),
          fetch('http://rebind.example.test/secret'),
          fetch('http://spa.example.test/401-trap')
        ]).finally(() => {
          document.getElementById('app').innerHTML =
            '<article><h1>Probe Done</h1><p>Browser subrequest probe completed under SSRF proxy guard with sufficient length for markdown extraction verification.</p></article>';
        });
      </script></body></html>`)
    })
    await new Promise<void>((done) => fixture.listen(0, '127.0.0.1', done))
    const fixturePort = (fixture.address() as net.AddressInfo).port

    let rebindCalls = 0
    const proxyOptions = {
      lookup: (async (host: string) => {
        if (host === 'rebind.example.test') {
          rebindCalls += 1
          // First two lookups (preflight + page load) resolve public; subrequest flips to 127.0.0.1
          return [{ address: rebindCalls <= 2 ? '93.184.216.34' : '127.0.0.1', family: 4 }]
        }
        return [{ address: '93.184.216.34', family: 4 }]
      }) as any,
      connectSocket: ({ host }: { host: string; port: number }) => {
        if (host !== '93.184.216.34') throw new Error(`non-public socket connect attempted: ${host}`)
        return net.connect({ host: '127.0.0.1', port: fixturePort })
      },
    }

    try {
      await withEnv({ OPENCLAUDE_WEB_CONTEXT_BIN: bin }, async () => {
        const res = await extractUrl({
          url: 'http://rebind.example.test/page',
          mode: 'browser',
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(res.ok, true)
        assert.equal(res.rendered_via, 'browser')
        assert.match(String(res.markdown), /Probe Done/)
        assert.equal(honeypotHits, 0)
        assert.equal(wsUpgradeHits, 0)
        assert.equal(popupTargetHits, 0)
        assert.equal(rebindSecretHits, 0)
        assert.ok(auth401Challenges >= 1, 'expected target /401-trap challenge to run')
        assert.deepEqual(siteReceivedAuthHeaders, [])
        assert.ok(rebindCalls >= 3, `expected DNS rebinding subrequest to trigger lookup (${rebindCalls})`)
      })
    } finally {
      await new Promise<void>((done) => fixture.close(() => done()))
      await new Promise<void>((done) => honeypot.close(() => done()))
    }
  })

  it('releases browser semaphore, kills Chromium PID, and cleans sockets after timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-webctx-timeout-'))
    dirs.push(dir)
    const bin = createFakeParserBin(dir)

    const hungSockets = new Set<net.Socket>()
    const server = createServer((req, res) => {
      if (req.url === '/slow') {
        hungSockets.add(req.socket)
        req.socket.once('close', () => hungSockets.delete(req.socket))
        return // Intentionally hang without sending headers
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><html><body><main><h1>Recovered Render</h1><p>Subsequent browser extraction succeeds immediately because timeout teardown released the concurrency slot and cleaned sockets.</p></main></body></html>',
      )
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const serverPort = (server.address() as net.AddressInfo).port

    const proxyOptions = {
      lookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      connectSocket: ({ host }: { host: string; port: number }) => {
        if (host !== '93.184.216.34') throw new Error(`unexpected host ${host}`)
        return net.connect({ host: '127.0.0.1', port: serverPort })
      },
    }

    try {
      await withEnv({ OPENCLAUDE_WEB_CONTEXT_BIN: bin }, async () => {
        let slowPid = 0
        await assert.rejects(() =>
          extractUrl({
            url: 'http://slow.example.test/slow',
            mode: 'browser',
            timeout_ms: 3_000,
            _browserProxyOptions: proxyOptions,
            _onBrowserPid: (pid) => {
              slowPid = pid
            },
          }),
        )
        assert.ok(slowPid > 0, 'expected real Chromium PID to be recorded')
        assert.equal(isProcessAlive(slowPid), false, `expected Chromium PID ${slowPid} to have exited`)

        const recovery = await extractUrl({
          url: 'http://slow.example.test/fast',
          mode: 'browser',
          timeout_ms: 15_000,
          _browserProxyOptions: proxyOptions,
        })
        assert.equal(recovery.ok, true)
        assert.match(String(recovery.markdown), /Recovered Render/)
      })
    } finally {
      for (const s of hungSockets) s.destroy()
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('arbitrates cross-process browser concurrency across two independent CLI-style processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-webctx-xproc-'))
    const lockDir = mkdtempSync(join(tmpdir(), 'oc-webctx-xproc-lock-'))
    dirs.push(dir, lockDir)
    const bin = createFakeParserBin(dir)
    const entryPath = fileURLToPath(new URL('../mcpWebContextServer.js', import.meta.url))

    let inFlight = 0
    let maxInFlight = 0
    const server = createServer((req, res) => {
      if (req.url === '/slow1' || req.url === '/slow2') {
        inFlight += 1
        if (inFlight > maxInFlight) maxInFlight = inFlight
        setTimeout(() => {
          inFlight -= 1
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(
            `<!doctype html><html><body><article><h1>Cross Process ${req.url}</h1><p>Independent process completed safely under cross-process Chromium slot arbitration with enough content length to pass extraction checks.</p></article></body></html>`,
          )
        }, 1_100)
        return
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const serverPort = (server.address() as net.AddressInfo).port

    const runChildExtract = (pathUrl: string) =>
      new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const script = `
          import net from 'node:net';
          import { extractUrl } from ${JSON.stringify(entryPath)};
          const res = await extractUrl({
            url: ${JSON.stringify(`http://xproc.example.test${pathUrl}`)},
            mode: 'browser',
            timeout_ms: 30_000,
            _browserProxyOptions: {
              lookup: async () => [{ address: '93.184.216.34', family: 4 }],
              connectSocket: ({ host }) => {
                if (host !== '93.184.216.34') throw new Error('unexpected host');
                return net.connect({ host: '127.0.0.1', port: ${serverPort} });
              },
            },
          });
          console.log(JSON.stringify(res));
        `
        const child = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script],
          {
            env: {
              ...process.env,
              OPENCLAUDE_WEB_CONTEXT_BIN: bin,
              OPENCLAUDE_WEB_CONTEXT_LOCK_DIR: lockDir,
              OPENCLAUDE_WEB_CONTEXT_BROWSER_CONCURRENT: '1',
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c) => {
          stdout += c.toString()
        })
        child.stderr.on('data', (c) => {
          stderr += c.toString()
        })
        child.on('error', reject)
        child.on('close', (code) => resolve({ code, stdout, stderr }))
      })

    try {
      const p1 = runChildExtract('/slow1')
      await new Promise((resolve) => setTimeout(resolve, 150))
      const p2 = runChildExtract('/slow2')
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1.code, 0, r1.stderr)
      assert.equal(r2.code, 0, r2.stderr)
      assert.equal(JSON.parse(r1.stdout).ok, true)
      assert.equal(JSON.parse(r2.stdout).ok, true)
      assert.equal(maxInFlight, 1, `expected strict cross-process serialization, got maxInFlight=${maxInFlight}`)
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
})
