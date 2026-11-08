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

test('Knowledge Planet setup distinguishes QR failure from capacity, stops polling and retries cleanly', { timeout: 90000 }, async () => {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./knowledge-planet-setup-harness.tsx', import.meta.url))],
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    alias: { 'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
      '@openclaude/protocol/browser': fileURLToPath(new URL('../../protocol/src/browser.ts', import.meta.url)),
      '@openclaude/protocol': fileURLToPath(new URL('../../protocol/src/index.ts', import.meta.url)) },
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
  })
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html; charset=utf-8')
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  let browser
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] })
    for (const mode of ['failure', 'timeout', 'capacity', 'late-qr', 'pending']) {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
      page.setDefaultTimeout(7000)
      const errors = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`)
      await page.getByRole('button', { name: '同意并生成二维码' }).click()
      if (mode === 'pending') {
        await page.getByRole('button', { name: '取消', exact: true }).click()
        await page.getByText('已关闭', { exact: true }).waitFor()
        await page.evaluate(() => window.kpFixture.finishStart())
        await page.waitForFunction(() => window.kpFixture.cancels === 1)
        assert.equal(await page.evaluate(() => window.kpFixture.polls), 0)
      } else {
        const text = mode === 'capacity' ? '知识星球扫码名额已满，请稍后再试。'
          : mode === 'timeout' ? '知识星球二维码生成超时，请重新授权；若仍失败，请稍后再试。'
          : '知识星球二维码生成失败，请重新授权；若仍失败，请稍后再试。'
        await page.getByText(text, { exact: true }).waitFor()
        const polls = await page.evaluate(() => window.kpFixture.polls)
        if (mode === 'late-qr') await page.evaluate(() => window.kpFixture.finishQr())
        await page.waitForTimeout(1900)
        assert.equal(await page.evaluate(() => window.kpFixture.polls), polls)
        assert.equal(await page.getByAltText('知识星球微信登录二维码').count(), 0)
        assert.equal(await page.evaluate(() => window.kpFixture.qrLoads), mode === 'late-qr' ? 1 : 0)
        if (mode !== 'capacity') await page.getByRole('button', { name: '重新授权' }).click()
        await page.getByRole('button', { name: '同意并生成二维码' }).click()
        await page.getByText('授权成功，Agent 现在可以直接读取知识星球内容；写入能力保持关闭，需你另行开启。', { exact: true }).waitFor()
        assert.equal(await page.evaluate(() => window.kpFixture.bound), 1)
      }
      assert.deepEqual(errors, [])
      await page.close()
    }
  } finally {
    await browser?.close()
    await new Promise((resolve) => server.close(resolve))
  }
})
