#!/usr/bin/env node
/**
 * openclaude-vision MCP
 *
 * CCB-compatible image understanding bridge for text-only models (DeepSeek,
 * custom Anthropic-compatible providers). v1 intentionally supports only
 * local files that the gateway saved under paths.uploadsDir; URL input is
 * rejected to avoid SSRF. The backend is Codex CLI image input, hidden behind
 * this MCP abstraction so future deployments can swap the implementation
 * without changing the agent-facing tool name.
 */

import { type ChildProcessByStdio, spawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { paths } from '@openclaude/storage'

const TOOL_NAME = 'understand_image'
const DEFAULT_MODEL = 'gpt-5.5'
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_CONFIGURED_IMAGE_BYTES = 50 * 1024 * 1024
const MIN_CONFIGURED_IMAGE_BYTES = 1024
const STDERR_CAP_BYTES = 16 * 1024
const STDOUT_CAP_BYTES = 32 * 1024
const LOCK_STALE_EXTRA_MS = 60_000
const DEFAULT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

export const OPENCLAUDE_VISION_MCP_ID = 'openclaude-vision'
export const OPENCLAUDE_VISION_TOOLS = [TOOL_NAME]

export function shouldEnableOpenClaudeVision(provider?: string, model?: string): boolean {
  if (process.env.OPENCLAUDE_VISION_MCP_DISABLED === '1') return false
  const p = provider?.trim().toLowerCase()
  const m = model?.trim().toLowerCase()
  if (p === 'deepseek' || m?.startsWith('deepseek-')) return true

  const optInProviders = (process.env.OPENCLAUDE_VISION_MCP_PROVIDERS ?? '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  return !!p && optInProviders.includes(p)
}

export type VisionToolArgs = {
  image_file?: unknown
  image_source?: unknown
  image_url?: unknown
  question?: unknown
  prompt?: unknown
}

type ResolvedVisionInput = {
  imagePath: string
  prompt: string
  timeoutMs: number
  maxImageBytes: number
  model: string
}

type RasterImageExtension = 'png' | 'jpg' | 'gif' | 'webp'

function parseBoundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min || i > max) return fallback
  return i
}

function asOptionalNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

function rasterImageExtension(buf: Buffer): RasterImageExtension | null {
  if (
    buf.length >= 8 &&
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return 'png'
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf.length >= 6) {
    const sig = buf.subarray(0, 6).toString('ascii')
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'gif'
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }
  return null
}

function isRasterImageMagic(buf: Buffer): boolean {
  return rasterImageExtension(buf) !== null
}

function safeRealpath(p: string): string {
  return realpathSync(p)
}

function assertInsideUploads(realPath: string): void {
  let uploadsReal: string
  try {
    uploadsReal = safeRealpath(paths.uploadsDir)
  } catch {
    throw new Error('uploads directory is not available')
  }
  const root = uploadsReal.endsWith('/') ? uploadsReal : `${uploadsReal}/`
  if (realPath !== uploadsReal && !realPath.startsWith(root)) {
    throw new Error(
      'image_file must point to an uploaded image under the OpenClaude uploads directory',
    )
  }
}

function assertAllowedImageFile(imagePath: string, maxBytes: number): string {
  const real = safeRealpath(imagePath)
  assertInsideUploads(real)
  const st = statSync(real)
  if (!st.isFile()) throw new Error('image_file is not a regular file')
  if (st.size <= 0) throw new Error('image_file is empty')
  if (st.size > maxBytes) {
    throw new Error(`image_file exceeds ${Math.round(maxBytes / 1024 / 1024)}MB vision limit`)
  }
  const head = readFileSync(real).subarray(0, 16)
  if (!isRasterImageMagic(head)) {
    throw new Error('image_file is not a supported raster image (PNG/JPEG/GIF/WebP)')
  }
  return real
}

export function resolveVisionInput(args: VisionToolArgs): ResolvedVisionInput {
  const imageUrl = asOptionalNonEmptyString(args.image_url)
  if (imageUrl) {
    throw new Error(
      'image_url is disabled for openclaude-vision v1; upload the image and pass image_file instead',
    )
  }

  const rawPath =
    asOptionalNonEmptyString(args.image_file) ?? asOptionalNonEmptyString(args.image_source)
  if (!rawPath) throw new Error('image_file is required')
  if (!rawPath.startsWith('/')) throw new Error('image_file must be an absolute local path')

  const maxImageBytes = parseBoundedInt(
    process.env.OPENCLAUDE_VISION_MAX_IMAGE_BYTES,
    DEFAULT_MAX_IMAGE_BYTES,
    MIN_CONFIGURED_IMAGE_BYTES,
    MAX_CONFIGURED_IMAGE_BYTES,
  )
  const timeoutMs = parseBoundedInt(
    process.env.OPENCLAUDE_VISION_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    10_000,
    300_000,
  )
  const model = process.env.OPENCLAUDE_VISION_CODEX_MODEL?.trim() || DEFAULT_MODEL
  const question = asOptionalNonEmptyString(args.question) ?? asOptionalNonEmptyString(args.prompt)
  const prompt = [
    'You are OpenClaude vision helper. Answer using only the attached image.',
    'Do not inspect the filesystem or workspace. Do not reveal local file paths.',
    question
      ? `User question: ${question}`
      : 'Describe the image clearly and include any visible text.',
  ].join('\n')

  return {
    imagePath: assertAllowedImageFile(rawPath, maxImageBytes),
    prompt,
    timeoutMs,
    maxImageBytes,
    model,
  }
}

