// UI 视觉预览台的截图驱动:真组件 + 真 production CSS + 真 Chromium → PNG 基线。
//
// 用途:管理中心 / AI 市场改造前后的**视觉对照基线**。改造前跑一遍存 before/,改造后
// 同样命令换 OC_UI_SHOTS 存 after/,逐张比。
//
// 构建方式完全沿用 browser-tests/run.mjs(唯一先例,别另起炉灶):
//   esbuild 把 harness.tsx 打成 IIFE(jsx automatic / .css 置空 / node:crypto 走 stub)
//   + vite@tailwind 编译 browser-tests/preview-styles.ts 得到真实 production CSS
//   + CSS 与 bundle 内联进一张 html,playwright-core 的 chromium 渲染。
// 差异只有三处:①`…/lib/api` 全图重定向到 api-stub(场景表驱动的假数据);
// ②字体资产随 CSS 一起用 page.route 供出去(Inter 变量字重要真,中文回落 Noto Sans CJK);
// ③截图 clip 到 [role=dialog](面板都在 Radix Dialog Portal 里)。
//
// 跑法:npm run preview:shots(web-react 包内)。
// 环境变量:
//   OC_UI_SHOTS       输出目录(默认 /tmp/claude-0/-root/b1d7896a-48a0-4d60-8110-f289447f9192/scratchpad/ui-shots/before)
//   OC_UI_SCENES      只跑匹配的场景(逗号分隔,子串匹配 id)
//   OC_UI_SHOT_DELAY  每张图截前的稳定等待毫秒(默认 400)
//   OC_UI_SHOT_TIMEOUT 单张截图的超时毫秒(默认 90000,见下方"渲染器偶发卡顿")
//   OC_E2E_BROWSER    指定 Chrome/Chromium 可执行文件(见 scripts/lib/resolve-browser.mjs)
// 退出码:0 全部成功 / 1 有场景失败或零场景(fail-loud,不静默出空目录)。
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import { build as viteBuild } from 'vite'
import { resolveBrowserExecutable } from '../../../../scripts/lib/resolve-browser.mjs'

const require_ = createRequire(import.meta.url)
const esbuild = require_('esbuild')
const { chromium } = require_('playwright-core')

const HERE = dirname(fileURLToPath(import.meta.url))
const BROWSER_TESTS = dirname(HERE)
const PKG = dirname(BROWSER_TESTS)
const REPO_ROOT = dirname(dirname(PKG))

const OUT_DIR =
  process.env.OC_UI_SHOTS ??
  '/tmp/claude-0/-root/b1d7896a-48a0-4d60-8110-f289447f9192/scratchpad/ui-shots/before'
mkdirSync(OUT_DIR, { recursive: true })

const SHOT_DELAY = Number(process.env.OC_UI_SHOT_DELAY ?? 400)
// page.screenshot 默认 30s。这台机器上 96 张 2x 高分图连拍时,渲染器偶发会在某一张上卡住
// (光栅化 + 字体子集化的尖峰),超时属于**环境抖动**而非"这个场景画不出来"。判定标准不同,
// 处置也必须不同:环境抖动给足预算 + 重试一次;真错误(渲染异常/页面异常)仍然 fail-loud。
// 否则整批基线会被一张随机图带崩,而 UI 基线的价值恰恰在于"能稳定复跑"。
const SHOT_TIMEOUT = Number(process.env.OC_UI_SHOT_TIMEOUT ?? 90_000)
const SCENE_FILTER = (process.env.OC_UI_SCENES ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 2 },
  // 触摸态一并模拟:src 里有 [@media(hover:none)] 的加大触控尺寸规则,不开就看不到真实移动布局。
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}
const THEMES = ['light', 'dark'] // useTheme.ts 的落点是 <html class="dark">,见 applyTheme

