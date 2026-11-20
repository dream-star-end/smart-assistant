import * as assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import {
  LIVE_BROWSER_MAX_QUEUE_DEPTH,
  LiveBrowserController,
  LiveBrowserError,
  buildPlaywrightRunCodeScript,
  handleLiveBrowserActionHttp,
  handleLiveBrowserLiveHttp,
  ocBrowserAgentKey,
  parsePlaywrightRunCodeResult,
  validateLiveBrowserAction,
  validateLiveBrowserUrl,
} from '../liveBrowserController.js'

function mockRunCodeOutput(payload: Record<string, unknown>): string {
  return `### Result\n${JSON.stringify(payload)}\n### Ran Playwright code\n\`\`\`js\nawait page.screenshot()\n\`\`\`\n`
}

function makeFakeRes() {
  const headers = new Map<string, string>()
  let statusCode = 0
  let body: unknown = null
  const res = {
    setHeader(name: string, val: string) {
      headers.set(name.toLowerCase(), val)
    },
  } as unknown as ServerResponse
  return {
    res,
    headers,
    get statusCode() {
      return statusCode
    },
    get body() {
      return body
    },
    sendJson(_r: ServerResponse, code: number, payload: unknown) {
      statusCode = code
      body = payload
    },
    sendError(_r: ServerResponse, code: number, message: string) {
      statusCode = code
      body = { error: message }
    },
  }
}

