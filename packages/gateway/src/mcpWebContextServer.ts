import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import {
  DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES,
  DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES,
  DEFAULT_WEB_CONTEXT_TIMEOUT_MS,
  HARD_WEB_CONTEXT_MAX_DECODED_BYTES,
  HARD_WEB_CONTEXT_MAX_ENCODED_BYTES,
  type WebContextKind,
  type WebContextSsrfProxyOptions,
  detectBlockedContent,
  fetchWebContextUrl,
  parseBoundedInt,
} from './webContextSafety.js'
import { checkWebContextBrowserHealth, renderWebContextUrlWithBrowser } from './webContextBrowser.js'

export const OPENCLAUDE_WEB_CONTEXT_MCP_ID = 'web-context'
export const WEB_CONTEXT_EXTRACT_URL_TOOL = 'web_context_extract_url'
export const WEB_CONTEXT_PARSE_FILE_TOOL = 'web_context_parse_file'
export const WEB_CONTEXT_HEALTH_TOOL = 'web_context_health_check'
export const OPENCLAUDE_WEB_CONTEXT_TOOLS = [
  WEB_CONTEXT_EXTRACT_URL_TOOL,
  WEB_CONTEXT_PARSE_FILE_TOOL,
  WEB_CONTEXT_HEALTH_TOOL,
]

const DEFAULT_BIN = '/usr/local/bin/oc-web-context'
const DEFAULT_TIMEOUT_MS = 90_000
const MIN_TIMEOUT_MS = 3_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_MAX_OUTPUT_CHARS = 80_000
const MAX_OUTPUT_CHARS = 500_000
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024
const HARD_MAX_FILE_BYTES = 100 * 1024 * 1024
const CHILD_STDOUT_CAP = 4 * 1024 * 1024
const CHILD_STDERR_CAP = 64 * 1024
const DEFAULT_SAFE_ROOTS = [
  '/home/agent/.openclaude/uploads',
  '/home/agent/.openclaude/generated',
  '/home/agent/.local/share/scansci-pdf/papers',
]
const ALLOWED_PARSE_EXTS = new Set([
  '.html',
  '.htm',
  '.txt',
  '.md',
  '.markdown',
  '.pdf',
  '.docx',
  '.pptx',
  '.xlsx',
  '.csv',
  '.json',
  '.xml',
])

export type WebContextExtractUrlArgs = {
  url?: unknown
  mode?: unknown
  max_chars?: unknown
  timeout_ms?: unknown
  max_encoded_bytes?: unknown
  max_decoded_bytes?: unknown
  _browserProxyOptions?: WebContextSsrfProxyOptions
  _onBrowserPid?: (pid: number) => void
}

export type WebContextParseFileArgs = {
  file_path?: unknown
  max_chars?: unknown
  timeout_ms?: unknown
  max_file_bytes?: unknown
}

type ChildResult = {
  ok?: boolean
  markdown?: string
  text?: string
  error?: string
  [key: string]: unknown
}

let active = 0

function boundedNumber(v: unknown, fallback: number, min: number, max: number): number {
  if (typeof v !== 'number' && typeof v !== 'string') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return fallback
  return Math.min(i, max)
}

function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function childBin(): string {
  return process.env.OPENCLAUDE_WEB_CONTEXT_BIN?.trim() || DEFAULT_BIN
}

function safeRoots(): string[] {
  const raw = process.env.OPENCLAUDE_WEB_CONTEXT_SAFE_ROOTS?.trim()
  if (!raw) return DEFAULT_SAFE_ROOTS
  return raw
    .split(':')
    .map((v) => v.trim())
    .filter(Boolean)
}

function assertInsideSafeRoots(realPath: string): void {
  const roots = safeRoots()
    .filter((root) => existsSync(root))
    .map((root) => realpathSync(root))
  for (const root of roots) {
    const normalized = root.endsWith('/') ? root : `${root}/`
    if (realPath === root || realPath.startsWith(normalized)) return
  }
  throw new Error('file_path must be under uploads, generated, or ScanSci papers')
}