// ── 场景模块发现 ────────────────────────────────────────────────────────────
// harness.tsx 静态 import './scenes-manage' 与 './scenes-market';这里把这两个 specifier
// 映射到目录内**实际存在**的场景文件,允许一组拆成多个文件、也允许暂时缺席(→ 空模块)。
const SKIP_FILE = /^(types|api-stub|harness)\.|(\.test\.|\.spec\.|\.d\.ts$)/
const sceneFiles = readdirSync(HERE).filter(
  (name) => /\.tsx?$/.test(name) && !SKIP_FILE.test(name) && /scene/i.test(name),
)
const groupFiles = {
  manage: sceneFiles.filter((name) => /manage/i.test(name)).sort(),
  market: sceneFiles.filter((name) => /market/i.test(name)).sort(),
}
const orphanFiles = sceneFiles.filter(
  (name) => !groupFiles.manage.includes(name) && !groupFiles.market.includes(name),
)
if (orphanFiles.length > 0) {
  // 归类不到就并进 manage 组一起打包 —— 分组只影响构建接线,场景归属看 Scene.group 字段。
  groupFiles.manage.push(...orphanFiles)
  console.warn(`ui-preview: 场景文件 ${orphanFiles.join(', ')} 文件名未含 manage/market,已并入 manage 组打包`)
}
console.log(
  `ui-preview: 场景模块 manage=[${groupFiles.manage.join(', ') || '无'}] market=[${groupFiles.market.join(', ') || '无'}]`,
)

const API_STUB = join(HERE, 'api-stub.ts')
const plugins = [
  {
    // src 全图(含 hooks/lib 的间接引用)的 `…/lib/api` → 场景表驱动的替身。
    // 桩自己 import 真实模块的那条边必须放行,否则自解析死循环。
    name: 'ui-preview-api-stub',
    setup(build) {
      build.onResolve({ filter: /(^|\/)lib\/api$/ }, (args) => {
        if (args.importer === API_STUB) return null
        return { path: API_STUB }
      })
    },
  },
  {
    name: 'ui-preview-scene-groups',
    setup(build) {
      build.onResolve({ filter: /(^|\/)scenes-(manage|market)$/ }, (args) => ({
        path: /market$/.test(args.path) ? 'market' : 'manage',
        namespace: 'oc-scene-group',
      }))
      build.onLoad({ filter: /.*/, namespace: 'oc-scene-group' }, (args) => {
        const files = groupFiles[args.path] ?? []
        const imports = files.map((file, i) => `import * as m${i} from ${JSON.stringify(`./${file}`)}`)
        const contents = `${imports.join('\n')}\nexport const modules = [${files.map((_, i) => `m${i}`).join(', ')}]\n`
        return { contents, loader: 'ts', resolveDir: HERE }
      })
    },
  },
]

// ── 构建 ────────────────────────────────────────────────────────────────────
const workDir = mkdtempSync(join(tmpdir(), 'oc-ui-preview-'))
const bundlePath = join(workDir, 'harness.js')
await esbuild.build({
  entryPoints: [join(HERE, 'harness.tsx')],
  bundle: true,
  format: 'iife',
  outfile: bundlePath,
  jsx: 'automatic',
  // 真实样式经 vite@tailwind 单独产出并内联;bundle 里把样式图置空(同 run.mjs)。
  loader: { '.css': 'empty' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env.PROD': 'true',
    'import.meta.env.DEV': 'false',
  },
  alias: { 'node:crypto': join(BROWSER_TESTS, 'stubs', 'node-crypto.js') },
  plugins,
  logLevel: 'warning',
})

const cssOutDir = join(workDir, 'css')
await viteBuild({
  root: PKG,
  configFile: false,
  logLevel: 'silent',
  plugins: [tailwindcss()],
  build: {
    outDir: cssOutDir,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      // 既有先例文件:内容就是 import '../src/styles.css'(tailwind 入口 + 设计 token)。
      input: join(BROWSER_TESTS, 'preview-styles.ts'),
      output: {
        entryFileNames: 'preview-styles.js',
        // 字体等资产保留各自文件名(run.mjs 那套 preview-styles[extname] 会让多个 woff2 撞名)。
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
})

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
  return out
}
const builtAssets = walk(cssOutDir)
const cssFile = builtAssets.find((p) => p.endsWith('.css'))
if (!cssFile) throw new Error('ui-preview: 预览 production CSS 构建失败(产物里没有 .css)')
const assetByName = new Map(builtAssets.map((p) => [basename(p), p]))

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#fafafb">
<title>OpenClaude UI 预览台</title>
<style>${readFileSync(cssFile, 'utf8')}</style>
</head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
}

// ── 驱动 ────────────────────────────────────────────────────────────────────
const HARNESS_URL = 'http://127.0.0.1/__openclaude_ui_preview__'

let browser
try {
  browser = await chromium.launch({ executablePath: resolveBrowserExecutable(), headless: true })
} catch (err) {
  console.error(`ui-preview: 环境错误(浏览器不可用): ${err.message}`)
  process.exit(1)
}

