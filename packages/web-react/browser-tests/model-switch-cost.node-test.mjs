import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')
const prefix = 'oc_v5_composer_draft:'

test(
  'model switch confirmation reuses one dialog and preserves cancelled drafts',
  { timeout: 90000 },
  async () => {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('./model-switch-cost-harness.tsx', import.meta.url))],
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      alias: {
        'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
        '@openclaude/protocol/browser': fileURLToPath(
          new URL('../../protocol/src/browser.ts', import.meta.url),
        ),
        '@openclaude/protocol': fileURLToPath(
          new URL('../../protocol/src/index.ts', import.meta.url),
        ),
      },
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
    })
    const server = createServer((req, res) => {
      // Serve the same bundle bytes through the existing HTTP fixture. Repeating
      // the large inline payload over CDP for every context/reload wastes the
      // suite budget when the real-browser files execute concurrently.
      if (req.url === '/fixture-bundle.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.end(bundle.outputFiles[0].text)
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    let browser
    try {
      browser = await chromium.launch({
        executablePath: resolveBrowserExecutable(),
        headless: true,
        args: ['--no-sandbox'],
      })
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
      const page = await context.newPage()
      page.setDefaultTimeout(7000)
      const errors = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.goto(`http://127.0.0.1:${server.address().port}`)
      await page.addScriptTag({
        url: `http://127.0.0.1:${server.address().port}/fixture-bundle.js`,
      })
      const input = page.getByRole('textbox', { name: '消息输入框' })
      await input.fill('keep this draft')
      await page.locator('input[type=file]').setInputFiles({
        name: 'fixture.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('cost fixture'),
      })
      await page.getByText('fixture.txt', { exact: true }).waitFor()
      await page.getByRole('button', { name: 'quote message', exact: true }).click()
      await page.getByRole('button', { name: 'select expensive', exact: true }).click()
      await page.getByText('切换后首次会话将重建全部上下文，价格较高', { exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog').count(), 1)
      assert.match(await page.getByRole('dialog').innerText(), /128 积分/)
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await page.getByTestId('model').innerText(), 'gpt-6-luna')
      assert.equal(await input.inputValue(), 'keep this draft')
      // Send cancellation preserves the real Composer draft and reply.
      await input.press('Enter')
      await page.getByRole('dialog').waitFor()
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await input.inputValue(), 'keep this draft')
      assert.equal(await page.getByTestId('sent').innerText(), '')
      assert.equal(await page.getByText('fixture.txt', { exact: true }).count(), 1)
      assert.equal(await page.getByText('quoted message', { exact: true }).count(), 1)
      await page.getByRole('button', { name: 'low balance fixture', exact: true }).click()
      await page.getByRole('button', { name: 'select expensive', exact: true }).click()
      await page.getByText('余额不足，请充值后重试或取消切换。', { exact: true }).waitFor()
      assert.equal(
        await page.getByRole('button', { name: '压缩并切换', exact: true }).isDisabled(),
        true,
      )
      assert.equal(
        await page.getByRole('button', { name: '直接切换', exact: true }).isDisabled(),
        true,
      )
      await page.getByRole('button', { name: '取消', exact: true }).click()
      assert.equal(await input.inputValue(), 'keep this draft')
      await page.getByRole('button', { name: 'risk fixture', exact: true }).click()
      await page.getByRole('button', { name: 'select expensive', exact: true }).click()
      await page.getByText('无法预估本轮费用', { exact: true }).waitFor()
      assert.match(await page.getByRole('dialog').innerText(), /当前可用余额：10,000/)
      assert.match(await page.getByRole('dialog').innerText(), /输入 598/)
      await page.getByRole('button', { name: '直接切换', exact: true }).click()
      await page.getByTestId('model').filter({ hasText: 'gpt-6-astra' }).waitFor()
      await input.press('Enter')
      await page.waitForFunction(
        () => document.querySelector('[data-testid=sent]').textContent.length > 0,
      )
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await input.inputValue(), '')
      const first = await page.getByTestId('sent').innerText()
      await input.fill('second turn')
      await input.press('Enter')
      await page.getByRole('dialog').waitFor()
      await page.getByRole('button', { name: '确认切换', exact: true }).click()
      await page.waitForFunction(() =>
        document.querySelector('[data-testid=sent]').textContent.includes(','),
      )
      const ids = (await page.getByTestId('sent').innerText()).split(',')
      assert.equal(ids.length, 2)
      assert.notEqual(ids[0], ids[1])
      assert.equal(ids[0], first)
      await page.getByRole('button', { name: 'new session fixture', exact: true }).click()
      await input.fill('new session first message')
      await page
        .locator('input[type=file]')
        .setInputFiles({
          name: 'fixture.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('new file'),
        })
      await page.getByText('fixture.txt', { exact: true }).waitFor()
      await input.press('Enter')
      await page.getByRole('dialog').waitFor()
      await page.getByRole('button', { name: '确认切换', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid=sent]').textContent.split(',').length === 3,
      )
      await page.getByRole('button', { name: 'new session fixture', exact: true }).click()
      assert.equal(await input.inputValue(), '')
      assert.equal(await page.getByText('fixture.txt', { exact: true }).count(), 0)
      assert.deepEqual(errors, [])
      await context.close()
    } finally {
      await browser?.close()
      await new Promise((resolve) => server.close(resolve))
    }
  },
)
