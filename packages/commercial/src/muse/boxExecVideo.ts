// OCV5-750: optional second Muse video backend (Box Exec → local muse-exec-cli → relay).
// Default remains the hatch / muse_bridge.py path. This module is only used when
// OC_MUSE_VIDEO_BACKEND=box-exec (or a runtime override to the same value).

import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BoxCcExecRequest } from '@openclaude/gateway'

import type { MuseJobSpec } from './protocol.js'
import { MuseError } from './protocol.js'

export const MUSE_VIDEO_BACKENDS = ['hatch', 'box-exec'] as const
export type MuseVideoBackend = (typeof MUSE_VIDEO_BACKENDS)[number]

export const MUSE_RELAY_MODES = ['native', 'first_frame', 'reference', 'composite'] as const
export type MuseRelayMode = (typeof MUSE_RELAY_MODES)[number]

export const DEFAULT_MUSE_VIDEO_BACKEND: MuseVideoBackend = 'hatch'
export const BOX_EXEC_MAX_CONCURRENCY = 5
export const BOX_EXEC_CHUNK_BYTES = 65_536
export const BOX_EXEC_CLI = '/workspace/muse-relay/bin/muse-exec-cli'
export const BOX_EXEC_PYTHON = '/usr/bin/python3'
export const BOX_EXEC_NATIVE_DEADLINE_MS = 6 * 60_000
export const BOX_EXEC_COMPOSITE_DEADLINE_MS = 12 * 60_000
export const BOX_EXEC_POLL_MS = 5_000

export function parseMuseVideoBackend(raw: string | undefined): MuseVideoBackend {
  const value = (raw ?? '').trim()
  if (!value) return DEFAULT_MUSE_VIDEO_BACKEND
  if ((MUSE_VIDEO_BACKENDS as readonly string[]).includes(value)) return value as MuseVideoBackend
  throw new MuseError(500, 'MUSE_INVALID_INPUT', 'OC_MUSE_VIDEO_BACKEND must be hatch or box-exec')
}

export function mapRelayMode(spec: MuseJobSpec): MuseRelayMode {
  const explicit = spec.mode
  if (explicit === 'composite') return 'composite'
  if (explicit === 'native' || explicit === 'first_frame' || explicit === 'reference')
    return explicit
  const n = spec.source_images?.length ?? 0
  if (n <= 0) return 'native'
  if (n === 1) return 'first_frame'
  return 'reference'
}

export function canRouteToBoxExec(backend: MuseVideoBackend, spec: MuseJobSpec): boolean {
  if (backend !== 'box-exec') return false
  if (spec.kind !== 'video') return false
  if (spec.resume_snapshot_id) return false
  return true
}

export function boxExecDeadlineMs(spec: MuseJobSpec): number {
  return mapRelayMode(spec) === 'composite'
    ? BOX_EXEC_COMPOSITE_DEADLINE_MS
    : BOX_EXEC_NATIVE_DEADLINE_MS
}

export interface BoxCliExecResult {
  stdout: string
}

export type BoxCliExecFn = (
  request: BoxCcExecRequest,
  opts: { timeoutMs: number; maxResponseBytes?: number; signal?: AbortSignal },
) => Promise<BoxCliExecResult>

export function museExecRequest(args: string[]): BoxCcExecRequest {
  return {
    command: BOX_EXEC_PYTHON,
    args: ['-I', BOX_EXEC_CLI, ...args],
    cwd: '/tmp',
    environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
  }
}

export function mapRelayFailure(
  message: string,
  code?: string,
): {
  code: string
  message: string
  retryable: boolean
} {
  const text = `${code ?? ''} ${message}`.toLowerCase()
  if (text.includes('logged_in') && text.includes('false')) {
    return {
      code: 'MUSE_UPSTREAM_ERROR',
      message: 'Muse login expired or signed out',
      retryable: true,
    }
  }
  if (
    text.includes('paywall') ||
    text.includes('usage cap') ||
    text.includes('usage limit') ||
    text.includes('upgrade')
  ) {
    return {
      code: 'MUSE_UPSTREAM_REJECTED',
      message: message || 'Muse usage cap',
      retryable: false,
    }
  }
  if (
    text.includes('muse_relay_down') ||
    text.includes('relay unreachable') ||
    text.includes('econnrefused')
  ) {
    return {
      code: 'MUSE_BRIDGE_OFFLINE',
      message: message || 'Muse relay is down',
      retryable: true,
    }
  }
  if (text.includes('mode_mismatch')) {
    return {
      code: 'MUSE_BAD_OUTPUT',
      message: message || 'relay reported a mode mismatch',
      retryable: false,
    }
  }
  if (code?.startsWith('MUSE_')) {
    return { code, message, retryable: /timeout|offline|lost|upstream_error|busy/i.test(code) }
  }
  return {
    code: code?.startsWith('MUSE_') ? code : 'MUSE_UPSTREAM_ERROR',
    message,
    retryable: true,
  }
}

function parseCliJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split(/\n/).filter(Boolean).at(-1) ?? ''
  try {
    const value = JSON.parse(line) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not object')
    return value as Record<string, unknown>
  } catch {
    throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'muse-exec-cli returned non-JSON')
  }
}

async function runCli(
  exec: BoxCliExecFn,
  args: string[],
  opts: { timeoutMs: number; maxResponseBytes?: number; signal?: AbortSignal },
): Promise<Record<string, unknown>> {
  const result = await exec(museExecRequest(args), opts)
  const payload = parseCliJson(result.stdout)
  if (payload.ok === false) {
    const mapped = mapRelayFailure(
      String(payload.message ?? 'cli failed'),
      String(payload.code ?? ''),
    )
    throw new MuseError(502, mapped.code, mapped.message, mapped.retryable)
  }
  return payload
}

export function applyChunk(
  chunks: Buffer[],
  expected: { sha256?: string; total?: number },
  frame: { offset: number; data: Buffer; total: number; sha256: string },
): { eof: boolean; total: number; sha256: string } {
  if (frame.offset !== chunks.reduce((n, part) => n + part.length, 0)) {
    throw new MuseError(502, 'MUSE_BAD_OUTPUT', `chunk offset mismatch: got ${frame.offset}`)
  }
  if (expected.total !== undefined && expected.total !== frame.total) {
    throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'chunk total changed between reads')
  }
  if (expected.sha256 && expected.sha256 !== frame.sha256) {
    throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'chunk sha256 changed between reads')
  }
  chunks.push(frame.data)
  const have = chunks.reduce((n, part) => n + part.length, 0)
  if (have > frame.total) throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'chunk overflow')
  return { eof: have >= frame.total, total: frame.total, sha256: frame.sha256 }
}

export async function downloadRelayFile(
  exec: BoxCliExecFn,
  jobId: string,
  index: number,
  signal?: AbortSignal,
): Promise<{ bytes: Buffer; sha256: string }> {
  const parts: Buffer[] = []
  let expected: { sha256?: string; total?: number } = {}
  for (;;) {
    const have = parts.reduce((n, part) => n + part.length, 0)
    const payload = await runCli(
      exec,
      ['fetch-chunk', jobId, String(index), String(have), String(BOX_EXEC_CHUNK_BYTES)],
      { timeoutMs: 30_000, maxResponseBytes: 131_072, signal },
    )
    const data = Buffer.from(String(payload.data ?? ''), 'base64')
    const frame = {
      offset: Number(payload.offset),
      data,
      total: Number(payload.total),
      sha256: String(payload.sha256 ?? ''),
    }
    if (!Number.isInteger(frame.offset) || !Number.isInteger(frame.total) || !frame.sha256) {
      throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'invalid fetch-chunk frame')
    }
    const next = applyChunk(parts, expected, frame)
    expected = { sha256: next.sha256, total: next.total }
    if (next.eof) break
  }
  const bytes = Buffer.concat(parts)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== expected.sha256) {
    throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'reassembled MP4 sha256 mismatch')
  }
  return { bytes, sha256: digest }
}

async function writeBoxFile(
  exec: BoxCliExecFn,
  path: string,
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<void> {
  const chunk = 48 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const slice = bytes.subarray(offset, offset + chunk)
    await runCli(exec, ['write-chunk', path, String(offset), slice.toString('base64')], {
      timeoutMs: 30_000,
      signal,
    })
  }
}

export interface BoxExecVideoSuccess {
  files: Array<{
    idx: number
    filename: string
    mime: string
    bytes: number
    sha256: string
    path: string
  }>
  snapshotId: null
  artifactIds: string[]
  modeMismatch: boolean
}

