/**
 * oc-browser daemon — keeps ONE `@playwright/mcp` session alive and serves it
 * over a per-agent Unix socket, so a `snapshot → click` workflow shares the
 * browser across separate `oc-browser` CLI invocations.
 *
 * Design (reviewed):
 *  - Reuse @playwright/mcp (no reimplementation of ref/snapshot/click semantics);
 *    talk to it with the official MCP SDK Client over a stdio child transport.
 *  - The Unix-socket bind is the singleton mutex: a second daemon that races to
 *    start gets EADDRINUSE, probes whether a live daemon is already serving, and
 *    exits — no separate lock file / race window.
 *  - Bind the socket first (mutex), then start the MCP child; connection handlers
 *    `await ready`, so a CLI that connects during startup simply waits.
 *  - @playwright/mcp version is pinned by the image (global install); we launch
 *    it with `npx --no-install` so there is never a runtime download / @latest.
 *  - Idle reaping only fires when there are no open connections AND no in-flight
 *    MCP call.
 */

import { existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { type Server, type Socket, connect as netConnect, createServer } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  type StdioServerParameters,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  OC_BROWSER_TOOLS,
  type OcBrowserRequest,
  type OcBrowserResponse,
  ocBrowserAgentDir,
  ocBrowserOutputRoot,
  ocBrowserSocketPath,
  ocBrowserUserDataDir,
} from './ocBrowserShared.js'

const IDLE_TIMEOUT_MS = Number(process.env.OPENCLAUDE_OC_BROWSER_IDLE_MS) || 5 * 60_000
const PLAYWRIGHT_MCP_PKG = process.env.OPENCLAUDE_PLAYWRIGHT_MCP_PKG?.trim() || '@playwright/mcp'

function log(msg: string): void {
  process.stderr.write(`[oc-browser-daemon] ${msg}\n`)
}

/**
 * 组装 @playwright/mcp 子进程的 StdioClientTransport 参数。抽成纯函数,便于单测断言
 * spawn 的 command/args/env/cwd(daemon `main()` 会 bind socket + 起子进程,有副作用,
 * 不适合在测试里直接 import 跑;所以模块底部用 isDirectExecution 守卫 main())。
 *
 * ── cwd 推导链:为什么把子进程 cwd 设成 agent 卷根,而不是传 `--output-dir` ──
 *   @playwright/mcp(0.0.76,镜像全局装)把 screenshot/pdf 等文件工具的可写根
 *   hardcode 成 `[outputDir, cwd]` 两个槽;outputDir 无 `--output-dir` 时默认 =
 *   `<cwd>/.playwright-mcp`。因此:
 *     cwd = OPENCLAUDE_HOME(= /home/agent/.openclaude,agent per-user volume 根)
 *     → allowed roots = [/home/agent/.openclaude/.playwright-mcp, /home/agent/.openclaude]
 *       ① 截图 `--path /home/agent/.openclaude/generated/x.png` 在第二个根下 → 合法
 *          (前端文件卡/下载的权威目录就是 generated/)。
 *       ② page snapshot 等 playwright 内部产物仍落隐藏的 `<cwd>/.playwright-mcp/`,
 *          不污染用户可见的 generated/ —— 这正是不选 `--output-dir generated` 的原因。
 *   旧行为:未传 cwd → 子进程继承 daemon 的 cwd = /opt/openclaude(oc-browser.sh
 *   `cd /opt/openclaude` + ocBrowserCli.spawnDaemon 的 cwd),roots 只含
 *   `/opt/openclaude*`,generated/ 不在其中 → 现网实测 "File access denied ...
 *   is outside allowed roots"。
 *
 * ── 只换这一个子进程的 cwd,不动 daemon 自身语义 ──
 *   daemon 进程与 tsx 模块解析仍需在 /opt/openclaude 跑(oc-browser.sh 的 cd 不动)。
 *   @playwright/mcp 走全局二进制(`npx --no-install @playwright/mcp`,非本地
 *   node_modules 依赖 —— 已取证 gateway 未把它列为依赖),换 cwd 不影响 npx 包解析。
 *
 * ── 健壮性 ──
 *   outputRoot 不存在(极端)时省略 cwd → 回落"继承 daemon cwd"的旧行为,不至于
 *   起不来。正常路径由 entrypoint.ts(mkdir /home/agent/.openclaude,:456-460)保证存在。
 */
