import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'
import { buildHarnessPage, serveHarnessPage } from './harness-page.mjs'

const { chromium } = createRequire(import.meta.url)('playwright-core')
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../..')
const redRef = process.env.OC_STUDIO_STEP_RED_REF || ''
const ID = '11111111-2222-4333-8444-555555555555'
const PROJECT_PATH = `/api/studio/projects/${ID}`
const PROVIDERS = {
  kinds: [
    { kind: 'image', state: 'unconfigured', providers: [] },
    { kind: 'video', state: 'unconfigured', providers: [] },
    {
      kind: 'voice', state: 'ready', providers: [{
        id: 'minimax-speech', label: 'MiniMax 语音', state: 'ready',
        models: [{
          id: 'minimax-voice-design', label: 'MiniMax 音色设计',
          ops: ['voice.design', 'voice.clone'], isDefault: true,
        }],
      }],
    },
    { kind: 'music', state: 'unconfigured', providers: [] },
  ],
}

function view(stage) {
  return {
    project: {
      id: ID, title: '冬日来客', brief: '拍一条 30 秒的冬日红狐短片',
      status: stage === 'brief' ? 'planning' : stage === 'final' ? 'composing' : 'running',
      autonomy: 'max', aspect: '16:9', fps: 24, targetSec: 30,
      budgetCredits: '2000', spentCredits: '0', reservedCredits: '0', settings: {}, rev: 1,
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    },
    shots: stage === 'brief' ? [] : [{
      id: 's0', ordinal: 0, spec: { title: '晨雾', durationSec: 5 },
      status: stage === 'board' ? 'planned' : 'ready', activeTakeId: null,
    }],
    lines: stage === 'voice' || stage === 'final' ? [{
      id: 'l0', shotId: 's0', ordinal: 0, speakerAssetId: null,
      text: '清晨的森林醒来了', emotion: null, speed: null,
      status: stage === 'voice' ? 'generating' : 'ready',
      activeTakeId: stage === 'voice' ? null : 't-line',
    }] : [],
    assets: [], takes: [], events: [],
  }
}

function currentStep(page, label) {
  return page.locator('.st-steps a[data-step="now"]').filter({ hasText: label })
}

test('#1260: real StudioApp preserves form drafts while progress remains live', { timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-studio-step-follow-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  let swapped = 0
  const plugins = redRef ? [{
    name: 'studio-step-follow-from-ref',
    setup(build) {
      build.onLoad({ filter: /[\\/]studio[\\/]ProjectShell\.tsx$/ }, ({ path }) => {
        const rel = 'packages/web-react/src/components/studio/ProjectShell.tsx'
        assert.equal(resolve(path), resolve(repoRoot, rel))
        swapped += 1
        return {
          contents: execFileSync('git', ['show', `${redRef}:${rel}`], {
            cwd: repoRoot, encoding: 'utf8',
          }),
          loader: 'tsx', resolveDir: dirname(path),
        }
      })
    },
  }] : []
  await buildHarnessPage({ harness: 'studio-step-follow-harness.tsx', assetDir: dir, plugins })
  assert.equal(swapped, redRef ? 1 : 0, 'the negative control replaces exactly the original shell')
  appendFileSync(join(dir, 'styles.css'), `\n${readFileSync(
    new URL('../src/components/studio/studio.css', import.meta.url), 'utf8',
  )}`)
  const server = await serveHarnessPage(dir)
  t.after(() => server.close())
  const browser = await chromium.launch({
    executablePath: resolveBrowserExecutable(), headless: true, args: ['--no-sandbox'],
  })
  t.after(() => browser.close())
  const origin = new URL(server.url).origin

  async function scenario(stage, firstPage, run) {
    let aggregate = view(stage)
    const writes = []
    const unexpectedApi = []
    const errors = []
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block',
    })
    try {
      const page = await context.newPage()
      page.setDefaultTimeout(10000)
      page.on('pageerror', (e) => errors.push(e.message))
      await context.route('**/*', async (route) => {
        const request = route.request()
        const url = new URL(request.url())
        // A fixture must never escape to a real service or perform a paid write.
        if (url.origin !== origin) return route.abort('blockedbyclient')
        if (request.method() !== 'GET') {
          writes.push(`${request.method()} ${url.pathname}`)
          return route.abort('blockedbyclient')
        }
        let body
        if (url.pathname === '/api/studio/providers') body = PROVIDERS
        else if (url.pathname === PROJECT_PATH) body = aggregate
        else if (url.pathname === '/api/public/models') body = {
          models: [{ id: 'grok-build', display_name: 'grok-build', engine: 'grok', degraded: false }],
        }
        if (body) return route.fulfill({
          status: 200, contentType: 'application/json', body: JSON.stringify(body),
        })
        if (url.pathname.startsWith('/api/')) {
          unexpectedApi.push(url.pathname)
          return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":{"code":"NOT_FOUND"}}' })
        }
        return route.continue()
      })
      await page.goto(`${server.url}?page=${firstPage}`)
      await currentStep(page, stage === 'voice' ? '配音' : '需求').waitFor()
      const advance = async (next) => {
        aggregate = view(next)
        await page.evaluate(() => window.studioStepFollow.push())
        await currentStep(page, next === 'board' ? '镜头' : next === 'voice' ? '配音' : '成片').waitFor()
        // Observe after painting the aggregate so ProjectShell's passive navigation effect
        // has run; a stale pre-effect URL must not make a broken build look green.
        await page.evaluate(() => new Promise((done) => {
          requestAnimationFrame(() => requestAnimationFrame(done))
        }))
      }
      await run(page, advance)
      assert.deepEqual(writes, [], 'no autosave, generation or paid API write')
      assert.deepEqual(unexpectedApi, [], 'all product API traffic is fixture-scoped')
      assert.deepEqual(errors, [], 'no Chromium pageerror')
    } finally {
      await context.close()
    }
  }

  await t.test('budget: unsaved input survives planning completion', async () => {
    await scenario('brief', 'brief', async (page, advance) => {
      await page.getByLabel('调整上限').fill('4300')
      await advance('board')
      assert.equal(new URL(page.url()).pathname, `/studio/p/${ID}/brief`)
      assert.equal(await page.getByLabel('调整上限').inputValue(), '4300')
    })
  })

  await t.test('voice: native design dialog and draft survive narration completion', async () => {
    await scenario('voice', 'voice', async (page, advance) => {
      await page.getByRole('button', { name: '一句话设计', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '一句话设计音色' })
      await dialog.waitFor()
      assert.equal(await dialog.evaluate((el) => el.matches(':modal')), true,
        'this exercises real Chromium showModal, not the jsdom open fallback')
      await dialog.getByLabel('声音描述').fill('沉稳温暖的纪录片旁白')
      await advance('final')
      assert.equal(new URL(page.url()).pathname, `/studio/p/${ID}/voice`)
      assert.equal(await dialog.isVisible(), true)
      assert.equal(await dialog.getByLabel('声音描述').inputValue(), '沉稳温暖的纪录片旁白')
    })
  })

  await t.test('no edit: completed planning still follows to the shot board', async () => {
    await scenario('brief', 'brief', async (page, advance) => {
      await page.getByLabel('调整上限').waitFor()
      await advance('board')
      await page.getByRole('heading', { name: '镜头', exact: true }).waitFor()
      assert.equal(new URL(page.url()).pathname, `/studio/p/${ID}`)
    })
  })
})
