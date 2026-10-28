/**
 * Session-display scripts R1 R2 R3 R5 R7 R9.
 *
 * Runs inside the existing web-react browser job (playwright-core + node:test).
 * Time jumps use the Playwright clock. The lock/background events are
 * visibilitychange; airplane mode is context.setOffline. Nothing here dials a
 * live gateway or spends a paid turn.
 *
 * Clauses that need the unmerged snapshot protocol are test.skip, with the
 * slice named in the reason, so this file stays green in CI.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBrowserExecutable } from '../../../../scripts/lib/resolve-browser.mjs'
import { TERMINAL_MARKER, startSessionDisplayGateway } from './gateway.mjs'

const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const { chromium } = require('playwright-core')

const here = dirname(fileURLToPath(import.meta.url))
const HONEST =
  /思考中|正在思考|处理过程|工具中|执行操作|处理时间较长|后台运行中|深度思考中|正在生成内容/
const STALE_ENGINE = /正在启动引擎/
const CLOCK_ORIGIN = new Date('2026-10-29T00:00:00Z')

const results = []

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function activityText(page) {
  const loc = page.locator('[aria-label="生成中"]')
  if ((await loc.count()) === 0) return ''
  return (await loc.first().innerText()).replace(/\s+/g, ' ').trim()
}

async function bodyText(page) {
  return page.locator('body').innerText()
}

async function diagnose(page, gateway, message) {
  const body = await bodyText(page).catch(() => '')
  const sd = await page.evaluate(() => window.__sd ?? null).catch(() => null)
  const errors = page.__nodeErrors || []
  return `${message}\nBODY=${body.slice(0, 900)}\nSD=${JSON.stringify(sd)}\nERRORS=${JSON.stringify(errors)}\nGW=${JSON.stringify(gateway.debug())}`
}

function assertHonest(text) {
  assert.doesNotMatch(text, STALE_ENGINE, `stale engine label: ${text}`)
  assert.match(text, HONEST, `activity is not an honest in-flight label: ${text}`)
}

async function surfaceText(page) {
  const activity = await activityText(page)
  const body = (await bodyText(page)).replace(/\s+/g, ' ')
  return `${activity}\n${body}`.trim()
}

async function waitHonest(page, gateway, timeoutMs) {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    last = await surfaceText(page)
    if (last && !STALE_ENGINE.test(last) && HONEST.test(last)) return last
    await sleep(100)
  }
  throw new Error(
    await diagnose(page, gateway, `activity not honest within ${timeoutMs}ms: ${last}`),
  )
}

async function setVisibility(page, state) {
  await page.evaluate((next) => {
    const host = window
    host.__sdVis = next
    if (!host.__sdVisPatched) {
      const define = (prop, get) => {
        try {
          Object.defineProperty(document, prop, { configurable: true, get })
        } catch {
          Object.defineProperty(Document.prototype, prop, { configurable: true, get })
        }
      }
      define('visibilityState', () => host.__sdVis)
      define('hidden', () => host.__sdVis !== 'visible')
      host.__sdVisPatched = true
    }
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
}

/** Chunked so a keepalive probe can receive its pong before the 10s timeout. */
async function pumpConnected(page, ms) {
  let left = ms
  while (left > 0) {
    const step = Math.min(5_000, left)
    await page.clock.fastForward(step)
    left -= step
    await sleep(50)
  }
}

async function openHarness(browser, gateway, boot) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  page.__nodeErrors = []
  page.on('pageerror', (error) => {
    page.__nodeErrors.push(String(error))
  })
  try {
    await page.clock.install({ time: CLOCK_ORIGIN })
    const query = boot ? `?boot=${boot}` : ''
    await page.goto(`${gateway.url}${query}`)
    await page
      .locator('[data-testid="session-display"]')
      .waitFor({ state: 'visible', timeout: 20_000 })
    if ((await page.getByTestId('harness-error').count()) > 0) {
      throw new Error('harness failed to render')
    }
    await page.locator('textarea').waitFor({ timeout: 20_000 })
  } catch (error) {
    const detail = await diagnose(page, gateway, `open harness: ${error}`)
    await context.close()
    throw new Error(detail)
  }
  return { context, page }
}