export function buildCodexVisionArgs(
  input: Pick<ResolvedVisionInput, 'imagePath' | 'prompt' | 'model'>,
  outputFile: string,
  runDir: string,
): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-rules',
    '--ignore-user-config',
    '--skip-git-repo-check',
    '--cd',
    runDir,
    '--sandbox',
    'read-only',
    '-c',
    'approval_policy="never"',
    // Codex 0.130 removes the legacy local shell via these feature flags.
    // Keep the isolated CODEX_HOME below as defense in depth if a future CLI
    // changes tool registration semantics.
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.unified_exec=false',
    '-c',
    'web_search="disabled"',
    '-c',
    'tools.web_search=false',
    '--output-last-message',
    outputFile,
    '--image',
    input.imagePath,
    '-m',
    input.model,
    input.prompt,
  ]
}

function codexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  return codexHome
}

function codexAuthFile(): string {
  return join(codexHomeDir(), 'auth.json')
}

function assertCodexAuthAvailable(): void {
  const auth = codexAuthFile()
  if (!existsSync(auth)) {
    throw new Error(
      'Codex auth is not configured for this container; image understanding is unavailable',
    )
  }
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function lockPathForSlot(slot: number): string {
  return join(tmpdir(), `openclaude-vision-codex.${slot}.lock`)
}

function malformedLockStartedAtMs(lockPath: string): number {
  const ownerPath = join(lockPath, 'owner.json')
  try {
    return statSync(ownerPath).mtimeMs
  } catch {
    try {
      return statSync(lockPath).mtimeMs
    } catch {
      return Date.now()
    }
  }
}

function tryAcquireSlot(slot: number, staleMs: number): (() => void) | null {
  const p = lockPathForSlot(slot)
  try {
    const now = Date.now()
    try {
      const raw = readFileSync(join(p, 'owner.json'), 'utf8')
      const owner = JSON.parse(raw) as { pid?: number; startedAt?: number }
      const startedAt = typeof owner.startedAt === 'number' ? owner.startedAt : now
      const pid = typeof owner.pid === 'number' ? owner.pid : -1
      if (now - startedAt > staleMs && !pidIsAlive(pid)) {
        rmSync(p, { recursive: true, force: true })
      }
    } catch {
      if (now - malformedLockStartedAtMs(p) > staleMs) {
        rmSync(p, { recursive: true, force: true })
      }
    }

    mkdirSync(p, { mode: 0o700 })
    writeFileSync(join(p, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: now }))
    return () => rmSync(p, { recursive: true, force: true })
  } catch {
    return null
  }
}

export function tryAcquireVisionLockSlotForTest(
  slot: number,
  staleMs: number,
): (() => void) | null {
  return tryAcquireSlot(slot, staleMs)
}

function acquireVisionLock(timeoutMs: number): () => void {
  const maxConcurrent = parseBoundedInt(process.env.OPENCLAUDE_VISION_MAX_CONCURRENT, 1, 1, 4)
  const staleMs = Math.max(timeoutMs + LOCK_STALE_EXTRA_MS, 60_000)
  for (let i = 0; i < maxConcurrent; i++) {
    const release = tryAcquireSlot(i, staleMs)
    if (release) return release
  }
  throw new Error(
    'another image understanding request is already running in this container; try again shortly',
  )
}

function appendCapped(acc: string, chunk: Buffer, cap: number): string {
  if (acc.length >= cap) return acc
  const next = acc + chunk.toString('utf8')
  return next.length > cap ? next.slice(0, cap) : next
}

export function stageVisionImage(imagePath: string, runDir: string): string {
  const ext = rasterImageExtension(readFileSync(imagePath).subarray(0, 16))
  if (!ext) throw new Error('image_file is not a supported raster image (PNG/JPEG/GIF/WebP)')
  const staged = join(runDir, `image.${ext}`)
  copyFileSync(imagePath, staged)
  chmodSync(staged, 0o600)
  return staged
}

export function prepareCodexVisionHome(runDir: string): string {
  const codexHome = join(runDir, 'codex-home')
  mkdirSync(codexHome, { recursive: true, mode: 0o700 })
  const authFile = join(codexHome, 'auth.json')
  copyFileSync(codexAuthFile(), authFile)
  chmodSync(authFile, 0o600)
  return codexHome
}

function removeCodexVisionAuth(codexHome: string): void {
  rmSync(join(codexHome, 'auth.json'), { force: true })
}

export function buildCodexVisionEnv(
  runDir: string,
  codexHome = join(runDir, 'codex-home'),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH || DEFAULT_PATH,
    HOME: join(runDir, 'home'),
    CODEX_HOME: codexHome,
    CODEX_SQLITE_HOME: join(runDir, 'codex-state'),
    TMPDIR: runDir,
    TMP: runDir,
    TEMP: runDir,
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || 'C.UTF-8',
  }

  for (const key of [
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'all_proxy',
    'no_proxy',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
    'NODE_EXTRA_CA_CERTS',
  ]) {
    const value = process.env[key]
    if (value) env[key] = value
  }

  return env
}