export function resolveSafeParseFile(args: WebContextParseFileArgs): {
  filePath: string
  maxChars: number
  timeoutMs: number
} {
  const raw = optionalString(args.file_path)
  if (!raw) throw new Error('file_path is required')
  if (!raw.startsWith('/')) throw new Error('file_path must be an absolute path')
  const real = realpathSync(raw)
  assertInsideSafeRoots(real)
  const st = statSync(real)
  if (!st.isFile()) throw new Error('file_path must point to a regular file')
  if (st.size <= 0) throw new Error('file is empty')
  const maxFileBytes = boundedNumber(
    args.max_file_bytes,
    DEFAULT_MAX_FILE_BYTES,
    1,
    HARD_MAX_FILE_BYTES,
  )
  if (st.size > maxFileBytes) throw new Error('file exceeds web-context parse size limit')
  const ext = extname(real).toLowerCase()
  if (!ALLOWED_PARSE_EXTS.has(ext))
    throw new Error(`unsupported file extension: ${ext || '(none)'}`)
  return {
    filePath: real,
    maxChars: boundedNumber(args.max_chars, DEFAULT_MAX_OUTPUT_CHARS, 1_000, MAX_OUTPUT_CHARS),
    timeoutMs: boundedNumber(args.timeout_ms, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS),
  }
}

function sanitizedChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? 'C.UTF-8',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  }
  return env
}

function runChild(payload: Record<string, unknown>, timeoutMs: number): Promise<ChildResult> {
  return new Promise((resolvePromise, reject) => {
    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(childBin(), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sanitizedChildEnv(),
        shell: false,
      })
    } catch (err) {
      reject(err)
      return
    }
    let stdout = Buffer.alloc(0)
    let stderr = Buffer.alloc(0)
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(
        new Error(
          'web-context parser timed out(页面可能重 JS/反爬。正文页可加大 --timeout-ms 重试;' +
            '要做搜索请改用内置 WebSearch,不要抓搜索引擎结果页)',
        ),
      )
    }, timeoutMs)
    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = Buffer.concat([stdout, chunk])
      if (stdout.length > CHILD_STDOUT_CAP) {
        proc.kill('SIGKILL')
        reject(new Error('web-context parser stdout exceeded limit'))
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk]).subarray(0, CHILD_STDERR_CAP)
    })
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        reject(new Error(`web-context parser exited ${code}: ${stderr.toString('utf8')}`.trim()))
        return
      }
      try {
        resolvePromise(JSON.parse(stdout.toString('utf8')) as ChildResult)
      } catch (err) {
        reject(new Error(`web-context parser returned invalid JSON: ${(err as Error).message}`))
      }
    })
    proc.stdin.end(JSON.stringify(payload))
  })
}

function truncateText(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  const raw = typeof value === 'string' ? value : ''
  if (raw.length <= maxChars) return { text: raw, truncated: false }
  return { text: raw.slice(0, maxChars), truncated: true }
}

function jsonToolResult(obj: unknown, isError = false) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function parserOpForKind(kind: WebContextKind): string {
  if (kind === 'html' || kind === 'text') return 'extract_file'
  return 'parse_document_file'
}

async function withConcurrency<T>(fn: () => Promise<T>): Promise<T> {
  const max = parseBoundedInt(process.env.OPENCLAUDE_WEB_CONTEXT_MAX_CONCURRENT, 2, 1, 8)
  if (active >= max) throw new Error('web-context tool concurrency limit reached')
  active += 1
  try {
    return await fn()
  } finally {
    active -= 1
  }
}

const SPA_JS_HINT_RE =
  /enable javascript|requires javascript|javascript is disabled|turn on javascript|please enable js/i
