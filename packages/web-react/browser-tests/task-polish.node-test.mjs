import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'
const require = createRequire(import.meta.url)
const { build } = require('esbuild')
const { chromium } = require('playwright-core')
const web = fileURLToPath(new URL('../', import.meta.url))
const baseline = process.env.OC_TASK_POLISH_RED_BASE
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('./task-polish-harness.tsx', import.meta.url))], bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
  alias: { '@openclaude/protocol/containerPreview': fileURLToPath(new URL('../../protocol/src/containerPreview.ts', import.meta.url)), '@openclaude/protocol/browser': fileURLToPath(new URL('../../protocol/src/browser.ts', import.meta.url)), '@openclaude/protocol': fileURLToPath(new URL('../../protocol/src/index.ts', import.meta.url)), 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)) },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  plugins: baseline ? [{ name: 'original-task-components', setup(build) {
    build.onLoad({ filter: /\/src\/components\/(sidebar\/VirtualList|taskboard\/(TicketListView|TicketDrawer))\.tsx$/ }, (args) => ({
      contents: execFileSync('git', ['show', `${baseline}:packages/web-react/${relative(web, args.path)}`], { cwd: web, encoding: 'utf8' }), loader: 'tsx', resolveDir: dirname(args.path),
    }))
  } }] : [],
})
test('task polish user flows (real Chromium, isolated)', { timeout: 240_000 }, async (t) => {
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px sans-serif}.virtual-fixture{height:200px;width:240px;overflow-y:auto}[role=dialog]{position:fixed;inset:0;background:white;display:flex;flex-direction:column;overflow:auto}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden}button{min-height:36px}details:not([open])>:not(summary){display:none}</style><div id="root"></div>') })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] })
  try {
    for (const width of [1440, 390]) {
      async function pageFor(query) {
        const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768 })
        const page = await context.newPage(); page.setDefaultTimeout(8000)
        const errors = []; page.on('pageerror', (e) => errors.push(e.message))
        await page.goto(`http://127.0.0.1:${server.address().port}/?${query}`)
        await page.addScriptTag({ content: bundle.outputFiles[0].text })
        return { context, page, errors }
      }
      await t.test(`${width}: all 1000 loaded tickets remain accessible with bounded pages`, async () => {
        const { context, page, errors } = await pageFor('scenario=list')
        try {
          await page.getByTestId('ticket-card').first().waitFor()
          assert.equal(await page.getByTestId('ticket-card').count(), 50)
          await page.getByTestId('ticket-list-page-next').click()
          await page.getByRole('button', { name: '任务 51', exact: true }).click()
          assert.equal(await page.getByTestId('opened').textContent(), 'FIX-51')
          for (let i = 1; i < 19; i += 1) await page.getByTestId('ticket-list-page-next').click()
          await page.getByRole('button', { name: '任务 1000', exact: true }).click()
          assert.equal(await page.getByTestId('opened').textContent(), 'FIX-1000')
          assert.equal(await page.getByTestId('ticket-list-page-next').isDisabled(), true)
          await page.evaluate(() => window.update())
          assert.match(await page.getByTestId('ticket-list-page-range').textContent(), /951–1000/)
          await page.evaluate(() => window.filter())
          await page.getByRole('button', { name: '任务 1', exact: true }).waitFor()
          assert.match(await page.getByTestId('ticket-list-page-range').textContent(), /1–50/)
          await page.evaluate(() => window.unfilter())
          assert.match(await page.getByTestId('ticket-list-page-range').textContent(), /1–50/)
          await page.getByTestId('ticket-list-page-next').click()
          await page.evaluate(() => window.shrink())
          assert.equal(await page.getByTestId('ticket-card').count(), 7)
          await page.evaluate(() => window.grow())
          await page.getByRole('button', { name: '任务 1', exact: true }).waitFor()
          assert.match(await page.getByTestId('ticket-list-page-range').textContent(), /1–50/)
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: hidden sidebar stays bounded and recovers on reveal`, async () => {
        const { context, page, errors } = await pageFor('scenario=hidden')
        try {
          await page.locator('[data-flat-kind]').first().waitFor({ state: 'attached' })
          assert.ok(await page.locator('[data-flat-kind]').count() < 100)
          await page.evaluate(() => window.reveal())
          await page.locator('[data-sidebar-list]').waitFor()
          await page.locator('[data-sidebar-list]').evaluate((el) => { el.scrollTop = el.scrollHeight })
          await page.getByText('item-999', { exact: true }).waitFor()
          assert.ok(await page.locator('[data-flat-kind]').count() < 100)
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: backlog cannot start through an invalid patrol action`, async () => {
        const { context, page, errors } = await pageFor('scenario=drawer&status=backlog')
        try {
          await page.getByTestId('ticket-drawer').waitFor()
          assert.equal(await page.getByTestId('ticket-drawer-patrol').count(), 0)
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: stop, paid result and retry fence a delayed old stop receipt`, async () => {
        const { context, page, errors } = await pageFor('scenario=execution')
        try {
          await page.getByText('执行模型：actual-r1', { exact: true }).waitFor()
          await page.getByText('真实执行进度 r1', { exact: true }).waitFor()
          await page.getByTestId('ticket-drawer-stop').click()
          await page.waitForFunction(() => window.isStopHeld())
          assert.equal(await page.getByTestId('ticket-drawer-stop').isDisabled(), true)
          await page.evaluate(() => window.reapExecution())
          await page.getByTestId('ticket-run-settling').waitFor()
          assert.equal(await page.getByTestId('ticket-drawer-retry').count(), 0)
          await page.evaluate(() => window.completeExecution())
          await page.getByTestId('ticket-drawer-retry').waitFor()
          assert.equal(await page.getByTestId('ticket-drawer-stop').count(), 0)
          await page.getByText('完整付费结果 FIRST_PAID_OUTPUT_END', { exact: true }).waitFor()
          await page.getByTestId('ticket-drawer-retry').click()
          await page.getByText('执行模型：actual-r2', { exact: true }).waitFor()
          await page.getByTestId('ticket-drawer-stop').waitFor()
          assert.equal(await page.getByTestId('ticket-drawer-stop').isDisabled(), false)
          await page.evaluate(() => window.releaseStop())
          await page.waitForTimeout(100)
          assert.equal(await page.getByTestId('ticket-drawer-stop').isDisabled(), false)
          assert.deepEqual(await page.evaluate(() => window.executionStats()), { runId: 'r2', readyVersions: [2], patrolVersions: [3] })
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: slow timeline cannot regress a known same-version terminal execution`, async () => {
        const { context, page, errors } = await pageFor('scenario=execution')
        try {
          await page.getByTestId('ticket-drawer-stop').waitFor()
          await page.evaluate(() => { window.immediateStop(); window.holdTimeline() })
          await page.getByTestId('ticket-drawer-stop').click()
          await page.waitForFunction(() => window.isTimelineHeld())
          await page.evaluate(() => window.completeExecution())
          await page.getByTestId('ticket-drawer-retry').waitFor()
          await page.evaluate(() => window.releaseTimeline())
          await page.waitForTimeout(100)
          assert.equal(await page.getByTestId('ticket-drawer-stop').count(), 0)
          assert.equal(await page.getByTestId('ticket-drawer-retry').isDisabled(), false)
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: switching ticket fences a held retry approval before patrol`, async () => {
        const { context, page, errors } = await pageFor('scenario=execution')
        try {
          await page.getByTestId('ticket-drawer-stop').waitFor()
          await page.evaluate(() => window.immediateStop())
          await page.getByTestId('ticket-drawer-stop').click()
          await page.evaluate(() => window.completeExecution())
          await page.getByTestId('ticket-drawer-retry').waitFor()
          await page.evaluate(() => window.holdReady())
          await page.getByTestId('ticket-drawer-retry').click()
          await page.waitForFunction(() => window.isReadyHeld())
          await page.evaluate(() => window.switchExecutionOwner())
          await page.getByText('执行模型：actual-other', { exact: true }).waitFor()
          await page.getByTestId('ticket-drawer-edit').click()
          await page.getByRole('textbox', { name: '单据标题', exact: true }).fill('新票草稿')
          await page.evaluate(() => window.releaseReady())
          await page.waitForTimeout(100)
          assert.deepEqual((await page.evaluate(() => window.executionStats())).patrolVersions, [])
          assert.equal(await page.getByRole('textbox', { name: '单据标题', exact: true }).inputValue(), '新票草稿')
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
      await t.test(`${width}: completion refresh keeps drafts and fences old owner replies`, async () => {
        const { context, page, errors } = await pageFor('scenario=drawer')
        try {
          await page.getByTestId('ticket-drawer-edit').click()
          await page.getByRole('textbox', { name: '单据标题', exact: true }).fill('尚未保存的草稿')
          await page.evaluate(() => window.finish())
          await page.waitForFunction(() => document.querySelector('[data-testid=client-status]')?.textContent === 'waiting_human', { timeout: 8000 })
          assert.equal(await page.getByRole('textbox', { name: '单据标题', exact: true }).inputValue(), '尚未保存的草稿')
          assert.equal(await page.getByTestId('writes').textContent(), '0')
          await page.getByRole('button', { name: '放弃修改', exact: true }).click()
          await page.getByText(/调研单 · P2 · 待确认/).waitFor()
          await page.evaluate(() => window.delayPoll())
          await page.waitForFunction(() => window.isHeld())
          await page.getByTestId('ticket-drawer-edit').click()
          await page.getByRole('textbox', { name: '单据标题', exact: true }).fill('保存后的新版本')
          await page.getByRole('button', { name: '保存', exact: true }).click()
          await page.getByRole('heading', { name: '保存后的新版本', exact: true }).waitFor()
          await page.evaluate(() => window.releasePoll())
          await page.waitForTimeout(100)
          await page.getByRole('heading', { name: '保存后的新版本', exact: true }).waitFor()
          assert.equal((await page.evaluate(() => window.stats())).maxActive, 1)
          await page.getByTestId('ticket-drawer-edit').click()
          await page.getByRole('textbox', { name: '单据标题', exact: true }).fill('发生冲突的旧草稿')
          await page.evaluate(() => window.externalEdit())
          await page.waitForFunction(() => document.querySelector('[data-testid=client-version]')?.textContent === '4')
          await page.getByTestId('ticket-drawer-save').click()
          await page.getByText('单据已被其他人更新，已刷新最新内容', { exact: true }).waitFor()
          assert.equal((await page.evaluate(() => window.stats())).patchVersion, 3)
          assert.equal((await page.evaluate(() => window.stats())).body, '另一客户端保存的最新正文')
          assert.equal(await page.getByRole('textbox', { name: '单据标题', exact: true }).inputValue(), '发生冲突的旧草稿')
          await page.getByRole('button', { name: '放弃修改', exact: true }).click()
          await page.evaluate(() => window.delayPoll())
          await page.waitForFunction(() => window.isHeld())
          await page.evaluate(() => window.switchOwner())
          await page.getByTestId('ticket-drawer-edit').click()
          await page.getByRole('textbox', { name: '单据标题', exact: true }).fill('另一任务的草稿')
          await page.evaluate(() => window.releasePoll())
          await page.waitForTimeout(100)
          assert.equal(await page.getByRole('textbox', { name: '单据标题', exact: true }).inputValue(), '另一任务的草稿')
          assert.deepEqual(errors, [])
        } finally { await context.close() }
      })
    }
  } finally { await browser.close(); await new Promise((resolve) => server.close(resolve)) }
})
