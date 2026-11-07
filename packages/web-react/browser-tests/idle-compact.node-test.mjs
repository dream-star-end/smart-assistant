import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')
const here = name => fileURLToPath(new URL(name, import.meta.url))

test('OCV5-747 browser: compacting clears into reply; unsafe recovery has no immediate retry', { timeout: 90000 }, async () => {
  const result = await build({
    entryPoints: [here('./idle-compact-harness.tsx')], bundle: true, write: false,
    format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    alias: { 'node:crypto': here('./stubs/node-crypto.js'),
      '@openclaude/protocol/browser': here('../../protocol/src/browser.ts') },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
    logLevel: 'warning',
  })
  const server = createServer((req, res) => {
    if (req.url === '/bundle.js') {
      res.setHeader('Content-Type', 'text/javascript'); res.end(result.outputFiles[0].text)
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/bundle.js"></script>')
    }
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  let browser
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    page.setDefaultTimeout(10000)
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.goto('http://127.0.0.1:' + server.address().port)
    await page.getByText(/正在压缩上下文/).waitFor()
    await page.getByRole('button', { name: 'finish safe recovery' }).click()
    await page.getByText('正常回复，原上下文保留。').waitFor()
    assert.equal(await page.getByText(/正在压缩上下文/).count(), 0)
    await page.getByRole('button', { name: 'unconfirmed stop' }).click()
    await page.getByText(/约 7 分钟后可继续/).waitFor()
    assert.doesNotMatch(await page.locator('body').innerText(), /请重试|内部错误/)
    assert.equal(await page.getByRole('button', { name: /^(继续|重试)$/ }).count(), 0)
    assert.equal(await page.getByTestId('continued').innerText(), '0')
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise(r => server.close(r))
  }
})
