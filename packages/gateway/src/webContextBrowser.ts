import { randomBytes } from 'node:crypto'
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES,
  DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES,
  HARD_WEB_CONTEXT_MAX_DECODED_BYTES,
  normalizeHttpUrl,
  parseBoundedInt,
  resolvePublicIp,
  startWebContextSsrfProxy,
  type WebContextSsrfProxyOptions,
  type WebContextSsrfProxyStats,
} from './webContextSafety.js'

const require = createRequire(import.meta.url)

const SYSTEM_BROWSER_CANDIDATES = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

const BLOCKED_RESOURCE_TYPES = new Set([
  'image',
  'media',
  'font',
  'websocket',
  'eventsource',
  'manifest',
])

const ALLOWED_PAGE_PROTOCOLS = new Set(['http:', 'https:', 'about:', 'data:', 'blob:'])
const BROWSER_CLOSE_TIMEOUT_MS = 2_000
const MAX_SLOT_LEASE_MS = 360_000
const STALE_EMPTY_LOCK_MS = 2_000
const STALE_REAP_LOCK_MS = 5_000
const SLOT_POLL_MS = 50

interface PlaywrightRequestLike {
  url(): string
  resourceType(): string
  redirectedFrom(): PlaywrightRequestLike | null
}

interface PlaywrightResponseLike {
  status(): number
  headers(): Record<string, string>
  request(): PlaywrightRequestLike
}

interface PlaywrightCdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  on(event: string, listener: (payload: Record<string, unknown>) => void): void
}

interface PlaywrightWebSocketRouteLike {
  close(options?: { code?: number; reason?: string }): Promise<void>
}

interface PlaywrightPageLike {
  goto(
    url: string,
    opts?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number },
  ): Promise<PlaywrightResponseLike | null>
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    opts?: { timeout?: number },
  ): Promise<void>
  content(): Promise<string>
  url(): string
  close(): Promise<void>
}

interface PlaywrightContextLike {
  newPage(): Promise<PlaywrightPageLike>
  newCDPSession(page: PlaywrightPageLike): Promise<PlaywrightCdpSessionLike>
  routeWebSocket(
    url: string,
    handler: (ws: PlaywrightWebSocketRouteLike) => Promise<void> | void,
  ): Promise<void>
  addInitScript(script: string): Promise<void>
  on(event: 'page', listener: (page: PlaywrightPageLike) => void): void
  close(): Promise<void>
}

interface PlaywrightBrowserLike {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContextLike>
  newBrowserCDPSession(): Promise<PlaywrightCdpSessionLike>
  close(): Promise<void>
}

interface PlaywrightBrowserServerLike {
  wsEndpoint(): string
  process(): { pid?: number; kill: (signal?: NodeJS.Signals | number) => boolean } | null
  close(): Promise<void>
  kill?(): Promise<void> | void
}

interface PlaywrightChromiumLike {
  executablePath?: () => string
  launchServer(opts: Record<string, unknown>): Promise<PlaywrightBrowserServerLike>
  connect(wsEndpoint: string, opts?: Record<string, unknown>): Promise<PlaywrightBrowserLike>
}

export interface WebContextBrowserRenderOptions {
  timeoutMs?: number
  deadlineMs?: number
  maxEncodedBytes?: number
  maxDecodedBytes?: number
  userAgent?: string
  proxyOptions?: WebContextSsrfProxyOptions
  onBrowserPid?: (pid: number) => void
}

export interface WebContextBrowserRenderResult {
  url: string
  finalUrl: string
  status: number
  headers: Record<string, string>
  body: Buffer
  contentType: string
  redirects: string[]
  proxyStats: WebContextSsrfProxyStats
  browserPid: number | null
}

export interface WebContextBrowserHealth {
  ok: boolean
  executable: string | null
  proxy: boolean
  error?: string
}

