// OCV5-482 / INC-20261017-INLINE-UI-FENCE: official DeepSeek glued the input-prediction ```ui block to the
// answer line ("2```ui{...}"). Real Chromium renders the production MarkdownImpl on that exact answer: the user
// must see only "2". OC_INLINE_UI_FENCE_RED=1 bundles the renderer with normalizeInlineUiFences disabled
// (product bytes untouched) and the same page must then show the raw block — the test is sensitive to the fix.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

if (!process.env.OC_E2E_BROWSER) {
  const cached = '/usr/local/share/ms-playwright/chromium-1226/chrome-linux64/chrome'
  if (existsSync(cached)) process.env.OC_E2E_BROWSER = cached
}

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')
const fencePath = fileURLToPath(new URL('../src/lib/uiFence.ts', import.meta.url))
const RED = process.env.OC_INLINE_UI_FENCE_RED === '1'
const CASES = {
  // 2026-10-17 commercial release gate, deepseek-v4-flash on the official DeepSeek API.
  gate: '2```ui{"type":"next","text":"2+2等于几?"}\n```',
  closerGlued: '好的,已经改好了。```ui {"type":"next","text":"再加一个测试"}```',
}

test('an inline ```ui next block never reaches the screen', { timeout: 120_000 }, async () => {
  const source = await readFile(fencePath, 'utf8')
  let disabled = 0
  const bundle = await build({
    entryPoints: [
      fileURLToPath(new URL('./ocv5-482-inline-ui-fence-harness.tsx', import.meta.url)),
    ],
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    loader: {
      '.css': 'empty',
      '.svg': 'dataurl',
      '.png': 'dataurl',
      '.jpg': 'dataurl',
      '.webp': 'dataurl',
    },
    alias: {
      'node:crypto': fileURLToPath(new URL('./stubs/node-crypto.js', import.meta.url)),
    },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{"MODE":"production","PROD":true,"DEV":false}',
    },
    plugins: RED
      ? [
          {
            name: 'ocv5-482-normalizer-disabled',
            setup(api) {
              api.onLoad({ filter: /[\\/]lib[\\/]uiFence\.ts$/ }, async ({ path }) => {
                assert.equal(path, fencePath, 'negative control targets the real normalizer only')
                disabled += 1
                return {
                  contents:
                    'export function normalizeInlineUiFences(text: string): string { return text; }\n',
                  loader: 'ts',
                }
              })
            },
          },
        ]
      : [],
    logLevel: 'error',
  })
  assert.equal(disabled, RED ? 1 : 0)
  assert.equal(await readFile(fencePath, 'utf8'), source, 'product bytes untouched')
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end('<!doctype html><meta charset="utf-8"><div id="root"></div>')
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  let browser
  try {
    browser = await chromium.launch({
      executablePath: resolveBrowserExecutable(),
      headless: true,
      args: ['--no-sandbox'],
    })
    const page = await (
      await browser.newContext({ viewport: { width: 1000, height: 800 } })
    ).newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.addInitScript((cases) => {
      window.__CASES__ = cases
    }, CASES)
    await page.goto(`http://127.0.0.1:${server.address().port}/`)
    await page.addScriptTag({ content: bundle.outputFiles[0].text })
    await page.waitForSelector('[data-case="closerGlued"]')
    await page.waitForTimeout(500)
    const seen = {}
    for (const id of Object.keys(CASES)) {
      seen[id] = (await page.locator(`[data-case="${id}"]`).innerText()).trim()
    }
    console.log(
      `ocv5-482-rendered ${JSON.stringify({ mode: RED ? 'normalizer-disabled' : 'current', seen })}`,
    )
    assert.deepEqual(errors, [])
    if (RED) {
      assert.match(
        seen.gate,
        /"type":"next"/,
        'negative control must reproduce the visible raw block',
      )
      return
    }
    assert.equal(seen.gate, '2')
    assert.equal(seen.closerGlued, '好的,已经改好了。')
    for (const text of Object.values(seen)) assert.doesNotMatch(text, /```|"type"|\bui\{/)
  } finally {
    await browser?.close()
    server.close()
  }
})
