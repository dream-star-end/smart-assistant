/**
 * oc-browser — thin CLI client over the oc-browser daemon (ocBrowserDaemon.ts),
 * which keeps one `@playwright/mcp` session alive. Replaces the per-call browser
 * MCP tools with `oc-browser <verb>` Bash invocations + the `browser` skill.
 *
 * Invoked via the /usr/local/bin/oc-browser wrapper (npx tsx), same as oc-web.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type OcBrowserRequest,
  type OcBrowserResponse,
  ocBrowserAgentId,
  ocBrowserSocketPath,
} from './ocBrowserShared.js'

export type OcBrowserCliResult = { exitCode: number; stdout: string; stderr: string }

// Per-subcommand flag specs: which flags are required vs optional, and how they
// map onto the underlying @playwright/mcp tool + argument object.
type FlagKind = 'string' | 'boolean' | 'number'
type SubcommandSpec = {
  tool: string
  flags: Record<string, { kind: FlagKind; required?: boolean; arg: string }>
}

const SUBCOMMANDS: Record<string, SubcommandSpec> = {
  navigate: {
    tool: 'browser_navigate',
    flags: { url: { kind: 'string', required: true, arg: 'url' } },
  },
  snapshot: { tool: 'browser_snapshot', flags: {} },
  click: {
    tool: 'browser_click',
    flags: {
      ref: { kind: 'string', required: true, arg: 'ref' },
      element: { kind: 'string', required: true, arg: 'element' },
    },
  },
  type: {
    tool: 'browser_type',
    flags: {
      ref: { kind: 'string', required: true, arg: 'ref' },
      element: { kind: 'string', required: true, arg: 'element' },
      text: { kind: 'string', required: true, arg: 'text' },
      submit: { kind: 'boolean', arg: 'submit' },
    },
  },
  'press-key': {
    tool: 'browser_press_key',
    flags: { key: { kind: 'string', required: true, arg: 'key' } },
  },
  screenshot: {
    tool: 'browser_take_screenshot',
    flags: {
      path: { kind: 'string', arg: 'filename' },
      'full-page': { kind: 'boolean', arg: 'fullPage' },
    },
  },
  'wait-for': {
    tool: 'browser_wait_for',
    flags: {
      text: { kind: 'string', arg: 'text' },
      'text-gone': { kind: 'string', arg: 'textGone' },
      time: { kind: 'number', arg: 'time' },
    },
  },
}

const USAGE = [
  'Usage: oc-browser <command> [options]',
  '',
  'Commands (session is shared across calls; start with snapshot to get refs):',
  '  navigate --url <url>',
  '  snapshot',
  '  click --ref <ref> --element <description>',
  '  type --ref <ref> --element <description> --text <text> [--submit]',
  '  press-key --key <key>',
  '  screenshot [--path <file>] [--full-page]',
  '  wait-for [--text <t>] [--text-gone <t>] [--time <seconds>]',
  '',
  'Options:',
  '  --json   Print the raw daemon result instead of a summary',
].join('\n')

export type ParsedCommand =
  | { ok: true; tool: string; args: Record<string, unknown>; asJson: boolean }
  | { ok: false; exitCode: number; message: string }

// Pure argv → {tool,args} mapping. Exported so it can be unit-tested without a
// running daemon or a real browser.
export function parseOcBrowserCommand(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv
  if (!command) return { ok: false, exitCode: 2, message: `${USAGE}\n` }
  if (command === 'help' || command === '--help' || command === '-h') {
    return { ok: false, exitCode: 0, message: `${USAGE}\n` }
  }
  const spec = SUBCOMMANDS[command]
  if (!spec)
    return { ok: false, exitCode: 2, message: `oc-browser: unknown command '${command}'\n` }

  const known = spec.flags
  const args: Record<string, unknown> = {}
  let asJson = false
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) {
      return { ok: false, exitCode: 2, message: `oc-browser: unexpected argument '${tok}'\n` }
    }
    const body = tok.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    let value: string | undefined = eq >= 0 ? body.slice(eq + 1) : undefined

    if (key === 'json') {
      if (value !== undefined) return usageErr('flag --json takes no value')
      asJson = true
      continue
    }
    const flag = known[key]
    if (!flag) return usageErr(`unknown flag --${key} for '${command}'`)
    if (flag.kind === 'boolean') {
      if (value !== undefined) return usageErr(`flag --${key} takes no value`)
      args[flag.arg] = true
      continue
    }
    if (value === undefined) {
      const next = rest[i + 1]
      if (next === undefined || next.startsWith('--'))
        return usageErr(`flag --${key} requires a value`)
      value = next
      i++
    }
    if (flag.kind === 'number') {
      const n = Number(value)
      if (!Number.isFinite(n)) return usageErr(`flag --${key} must be a number`)
      args[flag.arg] = n
    } else {
      args[flag.arg] = value
    }
  }

  for (const [name, flag] of Object.entries(known)) {
    if (flag.required && !(flag.arg in args)) return usageErr(`'${command}' requires --${name}`)
  }
  return { ok: true, tool: spec.tool, args, asJson }
}

function usageErr(message: string): ParsedCommand {
  return { ok: false, exitCode: 2, message: `oc-browser: ${message}\n` }
}

// ── Transport: connect to the per-agent daemon, lazily starting it ──

const DAEMON_START_TIMEOUT_MS = 30_000
const CALL_TIMEOUT_MS = 120_000

function daemonEntryPath(): string {
  return resolve(fileURLToPath(new URL('.', import.meta.url)), 'ocBrowserDaemon.ts')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function trySendOnce(socketPath: string, req: OcBrowserRequest): Promise<OcBrowserResponse> {
  return new Promise((resolvePromise, reject) => {
    const sock = connect(socketPath)
    let buf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      sock.destroy()
      reject(new Error('daemon call timed out'))
    }, CALL_TIMEOUT_MS)
    sock.on('connect', () => sock.write(`${JSON.stringify(req)}\n`))
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl < 0 || settled) return
      settled = true
      clearTimeout(timer)
      sock.end()
      try {
        resolvePromise(JSON.parse(buf.slice(0, nl)) as OcBrowserResponse)
      } catch (err) {
        reject(new Error(`bad daemon response: ${(err as Error).message}`))
      }
    })
    sock.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

function spawnDaemon(agentId: string): void {
  // Detached so the daemon outlives this CLI process. The daemon itself handles
  // the start lock, so racing CLIs spawning it concurrently is safe.
  const child = spawn('npx', ['--no-install', 'tsx', daemonEntryPath(), agentId], {
    detached: true,
    stdio: 'ignore',
    cwd: resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..'),
  })
  child.unref()
}

export async function runOcBrowser(argv: string[]): Promise<OcBrowserCliResult> {
  const parsed = parseOcBrowserCommand(argv)
  if (!parsed.ok) {
    return parsed.exitCode === 0
      ? { exitCode: 0, stdout: parsed.message, stderr: '' }
      : { exitCode: parsed.exitCode, stdout: '', stderr: parsed.message }
  }
  const agentId = ocBrowserAgentId()
  const socketPath = ocBrowserSocketPath(agentId)
  const req: OcBrowserRequest = { tool: parsed.tool, args: parsed.args }

  // Connect-with-lazy-start. We only retry the CONNECT (before the request is
  // sent); once a request reaches the daemon we never replay it, so a dropped
  // mid-call never double-executes a non-idempotent click/type/press-key.
  let spawned = false
  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  for (;;) {
    if (existsSync(socketPath)) {
      try {
        const res = await trySendOnce(socketPath, req)
        return formatResponse(res, parsed.asJson)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        // Connection-level failure before send → daemon down / stale socket; fall
        // through to (re)start. A timeout/protocol error after send is terminal.
        if (code !== 'ECONNREFUSED' && code !== 'ENOENT') {
          return { exitCode: 1, stdout: '', stderr: `oc-browser: ${(err as Error).message}\n` }
        }
      }
    }
    if (!spawned) {
      spawnDaemon(agentId)
      spawned = true
    }
    if (Date.now() > deadline) {
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'oc-browser: daemon did not become ready in time\n',
      }
    }
    await sleep(250)
  }
}

function formatResponse(res: OcBrowserResponse, asJson: boolean): OcBrowserCliResult {
  if (asJson) {
    return { exitCode: res.ok ? 0 : 1, stdout: `${JSON.stringify(res)}\n`, stderr: '' }
  }
  if (!res.ok) return { exitCode: 1, stdout: '', stderr: `oc-browser: ${res.error}\n` }
  // The daemon returns the MCP tool result; surface its text content for humans.
  const text = extractText(res.result)
  return { exitCode: 0, stdout: text ? `${text}\n` : `${JSON.stringify(res.result)}\n`, stderr: '' }
}

function extractText(result: unknown): string | null {
  if (result && typeof result === 'object' && 'content' in result) {
    const content = (result as { content?: unknown }).content
    if (Array.isArray(content)) {
      const parts = content
        .filter((c): c is { type: string; text: string } => {
          return !!c && typeof c === 'object' && (c as { type?: unknown }).type === 'text'
        })
        .map((c) => c.text)
      if (parts.length > 0) return parts.join('\n')
    }
  }
  return null
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return resolve(argv1) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
  runOcBrowser(process.argv.slice(2))
    .then((r) => {
      if (r.stdout) process.stdout.write(r.stdout)
      if (r.stderr) process.stderr.write(r.stderr)
      process.exit(r.exitCode)
    })
    .catch((err) => {
      process.stderr.write(`oc-browser: fatal: ${err?.message ?? String(err)}\n`)
      process.exit(1)
    })
}
