import assert from 'node:assert/strict'
import { unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')

const here = (name) => fileURLToPath(new URL(name, import.meta.url))

/**
 * The commercial billing modules pulled in by ModelSwitchCostService that have
 * no role in this scenario (engine multipliers, balance read, fast tier, cursor
 * surcharge). Everything that decides the quote — the reader, the exempt rule,
 * the grant signing — stays real.
 */
const backendStubs = {
  'agent-multiplier': here('./stubs/commercial-agent-multiplier.js'),
  precheck: here('./stubs/commercial-precheck.js'),
  'fast-tier': here('./stubs/commercial-fast-tier.js'),
  'cursor-settle': here('./stubs/commercial-cursor-settle.js'),
}

const stubBackendDeps = {
  name: 'stub-commercial-billing-deps',
  setup(build) {
    if (process.env.OC_MODEL_SWITCH_READER_UNDER_TEST)
      build.onResolve({ filter: /modelSwitchCostContextReader\.js$/ }, () => ({ path: process.env.OC_MODEL_SWITCH_READER_UNDER_TEST }))
    build.onResolve({ filter: /\/agentMultiplier\.js$/ }, () => ({ path: backendStubs['agent-multiplier'] }))
    build.onResolve({ filter: /\/preCheck\.js$/ }, () => ({ path: backendStubs.precheck }))
    build.onResolve({ filter: /\/fastServiceTier\.js$/ }, () => ({ path: backendStubs['fast-tier'] }))
    build.onResolve({ filter: /\/cursorExternalSettle\.js$/ }, () => ({
      path: backendStubs['cursor-settle'],
    }))
  },
}

async function buildBackend() {
  const outfile = path.join(tmpdir(), `ocv5-742-quote-backend-${process.pid}.mjs`)
  await build({
    entryPoints: [here('./model-switch-cost-continue-backend.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [stubBackendDeps],
    alias: {
      '@openclaude/protocol': here('../../protocol/src/index.ts'),
    },
    logLevel: 'silent',
  })
  const module = await import(pathToFileURL(outfile).href)
  return { module, outfile }
}

test(
  'a zero-token crashed first turn continues on the same model without a cost dialog',
  { timeout: 90000 },
  async () => {
    const { module: backend, outfile } = await buildBackend()
    const bundle = await build({
      entryPoints: [here('./model-switch-cost-continue-harness.tsx')],
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      loader: { '.css': 'empty' },
      alias: {
        'node:crypto': here('./stubs/node-crypto.js'),
        '@openclaude/protocol/browser': here('../../protocol/src/browser.ts'),
        '@openclaude/protocol/teamCards': here('../../protocol/src/teamCards.ts'),
        '@openclaude/protocol': here('../../protocol/src/index.ts'),
      },
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.MODE': '"production"' },
    })
    const service = backend.createQuoteService()
    const server = createServer(async (req, res) => {
      if (req.url === '/bundle.js') {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        res.end(bundle.outputFiles[0].text)
        return
      }
      if (req.url === '/quote' && req.method === 'POST') {
        let raw = ''
        for await (const chunk of req) raw += chunk
        try {
          const quote = await backend.handleQuote(service, JSON.parse(raw))
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ quote }))
        } catch (error) {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ error: String(error?.message ?? error) }))
        }
        return
      }
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${server.address().port}`
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
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`${origin}/`)
      await page.addScriptTag({ url: `${origin}/bundle.js` })
      const input = page.getByRole('textbox', { name: '消息输入框' })
      const sent = page.getByTestId('sent')

      // Same model as the crashed first attempt: the real backend returns the
      // exempt quote, so the send must pass straight through — no dialog and
      // exactly one dispatch id.
      await page.getByRole('button', { name: '继续', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid=sent]').textContent.length > 0,
      )
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal((await sent.innerText()).split(',').length, 1)
      assert.equal(await input.inputValue(), '')
      const frames = await page.evaluate(() => window.__costContinueFrames)
      assert.equal(frames.length, 1)
      assert.equal(frames[0].model, 'cheap')
      assert.equal(frames[0].displayText, '继续')
      assert.match(frames[0].text, /原任务目标：完成检查/)
      assert.match(frames[0].text, /不要重新执行已经完成的步骤/)

      // A real switch still quotes risk and must ask, then send once after the
      // operator confirms.
      await page.getByRole('button', { name: 'switch model', exact: true }).click()
      await input.fill('switch to the expensive model')
      await input.press('Enter')
      await page.getByRole('dialog').waitFor()
      await page.getByText('无法预估本轮费用', { exact: true }).waitFor()
      await page.getByRole('button', { name: '确认切换', exact: true }).click()
      await page.waitForFunction(
        () => document.querySelector('[data-testid=sent]').textContent.split(',').length === 2,
      )
      assert.equal(await page.getByRole('dialog').count(), 0)
      assert.equal(await page.getByTestId('toast').innerText(), '')
      assert.deepEqual(errors, [])
      await context.close()
    } finally {
      await browser?.close()
      await new Promise((resolve) => server.close(resolve))
      await unlink(outfile).catch(() => {})
    }
  },
)