async function runCodexVision(input: ResolvedVisionInput): Promise<string> {
  assertCodexAuthAvailable()
  const release = acquireVisionLock(input.timeoutMs)
  let runDir = ''

  try {
    runDir = resolve(
      tmpdir(),
      `openclaude-vision-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    mkdirSync(runDir, { recursive: true, mode: 0o700 })
    const outputFile = join(runDir, 'last-message.txt')
    const stagedImagePath = stageVisionImage(input.imagePath, runDir)
    mkdirSync(join(runDir, 'home'), { recursive: true, mode: 0o700 })
    mkdirSync(join(runDir, 'codex-state'), { recursive: true, mode: 0o700 })
    const codexHome = prepareCodexVisionHome(runDir)
    const args = buildCodexVisionArgs({ ...input, imagePath: stagedImagePath }, outputFile, runDir)
    const command = process.env.OPENCLAUDE_VISION_CODEX_CMD?.trim() || 'codex'

    const result = await new Promise<{
      code: number | null
      signal: NodeJS.Signals | null
      stdout: string
      stderr: string
    }>((resolvePromise, reject) => {
      let proc: ChildProcessByStdio<null, Readable, Readable>
      let authRemoved = false
      let authRemovalTimer: NodeJS.Timeout | null = null
      const removeAuthOnce = () => {
        if (authRemoved) return
        authRemoved = true
        removeCodexVisionAuth(codexHome)
      }
      try {
        proc = spawn(command, args, {
          cwd: runDir,
          env: buildCodexVisionEnv(runDir, codexHome),
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        authRemovalTimer = setTimeout(removeAuthOnce, 3000)
      } catch (err) {
        reject(err)
        return
      }

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let closed = false
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill('SIGTERM')
        setTimeout(() => {
          if (!closed) proc.kill('SIGKILL')
        }, 2000).unref()
      }, input.timeoutMs)

      proc.stdout.on('data', (chunk: Buffer) => {
        stdout = appendCapped(stdout, chunk, STDOUT_CAP_BYTES)
        if (stdout.includes('session id:')) removeAuthOnce()
      })
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk, STDERR_CAP_BYTES)
      })
      proc.on('error', (err) => {
        if (authRemovalTimer) clearTimeout(authRemovalTimer)
        removeAuthOnce()
        clearTimeout(timer)
        reject(err)
      })
      proc.on('close', (code, signal) => {
        closed = true
        if (authRemovalTimer) clearTimeout(authRemovalTimer)
        removeAuthOnce()
        clearTimeout(timer)
        if (timedOut) {
          reject(new Error(`Codex vision timed out after ${Math.round(input.timeoutMs / 1000)}s`))
          return
        }
        resolvePromise({ code, signal, stdout, stderr })
      })
    })

    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || `signal=${result.signal ?? ''}`).trim()
      throw new Error(`Codex vision failed (exit ${result.code}): ${detail.slice(0, 1000)}`)
    }

    let text = ''
    try {
      text = readFileSync(outputFile, 'utf8').trim()
    } catch {}
    if (!text) text = result.stdout.trim()
    if (!text) throw new Error('Codex vision returned an empty response')
    return text
  } finally {
    release()
    if (runDir) rmSync(runDir, { recursive: true, force: true })
  }
}

const TOOLS = [
  {
    name: TOOL_NAME,
    description: [
      'Understand an uploaded local image using the OpenClaude vision bridge.',
      'Pass image_file (preferred) or image_source as an absolute path from the upload hint.',
      'URL input is intentionally disabled in v1 to avoid SSRF; upload remote images first.',
    ].join('\n'),
    inputSchema: {
      type: 'object',
      properties: {
        image_file: {
          type: 'string',
          description: 'Absolute path to an uploaded PNG/JPEG/GIF/WebP image',
        },
        image_source: { type: 'string', description: 'Alias for image_file' },
        image_url: {
          type: 'string',
          description: 'Disabled in v1; upload the image and use image_file',
        },
        question: { type: 'string', description: 'Question to answer about the image' },
        prompt: { type: 'string', description: 'Alias for question' },
      },
    },
  },
]

export async function startVisionMcpServer(): Promise<void> {
  const server = new Server(
    { name: OPENCLAUDE_VISION_MCP_ID, version: '0.1.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    if (name !== TOOL_NAME) {
      return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
    }
    try {
      const input = resolveVisionInput((args ?? {}) as VisionToolArgs)
      const text = await runCodexVision(input)
      return { content: [{ type: 'text', text }] }
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `error: ${err?.message ?? String(err)}` }],
        isError: true,
      }
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
  startVisionMcpServer().catch((err) => {
    const name = basename(fileURLToPath(import.meta.url))
    process.stderr.write(`[${name}] fatal: ${err?.message ?? String(err)}\n`)
    process.exit(1)
  })
}