export function buildPlaywrightMcpTransportParams(agentId: string): StdioServerParameters {
  const outputRoot = ocBrowserOutputRoot()
  return {
    command: 'npx',
    args: [
      '--no-install',
      PLAYWRIGHT_MCP_PKG,
      // @playwright/mcp 默认走 Chrome 品牌通道(/opt/google/chrome),镜像里装的
      // 是 playwright chromium(PLAYWRIGHT_BROWSERS_PATH 缓存)—— 不显式指定会报
      // "Chromium distribution 'chrome' is not found"(v3/v5 现网实测同病)。
      '--browser',
      'chromium',
      '--headless',
      '--no-sandbox',
      '--user-data-dir',
      ocBrowserUserDataDir(agentId),
    ],
    // StdioClientTransport's default env is a minimal allowlist that does NOT
    // forward PLAYWRIGHT_BROWSERS_PATH, so the child would look for Chromium in
    // the wrong cache and fail. Pass it through (the image installs it there).
    env: {
      ...getDefaultEnvironment(),
      PLAYWRIGHT_BROWSERS_PATH:
        process.env.PLAYWRIGHT_BROWSERS_PATH ?? '/usr/local/share/ms-playwright',
    },
    // cwd 见本函数 docblock 的推导链;目录缺失时省略以回落旧行为。
    ...(existsSync(outputRoot) ? { cwd: outputRoot } : {}),
    stderr: 'ignore',
  }
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return resolve(argv1) === fileURLToPath(import.meta.url)
}

function socketLive(socketPath: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const probe = netConnect(socketPath)
    const done = (live: boolean) => {
      probe.destroy()
      resolvePromise(live)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
    setTimeout(() => done(false), 1_000)
  })
}