describe('liveBrowserController', () => {
  it('computes deterministic ocBrowserAgentKey matching oc-browser wrapper convention', () => {
    const keyMain = ocBrowserAgentKey('main')
    assert.match(keyMain, /^main-[0-9a-f]{16}$/)
    assert.equal(keyMain, ocBrowserAgentKey('main'))
    assert.notEqual(ocBrowserAgentKey('main'), ocBrowserAgentKey('coder'))
  })

  it('strictly allows only http: and https: URLs', () => {
    assert.equal(validateLiveBrowserUrl('https://arxiv.org/abs/2501.00001'), 'https://arxiv.org/abs/2501.00001')
    assert.equal(validateLiveBrowserUrl('http://127.0.0.1:8765/demo.html'), 'http://127.0.0.1:8765/demo.html')
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
      'chrome://settings',
      'ftp://example.com/a',
      '',
      'not a url',
    ]) {
      assert.throws(() => validateLiveBrowserUrl(bad), LiveBrowserError)
    }
  })

  it('validates takeover action payloads and rejects unsafe keys or invalid coordinates', () => {
    assert.deepEqual(validateLiveBrowserAction({ action: 'click', x: 0.5, y: 0.25, normalized: true }), {
      action: 'click',
      x: 0.5,
      y: 0.25,
      normalized: true,
      button: 'left',
    })
    assert.deepEqual(validateLiveBrowserAction({ action: 'type', text: 'hello', submit: true }), {
      action: 'type',
      text: 'hello',
      submit: true,
    })
    assert.deepEqual(validateLiveBrowserAction({ action: 'press', key: 'Control+a' }), {
      action: 'press',
      key: 'Control+a',
    })
    assert.throws(() => validateLiveBrowserAction({ action: 'eval', code: '1+1' }), LiveBrowserError)
    assert.throws(() => validateLiveBrowserAction({ action: 'click', x: 2, y: 0.5, normalized: true }), LiveBrowserError)
    assert.throws(() => validateLiveBrowserAction({ action: 'press', key: 'Enter; rm -rf /' }), LiveBrowserError)
    assert.throws(() => validateLiveBrowserAction({ action: 'type', text: '' }), LiveBrowserError)
    assert.throws(() => validateLiveBrowserAction({ action: 'goto', url: 'file:///etc/hosts' }), LiveBrowserError)
  })

  it('parses Playwright run-code JSON result blocks', () => {
    const out = mockRunCodeOutput({ url: 'https://arxiv.org/', title: 'arXiv', viewport: { width: 1280, height: 720 }, tabs: [] })
    const parsed = parsePlaywrightRunCodeResult(out)
    assert.equal(parsed?.url, 'https://arxiv.org/')
    assert.equal(parsed?.title, 'arXiv')
    assert.equal(parsePlaywrightRunCodeResult('no result block here'), null)
  })

  it('builds self-contained run-code script with JSON payload embedded safely', () => {
    const script = buildPlaywrightRunCodeScript({
      mode: 'action',
      includeFrame: true,
      quality: 70,
      maxBytes: 900_000,
      op: { action: 'type', text: "it's </script> \"quoted\"", submit: false },
    })
    assert.ok(script.startsWith('async (page) => {'))
    assert.ok(script.includes('insertText'))
  })

  it('returns inactive in O(1) without launching oc-browser when activity marker is absent', async () => {
    let calls = 0
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: (p) => p === '/usr/local/bin/oc-browser',
      execFn: async () => {
        calls += 1
        return { stdout: '', stderr: '' }
      },
    })
    const state = await ctrl.getLiveState('main')
    assert.deepEqual(state, { available: true, active: false })
    assert.equal(calls, 0)
  })

  it('returns unavailable when oc-browser binary is missing', async () => {
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/nonexistent/oc-browser',
      existsSync: () => false,
    })
    assert.deepEqual(await ctrl.getLiveState('main'), { available: false, active: false, reason: 'unavailable' })
    await assert.rejects(() => ctrl.performAction('main', { action: 'open' }), (err: unknown) => {
      assert.ok(err instanceof LiveBrowserError)
      assert.equal(err.status, 503)
      return true
    })
  })

  it('coalesces concurrent GET frame reads and invalidates coalesced read when an action arrives', async () => {
    let execCount = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: () => true,
      execFn: async (_bin, args) => {
        const myCall = ++execCount
        if (myCall === 1) await firstGate
        const title = args[1]?.includes('"click"') ? 'After Click' : `Frame ${myCall}`
        return {
          stdout: mockRunCodeOutput({
            url: 'https://example.com',
            title,
            viewport: { width: 1280, height: 720 },
            tabs: [{ index: 0, title, url: 'https://example.com', active: true }],
            imageBase64: 'AAAA',
            capturedAt: 1000 + myCall,
          }),
          stderr: '',
        }
      },
    })

    const p1 = ctrl.getLiveState('main')
    const p2 = ctrl.getLiveState('main')
    // Coalesced while first read is in-flight
    const actionP = ctrl.performAction('main', { action: 'click', x: 0.5, y: 0.5, normalized: true })
    // Poll arriving AFTER action must NOT reuse p1
    const p3 = ctrl.getLiveState('main')

    releaseFirst()
    const [r1, r2, rAct, r3] = await Promise.all([p1, p2, actionP, p3])
    assert.equal(r1.title, 'Frame 1')
    assert.equal(r2.title, 'Frame 1')
    assert.equal(rAct.title, 'After Click')
    assert.equal(r3.title, 'Frame 3')
    assert.equal(execCount, 3)
  })

  it('rejects excess queued actions with 429 BROWSER_BUSY', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: () => true,
      execFn: async () => {
        await gate
        return { stdout: mockRunCodeOutput({ url: 'https://example.com', title: 'ok', viewport: { width: 1280, height: 720 }, tabs: [] }), stderr: '' }
      },
    })

    const queued: Promise<unknown>[] = []
    for (let i = 0; i < LIVE_BROWSER_MAX_QUEUE_DEPTH; i++) {
      queued.push(ctrl.performAction('main', { action: 'reload' }))
    }
    await assert.rejects(() => ctrl.performAction('main', { action: 'reload' }), (err: unknown) => {
      assert.ok(err instanceof LiveBrowserError)
      assert.equal(err.status, 429)
      assert.equal(err.code, 'BROWSER_BUSY')
      return true
    })
    release()
    await Promise.all(queued)
  })

  it('supports cold-start open/goto, idempotent close, and rejects inactive non-nav actions with 409', async () => {
    let active = false
    const cmds: Array<readonly string[]> = []
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: (p) => p === '/usr/local/bin/oc-browser' || (active && p.endsWith('/activity')),
      execFn: async (_bin, args) => {
        cmds.push(args)
        if (args[0] === 'open') {
          active = true
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'close') {
          active = false
          return { stdout: '', stderr: '' }
        }
        return {
          stdout: mockRunCodeOutput({
            url: 'https://arxiv.org/',
            title: 'arXiv',
            viewport: { width: 1280, height: 720 },
            tabs: [{ index: 0, title: 'arXiv', url: 'https://arxiv.org/', active: true }],
            imageBase64: 'BBBB',
          }),
          stderr: '',
        }
      },
    })

    await assert.rejects(() => ctrl.performAction('main', { action: 'click', x: 0.2, y: 0.2, normalized: true }), (err: unknown) => {
      assert.ok(err instanceof LiveBrowserError)
      assert.equal(err.status, 409)
      return true
    })

    const opened = await ctrl.performAction('main', { action: 'goto', url: 'https://arxiv.org/' })
    assert.equal(opened.active, true)
    assert.equal(opened.title, 'arXiv')
    assert.equal(cmds[0][0], 'open')

    const closed = await ctrl.performAction('main', { action: 'close' })
    assert.equal(closed.active, false)
    const closedAgain = await ctrl.performAction('main', { action: 'close' })
    assert.equal(closedAgain.active, false)
  })

  it('HTTP handlers enforce method, agent existence, body cap, and Cache-Control: no-store', async () => {
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: (p) => p === '/usr/local/bin/oc-browser',
    })

    // 405 on wrong method
    const r405 = makeFakeRes()
    await handleLiveBrowserLiveHttp(
      { controller: ctrl, hasAgent: async () => true, readBody: async () => '', sendJson: r405.sendJson, sendError: r405.sendError },
      { method: 'POST' } as IncomingMessage,
      r405.res,
      'main',
      new URL('http://gw/api/agents/main/browser/live'),
    )
    assert.equal(r405.statusCode, 405)

    // 404 on unknown agent
    const r404 = makeFakeRes()
    await handleLiveBrowserLiveHttp(
      { controller: ctrl, hasAgent: async () => false, readBody: async () => '', sendJson: r404.sendJson, sendError: r404.sendError },
      { method: 'GET' } as IncomingMessage,
      r404.res,
      'ghost',
      new URL('http://gw/api/agents/ghost/browser/live'),
    )
    assert.equal(r404.statusCode, 404)

    // 200 with Cache-Control: no-store
    const r200 = makeFakeRes()
    await handleLiveBrowserLiveHttp(
      { controller: ctrl, hasAgent: async () => true, readBody: async () => '', sendJson: r200.sendJson, sendError: r200.sendError },
      { method: 'GET' } as IncomingMessage,
      r200.res,
      'main',
      new URL('http://gw/api/agents/main/browser/live'),
    )
    assert.equal(r200.statusCode, 200)
    assert.equal(r200.headers.get('cache-control'), 'no-store')
    assert.deepEqual(r200.body, { available: true, active: false, agentBusy: false })

    // 409 AGENT_RUNNING when another session for the same agent is actively executing
    const rBusy = makeFakeRes()
    await handleLiveBrowserActionHttp(
      {
        controller: ctrl,
        hasAgent: async () => true,
        isAgentRunning: () => true,
        sendJson: rBusy.sendJson,
        sendError: rBusy.sendError,
      },
      { method: 'POST' } as IncomingMessage,
      rBusy.res,
      'main',
    )
    assert.equal(rBusy.statusCode, 409)
    assert.equal((rBusy.body as { code?: string }).code, 'AGENT_RUNNING')

    // 413 on oversized POST body over real HTTP (no premature socket destroy)
    const server = createServer((req, res) => {
      handleLiveBrowserActionHttp(
        {
          controller: ctrl,
          hasAgent: async () => true,
          sendJson: (r, code, body) => {
            r.writeHead(code, { 'Content-Type': 'application/json' })
            r.end(JSON.stringify(body))
          },
          sendError: (r, code, message) => {
            r.writeHead(code, { 'Content-Type': 'application/json' })
            r.end(JSON.stringify({ error: message }))
          },
        },
        req,
        res,
        'main',
      ).catch(() => {})
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const addr = server.address() as { port: number }
      const bigResp = await fetch(`http://127.0.0.1:${addr.port}/api/agents/main/browser/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'type', text: 'a'.repeat(40 * 1024) }),
      })
      assert.equal(bigResp.status, 413)
      const json = (await bigResp.json()) as { code?: string }
      assert.equal(json.code, 'BODY_TOO_LARGE')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('emits zero unhandledRejection when coalesced GET capture fails (P0 regression)', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctrl = new LiveBrowserController({
        ocBrowserBin: '/usr/local/bin/oc-browser',
        existsSync: () => true,
        execFn: async () => {
          throw new Error('chromium screenshot timed out')
        },
      })
      await assert.rejects(() => ctrl.getLiveState('main'), (err: unknown) => {
        assert.ok(err instanceof LiveBrowserError)
        assert.equal(err.code, 'BROWSER_CAPTURE_FAILED')
        return true
      })
      await new Promise((r) => setTimeout(r, 20))
      assert.equal(unhandled.length, 0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('uses native CLI tab-select / tab-new / tab-close commands and recovers stale activity markers', async () => {
    const cmds: Array<readonly string[]> = []
    let daemonDead = true
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      // Stale activity marker exists even though daemonDead === true
      existsSync: () => true,
      execFn: async (_bin, args) => {
        cmds.push(args)
        if (args[0] === 'goto' && daemonDead) {
          throw new Error('session not found / browser is closed')
        }
        if (args[0] === 'open') {
          daemonDead = false
          return { stdout: '', stderr: '' }
        }
        if (args[0] === 'tab-select' || args[0] === 'tab-new' || args[0] === 'tab-close') {
          return { stdout: '', stderr: '' }
        }
        return {
          stdout: mockRunCodeOutput({
            url: 'https://arxiv.org/',
            title: 'arXiv',
            viewport: { width: 1280, height: 720 },
            tabs: [{ index: 0, title: 'arXiv', url: 'https://arxiv.org/', active: true }],
            imageBase64: 'CCCC',
          }),
          stderr: '',
        }
      },
    })

    // Open recovers from stale activity marker via fallback `open`
    const state = await ctrl.performAction('main', { action: 'open', url: 'https://arxiv.org/' })
    assert.equal(state.active, true)
    assert.deepEqual(cmds[0], ['goto', 'https://arxiv.org/'])
    assert.deepEqual(cmds[1], ['open', 'https://arxiv.org/'])
    assert.equal(cmds[2][0], 'run-code')

    // Native tab commands
    cmds.length = 0
    await ctrl.performAction('main', { action: 'tab_select', index: 1 })
    assert.deepEqual(cmds[0], ['tab-select', '1'])
    assert.equal(cmds[1][0], 'run-code')

    cmds.length = 0
    await ctrl.performAction('main', { action: 'tab_new', url: 'https://github.com/' })
    assert.deepEqual(cmds[0], ['tab-new', 'https://github.com/'])

    cmds.length = 0
    await ctrl.performAction('main', { action: 'tab_close', index: 1 })
    assert.deepEqual(cmds[0], ['tab-close', '1'])
  })

  it('surfaces non-closed errors on close and accepts unified Ctrl+X/Z keys', async () => {
    assert.deepEqual(validateLiveBrowserAction({ action: 'press', key: 'Control+x' }), {
      action: 'press',
      key: 'Control+x',
    })
    assert.deepEqual(validateLiveBrowserAction({ action: 'press', key: 'Control+z' }), {
      action: 'press',
      key: 'Control+z',
    })
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: () => true,
      execFn: async () => {
        throw new Error('ETIMEDOUT waiting for flock')
      },
    })
    await assert.rejects(() => ctrl.performAction('main', { action: 'close' }), (err: unknown) => {
      assert.ok(err instanceof LiveBrowserError)
      assert.equal(err.status, 502)
      assert.equal(err.code, 'BROWSER_CLOSE_FAILED')
      return true
    })
  })

  it('does NOT cold-restart browser on webpage network error ERR_CONNECTION_CLOSED', async () => {
    const cmds: Array<readonly string[]> = []
    const ctrl = new LiveBrowserController({
      ocBrowserBin: '/usr/local/bin/oc-browser',
      existsSync: () => true,
      execFn: async (_bin, args) => {
        cmds.push(args)
        throw new Error('page.goto: net::ERR_CONNECTION_CLOSED at https://flaky.invalid/')
      },
    })
    await assert.rejects(
      () => ctrl.performAction('main', { action: 'goto', url: 'https://flaky.invalid/' }),
      (err: unknown) => {
        assert.ok(err instanceof LiveBrowserError)
        assert.equal(err.status, 502)
        assert.equal(err.code, 'BROWSER_ACTION_FAILED')
        return true
      },
    )
    // Must NOT invoke `open` which would restart the healthy browser and lose tabs/forms.
    assert.equal(cmds.length, 1)
    assert.equal(cmds[0][0], 'run-code')
  })
})