function isRegularFile(filePath: string): boolean {
  try {
    return existsSync(filePath) && statSync(filePath).isFile()
  } catch {
    return false
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function remainingBudgetMs(deadlineMs: number, floorMs = 0): number {
  return Math.max(floorMs, deadlineMs - Date.now())
}

async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  message: string,
): Promise<T> {
  const rem = deadlineMs - Date.now()
  if (rem <= 0) throw new Error(message)
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), rem)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function loadPlaywrightChromium(): PlaywrightChromiumLike {
  const pw = require('playwright-core') as { chromium?: PlaywrightChromiumLike }
  if (
    !pw?.chromium ||
    typeof pw.chromium.launchServer !== 'function' ||
    typeof pw.chromium.connect !== 'function'
  ) {
    throw new Error('playwright-core chromium launcher is unavailable')
  }
  return pw.chromium
}

function findPlaywrightCachedChromium(cacheDir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(cacheDir)
  } catch {
    return null
  }
  const revs = entries
    .map((name) => /^chromium-(\d+)$/.exec(name))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => ({ rev: Number(m[1]), dir: m[0] }))
    .sort((a, b) => b.rev - a.rev)
  for (const { dir } of revs) {
    for (const sub of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const candidate = join(cacheDir, dir, sub)
      if (isRegularFile(candidate)) return candidate
    }
  }
  return null
}

export function resolveWebContextBrowserExecutable(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.OPENCLAUDE_WEB_CONTEXT_BROWSER?.trim()
  if (explicit) {
    return isRegularFile(explicit) ? explicit : null
  }

  const cacheDirs = new Set<string>(['/usr/local/share/ms-playwright'])
  const configuredCache = env.PLAYWRIGHT_BROWSERS_PATH?.trim()
  if (configuredCache) cacheDirs.add(configuredCache)
  cacheDirs.add(join(homedir(), '.cache', 'ms-playwright'))
  for (const dir of cacheDirs) {
    const found = findPlaywrightCachedChromium(dir)
    if (found) return found
  }

  for (const candidate of SYSTEM_BROWSER_CANDIDATES) {
    if (isRegularFile(candidate)) return candidate
  }

  try {
    const fallback = loadPlaywrightChromium().executablePath?.()
    if (fallback && isRegularFile(fallback)) return fallback
  } catch {
    /* ignore missing playwright-core when probing */
  }
  return null
}

function resolveBrowserLockDir(): string {
  const explicit = process.env.OPENCLAUDE_WEB_CONTEXT_LOCK_DIR?.trim()
  if (explicit) return explicit
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : 'user'
  return join(tmpdir(), `oc-webctx-browser-locks-${uid}`)
}

