import assert from 'node:assert/strict'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { launchJourneyBrowser } from '../../../scripts/lib/journey-browser.mjs'

const SCREENSHOT_DIR = existsSync('/var/lib/docker/volumes/oc-v5-data-u3/_data/generated')
  ? '/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/ocv5-210-m2-ui-screens'
  : '/home/agent/.openclaude/generated/ocv5-210-m2-ui-screens'
mkdirSync(SCREENSHOT_DIR, { recursive: true })

async function openHarness(page, port, js) {
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.setContent(`<!doctype html><html><body><div id="root"></div><script>${js}</script></body></html>`)
}

async function chooseAdvisor(page) {
  await page.getByTestId('open-picker').click()
  await page.getByRole('button', { name: /主模型不切换/ }).click()
  await page.waitForFunction(
    () => document.querySelector('[data-testid="config-version"]')?.textContent === 'v1:advisor:gpt-6-astra',
    null,
    { timeout: 5000 },
  )
}

const { build } = createRequire(import.meta.url)('esbuild')

function collabDoc(overrides = {}) {
  return {
    rev: 1,
    defaultMode: 'solo',
    defaultAdvisorModel: 'gpt-6-astra',
    session: {
      mode: 'solo',
      advisorModel: null,
      configVersion: 'v1:solo:',
      source: 'default',
    },
    advisorModels: [{ id: 'gpt-6-astra', label: 'GPT-6-Astra', engine: 'codex' }],
    ...overrides,
  }
}

async function bundleHarness() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL('./ocv5-210-advisor-ui-harness.tsx', import.meta.url))],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    alias: {
      'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
      '@openclaude/protocol': fileURLToPath(new URL('../../protocol/src/index.ts', import.meta.url)),
    },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  })
  return bundled.outputFiles[0].text
}

function startFixture({ delayMs = 0, conflict = false } = {}) {
  const sessions = {
    'sess-a': collabDoc(),
    'sess-b': collabDoc({
      session: {
        mode: 'advisor',
        advisorModel: 'gpt-6-astra',
        configVersion: 'v1:advisor:gpt-6-astra',
        source: 'session',
      },
    }),
  }
  const puts = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    res.setHeader('content-type', 'application/json; charset=utf-8')
    if (url.pathname === '/api/collaboration-config' && req.method === 'GET') {
      const sid = url.searchParams.get('sessionId') || 'sess-a'
      const send = () => res.end(JSON.stringify(sessions[sid] || sessions['sess-a']))
      if (delayMs && sid === 'sess-a') setTimeout(send, delayMs)
      else send()
      return
    }
    if (url.pathname === '/api/collaboration-config' && req.method === 'PUT') {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw || '{}')
        puts.push(body)
        if (conflict) {
          res.statusCode = 409
          res.end(JSON.stringify({ error: 'rev mismatch' }))
          return
        }
        const sid = body.sessionId || 'sess-a'
        const next = collabDoc({
          rev: (sessions[sid]?.rev || 1) + 1,
          session: {
            mode: body.mode,
            advisorModel: body.mode === 'advisor' ? 'gpt-6-astra' : null,
            configVersion: body.mode === 'advisor' ? 'v1:advisor:gpt-6-astra' : `v1:${body.mode}:`,
            source: body.asDefault ? 'default' : 'session',
          },
        })
        sessions[sid] = next
        res.end(JSON.stringify(next))
      })
      return
    }
    res.end('{}')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, port, puts })
    })
  })
}

test('ocv5-210-advisor-ui: click advisor keeps advisor send and does not change main model', async () => {
  const js = await bundleHarness()
  const { server, port, puts } = await startFixture()
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await openHarness(page, port, js)
    await chooseAdvisor(page)
    assert.equal(await page.getByTestId('collab-mode').innerText(), 'advisor')
    assert.equal(await page.getByTestId('main-model').innerText(), 'glm-5.2')
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'advisor-keeps-send.png'), fullPage: true })
    await page.getByTestId('send').click()
    const sent = JSON.parse(await page.getByTestId('last-send').innerText())
    assert.equal(sent.collabMode, 'advisor')
    assert.equal(sent.advisorModel, 'gpt-6-astra')
    assert.equal(sent.collabConfigVersion, 'v1:advisor:gpt-6-astra')
    assert.equal(sent.teamMode, false)
    assert.equal(puts.at(-1)?.asDefault, undefined)
    assert.equal(puts.at(-1)?.mode, 'advisor')
    assert.equal(Object.prototype.hasOwnProperty.call(puts.at(-1) || {}, 'asDefault'), false)
  } finally {
    await browser.close()
    server.close()
  }
})