const unmocked = new Set()
const failures = []
const shots = []
/** 首次截图超时、靠重试才拿到的图(环境抖动的可观测记录,不算失败)。 */
const retried = []
/** 当前正在截的图,供 console/pageerror 监听归因。 */
let current = null

async function preparePage(page) {
  page.on('console', (msg) => {
    const text = msg.text()
    if (text.startsWith('[unmocked-api]')) {
      unmocked.add(text.replace('[unmocked-api]', '').trim())
    }
  })
  page.on('pageerror', (err) => {
    if (current) current.pageErrors.push(String(err?.message ?? err))
  })
  // 只有 harness 页与 CSS 引出的资产走真实响应;其余一切(埋点/图片外链)兜 204,
  // 免得离线环境的失败请求污染控制台与渲染时序。
  await page.route('**/*', async (route) => {
    const url = route.request().url()
    if (url.startsWith(HARNESS_URL)) {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    let asset
    try {
      asset = assetByName.get(basename(new URL(url).pathname))
    } catch {}
    if (asset) {
      return route.fulfill({
        status: 200,
        contentType: CONTENT_TYPES[extname(asset)] ?? 'application/octet-stream',
        body: readFileSync(asset),
      })
    }
    return route.fulfill({ status: 204 })
  })
  await page.goto(HARNESS_URL, { waitUntil: 'load' })
}

async function applyTheme(page, theme) {
  // useTheme.ts 的唯一落点:<html class="dark">(index.html 首屏内联脚本同款)。
  // 同时 emulateMedia,让 theme==='system' 分支与任何 prefers-color-scheme 规则也对齐。
  await page.emulateMedia({ colorScheme: theme })
  await page.evaluate((t) => {
    document.documentElement.classList.toggle('dark', t === 'dark')
    try {
      localStorage.setItem('oc_theme', t)
    } catch {}
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', t === 'dark' ? '#0c0c11' : '#fafafb')
  }, theme)
}

async function capture(page, scene, viewport, theme) {
  const name = `${scene.id}--${viewport}--${theme}.png`
  const file = join(OUT_DIR, name)
  current = { name, pageErrors: [] }
  try {
    await page.evaluate((id) => window.__mountScene(id), scene.id)
    // 字体没就位就截 = 假的字重/行高;先等 fonts.ready,再给动画/异步数据一段稳定期。
    await page.evaluate(() => document.fonts.ready.then(() => true))
    await page.waitForTimeout(SHOT_DELAY)
    // Radix 打开对话框会把焦点程序化地丢给第一个可聚焦元素,Chromium 随即画上 :focus-visible
    // 光环 —— 那是"刚打开的一瞬"的态,不是要评估的静态视觉。收掉焦点得干净基线
    // (FocusScope 会把焦点收回 Content 容器本身,该容器 focus:outline-none,不再有光环)。
    await page.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement && active !== document.body) active.blur()
    })
    await page.waitForTimeout(80)

    const renderError = await page.evaluate(() => window.__ocSceneError)

    let clip
    const dialog = page.locator('[role="dialog"]').first()
    if ((await dialog.count()) > 0) {
      const box = await dialog.boundingBox()
      const size = page.viewportSize() ?? { width: 1440, height: 900 }
      if (box) {
        // 留一点余白:遮罩/投影也是视觉基线的一部分。越界要夹回视口,否则 Chromium 报错。
        const pad = 20
        const x = Math.max(0, Math.floor(box.x - pad))
        const y = Math.max(0, Math.floor(box.y - pad))
        clip = {
          x,
          y,
          width: Math.max(1, Math.min(Math.ceil(box.width + pad * 2), size.width - x)),
          height: Math.max(1, Math.min(Math.ceil(box.height + pad * 2), size.height - y)),
        }
      }
    }

    const shotOptions = {
      path: file,
      ...(clip ? { clip } : { fullPage: true }),
      animations: 'disabled',
      caret: 'hide',
      timeout: SHOT_TIMEOUT,
    }
    try {
      await page.screenshot(shotOptions)
    } catch (err) {
      // 见 SHOT_TIMEOUT 注释:渲染器卡顿只重试这一步,不重挂场景(重挂会重放动画、丢掉已就位的
      // 异步数据,反而引入新的不确定性)。retried 记进 manifest,便于发现"某张图长期不稳"。
      console.warn(`ui-preview: 截图卡顿,重试一次 ${name}(${String(err?.message ?? err).split('\n')[0]})`)
      await page.waitForTimeout(1000)
      await page.screenshot(shotOptions)
      retried.push(name)
    }
    shots.push({ name, scene: scene.id, label: scene.label, group: scene.group, viewport, theme, clipped: Boolean(clip) })

    if (renderError) {
      failures.push({ name, reason: `渲染错误(ErrorBoundary 捕获):${renderError.split('\n')[0]}` })
    } else if (current.pageErrors.length > 0) {
      failures.push({ name, reason: `页面未捕获异常:${current.pageErrors.join(' | ')}` })
    }
  } catch (err) {
    failures.push({ name, reason: String(err?.message ?? err) })
    console.error(`ui-preview: 场景失败 ${name}\n  ${String(err?.message ?? err).replaceAll('\n', '\n  ')}`)
  } finally {
    current = null
    try {
      await page.evaluate(() => window.__unmountScene())
    } catch {}
  }
}

