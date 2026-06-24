/**
 * oc-web — thin CLI front-end over the web-context extraction core.
 *
 * Replaces the web-context MCP server's agent-facing surface: instead of the
 * `web_context_*` MCP tools, the in-container agent runs `oc-web extract <url>`
 * / `oc-web parse <file>` via Bash. All fetching plus the SSRF / path-allowlist
 * / size / blocked-content safety lives in mcpWebContextServer.ts
 * (extractUrl / parseFile / healthCheck) and is reused verbatim — this file only
 * parses argv and formats output, so the safety boundary cannot drift.
 *
 * Invoked the same way as its sibling MCP entry (no shebang / not node-direct):
 * the runtime ships `/usr/local/bin/oc-web` as a wrapper that runs
 * `exec npx tsx <this file> "$@"`, so TS is stripped by tsx at run time.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractUrl, healthCheck, parseFile } from './mcpWebContextServer.js'

export type OcWebCliResult = {
  exitCode: number
  stdout: string
  stderr: string
}

// Known flags, split by arity so the parser can reject typos / missing values
// instead of silently defaulting (this CLI is driven by a model, which will
// occasionally emit `--flag=value` or misspell a flag).
const BOOLEAN_FLAGS = new Set(['json'])
const VALUE_FLAGS = new Set(['max-chars', 'timeout-ms', 'mode', 'max-file-bytes'])

const USAGE = [
  'Usage: oc-web <command> [options]',
  '',
  'Commands:',
  '  extract <url>        Fetch a public URL and extract clean Markdown',
  '  parse <file>         Parse a local uploaded/generated file into Markdown',
  '  health               Check parser dependency availability',
  '',
  'Options:',
  '  --json               Print the full JSON result instead of Markdown',
  '  --max-chars <n>      Max output characters',
  '  --timeout-ms <n>     Per-call timeout in milliseconds',
  '  --mode <m>           extract mode: auto (default) | static | browser',
  '  --max-file-bytes <n> parse: max input file size in bytes',
].join('\n')

type ParsedFlags =
  | { ok: true; flags: Record<string, string | boolean>; positional: string[] }
  | { ok: false; error: string }

function parseFlags(rest: string[]): ParsedFlags {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (!tok.startsWith('--')) {
      positional.push(tok)
      continue
    }
    const body = tok.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    const inlineValue = eq >= 0 ? body.slice(eq + 1) : undefined

    if (BOOLEAN_FLAGS.has(key)) {
      if (inlineValue !== undefined) return { ok: false, error: `flag --${key} takes no value` }
      flags[key] = true
      continue
    }
    if (VALUE_FLAGS.has(key)) {
      if (inlineValue !== undefined) {
        flags[key] = inlineValue
        continue
      }
      const next = rest[i + 1]
      if (next === undefined || next.startsWith('--')) {
        return { ok: false, error: `flag --${key} requires a value` }
      }
      flags[key] = next
      i++
      continue
    }
    return { ok: false, error: `unknown flag --${key}` }
  }
  return { ok: true, flags, positional }
}

function numFlag(v: string | boolean | undefined): number | undefined {
  if (typeof v !== 'string') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function formatResult(result: Record<string, unknown>, asJson: boolean): OcWebCliResult {
  const ok = result.ok !== false
  if (asJson) {
    return { exitCode: ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n`, stderr: '' }
  }
  if (!ok) {
    const reason =
      typeof result.error === 'string'
        ? result.error
        : typeof result.blocked_reason === 'string'
          ? `blocked: ${result.blocked_reason}`
          : 'extraction failed'
    return { exitCode: 1, stdout: '', stderr: `oc-web: ${reason}\n` }
  }
  const body =
    typeof result.markdown === 'string'
      ? result.markdown
      : typeof result.text === 'string'
        ? result.text
        : JSON.stringify(result)
  return { exitCode: 0, stdout: body.endsWith('\n') ? body : `${body}\n`, stderr: '' }
}

function usageError(message: string): OcWebCliResult {
  return { exitCode: 2, stdout: '', stderr: `oc-web: ${message}\n` }
}

export async function runOcWebCli(argv: string[]): Promise<OcWebCliResult> {
  const [command, ...rest] = argv
  if (!command) return { exitCode: 2, stdout: '', stderr: `${USAGE}\n` }
  if (command === 'help' || command === '--help' || command === '-h') {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: '' }
  }
  const parsed = parseFlags(rest)
  if (!parsed.ok) return usageError(parsed.error)
  const { flags, positional } = parsed
  const asJson = flags.json === true

  try {
    if (command === 'extract') {
      if (positional.length === 0) return usageError('extract requires a <url>')
      if (positional.length > 1) return usageError('extract takes a single <url>')
      const result = await extractUrl({
        url: positional[0],
        mode: typeof flags.mode === 'string' ? flags.mode : undefined,
        max_chars: numFlag(flags['max-chars']),
        timeout_ms: numFlag(flags['timeout-ms']),
      })
      return formatResult(result, asJson)
    }
    if (command === 'parse') {
      if (positional.length === 0) return usageError('parse requires a <file>')
      if (positional.length > 1) return usageError('parse takes a single <file>')
      const result = await parseFile({
        file_path: positional[0],
        max_chars: numFlag(flags['max-chars']),
        timeout_ms: numFlag(flags['timeout-ms']),
        max_file_bytes: numFlag(flags['max-file-bytes']),
      })
      return formatResult(result, asJson)
    }
    if (command === 'health') {
      if (positional.length > 0) return usageError('health takes no arguments')
      return formatResult(await healthCheck(), asJson)
    }
    return usageError(`unknown command '${command}'\n${USAGE}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (asJson) {
      return {
        exitCode: 1,
        stdout: `${JSON.stringify({ ok: false, error: message })}\n`,
        stderr: '',
      }
    }
    return { exitCode: 1, stdout: '', stderr: `oc-web: ${message}\n` }
  }
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return resolve(argv1) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
  runOcWebCli(process.argv.slice(2))
    .then((r) => {
      if (r.stdout) process.stdout.write(r.stdout)
      if (r.stderr) process.stderr.write(r.stderr)
      process.exit(r.exitCode)
    })
    .catch((err) => {
      process.stderr.write(`oc-web: fatal: ${err?.message ?? String(err)}\n`)
      process.exit(1)
    })
}
