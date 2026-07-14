#!/usr/bin/env tsx
/** 由真实 v5 组件舞台确定性生成 9 组 960×540 WebP + VP8 WebM 教程媒体。 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const WEB_ROOT = join(ROOT, 'packages/web-react')
const CAPTURE_DIST = join(WEB_ROOT, 'dist-tutorial-capture')
const OUTPUT = join(WEB_ROOT, 'public/tutorials')
const PORT = 5190
const FPS = 4
const FRAME_COUNT = 13
const SCENES = [
  'workspace',
  'composer',
  'research',
  'agents',
  'manage',
  'market',
  'settings',
  'organization',
  'github',
] as const

type BrowserModule = {
  chromium: {
    launch: (options: { headless: boolean; executablePath: string; args: string[] }) => Promise<{
      newPage: (options: {
        viewport: { width: number; height: number }
        deviceScaleFactor: number
      }) => Promise<{
        addInitScript: (options: { content: string }) => Promise<void>
        goto: (url: string, options: { waitUntil: 'networkidle' }) => Promise<unknown>
        evaluate: (fn: () => Promise<void>) => Promise<void>
        screenshot: (options: { type: 'jpeg'; quality: number }) => Promise<Buffer>
        emulateMedia: (options: { reducedMotion: 'reduce' }) => Promise<void>
        close: () => Promise<void>
      }>
      close: () => Promise<void>
    }>
  }
}
type CaptureBrowser = Awaited<ReturnType<BrowserModule['chromium']['launch']>>

function commandPath(name: string): string | null {
  try {
    return execFileSync('bash', ['-lc', `command -v ${name}`], { encoding: 'utf8' }).trim() || null
  } catch {
    return null
  }
}

function latestCacheBinary(product: 'chromium' | 'ffmpeg', suffix: string): string | null {
  const cache = join(homedir(), '.cache/ms-playwright')
  if (!existsSync(cache)) return null
  const entries = readdirSync(cache)
    .filter((name) => name.startsWith(`${product}-`))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const entry of entries) {
    const candidate = join(cache, entry, suffix)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function chromePath(): string {
  const candidates = [
    process.env.TUTORIAL_CHROME,
    commandPath('google-chrome'),
    commandPath('chromium'),
    commandPath('chromium-browser'),
    latestCacheBinary('chromium', 'chrome-linux64/chrome'),
    latestCacheBinary('chromium', 'chrome-linux/chrome'),
  ]
  const found = candidates.find((value): value is string => !!value && existsSync(value))
  if (!found) throw new Error('找不到 Chromium；请设置 TUTORIAL_CHROME=/path/to/chrome')
  return found
}

function ffmpegPath(): string {
  const candidates = [
    process.env.TUTORIAL_FFMPEG,
    commandPath('ffmpeg'),
    latestCacheBinary('ffmpeg', 'ffmpeg-linux'),
  ]
  const found = candidates.find((value): value is string => !!value && existsSync(value))
  if (!found) throw new Error('找不到 ffmpeg（需 libvpx）；请设置 TUTORIAL_FFMPEG=/path/to/ffmpeg')
  return found
}

function playwright(): BrowserModule {
  const require = createRequire(import.meta.url)
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    'playwright-core',
    '/usr/lib/node_modules/@playwright/mcp/node_modules/playwright-core',
    '/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core',
  ].filter((value): value is string => !!value)
  for (const candidate of candidates) {
    try {
      return require(candidate) as BrowserModule
    } catch {
      // 尝试下一个已安装位置。
    }
  }
  throw new Error('找不到 playwright-core；请设置 PLAYWRIGHT_CORE_PATH 或安装 Playwright MCP')
}

function runBuild(): void {
  execFileSync(
    'npm',
    [
      'exec',
      '--workspace',
      '@openclaude/web-react',
      '--',
      'vite',
      'build',
      '--mode',
      'tutorial-capture',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  )
}

async function startPreview(): Promise<ChildProcess> {
  const child = spawn(
    'npm',
    [
      'exec',
      '--workspace',
      '@openclaude/web-react',
      '--',
      'vite',
      'preview',
      '--host',
      '127.0.0.1',
      '--port',
      String(PORT),
      '--strictPort',
      '--outDir',
      'dist-tutorial-capture',
    ],
    // 独立进程组：npm 会再派生 vite；清理时必须整组结束，不能只杀 npm 留孤儿 preview。
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  let output = ''
  child.stdout?.on('data', (chunk) => (output += String(chunk)))
  child.stderr?.on('data', (chunk) => (output += String(chunk)))
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode != null) throw new Error(`教程 capture preview 启动失败：\n${output}`)
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/tutorial-capture.html`)
      if (response.ok) return child
    } catch {
      // 等待服务就绪。
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (child.pid) process.kill(-child.pid, 'SIGTERM')
  throw new Error(`教程 capture preview 启动超时：\n${output}`)
}

async function encodeVideo(path: string, frames: Buffer[], ffmpeg: string): Promise<void> {
  const child = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-vcodec',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libvpx',
      '-deadline',
      'good',
      '-cpu-used',
      '4',
      '-crf',
      '36',
      '-b:v',
      '320k',
      '-pix_fmt',
      'yuv420p',
      // Matroska 默认写随机 SegmentUID/当前日期；bitexact 移除这些非视觉熵，重复生成哈希稳定。
      '-bitexact',
      '-map_metadata',
      '-1',
      '-metadata',
      'creation_time=1970-01-01T00:00:00Z',
      '-y',
      path,
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  )
  let error = ''
  child.stderr?.on('data', (chunk) => (error += String(chunk)))
  for (const frame of frames) {
    if (!child.stdin!.write(frame)) await once(child.stdin!, 'drain')
  }
  child.stdin!.end()
  const [code] = (await once(child, 'close')) as [number]
  if (code !== 0) throw new Error(`ffmpeg 生成 ${path} 失败：${error}`)
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true })
  rmSync(CAPTURE_DIST, { recursive: true, force: true })
  let preview: ChildProcess | null = null
  let browser: CaptureBrowser | null = null
  try {
    runBuild()
    preview = await startPreview()
    const { chromium } = playwright()
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath(),
      args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
    })
    const ffmpeg = ffmpegPath()
    for (const scene of SCENES) {
      const page = await browser.newPage({
        viewport: { width: 960, height: 540 },
        deviceScaleFactor: 1,
      })
      await page.addInitScript({
        // Sidebar 的“今天/昨天”分组也必须与生成日期解耦，避免跨日重跑改变媒体。
        content: `
          (() => {
            const NativeDate = Date;
            const fixedNow = NativeDate.parse('2026-07-15T00:00:00.000Z');
            class CaptureDate extends NativeDate {
              constructor(...args) {
                super(...(args.length ? args : [fixedNow]));
              }
              static now() { return fixedNow; }
            }
            globalThis.Date = CaptureDate;
          })();
        `,
      })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const frames: Buffer[] = []
      for (let step = 0; step < FRAME_COUNT; step += 1) {
        await page.goto(
          `http://127.0.0.1:${PORT}/tutorial-capture.html?scene=${scene}&step=${step}`,
          { waitUntil: 'networkidle' },
        )
        await page.evaluate(async () => {
          await document.fonts.ready
        })
        frames.push(await page.screenshot({ type: 'jpeg', quality: 82 }))
      }
      await sharp(frames[8])
        .webp({ quality: 78, effort: 5 })
        .toFile(join(OUTPUT, `${scene}.webp`))
      await encodeVideo(join(OUTPUT, `${scene}.webm`), frames, ffmpeg)
      await page.close()
      process.stdout.write(`generated ${scene}.webp + ${scene}.webm\n`)
    }
  } finally {
    try {
      await browser?.close()
    } catch {
      // 继续清理 preview 与构建目录，不能让浏览器关闭错误中断 finally。
    }
    if (preview?.pid) {
      try {
        process.kill(-preview.pid, 'SIGTERM')
      } catch {
        // preview 已自行退出。
      }
    }
    if (preview) {
      await Promise.race([
        once(preview, 'close'),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ])
      preview.stdout?.destroy()
      preview.stderr?.destroy()
    }
    rmSync(CAPTURE_DIST, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
