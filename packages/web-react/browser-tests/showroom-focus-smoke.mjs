import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { build as viteBuild } from 'vite'
import { resolveBrowserExecutable } from '../../../scripts/lib/resolve-browser.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = resolve(here, '..')
const out = resolve(process.env.SHOWROOM_FOCUS_SHOTS || '/home/agent/.openclaude/generated/ocv5-183-r4-focus-shots')
const dist = resolve(process.env.SHOWROOM_DIR || '/home/agent/.openclaude/generated/ocv5-183-r4-dist-showroom')
await mkdir(out, { recursive: true })

if (!process.env.SHOWROOM_DIR) {
  await viteBuild({
    configFile: resolve(here, 'showroom.vite.config.ts'),
    root: webRoot,
    build: { outDir: dist, emptyOutDir: true },
  })
}

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname))
    if (!path.startsWith(dist + sep) || !(await stat(path)).isFile()) throw Error('not found')
    res.setHeader('Content-Type', types[extname(path)] || 'application/octet-stream')
    res.end(await readFile(path))
  } catch { res.writeHead(404); res.end('Not found') }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const port = server.address().port
assert.notEqual(port, 3077, 'must not reuse the old 3077 preview')
const url = 'http://127.0.0.1:' + port
const browser = await chromium.launch({
  executablePath: resolveBrowserExecutable(),
  headless: true,
  args: ['--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'],
})
const checks = []

function focusedName(page) {
  return page.evaluate(() => (document.activeElement?.innerText || document.activeElement?.textContent || '').replace(/\s+/g, ' ').trim())
}

function isEntryVisible(page, name) {
  return page.getByRole('button', { name, exact: true }).evaluate((el) => {
    const box = el.getBoundingClientRect()
    const scroller = el.closest('.tutorial-detail')
    const view = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: innerHeight, left: 0, right: innerWidth }
    return box.width > 0 && box.height > 0 && box.bottom > view.top && box.top < view.bottom && box.right > view.left && box.left < view.right
  })
}

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url + '/browser-tests/showroom.html')
  await page.getByRole('heading', { name: /让它做给你看/ }).waitFor()
  const planet = page.getByRole('button', { name: '探索这颗星球', exact: true })
  const gravity = page.getByRole('button', { name: '开始引力实验', exact: true })
  assert.equal(await planet.evaluate((el) => el === document.activeElement), false, 'first visit must not steal planet focus')
  assert.equal(await gravity.evaluate((el) => el === document.activeElement), false, 'first visit must not steal gravity focus')
  await page.screenshot({ path: out + '/first-visit.png' })

  await planet.focus()
  assert.match(await focusedName(page), /探索这颗星球/)
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: '一句话，造一颗属于你的星球。' }).waitFor()
  await page.getByRole('button', { name: '复制创作指令' }).click()
  await page.getByRole('link', { name: '下载完整源文件' }).focus()
  await page.screenshot({ path: out + '/planet-detail.png' })
  await page.getByRole('button', { name: '返回案例展厅' }).click()
  await planet.waitFor()
  assert.equal(await planet.evaluate((el) => el === document.activeElement), true, 'return from planet must restore planet entry')
  assert.equal(await isEntryVisible(page, '探索这颗星球'), true)
  assert.equal(await page.getByRole('textbox', { name: '任务草稿' }).count(), 0, 'return must not auto-run / auto-send')
  await page.screenshot({ path: out + '/planet-restored.png' })

  await page.keyboard.press('Tab')
  assert.match(await focusedName(page), /开始引力实验/)
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: '把“三体”，变成你能玩的实验。' }).waitFor()
  await page.getByRole('button', { name: '返回案例展厅' }).click()
  await gravity.waitFor()
  assert.equal(await gravity.evaluate((el) => el === document.activeElement), true, 'return from gravity must restore gravity entry')
  assert.equal(await isEntryVisible(page, '开始引力实验'), true)
  await page.screenshot({ path: out + '/gravity-restored.png' })

  await planet.click()
  await page.getByRole('heading', { name: '一句话，造一颗属于你的星球。' }).waitFor()
  await page.getByRole('button', { name: '返回案例展厅' }).click()
  await planet.waitFor()
  assert.equal(await planet.evaluate((el) => el === document.activeElement), true)
  assert.deepEqual(errors, [])
  checks.push({ port, firstVisitNoSteal: true, planetRestore: true, gravityRestore: true, mouseRestore: true, noAutoRun: true })
  await page.close()
  await writeFile(out + '/results.json', JSON.stringify({ checkedAt: new Date().toISOString(), url, checks }, null, 2))
  console.log(JSON.stringify({ url, checks }))
} finally {
  await browser.close()
  server.close()
}