const SPA_EMPTY_MOUNT_RE = /<div\s+id=["'](?:app|root|__next|__nuxt)["']\s*>\s*<\/div>/i

async function runExtractorOnBody(params: {
  url: string
  finalUrl: string
  status: number
  contentType: string
  kind: WebContextKind
  body: Buffer
  encodedBytes: number
  decodedBytes: number
  redirects: string[]
  maxChars: number
  timeoutMs: number
}): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'oc-web-context-'))
  try {
    const ext =
      params.kind === 'html' ? '.html' : params.kind === 'text' ? '.txt' : `.${params.kind}`
    const file = join(dir, `body${ext}`)
    writeFileSync(file, params.body)
    const child = await runChild(
      {
        op: parserOpForKind(params.kind),
        file_path: file,
        source_url: params.finalUrl,
        content_type: params.contentType,
        kind: params.kind,
        max_chars: params.maxChars,
      },
      params.timeoutMs,
    )
    const out = truncateText(child.markdown ?? child.text, params.maxChars)
    const markerMiss = out.text.trim().length < 120 && params.kind === 'html'
    return {
      ...child,
      ok: child.ok !== false && !markerMiss,
      url: params.url,
      final_url: params.finalUrl,
      http_status: params.status,
      content_type: params.contentType,
      kind: params.kind,
      encoded_bytes: params.encodedBytes,
      decoded_bytes: params.decodedBytes,
      redirects: params.redirects,
      markdown: out.text,
      truncated: out.truncated || child.truncated === true,
      ...(markerMiss ? { error: 'extracted output is too small to be useful' } : {}),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function shouldFallbackToBrowser(
  staticResult: Record<string, unknown>,
  rawHtml: Buffer,
): string | null {
  if (staticResult.kind !== 'html' || staticResult.blocked === true) return null
  const status = typeof staticResult.http_status === 'number' ? staticResult.http_status : 0
  if (status < 200 || status >= 300) return null
  const md = typeof staticResult.markdown === 'string' ? staticResult.markdown.trim() : ''
  if (staticResult.ok === false || md.length < 120) return 'static_output_too_small'
  if (md.length < 400) {
    const htmlSample = rawHtml.subarray(0, 32 * 1024).toString('utf8')
    if (SPA_JS_HINT_RE.test(md) || SPA_EMPTY_MOUNT_RE.test(htmlSample)) {
      return 'spa_shell_detected'
    }
  }
  return null
}

function isSsrfRejectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /non-public ip|localhost|not allowed|ssrf|resolve to a public ip/i.test(msg)
}

async function extractViaBrowser(params: {
  url: string
  mode: 'auto' | 'browser'
  maxChars: number
  deadlineMs: number
  maxEncodedBytes: number
  maxDecodedBytes: number
  proxyOptions?: WebContextSsrfProxyOptions
  onBrowserPid?: (pid: number) => void
  fallbackReason?: string
}): Promise<Record<string, unknown>> {
  const rendered = await renderWebContextUrlWithBrowser(params.url, {
    timeoutMs: Math.max(1_000, params.deadlineMs - Date.now()),
    deadlineMs: params.deadlineMs,
    maxEncodedBytes: params.maxEncodedBytes,
    maxDecodedBytes: params.maxDecodedBytes,
    proxyOptions: params.proxyOptions,
    onBrowserPid: params.onBrowserPid,
  })
  const blockedReason = detectBlockedContent(rendered.status, rendered.body)
  if (blockedReason) {
    return {
      ok: false,
      blocked: true,
      blocked_reason: blockedReason,
      url: params.url,
      final_url: rendered.finalUrl,
      http_status: rendered.status,
      content_type: rendered.contentType,
      mode: params.mode,
      rendered_via: 'browser',
      ...(params.fallbackReason ? { fallback_reason: params.fallbackReason } : {}),
    }
  }
  if (rendered.status < 200 || rendered.status >= 300) {
    return {
      ok: false,
      error: `HTTP ${rendered.status}`,
      url: params.url,
      final_url: rendered.finalUrl,
      http_status: rendered.status,
      mode: params.mode,
      rendered_via: 'browser',
      ...(params.fallbackReason ? { fallback_reason: params.fallbackReason } : {}),
    }
  }
  const remainingChildMs = params.deadlineMs - Date.now()
  if (remainingChildMs <= 0) {
    throw new Error('web-context extraction timed out before parser stage')
  }
  const extracted = await runExtractorOnBody({
    url: params.url,
    finalUrl: rendered.finalUrl,
    status: rendered.status,
    contentType: rendered.contentType,
    kind: 'html',
    body: rendered.body,
    encodedBytes: rendered.body.length,
    decodedBytes: rendered.body.length,
    redirects: rendered.redirects,
    maxChars: params.maxChars,
    timeoutMs: remainingChildMs,
  })
  return {
    ...extracted,
    mode: params.mode,
    rendered_via: 'browser',
    ...(params.fallbackReason ? { fallback_reason: params.fallbackReason } : {}),
  }
}

export async function extractUrl(args: WebContextExtractUrlArgs): Promise<Record<string, unknown>> {
  const url = optionalString(args.url)
  if (!url) throw new Error('url is required')
  const mode = optionalString(args.mode) ?? 'auto'
  if (mode !== 'auto' && mode !== 'static' && mode !== 'browser') {
    throw new Error('invalid mode: expected auto, static, or browser')
  }
  const maxChars = boundedNumber(args.max_chars, DEFAULT_MAX_OUTPUT_CHARS, 1_000, MAX_OUTPUT_CHARS)
  const timeoutMs = boundedNumber(
    args.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
  )
  const deadlineMs = Date.now() + timeoutMs
  const maxEncodedBytes = boundedNumber(
    args.max_encoded_bytes,
    DEFAULT_WEB_CONTEXT_MAX_ENCODED_BYTES,
    1,
    HARD_WEB_CONTEXT_MAX_ENCODED_BYTES,
  )
  const maxDecodedBytes = boundedNumber(
    args.max_decoded_bytes,
    DEFAULT_WEB_CONTEXT_MAX_DECODED_BYTES,
    1,
    HARD_WEB_CONTEXT_MAX_DECODED_BYTES,
  )

  if (mode === 'browser') {
    return await extractViaBrowser({
      url,
      mode: 'browser',
      maxChars,
      deadlineMs,
      maxEncodedBytes,
      maxDecodedBytes,
      proxyOptions: args._browserProxyOptions,
      onBrowserPid: args._onBrowserPid,
    })
  }

  const fetched = await fetchWebContextUrl(url, {
    timeoutMs: Math.max(1_000, Math.min(deadlineMs - Date.now(), DEFAULT_WEB_CONTEXT_TIMEOUT_MS)),
    deadlineMs,
    maxEncodedBytes,
    maxDecodedBytes,
    ...(args._browserProxyOptions?.lookup ? { lookup: args._browserProxyOptions.lookup } : {}),
    ...(args._browserProxyOptions?.connectSocket
      ? { connectSocket: args._browserProxyOptions.connectSocket }
      : {}),
  })
  const blockedReason = detectBlockedContent(fetched.status, fetched.body)
  if (blockedReason) {
    return {
      ok: false,
      blocked: true,
      blocked_reason: blockedReason,
      url,
      final_url: fetched.finalUrl,
      http_status: fetched.status,
      content_type: fetched.contentType,
      mode,
      rendered_via: 'static',
    }
  }
  if (fetched.status < 200 || fetched.status >= 300) {
    return {
      ok: false,
      error: `HTTP ${fetched.status}`,
      url,
      final_url: fetched.finalUrl,
      http_status: fetched.status,
      mode,
      rendered_via: 'static',
    }
  }

  const staticChildTimeout = deadlineMs - Date.now()
  if (staticChildTimeout <= 0) {
    throw new Error('web-context extraction timed out before parser stage')
  }
  const staticResult = await runExtractorOnBody({
    url,
    finalUrl: fetched.finalUrl,
    status: fetched.status,
    contentType: fetched.contentType,
    kind: fetched.kind,
    body: fetched.body,
    encodedBytes: fetched.encodedBytes,
    decodedBytes: fetched.decodedBytes,
    redirects: fetched.redirects,
    maxChars,
    timeoutMs: staticChildTimeout,
  })
  if (mode === 'static') {
    return { ...staticResult, mode: 'static', rendered_via: 'static' }
  }

  const fallbackReason = shouldFallbackToBrowser(staticResult, fetched.body)
  if (!fallbackReason) {
    return { ...staticResult, mode: 'auto', rendered_via: 'static' }
  }

  const remainingMs = deadlineMs - Date.now()
  if (remainingMs < 500) {
    return { ...staticResult, mode: 'auto', rendered_via: 'static' }
  }

  try {
    const browserResult = await extractViaBrowser({
      url,
      mode: 'auto',
      maxChars,
      deadlineMs,
      maxEncodedBytes,
      maxDecodedBytes,
      proxyOptions: args._browserProxyOptions,
      onBrowserPid: args._onBrowserPid,
      fallbackReason,
    })
    const staticLen = typeof staticResult.markdown === 'string' ? staticResult.markdown.trim().length : 0
    const browserLen = typeof browserResult.markdown === 'string' ? browserResult.markdown.trim().length : 0
    if (browserResult.ok === true || browserResult.blocked === true || browserLen > staticLen) {
      return browserResult
    }
    return {
      ...staticResult,
      mode: 'auto',
      rendered_via: 'static',
      fallback_reason: fallbackReason,
    }
  } catch (err) {
    if (isSsrfRejectionError(err)) throw err
    const msg = err instanceof Error ? err.message : String(err)
    if (staticResult.ok === true || /Chromium executable not found/i.test(msg)) {
      return {
        ...staticResult,
        mode: 'auto',
        rendered_via: 'static',
        fallback_reason: fallbackReason,
        browser_fallback_error: msg,
      }
    }
    throw err
  }
}

export async function parseFile(args: WebContextParseFileArgs): Promise<Record<string, unknown>> {
  const input = resolveSafeParseFile(args)
  const child = await runChild(
    {
      op: 'parse_document_file',
      file_path: input.filePath,
      kind: extname(input.filePath).toLowerCase().replace(/^\./, ''),
      max_chars: input.maxChars,
    },
    input.timeoutMs,
  )
  const out = truncateText(child.markdown ?? child.text, input.maxChars)
  return {
    ...child,
    file_path: input.filePath,
    markdown: out.text,
    truncated: out.truncated || child.truncated === true,
  }
}

export async function healthCheck(): Promise<Record<string, unknown>> {
  const timeoutMs = boundedNumber(undefined, 20_000, 1_000, 60_000)
  const child = await runChild({ op: 'health_check' }, timeoutMs)
  const hasExplicitBrowserEnv = Boolean(process.env.OPENCLAUDE_WEB_CONTEXT_BROWSER?.trim())
  if (Object.prototype.hasOwnProperty.call(child, 'browser') && !hasExplicitBrowserEnv) {
    return child
  }
  return {
    ...child,
    browser: await checkWebContextBrowserHealth(),
  }
}

const TOOLS = [
  {
    name: WEB_CONTEXT_EXTRACT_URL_TOOL,
    description: [
      'Extract public web/document context into clean Markdown for AI use.',
      'Use for public URLs, official pages, articles, filings, PDFs and documents.',
      'Does not bypass anti-bot/CAPTCHA/Cloudflare; blocked pages return blocked=true.',
      'mode="auto" tries fast static extraction first and falls back to SSRF-guarded headless Chromium when SPA HTML yields insufficient text; mode="browser" renders via guarded Chromium directly.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        mode: { type: 'string', enum: ['auto', 'static', 'browser'], default: 'auto' },
        max_chars: { type: 'number', default: DEFAULT_MAX_OUTPUT_CHARS },
        timeout_ms: { type: 'number', default: DEFAULT_TIMEOUT_MS },
      },
      required: ['url'],
    },
  },
  {
    name: WEB_CONTEXT_PARSE_FILE_TOOL,
    description: [
      'Parse an uploaded/generated local HTML/PDF/Office/text file into Markdown.',
      'file_path must be under uploads, generated, or ScanSci papers; arbitrary filesystem paths are rejected.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        max_chars: { type: 'number', default: DEFAULT_MAX_OUTPUT_CHARS },
        timeout_ms: { type: 'number', default: DEFAULT_TIMEOUT_MS },
        max_file_bytes: { type: 'number', default: DEFAULT_MAX_FILE_BYTES },
      },
      required: ['file_path'],
    },
  },
  {
    name: WEB_CONTEXT_HEALTH_TOOL,
    description: 'Check web-context parser dependency availability.',
    inputSchema: { type: 'object', properties: {} },
  },
]

export async function startWebContextMcpServer(): Promise<void> {
  const server = new Server(
    { name: OPENCLAUDE_WEB_CONTEXT_MCP_ID, version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    try {
      const result = await withConcurrency(async () => {
        if (name === WEB_CONTEXT_EXTRACT_URL_TOOL)
          return await extractUrl((args ?? {}) as WebContextExtractUrlArgs)
        if (name === WEB_CONTEXT_PARSE_FILE_TOOL)
          return await parseFile((args ?? {}) as WebContextParseFileArgs)
        if (name === WEB_CONTEXT_HEALTH_TOOL) return await healthCheck()
        throw new Error(`unknown tool: ${name}`)
      })
      return jsonToolResult(result, (result as { ok?: boolean }).ok === false)
    } catch (err: any) {
      return jsonToolResult({ ok: false, error: err?.message ?? String(err) }, true)
    }
  })
  await server.connect(new StdioServerTransport())
}

function isDirectExecution(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  return resolve(argv1) === fileURLToPath(import.meta.url)
}

if (isDirectExecution()) {
  startWebContextMcpServer().catch((err) => {
    const name = basename(fileURLToPath(import.meta.url))
    process.stderr.write(`[${name}] fatal: ${err?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