async function main(): Promise<void> {
  const agentId = process.argv[2]?.trim() || 'default'
  const agentDir = ocBrowserAgentDir(agentId)
  const socketPath = ocBrowserSocketPath(agentId)
  mkdirSync(agentDir, { recursive: true, mode: 0o700 })

  // ── State ──
  let mcp: Client | null = null
  let transport: StdioClientTransport | null = null
  let readyResolve!: () => void
  let readyReject!: (e: Error) => void
  const ready = new Promise<void>((res, rej) => {
    readyResolve = res
    readyReject = rej
  })
  let openConnections = 0
  let inFlight = 0
  let idleTimer: NodeJS.Timeout | null = null
  let shuttingDown = false

  const shutdown = (code: number) => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      server.close()
    } catch {}
    try {
      if (existsSync(socketPath)) unlinkSync(socketPath)
    } catch {}
    // transport.close() closes the child's stdin (clean MCP shutdown) then
    // SIGTERM/SIGKILLs @playwright/mcp + its Chromium. Await it (bounded) so the
    // browser is actually reaped, then exit regardless.
    const exit = () => process.exit(code)
    const cap = setTimeout(exit, 3_000)
    Promise.resolve(transport?.close())
      .catch(() => {})
      .finally(() => {
        clearTimeout(cap)
        exit()
      })
  }

  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      if (openConnections === 0 && inFlight === 0) {
        log('idle timeout — shutting down')
        shutdown(0)
      } else {
        armIdle()
      }
    }, IDLE_TIMEOUT_MS)
  }

  // ── Socket server (handlers wait for `ready`) ──
  const server: Server = createServer((sock: Socket) => {
    openConnections += 1
    if (idleTimer) clearTimeout(idleTimer)
    let buf = ''
    let handled = false
    sock.setEncoding('utf8')
    sock.on('data', async (chunk: string) => {
      if (handled) return
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      handled = true
      const line = buf.slice(0, nl)
      const res = await handleRequest(line)
      sock.write(`${JSON.stringify(res)}\n`)
      sock.end()
    })
    const onClose = () => {
      openConnections -= 1
      if (openConnections === 0 && inFlight === 0) armIdle()
    }
    sock.on('close', onClose)
    sock.on('error', () => {})
  })

  async function handleRequest(line: string): Promise<OcBrowserResponse> {
    let req: OcBrowserRequest
    try {
      req = JSON.parse(line) as OcBrowserRequest
    } catch {
      return { ok: false, error: 'malformed request' }
    }
    if (!req || typeof req.tool !== 'string') return { ok: false, error: 'missing tool' }
    if (!OC_BROWSER_TOOLS.includes(req.tool as (typeof OC_BROWSER_TOOLS)[number])) {
      return { ok: false, error: `unknown tool ${req.tool}` }
    }
    try {
      await ready
    } catch (err) {
      return { ok: false, error: `browser unavailable: ${(err as Error).message}` }
    }
    inFlight += 1
    try {
      const result = await mcp!.callTool({
        name: req.tool,
        arguments: (req.args ?? {}) as Record<string, unknown>,
      })
      return { ok: true, result }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    } finally {
      inFlight -= 1
      // Re-arm idle if the client already disconnected while this call was in
      // flight (the close handler skipped arming because inFlight was > 0).
      if (openConnections === 0 && inFlight === 0) armIdle()
    }
  }

  // ── Bind (singleton mutex), then start the MCP child ──
  await new Promise<void>((resolveBind) => {
    const tryListen = (retried: boolean) => {
      server.once('error', async (err: NodeJS.ErrnoException) => {
        if (err.code !== 'EADDRINUSE') {
          log(`listen error: ${err.message}`)
          process.exit(1)
        }
        if (await socketLive(socketPath)) {
          log('another daemon already serving — exiting')
          process.exit(0)
        }
        if (retried) {
          log('socket still in use after cleanup — exiting')
          process.exit(0)
        }
        try {
          unlinkSync(socketPath)
        } catch {}
        tryListen(true)
      })
      server.listen(socketPath, () => resolveBind())
    }
    tryListen(false)
  })
  log(`listening on ${socketPath}`)
  armIdle()

  process.on('SIGTERM', () => shutdown(0))
  process.on('SIGINT', () => shutdown(0))

  // ── Start @playwright/mcp via the official MCP client ──
  try {
    // 子进程 cwd = agent 卷根(见 buildPlaywrightMcpTransportParams docblock),让
    // 截图能落 generated/;env/args 亦在此收口以便单测。
    transport = new StdioClientTransport(buildPlaywrightMcpTransportParams(agentId))
    const client = new Client({ name: 'oc-browser-daemon', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    // If the @playwright/mcp child dies later, the socket would stay live but
    // every callTool would fail; tear down so the next CLI lazy-starts a fresh
    // daemon instead of connecting to a dead one. CHAIN (do not overwrite) the
    // SDK's onclose so it still rejects any in-flight listTools/callTool promises
    // immediately instead of leaving the CLI hung until its call timeout.
    const sdkOnClose = transport.onclose
    transport.onclose = () => {
      sdkOnClose?.()
      if (!shuttingDown) {
        log('@playwright/mcp transport closed — shutting down')
        shutdown(1)
      }
    }
    // Validate the expected tools exist so a pinned-version bump fails loudly.
    const { tools } = await client.listTools()
    const names = new Set(tools.map((t) => t.name))
    const missing = OC_BROWSER_TOOLS.filter((t) => !names.has(t))
    if (missing.length > 0) {
      throw new Error(`@playwright/mcp missing expected tools: ${missing.join(', ')}`)
    }
    mcp = client
    readyResolve()
    log('@playwright/mcp ready')
  } catch (err) {
    log(`failed to start @playwright/mcp: ${(err as Error).message}`)
    readyReject(err as Error)
    shutdown(1)
  }
}

// 仅在被当作脚本直接执行时启动 daemon(npx tsx ocBrowserDaemon.ts <agentId>)。
// import(单测)时不跑 main() —— 避免 bind socket / 起子进程的副作用。与
// ocBrowserCli.ts 的同款守卫一致。
if (isDirectExecution()) {
  main().catch((err) => {
    log(`fatal: ${err?.message ?? String(err)}`)
    process.exit(1)
  })
}