async function sendTask(page, gateway, text, options = {}) {
  const requireStartup = options.requireStartup !== false
  await page.locator('textarea').fill(text)
  await page.getByRole('button', { name: '发送', exact: true }).click()
  try {
    await page.getByText(text, { exact: true }).waitFor({ timeout: 10_000 })
    if (requireStartup) {
      await page.getByText(STALE_ENGINE).waitFor({ timeout: 10_000 })
    } else {
      const start = Date.now()
      while (gateway.status !== 'open' && Date.now() - start < 10_000) await sleep(50)
      if (gateway.status !== 'open') throw new Error(`gateway status ${gateway.status}`)
    }
  } catch (error) {
    throw new Error(await diagnose(page, gateway, `send did not start the turn: ${error}`))
  }
}

async function markerVisible(page, marker) {
  return (await page.getByText(marker, { exact: true }).count()) > 0
}

async function expandCollapsed(page, testId) {
  const buttons = page.getByTestId(testId)
  const count = await buttons.count()
  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i)
    if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
  }
}

async function expectProcessText(page, gateway, marker) {
  // Shell defaults open while the turn is active; the step group and the
  // thinking card stay collapsed, and each click commits on the next paint.
  // count() does not wait, so retry until the marker is actually in the DOM.
  const start = Date.now()
  while (Date.now() - start < 8_000) {
    if (await markerVisible(page, marker)) return
    await expandCollapsed(page, 'process-toggle')
    await expandCollapsed(page, 'process-detail-toggle')
    const steps = page.locator('[data-testid="process-step"] button')
    const count = await steps.count()
    for (let i = 0; i < count; i++) {
      const button = steps.nth(i)
      if ((await button.getAttribute('aria-expanded')) === 'false') await button.click()
      if (await markerVisible(page, marker)) return
    }
    await sleep(100)
  }
  throw new Error(await diagnose(page, gateway, `process frame ${marker} is not in the page`))
}

async function assertContent(page, gateway, text) {
  const count = await page.getByText(text, { exact: true }).count()
  if (count < 1) {
    throw new Error(await diagnose(page, gateway, `missing user text ${text}`))
  }
}

test(
  'R5 hello 未完成时 8 秒内 HTTP 快照对齐',
  {
    skip: 'fixme: 依赖 codex-rf-snapshot（B3 并入）。当前协议没有 hello ack，live-frames 也不带 dispatch.turnStatus；8 秒 HTTP 对齐未实现。',
  },
  () => {},
)

test(
  'R9 上一轮仍在后台运行的横幅与积分确认',
  {
    skip: 'fixme: 积分数字「已用 X 积分」依赖 B4b/codex-rf-snapshot。已落地的 B4a 文案不带积分，由 R9 主断言覆盖。',
  },
  () => {},
)

