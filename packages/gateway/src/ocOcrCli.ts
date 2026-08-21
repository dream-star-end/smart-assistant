import { statSync } from 'node:fs'
/**
 * oc-ocr — submit, observe, cancel and download complete OCR jobs.
 * Progress is emitted on stderr; stdout remains machine-readable JSON.
 */
import { resolve } from 'node:path'

import {
  type OcrFormat,
  type OcrMode,
  cancelOcr,
  downloadOcr,
  statusOcr,
  submitOcr,
} from './ocOcrClient.js'
import { exitWithCliHelp, fail, isCliHelpArg, out, parseFlags } from './ocResearchClient.js'

const TOOL = 'oc-ocr'
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

function usage(): never {
  fail(
    TOOL,
    'usage: oc-ocr run <file> --out <path> [--mode hybrid|pp|vl] [--fallback 0.10] [--format markdown|jsonl] | submit <file> | status <ticket> | cancel <ticket> | download <ticket> --out <path>',
  )
}

function options(flags: Record<string, string>): {
  mode: OcrMode
  fallback: number
  format: OcrFormat
} {
  const mode = (flags.mode ?? 'hybrid') as OcrMode
  if (!(['hybrid', 'pp', 'vl'] as string[]).includes(mode))
    fail(TOOL, '--mode must be hybrid, pp, or vl')
  const fallback = Number(flags.fallback ?? '0.10')
  if (!Number.isFinite(fallback) || fallback < 0 || fallback > 1)
    fail(TOOL, '--fallback must be between 0 and 1')
  const format = (flags.format ?? 'markdown') as OcrFormat
  if (format !== 'markdown' && format !== 'jsonl') fail(TOOL, '--format must be markdown or jsonl')
  return { mode, fallback, format }
}

function readableFile(path: string): string {
  const absolute = resolve(path)
  try {
    if (!statSync(absolute).isFile()) throw new Error('not a file')
  } catch {
    fail(TOOL, `cannot read file: ${path}`)
  }
  return absolute
}

function progress(value: any): void {
  const done = Number(value.pages_done ?? 0)
  const total = value.pages_total == null ? '?' : String(value.pages_total)
  const eta =
    value.eta_seconds == null ? '?' : `${Math.max(0, Math.round(Number(value.eta_seconds)))}s`
  const position = value.queue_position == null ? '' : ` queue=${value.queue_position}`
  process.stderr.write(
    `[oc-ocr] ${value.status} phase=${value.phase ?? '-'} pages=${done}/${total} eta=${eta}${position}\n`,
  )
}

async function wait(ticket: string, onTicket?: (ticket: string) => void): Promise<any> {
  onTicket?.(ticket)
  let last = ''
  for (;;) {
    const value = await statusOcr(ticket)
    const marker = JSON.stringify([
      value.status,
      value.phase,
      value.pages_done,
      value.pages_total,
      value.queue_position,
    ])
    if (marker !== last) {
      progress(value)
      last = marker
    }
    if (TERMINAL.has(String(value.status))) return value
    await new Promise((done) => setTimeout(done, 2_000))
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (isCliHelpArg(cmd)) {
    exitWithCliHelp(
      'usage: oc-ocr run <file> --out <path> [--mode hybrid|pp|vl] [--fallback 0.10] [--format markdown|jsonl] | submit <file> | status <ticket> | cancel <ticket> | download <ticket> --out <path>',
    )
  }
  const { positional, flags } = parseFlags(rest)

  if (cmd === 'submit' || cmd === 'run') {
    const input = positional[0]
    if (!input) fail(TOOL, `${cmd} <file>`)
    const file = readableFile(input)
    const opts = options(flags)
    const submitted = await submitOcr(file, opts)
    if (cmd === 'submit') {
      out(submitted)
      return
    }
    const output = flags.out
    if (!output) fail(TOOL, 'run requires --out <path>')
    const ticket = String(submitted.ticket)
    let cancelling = false
    const cancelOnSignal = async (signal: NodeJS.Signals): Promise<void> => {
      if (cancelling) return
      cancelling = true
      process.stderr.write(`[oc-ocr] ${signal}: cancelling ${ticket}\n`)
      try {
        await cancelOcr(ticket)
      } catch {}
      process.exit(130)
    }
    process.once('SIGINT', cancelOnSignal)
    process.once('SIGTERM', cancelOnSignal)
    process.stderr.write(`[oc-ocr] ticket=${ticket}\n`)
    const status = await wait(ticket)
    if (status.status !== 'completed') throw new Error(status.error ?? `job ${status.status}`)
    await downloadOcr(ticket, opts.format, resolve(output))
    process.removeListener('SIGINT', cancelOnSignal)
    process.removeListener('SIGTERM', cancelOnSignal)
    out({
      ticket,
      status: 'completed',
      output: resolve(output),
      format: opts.format,
      pages: status.pages_total,
    })
    return
  }

  if (cmd === 'status' || cmd === 'cancel') {
    const ticket = positional[0]
    if (!ticket) fail(TOOL, `${cmd} <ticket>`)
    out(cmd === 'status' ? await statusOcr(ticket) : await cancelOcr(ticket))
    return
  }

  if (cmd === 'download') {
    const ticket = positional[0]
    const output = flags.out
    if (!ticket || !output) fail(TOOL, 'download <ticket> --out <path>')
    const opts = options(flags)
    await downloadOcr(ticket, opts.format, resolve(output))
    out({ ticket, output: resolve(output), format: opts.format })
    return
  }

  usage()
}

main().catch((err) => fail(TOOL, err instanceof Error ? err.message : String(err)))
