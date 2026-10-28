import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')

test('plugin direct connect selects GitHub OAuth, preserves PAT fallback and fences unknown preferences', { timeout: 90000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./plugin-connect-harness.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
      '@openclaude/protocol/browser': fileURLToPath(new URL('../../protocol/src/browser.ts', import.meta.url)),
      '@openclaude/protocol': fileURLToPath(new URL('../../protocol/src/index.ts', import.meta.url)) },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  })
  const server = createServer((req, res) => {
    if (req.url === '/fixture.js') {
      res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
      res.end(bundle.outputFiles[0].text)
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] })
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport })
      page.setDefaultTimeout(7000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      const base = `http://127.0.0.1:${server.address().port}`
      await page.goto(base)
      await page.getByRole('button', { name: '连接「GitHub」', exact: true }).click()
      await page.waitForFunction(() => window.pluginFixture.oauth === 1)
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.evaluate(() => window.pluginFixture.preferenceWrites), 0)
      await page.getByRole('button', { name: '使用 GitHub 访问令牌', exact: true }).click()
      await page.getByRole('dialog').waitFor()
      assert.equal(await page.getByRole('dialog').locator('input[type=password]').count(), 1)
      await page.goto(`${base}/?prefs-fail`)
      await page.getByText('暂时读不到插件启用状态，恢复后才能修改开关。', { exact: true }).waitFor()
      assert.equal(await page.getByRole('switch', { name: '启用「GitHub」', exact: true }).isDisabled(), true)
      assert.equal(await page.getByRole('button', { name: '连接「GitHub」', exact: true }).count(), 0)
      assert.equal(await page.evaluate(() => window.pluginFixture.preferenceWrites), 0)
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