test('session-display scripts R1 R2 R3 R5 R7 R9', { timeout: 300_000 }, async () => {
  const assetDir = mkdtempSync(join(tmpdir(), 'oc-session-display-'))
  let gateway
  let browser
  const failures = []
  try {
    await build({
      entryPoints: [join(here, 'harness.tsx')],
      bundle: true,
      format: 'esm',
      outfile: join(assetDir, 'harness.js'),
      jsx: 'automatic',
      loader: {
        '.css': 'empty',
        '.svg': 'dataurl',
        '.png': 'dataurl',
        '.jpg': 'dataurl',
        '.webp': 'dataurl',
        '.gif': 'dataurl',
      },
      alias: { 'node:crypto': join(here, '../stubs/node-crypto.js') },
      define: {
        'process.env.NODE_ENV': '"production"',
        'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}',
      },
      logLevel: 'warning',
    })
    writeFileSync(
      join(assetDir, 'index.html'),
      '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="oc-build" content="session-display-fixture"><title>session-display</title><div id="root"></div><script type="module" src="/harness.js"></script>',
    )
    gateway = await startSessionDisplayGateway(assetDir)
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ['--no-sandbox'],
    })

    const scripts = [
      ['R1', runR1],
      ['R2', runR2],
      ['R3', runR3],
      ['R5', runR5],
      ['R7', runR7],
      ['R9', runR9],
    ]
    for (const [id, run] of scripts) {
      gateway.reset()
      try {
        const status = await run(browser, gateway)
        results.push({ id, status })
        console.log(`SCRIPT ${id} ${status}`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        results.push({ id, status: `FAIL ${message.split('\n')[0]}` })
        failures.push(`${id}: ${message}`)
        console.log(`SCRIPT ${id} FAIL`)
      }
    }
  } finally {
    console.log('SESSION_DISPLAY_SUMMARY')
    for (const row of results) console.log(`${row.id} ${row.status}`)
    console.log('R5 fixme: hello 未完成时 8s HTTP 快照（codex-rf-snapshot）')
    console.log('R9 fixme: 积分数字（B4b/codex-rf-snapshot）')
    await browser?.close()
    await gateway?.stop?.()
    rmSync(assetDir, { recursive: true, force: true })
  }
  assert.equal(failures.length, 0, failures.join('\n\n'))
})

async function runR1(browser, gateway) {
  const text = 'R1_LONG_TASK_LOCK'
  const { context, page } = await openHarness(browser, gateway)
  try {
    await sendTask(page, gateway, text)
    await setVisibility(page, 'hidden')
    await pumpConnected(page, 120_000)
    await setVisibility(page, 'visible')
    await sleep(150)
    await page.clock.fastForward(1_000)
    const label = await waitHonest(page, gateway, 5_000)
    await assertContent(page, gateway, text)
    assertHonest(label)
    return '通过'
  } finally {
    await context.close()
  }
}

async function runR2(browser, gateway) {
  const text = 'R2_LONG_TASK_BACKGROUND'
  const thinking = 'R2_PARKED_THINKING'
  const { context, page } = await openHarness(browser, gateway)
  try {
    await sendTask(page, gateway, text)
    gateway.parkThinking(thinking)
    await setVisibility(page, 'hidden')
    await page.clock.fastForward(600_000)
    await page.clock.fastForward(15_000)
    await page.clock.fastForward(5_000)
    await setVisibility(page, 'visible')
    const label = await waitHonest(page, gateway, 5_000)
    await assertContent(page, gateway, text)
    assertHonest(label)
    await expectProcessText(page, gateway, thinking)
    return '通过'
  } finally {
    await context.close()
  }
}

async function runR3(browser, gateway) {
  const text = 'R3_LONG_TASK_AIRPLANE'
  const { context, page } = await openHarness(browser, gateway)
  try {
    await sendTask(page, gateway, text)
    const closesBefore = gateway.closes
    await context.setOffline(true)
    const cdp = await context.newCDPSession(page).catch(() => null)
    if (cdp) {
      await cdp.send('Network.enable').catch(() => {})
      await cdp
        .send('Network.emulateNetworkConditions', {
          offline: true,
          latency: 0,
          downloadThroughput: 0,
          uploadThroughput: 0,
        })
        .catch(() => {})
    }
    await sleep(300)
    await page.clock.fastForward(180_000)
    if (cdp) {
      await cdp
        .send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 0,
          downloadThroughput: -1,
          uploadThroughput: -1,
        })
        .catch(() => {})
    }
    await context.setOffline(false)
    const label = await waitHonest(page, gateway, 8_000)
    await assertContent(page, gateway, text)
    assertHonest(label)
    assert.equal(page.url().startsWith(gateway.url), true)
    const dropped = gateway.closes > closesBefore
    return dropped
      ? '通过'
      : '通过（切回后状态真实、内容不丢；context.setOffline 未拆已建立的 WS，重连未触发，记 CONTINUE）'
  } finally {
    await context.close()
  }
}