function safeUnlink(filePath: string): void {
  try {
    unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function isLockStale(slotPath: string): { stale: boolean; ino: number } | null {
  try {
    const st = statSync(slotPath)
    const raw = readFileSync(slotPath, 'utf8')
    if (!raw.trim()) {
      return { stale: Date.now() - st.mtimeMs > STALE_EMPTY_LOCK_MS, ino: st.ino }
    }
    let parsed: { pid?: unknown; startedAt?: unknown } | null = null
    try {
      parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown }
    } catch {
      return { stale: Date.now() - st.mtimeMs > STALE_EMPTY_LOCK_MS, ino: st.ino }
    }
    const pid = typeof parsed?.pid === 'number' ? parsed.pid : 0
    const startedAt = typeof parsed?.startedAt === 'number' ? parsed.startedAt : st.mtimeMs
    const deadOwner = pid > 0 && !isPidAlive(pid)
    const expiredLease = Date.now() - startedAt > MAX_SLOT_LEASE_MS
    return { stale: deadOwner || expiredLease, ino: st.ino }
  } catch {
    return null
  }
}

function reapStaleSlot(lockDir: string, slotPath: string, slotIndex: number, expectedIno: number): void {
  const reapPath = join(lockDir, `slot-${slotIndex}.reap`)
  const tmpReap = join(lockDir, `.reap-${process.pid}-${randomBytes(8).toString('hex')}`)
  try {
    writeFileSync(tmpReap, JSON.stringify({ pid: process.pid, startedAt: Date.now() }), {
      mode: 0o600,
    })
    try {
      linkSync(tmpReap, reapPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return
      try {
        const reapStat = statSync(reapPath)
        if (Date.now() - reapStat.mtimeMs > STALE_REAP_LOCK_MS) safeUnlink(reapPath)
      } catch {
        /* ignore */
      }
      return
    }
    try {
      const curStat = statSync(slotPath)
      if (curStat.ino === expectedIno) safeUnlink(slotPath)
    } catch {
      /* slot already gone */
    } finally {
      safeUnlink(reapPath)
    }
  } finally {
    safeUnlink(tmpReap)
  }
}

function tryAcquireSlotFile(lockDir: string, slotIndex: number, token: string): (() => void) | null {
  const slotPath = join(lockDir, `slot-${slotIndex}.lock`)
  const tmpPath = join(lockDir, `.tmp-${process.pid}-${token}`)
  const payload = JSON.stringify({ pid: process.pid, token, startedAt: Date.now() })
  writeFileSync(tmpPath, payload, { mode: 0o600 })
  try {
    try {
      linkSync(tmpPath, slotPath)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') return null
      const check = isLockStale(slotPath)
      if (!check?.stale) return null
      reapStaleSlot(lockDir, slotPath, slotIndex, check.ino)
      try {
        linkSync(tmpPath, slotPath)
      } catch {
        return null
      }
    }
  } finally {
    safeUnlink(tmpPath)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      const raw = readFileSync(slotPath, 'utf8')
      const parsed = JSON.parse(raw) as { token?: unknown }
      if (parsed?.token === token) safeUnlink(slotPath)
    } catch {
      /* already removed or unreadable */
    }
  }
}

async function withBrowserRenderSlot<T>(deadlineMs: number, fn: () => Promise<T>): Promise<T> {
  const maxConcurrent = parseBoundedInt(
    process.env.OPENCLAUDE_WEB_CONTEXT_BROWSER_CONCURRENT,
    1,
    1,
    2,
  )
  const lockDir = resolveBrowserLockDir()
  mkdirSync(lockDir, { recursive: true, mode: 0o700 })
  const token = randomBytes(12).toString('hex')

  let release: (() => void) | null = null
  while (!release) {
    for (let i = 0; i < maxConcurrent; i++) {
      release = tryAcquireSlotFile(lockDir, i, token)
      if (release) break
    }
    if (release) break
    const rem = deadlineMs - Date.now()
    if (rem <= 0) {
      throw new Error('web-context browser render concurrency limit timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(SLOT_POLL_MS, rem)))
  }

  try {
    return await fn()
  } finally {
    release()
  }
}

async function killBrowserServer(browserServer: PlaywrightBrowserServerLike): Promise<void> {
  const pid = browserServer.process?.()?.pid
  try {
    await browserServer.kill?.()
  } catch {
    /* ignore */
  }
  try {
    browserServer.process?.()?.kill('SIGKILL')
  } catch {
    /* ignore */
  }
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* ignore */
    }
    const waitUntil = Date.now() + 1_000
    while (Date.now() < waitUntil && isPidAlive(pid)) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}

async function closeBrowserSafely(
  context: PlaywrightContextLike | undefined,
  browser: PlaywrightBrowserLike | undefined,
  browserServer: PlaywrightBrowserServerLike,
): Promise<void> {
  const pid = browserServer.process?.()?.pid
  const graceful = (async () => {
    try {
      await context?.close()
    } catch {
      /* ignore context close errors during teardown */
    }
    try {
      await browser?.close()
    } catch {
      /* ignore browser close errors during teardown */
    }
    try {
      await browserServer.close()
    } catch {
      /* ignore browser server close errors during teardown */
    }
  })()

  let timedOut = false
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      graceful,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve()
        }, BROWSER_CLOSE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }

  if (timedOut || (pid !== undefined && isPidAlive(pid))) {
    await killBrowserServer(browserServer)
  }
}

function collectRedirectChain(response: PlaywrightResponseLike | null): string[] {
  if (!response) return []
  const urls: string[] = []
  let req: PlaywrightRequestLike | null = response.request()
  while (req) {
    urls.push(req.url())
    req = req.redirectedFrom()
  }
  urls.reverse()
  return urls.slice(1)
}

