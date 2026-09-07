import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile, stat, mkdir, writeFile, copyFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { chromium } from 'playwright-core'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'
const root = resolve(process.env.SHOWROOM_DIR || 'dist-showroom')
const out = resolve(process.env.SHOWROOM_SHOTS || 'showroom-shots')
const covers = process.env.SHOWROOM_COVERS ? resolve(process.env.SHOWROOM_COVERS) : null
await mkdir(out, { recursive: true })
if (covers) await mkdir(covers, { recursive: true })
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw Error('not found')
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream')
    res.end(await readFile(path))
  } catch { res.writeHead(404); res.end('Not found') }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const url = 'http://127.0.0.1:' + server.address().port
const browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true })
const checks = []
const layoutFailures = []
const coverRecords = []
try {
  for (const caseId of ['research-bike-demand', 'general-public-data-brief']) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 740 }, deviceScaleFactor: 1 })
    const errors = []; page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(url + '/tutorials/cases/' + caseId + '/showcase/dashboard.html')
    await page.locator('h1').waitFor()
    const coverFile = (covers || out) + '/' + caseId + '.png'
    await page.locator('section.panel').first().screenshot({ path: coverFile })
    const sourcePath = '/tutorials/cases/' + caseId + '/showcase/dashboard.html'
    const sha = (data) => createHash('sha256').update(data).digest('hex')
    coverRecords.push({ caseId, sourcePath, sourceSha256: sha(await readFile(root + sourcePath)), path: '/tutorials/showcase-covers/' + caseId + '.png', sha256: sha(await readFile(coverFile)), selector: 'section.panel:first-of-type', viewport: { width: 1024, height: 740 } })
    if (covers) {
      await mkdir(root + '/tutorials/showcase-covers', { recursive: true })
      await copyFile(coverFile, root + '/tutorials/showcase-covers/' + caseId + '.png')
    }
    if (await page.locator('[data-metric]').count()) await page.locator('[data-metric]').nth(2).click()
    const controls = await page.locator('select').count()
    assert.ok(controls > 0, 'dashboard must have real filtering controls')
    for (const select of await page.locator('select').all()) {
      const options = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value))
      if (options.length > 1) {
        const before = await page.locator('body').innerText()
        const initial = await select.inputValue()
        await select.selectOption(options.find((v) => v !== initial))
        const after = await page.locator('body').innerText()
        assert.notEqual(after, before, 'changing a filter must update visible results')
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) layoutFailures.push(caseId)
    assert.deepEqual(errors, [])
    checks.push({ caseId, controls, responsive: 'PASS', filterChangesResults: 'PASS', errors })
    await page.close()
  }
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 960 }, deviceScaleFactor: 1 })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(url + '/browser-tests/showroom.html')
    await page.getByRole('heading', { name: /你的下一件事/ }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^查看成果：/ }).count(), 2)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.getByRole('button', { name: '快速上手', exact: true }).isVisible(), false)
    await page.screenshot({ path: out + '/gallery-' + width + '.png', fullPage: true })
    await page.getByRole('button', { name: /^查看成果：/ }).first().click()
    await page.getByRole('button', { name: '打开交互看板' }).click()
    const frame = page.frameLocator('iframe')
    await frame.locator('body').waitFor()
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts')
    if (await frame.locator('select').count()) {
      const select = frame.locator('select').first()
      const values = await select.locator('option').evaluateAll((nodes) => nodes.map((n) => n.value))
      if (values.length > 1) await select.selectOption(values[1])
    }
    await page.screenshot({ path: out + '/detail-' + width + '.png', fullPage: true })
    await page.getByRole('button', { name: '做一个我的版本', exact: true }).click()
    await page.getByRole('textbox', { name: '任务草稿' }).waitFor()
    assert.match(await page.getByRole('textbox', { name: '任务草稿' }).inputValue(), /先询问/)
    assert.deepEqual(errors, [])
    checks.push({ viewport: width, gallery: 'PASS', sandbox: 'PASS', editableDraft: 'PASS', errors })
    await page.close()
  }
  assert.deepEqual(layoutFailures, [], 'artifact mobile overflow')
  if (covers) {
    const manifest = JSON.stringify({ capturedAt: new Date().toISOString(), covers: coverRecords }, null, 2)
    await writeFile(covers + '/manifest.json', manifest)
    await writeFile(root + '/tutorials/showcase-covers/manifest.json', manifest)
  }
  await writeFile(out + '/results.json', JSON.stringify({ checkedAt: new Date().toISOString(), checks }, null, 2))
  console.log(JSON.stringify(checks))
} finally { await browser.close(); server.close() }
