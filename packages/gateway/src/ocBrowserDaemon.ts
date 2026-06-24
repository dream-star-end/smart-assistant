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
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  OC_BROWSER_TOOLS,
  type OcBrowserRequest,
  type OcBrowserResponse,
  ocBrowserAgentDir,
  ocBrowserSocketPath,
  ocBrowserUserDataDir,
} from './ocBrowserShared.js'

const IDLE_TIMEOUT_MS = Number(process.env.OPENCLAUDE_OC_BROWSER_IDLE_MS) || 5 * 60_000
const PLAYWRIGHT_MCP_PKG = process.env.OPENCLAUDE_PLAYWRIGHT_MCP_PKG?.trim() || '@playwright/mcp'

function log(msg: string): void {
  process.stderr.write(`[oc-browser-daemon] ${msg}\n`)
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
    try {
      // transport.close() closes the child's stdin (clean MCP shutdown) and
      // terminates the @playwright/mcp process + its Chromium.
      transport?.close()
    } catch {}
    setTimeout(() => process.exit(code), 200)
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
    transport = new StdioClientTransport({
      command: 'npx',
      args: [
        '--no-install',
        PLAYWRIGHT_MCP_PKG,
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
      stderr: 'ignore',
    })
    const client = new Client({ name: 'oc-browser-daemon', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    // If the @playwright/mcp child dies later, the socket would stay live but
    // every callTool would fail; tear down so the next CLI lazy-starts a fresh
    // daemon instead of connecting to a dead one.
    transport.onclose = () => {
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

main().catch((err) => {
  log(`fatal: ${err?.message ?? String(err)}`)
  process.exit(1)
})