async function attachPageFetchGuard(
  context: PlaywrightContextLike,
  page: PlaywrightPageLike,
  proxyCredentials: { username: string; password: string },
  deadlineMs: number,
): Promise<PlaywrightCdpSessionLike> {
  const cdp = await withDeadline(
    context.newCDPSession(page),
    deadlineMs,
    'web-context CDP session creation timed out',
  )
  const attemptedProxyAuth = new Set<string>()

  cdp.on('Fetch.authRequired', (ev) => {
    const requestId = typeof ev.requestId === 'string' ? ev.requestId : ''
    if (!requestId) return
    const challenge = ev.authChallenge as { source?: string } | undefined
    const isProxyChallenge = challenge?.source === 'Proxy'
    if (isProxyChallenge && !attemptedProxyAuth.has(requestId)) {
      attemptedProxyAuth.add(requestId)
      void cdp
        .send('Fetch.continueWithAuth', {
          requestId,
          authChallengeResponse: {
            response: 'ProvideCredentials',
            username: proxyCredentials.username,
            password: proxyCredentials.password,
          },
        })
        .catch(() => {})
      return
    }
    // Never supply proxy credentials to origin HTTP 401/server auth challenges.
    void cdp
      .send('Fetch.continueWithAuth', {
        requestId,
        authChallengeResponse: { response: 'CancelAuth' },
      })
      .catch(() => {})
  })

  cdp.on('Fetch.requestPaused', (ev) => {
    const requestId = typeof ev.requestId === 'string' ? ev.requestId : ''
    if (!requestId) return
    const req = ev.request as { url?: string } | undefined
    const rawUrl = typeof req?.url === 'string' ? req.url : ''
    let protocol = ''
    try {
      protocol = new URL(rawUrl).protocol
    } catch {
      void cdp
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        .catch(() => {})
      return
    }
    const resourceType =
      typeof ev.resourceType === 'string' ? ev.resourceType.toLowerCase() : ''
    if (!ALLOWED_PAGE_PROTOCOLS.has(protocol) || BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      void cdp
        .send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
        .catch(() => {})
      return
    }
    void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {})
  })

  await withDeadline(
    cdp.send('Fetch.enable', {
      handleAuthRequests: true,
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    }),
    deadlineMs,
    'web-context CDP Fetch.enable timed out',
  )
  return cdp
}