test('ocv5-210-advisor-ui: slow session A GET cannot overwrite session B', async () => {
  const js = await bundleHarness()
  const { server, port } = await startFixture({ delayMs: 800 })
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await openHarness(page, port, js)
    await page.getByTestId('switch-b').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="collab-mode"]')?.textContent === 'advisor', null, { timeout: 5000 })
    assert.equal(await page.getByTestId('collab-mode').innerText(), 'advisor')
  } finally {
    await browser.close()
    server.close()
  }
})

test('ocv5-210-advisor-ui: PUT 409 rereads and does not swallow', async () => {
  const js = await bundleHarness()
  const { server, port } = await startFixture({ conflict: true })
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await openHarness(page, port, js)
    await page.getByTestId('open-picker').click()
    await page.getByRole('button', { name: /主模型不切换/ }).click()
    await page.getByTestId('blocked').waitFor()
    assert.match(await page.getByTestId('blocked').innerText(), /配置已被更新/)
  } finally {
    await browser.close()
    server.close()
  }
})

test('ocv5-210-advisor-ui: non-main send stays solo', async () => {
  const js = await bundleHarness()
  const { server, port } = await startFixture()
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await openHarness(page, port, js)
    await chooseAdvisor(page)
    await page.getByTestId('as-coding').click()
    await page.getByTestId('send').click()
    const sent = JSON.parse(await page.getByTestId('last-send').innerText())
    assert.equal(sent.collabMode, 'solo')
    assert.equal(sent.teamMode, false)
  } finally {
    await browser.close()
    server.close()
  }
})

test('ocv5-210-advisor-ui: team click keeps team send (old team regression)', async () => {
  const js = await bundleHarness()
  const { server, port, puts } = await startFixture()
  const browser = await launchJourneyBrowser()
  try {
    const page = await browser.newPage()
    await openHarness(page, port, js)
    await page.getByTestId('open-picker').click()
    await page.getByRole('button', { name: /队长切 Astra/ }).click()
    await page.waitForFunction(
      () => document.querySelector('[data-testid="config-version"]')?.textContent === 'v1:team:',
      null,
      { timeout: 5000 },
    )
    await page.getByTestId('send').click()
    const sent = JSON.parse(await page.getByTestId('last-send').innerText())
    assert.equal(sent.collabMode, 'team')
    assert.equal(sent.teamMode, true)
    assert.equal(sent.advisorModel, undefined)
    assert.equal(puts.at(-1)?.mode, 'team')
    assert.equal(puts.at(-1)?.asDefault, undefined)
  } finally {
    await browser.close()
    server.close()
  }
})

test('ocv5-210-advisor-ui: two browser contexts share server session config', async () => {
  const js = await bundleHarness()
  const { server, port } = await startFixture()
  const browser = await launchJourneyBrowser()
  try {
    const c1 = await browser.newContext()
    const c2 = await browser.newContext()
    const p1 = await c1.newPage()
    const p2 = await c2.newPage()
    await openHarness(p1, port, js)
    await openHarness(p2, port, js)
    await chooseAdvisor(p1)
    await p1.screenshot({ path: join(SCREENSHOT_DIR, 'dual-context-device-a.png'), fullPage: true })
    await p2.getByTestId('reload').click()
    await p2.waitForFunction(
      () => document.querySelector('[data-testid="collab-mode"]')?.textContent === 'advisor',
      null,
      { timeout: 5000 },
    )
    assert.equal(await p2.getByTestId('collab-mode').innerText(), 'advisor')
    assert.equal(await p2.getByTestId('config-version').innerText(), 'v1:advisor:gpt-6-astra')
    assert.equal(await p2.getByTestId('main-model').innerText(), 'glm-5.2')
    await p2.screenshot({ path: join(SCREENSHOT_DIR, 'dual-context-device-b.png'), fullPage: true })
  } finally {
    await browser.close()
    server.close()
  }
})