// 先开一张一次性页面读场景清单(要先知道每个场景需要哪些视口,才能决定开哪些 context)。
const probeContext = await browser.newContext()
const probePage = await probeContext.newPage()
await preparePage(probePage)
const allScenes = await probePage.evaluate(() => window.__ocScenes)
const sceneModuleKeys = await probePage.evaluate(() => window.__ocSceneModules)
await probeContext.close()

const selected = allScenes.filter(
  (scene) => SCENE_FILTER.length === 0 || SCENE_FILTER.some((needle) => scene.id.includes(needle)),
)
if (selected.length === 0) {
  await browser.close()
  console.error(
    allScenes.length === 0
      ? 'ui-preview: 零场景 —— scenes-manage / scenes-market 模块没产出任何 Scene(检查文件名是否含 manage/market,以及是否导出了场景数组)\n' +
        `  模块导出:manage=[${(sceneModuleKeys?.manage ?? []).join(', ')}] market=[${(sceneModuleKeys?.market ?? []).join(', ')}]`
      : `ui-preview: OC_UI_SCENES=${SCENE_FILTER.join(',')} 未匹配到任何场景`,
  )
  process.exit(1)
}

for (const [viewport, options] of Object.entries(VIEWPORTS)) {
  const list = selected.filter((scene) => (scene.viewports ?? ['desktop']).includes(viewport))
  if (list.length === 0) continue
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    deviceScaleFactor: options.deviceScaleFactor,
    isMobile: options.isMobile ?? false,
    hasTouch: options.hasTouch ?? false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()
  await preparePage(page)
  for (const theme of THEMES) {
    await applyTheme(page, theme)
    for (const scene of list) {
      await capture(page, scene, viewport, theme)
    }
  }
  await context.close()
}

await browser.close()

// ── 汇总 ────────────────────────────────────────────────────────────────────
const manifest = {
  generatedAt: new Date().toISOString(),
  repo: REPO_ROOT,
  outDir: OUT_DIR,
  viewports: VIEWPORTS,
  themes: THEMES,
  scenes: selected,
  shots,
  failures,
  retried,
  unmockedApi: [...unmocked].sort(),
}
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`\nui-preview: 输出目录 ${OUT_DIR}`)
for (const shot of shots) {
  const bytes = statSync(join(OUT_DIR, shot.name)).size
  console.log(`  ${shot.name.padEnd(52)} ${shot.group}/${shot.label}${shot.clipped ? '' : ' (整页)'} ${(bytes / 1024).toFixed(0)}KB`)
}
console.log(`ui-preview: ${shots.length} 张 / ${selected.length} 场景 × ${THEMES.length} 主题`)

if (retried.length > 0) {
  console.log(`\nui-preview: ${retried.length} 张首次截图超时、重试后成功(环境抖动):`)
  for (const name of retried) console.log(`  - ${name}`)
}

if (unmocked.size > 0) {
  console.log(`\nui-preview: 未打桩的 api 方法(${unmocked.size} 个,已返回中性值):`)
  for (const name of [...unmocked].sort()) console.log(`  - ${name}`)
}

if (failures.length > 0) {
  console.error(`\nui-preview: ${failures.length} 个场景失败`)
  for (const failure of failures) console.error(`  ✗ ${failure.name}: ${failure.reason}`)
  process.exit(1)
}
console.log('\nui-preview: 全部成功')
process.exit(0)