export async function renderWebContextUrlWithBrowser(
  rawUrl: string,
  options: WebContextBrowserRenderOptions = {},
): Promise<WebContextBrowserRenderResult> {
  const totalTimeoutMs = parseBoundedInt(String(options.timeoutMs ?? ''), 90_000, 1_000, 300_000)
  const deadlineMs =
    typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs)
      ? options.deadlineMs
      : Date.now() + totalTimeoutMs

  const initialUrl = normalizeHttpUrl(rawUrl)
  await withDeadline(
    resolvePublicIp(initialUrl.hostname, options.proxyOptions?.lookup),
    deadlineMs,
    'web-context DNS check timed out',
  )

  const executablePath = resolveWebContextBrowserExecutable()
  if (!executablePath) {
    throw new Error('browser rendering unavailable: Chromium executable not found')
  }

  const maxDecodedBytes = Math.min(
    Math.max(1024, Math.floor(options.maxDecodedBytes ?? DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES)),
    HARD_WEB_CONTEXT_MAX_DECODED_BYTES,
  )

  return await withBrowserRenderSlot(deadlineMs, async () => {
    const proxy = await withDeadline(
      startWebContextSsrfProxy({
        ...options.proxyOptions,
        maxBytesPerRequest: options.maxEncodedBytes ?? DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES,
        socketTimeoutMs: Math.min(remainingBudgetMs(deadlineMs, 1_000), 30_000),
      }),
      deadlineMs,
      'web-context SSRF proxy startup timed out',
    )

    try {
      const chromium = loadPlaywrightChromium()
      let launchTimedOut = false
      const launchPromise = chromium
        .launchServer({
          executablePath,
          headless: true,
          chromiumSandbox: false,
          timeout: remainingBudgetMs(deadlineMs, 1_000),
          args: [
            `--proxy-server=${proxy.serverUrl}`,
            '--proxy-bypass-list=<-loopback>',
            '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-background-networking',
            '--disable-extensions',
            '--mute-audio',
            '--webrtc-ip-handling-policy=disable_non_proxied_udp',
            '--force-webrtc-ip-handling-policy',
          ],
        })
        .then(async (srv) => {
          if (launchTimedOut) {
            await killBrowserServer(srv)
            throw new Error('web-context Chromium launch timed out')
          }
          return srv
        })

      let browserServer: PlaywrightBrowserServerLike
      try {
        browserServer = await withDeadline(
          launchPromise,
          deadlineMs,
          'web-context Chromium launch timed out',
        )
      } catch (err) {
        launchTimedOut = true
        void launchPromise.catch(() => {})
        throw err
      }

      const browserPid = browserServer.process?.()?.pid ?? null
      if (browserPid !== null) options.onBrowserPid?.(browserPid)

      let browser: PlaywrightBrowserLike | undefined
      let context: PlaywrightContextLike | undefined
      try {
        browser = await withDeadline(
          chromium.connect(browserServer.wsEndpoint(), {
            timeout: remainingBudgetMs(deadlineMs, 500),
          }),
          deadlineMs,
          'web-context Chromium connect timed out',
        )

        // Omit proxy username/password from Playwright context options so Playwright
        // never sets global httpCredentials that would leak to target HTTP 401 sites.
        context = await withDeadline(
          browser.newContext({
            proxy: {
              server: proxy.serverUrl,
              bypass: '<-loopback>',
            },
            acceptDownloads: false,
            serviceWorkers: 'block',
            ...(options.userAgent ? { userAgent: options.userAgent } : {}),
          }),
          deadlineMs,
          'web-context browser context timed out',
        )

        // Context-wide WebSocket and popup/new-window blocking registered before creating any page.
        await withDeadline(
          context.routeWebSocket('**/*', (ws) => {
            void ws.close({ code: 1008, reason: 'WebSocket disabled' }).catch(() => {})
          }),
          deadlineMs,
          'web-context routeWebSocket setup timed out',
        )
        await withDeadline(
          context.addInitScript(
            `try {
              window.open = function () { return null; };
              document.addEventListener('click', function (ev) {
                var a = ev.target && ev.target.closest ? ev.target.closest('a[target]') : null;
                if (a && a.getAttribute('target') !== '_self') ev.preventDefault();
              }, true);
              HTMLAnchorElement.prototype.click = function () {
                if (this.target && this.target !== '_self') return;
                return HTMLElement.prototype.click.call(this);
              };
              HTMLFormElement.prototype.submit = function () {
                if (this.target && this.target !== '_self') return;
                return HTMLFormElement.prototype.submit.apply(this, arguments);
              };
            } catch {}`,
          ),
          deadlineMs,
          'web-context init script setup timed out',
        )

        const browserCdp = await withDeadline(
          browser.newBrowserCDPSession(),
          deadlineMs,
          'web-context browser CDP session timed out',
        )
        let mainTargetId: string | undefined
        browserCdp.on('Target.targetCreated', (ev) => {
          const info = ev.targetInfo as { targetId?: string; type?: string } | undefined
          if (
            info?.type === 'page' &&
            typeof info.targetId === 'string' &&
            mainTargetId &&
            info.targetId !== mainTargetId
          ) {
            void browserCdp.send('Target.closeTarget', { targetId: info.targetId }).catch(() => {})
          }
        })
        await withDeadline(
          browserCdp.send('Target.setDiscoverTargets', { discover: true }),
          deadlineMs,
          'web-context Target.setDiscoverTargets timed out',
        )

        let mainPage: PlaywrightPageLike | undefined
        context.on('page', (popupPage) => {
          if (mainPage && popupPage !== mainPage) {
            void popupPage.close().catch(() => {})
          }
        })

        mainPage = await withDeadline(
          context.newPage(),
          deadlineMs,
          'web-context page creation timed out',
        )
        const pageCdp = await attachPageFetchGuard(
          context,
          mainPage,
          { username: proxy.username, password: proxy.password },
          deadlineMs,
        )
        const targetInfoRes = (await withDeadline(
          pageCdp.send('Target.getTargetInfo'),
          deadlineMs,
          'web-context Target.getTargetInfo timed out',
        )) as { targetInfo?: { targetId?: string } } | undefined
        mainTargetId = targetInfoRes?.targetInfo?.targetId

        const gotoTimeout = remainingBudgetMs(deadlineMs, 200)
        let response: PlaywrightResponseLike | null
        try {
          response = await withDeadline(
            mainPage.goto(initialUrl.toString(), {
              waitUntil: 'domcontentloaded',
              timeout: gotoTimeout,
            }),
            deadlineMs,
            'web-context page navigation timed out',
          )
        } catch (err) {
          const proxyBlock = proxy.getStats().lastBlockedReason
          const msg = err instanceof Error ? err.message : String(err)
          if (
            proxyBlock &&
            (msg.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
              msg.includes('ERR_INVALID_RESPONSE') ||
              msg.includes('ERR_ACCESS_DENIED'))
          ) {
            throw new Error(proxyBlock)
          }
          throw err
        }

        const settleBudget = Math.min(2_500, Math.max(0, deadlineMs - Date.now() - 250))
        if (settleBudget >= 200) {
          await mainPage.waitForLoadState('networkidle', { timeout: settleBudget }).catch(() => {})
        }
        const microWait = Math.min(150, Math.max(0, deadlineMs - Date.now()))
        if (microWait > 20) {
          await new Promise((resolve) => setTimeout(resolve, microWait))
        }

        const headers = response?.headers() ?? {}
        if (headers['x-openclaude-ssrf-blocked'] === '1') {
          throw new Error(
            headers['x-openclaude-ssrf-reason'] || 'URL resolves to a non-public IP address',
          )
        }

        const rawFinalUrl = mainPage.url()
        let finalUrl: string
        try {
          finalUrl = normalizeHttpUrl(rawFinalUrl).toString()
        } catch (err) {
          const proxyBlock = proxy.getStats().lastBlockedReason
          if (proxyBlock) throw new Error(proxyBlock)
          throw err
        }

        const html = await withDeadline(
          mainPage.content(),
          deadlineMs,
          'web-context page content read timed out',
        )
        const body = Buffer.from(html, 'utf8')
        if (body.length > maxDecodedBytes) {
          throw new Error('decoded response exceeds size limit')
        }

        return {
          url: rawUrl,
          finalUrl,
          status: response?.status() ?? 200,
          headers,
          body,
          contentType: headers['content-type'] ?? 'text/html; charset=utf-8',
          redirects: collectRedirectChain(response),
          proxyStats: proxy.getStats(),
          browserPid,
        }
      } finally {
        await closeBrowserSafely(context, browser, browserServer)
      }
    } finally {
      await proxy.close()
    }
  })
}

export async function checkWebContextBrowserHealth(
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebContextBrowserHealth> {
  const executable = resolveWebContextBrowserExecutable(env)
  let proxyOk = false
  let proxyErr: string | undefined

  try {
    const proxy = await startWebContextSsrfProxy({ socketTimeoutMs: 3_000 })
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: proxy.host,
            port: proxy.port,
            method: 'GET',
            path: 'http://example.com/',
            timeout: 2_000,
          },
          (res) => {
            res.resume()
            resolve(res.statusCode ?? 0)
          },
        )
        req.on('timeout', () => req.destroy(new Error('proxy health probe timed out')))
        req.on('error', reject)
        req.end()
      })
      proxyOk = status === 407
      if (!proxyOk) proxyErr = `unexpected proxy probe status: ${status}`
    } finally {
      await proxy.close()
    }
  } catch (err) {
    proxyErr = err instanceof Error ? err.message : String(err)
  }

  const error = !executable
    ? 'Chromium executable not found'
    : !proxyOk
      ? proxyErr ?? 'SSRF proxy self-check failed'
      : undefined

  return {
    ok: Boolean(executable) && proxyOk,
    executable,
    proxy: proxyOk,
    ...(error ? { error } : {}),
  }
}
