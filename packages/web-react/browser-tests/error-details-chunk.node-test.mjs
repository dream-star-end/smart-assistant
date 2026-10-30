import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const { build } = createRequire(import.meta.url)('esbuild')
const { chromium } = createRequire(import.meta.url)('playwright-core')
const here = dirname(fileURLToPath(import.meta.url))
const red = process.env.OC_TECH_DETAILS_RED === '1'

test('error panels retain their actions and technical details when the optional notice chunk fails', { timeout: 60000 }, async () => {
  let rewrites = 0
  const bundle = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
      import { ErrorBanner } from './src/components/ErrorBanner';
      import { AgentGate } from './src/components/AgentGate';
      window.retries = 0;
      const retry = () => { window.retries++; };
      createRoot(document.getElementById('root')).render(<>
        <section id='send'><ErrorBanner error={{message:'synthetic send failure',requestId:'send-trace',retryText:'kept'}} onRetry={retry} onDismiss={()=>{}} /></section>
        <section id='agent'><AgentGate phase={{kind:'error',message:'synthetic agent failure',requestId:'agent-trace'}} onOpen={()=>{}} onRetry={retry} onTopUp={()=>{}} /></section>
      </>);`, resolveDir: resolve(here, '..'), loader: 'tsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [{ name: 'failed-optional-notice-chunk', setup(b) {
      if (red) b.onLoad({ filter: /\/(?:AgentGate|ErrorBanner)\.tsx$/ }, ({path}) => {
        const source = readFileSync(path, 'utf8')
        assert.ok(source.includes('from "./ErrorTechDetails"'))
        rewrites++
        return { contents: source.replace('from "./ErrorTechDetails"', 'from "./chat/lazyTurnErrorNotice"'), loader: 'tsx' }
      })
      b.onLoad({ filter: /\/lazyTurnErrorNotice\.tsx$/ }, () => ({ loader: 'tsx', contents: `
        import { lazy, Suspense } from 'react';
        const FailedChunk = lazy(() => Promise.reject(new Error('synthetic TurnErrorNotice chunk failure')));
        export function ErrorTechDetails() { return <Suspense fallback={null}><FailedChunk /></Suspense>; }
      ` }))
    }}], logLevel: 'warning',
  })
  assert.equal(rewrites, red ? 2 : 0)
  console.log("DETAILS_FIXTURE_REWRITES", rewrites)
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8')
    res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].text : '<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/fixture.js"></script>')
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  let browser
  try {
    browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'] })
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', error => { errors.push(error.message); console.log('DETAILS_FIXTURE_PAGEERROR', error.message) })
    page.setDefaultTimeout(5000)
    await page.goto(`http://127.0.0.1:${server.address().port}`)
    await page.locator('#send').getByRole('button', { name: '继续', exact: true }).click()
    await page.locator('#agent').getByRole('button', { name: '继续', exact: true }).click()
    await page.locator('#send').getByRole('button', { name: '技术详情', exact: true }).click()
    await page.locator('#agent').getByRole('button', { name: '技术详情', exact: true }).click()
    assert.equal(await page.getByText('追踪号：send-trace', {exact:true}).isVisible(), true)
    assert.equal(await page.getByText('追踪号：agent-trace', {exact:true}).isVisible(), true)
    assert.equal(await page.evaluate(() => window.retries), 2)
    assert.deepEqual(errors, [])
  } finally {
    await browser?.close()
    await new Promise(done => server.close(done))
  }
})