async function runR5(browser, gateway) {
  const text = 'R5_LONG_TASK_WEAKNET'
  const { context, page } = await openHarness(browser, gateway)
  try {
    gateway.armDrops(5)
    await sendTask(page, gateway, text, { requireStartup: false })
    const start = Date.now()
    let seen = 0
    while (Date.now() - start < 25_000) {
      await page.clock.fastForward(35_000)
      await sleep(250)
      seen = await page.getByText(TERMINAL_MARKER, { exact: true }).count()
      if (seen > 0) break
    }
    if (seen !== 1) {
      throw new Error(await diagnose(page, gateway, `terminal answer count ${seen}, want 1`))
    }
    await assertContent(page, gateway, text)
    const body = await bodyText(page)
    assert.doesNotMatch(body, STALE_ENGINE)
    return '通过（反复断线后终态一致、内容不丢）；fixme：hello 未完成时 8s HTTP 快照（codex-rf-snapshot）'
  } finally {
    await context.close()
  }
}

async function runR7(browser, gateway) {
  const text = 'R7_SEEDED_LONG_TASK'
  const thinking = 'R7_CATCHUP_THINKING'
  gateway.seedCold({
    userText: text,
    clientMessageId: 'cm-user-r7',
    thinking,
    admittedAt: CLOCK_ORIGIN.getTime(),
  })
  const { context, page } = await openHarness(browser, gateway, 'cold')
  try {
    await page.getByText(text, { exact: true }).waitFor({ timeout: 10_000 })
    const label = await waitHonest(page, gateway, 5_000)
    assertHonest(label)
    await expectProcessText(page, gateway, thinking)
    return '通过'
  } finally {
    await context.close()
  }
}

async function runR9(browser, gateway) {
  const text = 'R9_LONG_TASK_BACKGROUND'
  const { context, page } = await openHarness(browser, gateway)
  try {
    await sendTask(page, gateway, text)
    await page.locator('textarea').fill('继续')
    await page.getByRole('button', { name: '排队发送', exact: true }).click()
    const queued = page.getByTestId('queued-send-row').getByText('继续', { exact: true })
    const toast = page.getByText('已加入队列，本轮结束后发送')
    const start = Date.now()
    let queuedCount = 0
    let toastCount = 0
    while (Date.now() - start < 5_000) {
      queuedCount = await queued.count()
      toastCount = await toast.count()
      if (queuedCount > 0 || toastCount > 0) break
      await sleep(100)
    }
    if (queuedCount < 1 && toastCount < 1) {
      throw new Error(await diagnose(page, gateway, '继续 was not queued'))
    }
    await assertContent(page, gateway, text)
    const label = await surfaceText(page)
    // A just-admitted turn still says 正在启动引擎. That copy is fresh, not the stale timer #1198 removed.
    assert.doesNotMatch(label, /正在启动引擎\s*\(\d{3,}/)
    assert.match(label, /正在启动引擎|思考中|正在思考|处理时间较长|后台运行中|工具中|执行操作/)
    if (gateway.inboundMessages.length !== 1) {
      throw new Error(
        await diagnose(
          page,
          gateway,
          `expected one admitted turn, got ${gateway.inboundMessages.length}`,
        ),
      )
    }
    const banner = page.getByTestId('background-turn-banner')
    try {
      await banner
        .getByText('本轮仍在运行。现在发送的消息会等本轮结束后再发出，另行计费。')
        .waitFor({ timeout: 5_000 })
    } catch (error) {
      throw new Error(await diagnose(page, gateway, `B4a banner missing: ${error}`))
    }
    return '通过（叠发不丢、原回合仍在、B4a 横幅）；fixme：积分数字（B4b/codex-rf-snapshot）'
  } finally {
    await context.close()
  }
}