export async function runBoxExecVideoJob(input: {
  exec: BoxCliExecFn
  spec: MuseJobSpec
  destDir: string
  now?: () => number
  pollMs?: number
  signal?: AbortSignal
}): Promise<BoxExecVideoSuccess> {
  const mode = mapRelayMode(input.spec)
  const count = Math.max(1, Math.min(6, input.spec.count ?? 1))
  await mkdir(input.destDir, { recursive: true, mode: 0o700 })
  const args = ['submit', '--prompt', input.spec.prompt, '--mode', mode, '--count', String(count)]
  if (input.spec.orientation) args.push('--orientation', input.spec.orientation)
  if (input.spec.aspect_ratio) {
    args.push(
      '--orientation',
      input.spec.aspect_ratio === '9:16'
        ? 'vertical'
        : input.spec.aspect_ratio === '1:1'
          ? 'square'
          : 'landscape',
    )
  }
  const sources = input.spec.source_images ?? []
  const stamp = createHash('sha256')
    .update(`${Date.now()}:${input.spec.prompt}`)
    .digest('hex')
    .slice(0, 16)
  for (const [i, raw] of sources.entries()) {
    const remote = `/tmp/oc-muse-${stamp}-${i}.img`
    await writeBoxFile(input.exec, remote, Buffer.from(raw, 'base64'), input.signal)
    args.push('--image', remote)
  }
  const submitted = await runCli(input.exec, args, { timeoutMs: 60_000, signal: input.signal })
  const jobId = String(submitted.id ?? '')
  if (!jobId) throw new MuseError(502, 'MUSE_BAD_OUTPUT', 'relay did not return a job id')

  const deadline = (input.now ?? Date.now)() + boxExecDeadlineMs(input.spec)
  const pollMs = input.pollMs ?? BOX_EXEC_POLL_MS
  let status = String(submitted.status ?? 'queued')
  let last: Record<string, unknown> = submitted
  while (status === 'queued' || status === 'running' || status === 'needs_input') {
    if ((input.now ?? Date.now)() > deadline) {
      throw new MuseError(504, 'MUSE_TIMEOUT', 'the box-exec Muse job exceeded its deadline', true)
    }
    if (input.signal?.aborted) throw new MuseError(499, 'MUSE_CANCELLED', 'cancelled', false)
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    last = await runCli(input.exec, ['status', jobId], { timeoutMs: 20_000, signal: input.signal })
    status = String(last.status ?? '')
  }
  if (status !== 'done') {
    const mapped = mapRelayFailure(String(last.error ?? `relay status ${status}`), undefined)
    throw new MuseError(502, mapped.code, mapped.message, mapped.retryable)
  }
  const listed = Array.isArray(last.files) ? (last.files as Array<Record<string, unknown>>) : []
  const indexes = listed.length > 0 ? listed.map((_, i) => i) : [0]
  const files = []
  for (const idx of indexes) {
    const downloaded = await downloadRelayFile(input.exec, jobId, idx, input.signal)
    const filename = `${idx}.mp4`
    const path = join(input.destDir, `${idx}.bin`)
    await writeFile(path, downloaded.bytes)
    files.push({
      idx,
      filename,
      mime: 'video/mp4',
      bytes: downloaded.bytes.length,
      sha256: downloaded.sha256,
      path,
    })
  }
  return {
    files,
    snapshotId: null,
    artifactIds: [],
    modeMismatch: last.mode_mismatch === true,
  }
}

export function createMuseBoxExecRunner(uidRaw: string | undefined): () => Promise<BoxCliExecFn> {
  let cached: BoxCliExecFn | null = null
  return async () => {
    if (cached) return cached
    const uid = (uidRaw ?? '').trim()
    if (!/^[1-9]\d{0,18}$/.test(uid)) {
      throw new MuseError(
        503,
        'MUSE_BRIDGE_OFFLINE',
        'OC_MUSE_BOX_EXEC_UID is not set; box-exec Muse backend cannot resolve a Box',
        true,
      )
    }
    const { createProductionBoxAccountResolver } = await import(
      '../http/proxy/boxAccountResolver.js'
    )
    const resolver = createProductionBoxAccountResolver()
    const target = await resolver.resolve({
      uid: BigInt(uid),
      sessionId: null,
      requestId: `muse-box-exec-${Date.now()}`,
      upstreamModel: 'muse-box-exec',
      signal: new AbortController().signal,
      interactiveExecTarget: true,
    })
    cached = (request, opts) => target.exec.run(request, opts)
    return cached
  }
}
