/**
 * Multimodal Summarization (P1.6)
 *
 * Generates text summaries from images and files, then stores them
 * in archival memory for retrieval. Enables "remember this image" workflows.
 *
 * Supported inputs:
 * - Images (PNG, JPG, GIF, WebP) → vision model description
 * - Text files → truncated + LLM summary
 *
 * Configuration via environment:
 *   SUMMARY_MODEL       — model for summarization (default: claude-haiku-4-5-20251001)
 *   SUMMARY_API_KEY     — API key (falls back to ANTHROPIC_API_KEY)
 *   SUMMARY_BASE_URL    — API base URL
 *   SUMMARY_MAX_TOKENS  — max output tokens for summary (default: 300, must be positive integer)
 */

import { open, realpath, constants } from 'node:fs/promises'
import { extname, isAbsolute } from 'node:path'
import { paths } from './paths.js'

// ── Types ────────────────────────────────────────

export interface SummaryResult {
  /** Generated text summary */
  summary: string
  /** MIME type of the input */
  mimeType: string
  /** Input file size in bytes */
  fileSize: number
}

export interface SummaryProvider {
  /** Summarize an image from its base64-encoded data. */
  summarizeImage(base64: string, mimeType: string, context?: string): Promise<string>
  /** Summarize a text document. */
  summarizeText(text: string, context?: string): Promise<string>
}

export interface SummaryProviderConfig {
  apiKey?: string
  baseUrl?: string
  model?: string
  maxTokens?: number
}

// ── Path safety ──────────────────────────────────

/**
 * Allowed base directories for summarization.
 * Files must resolve (after symlink resolution) to a path under one of these.
 */
function getAllowedBaseDirs(): string[] {
  return [
    paths.uploadsDir,       // ~/.openclaude/uploads/
    paths.generatedDir,     // ~/.openclaude/generated/
    '/tmp',
  ]
}

/**
 * Validate that a file path is safe to read for summarization.
 * - Must be absolute
 * - Resolved (realpath) must be under an allowed base directory
 * - Allowed base directories are also resolved to handle symlinked OPENCLAUDE_HOME
 */
async function validateFilePath(filePath: string): Promise<string> {
  if (!isAbsolute(filePath)) {
    throw new Error(`summarizeFile: path must be absolute, got "${filePath}"`)
  }

  // Resolve full real path (handles symlinked parents)
  const resolvedPath = await realpath(filePath)

  // Also resolve allowed base dirs (OPENCLAUDE_HOME may itself be a symlink)
  const rawAllowed = getAllowedBaseDirs()
  const resolvedAllowed: string[] = []
  for (const base of rawAllowed) {
    try {
      resolvedAllowed.push(await realpath(base))
    } catch {
      // Base dir doesn't exist yet — skip
    }
  }

  const isAllowed = resolvedAllowed.some(
    base => resolvedPath.startsWith(base + '/') || resolvedPath === base,
  )

  if (!isAllowed) {
    throw new Error(
      `summarizeFile: path "${filePath}" resolves outside allowed directories`,
    )
  }

  return resolvedPath
}

// ── MIME detection ───────────────────────────────

const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.xml',
  '.html', '.css', '.js', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.sh', '.bash', '.zsh', '.toml', '.ini', '.cfg',
  '.log', '.sql', '.graphql',
])

function detectMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  if (ext in IMAGE_EXTENSIONS) return IMAGE_EXTENSIONS[ext]
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain'
  return 'application/octet-stream'
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/')
}

function isTextMime(mime: string): boolean {
  return mime === 'text/plain' || mime === 'application/json'
}

// ── Claude Vision Provider ───────────────────────

export class ClaudeSummaryProvider implements SummaryProvider {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly model: string
  private readonly maxTokens: number

  constructor(config: SummaryProviderConfig = {}) {
    this.apiKey = config.apiKey ?? ''
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    this.model = config.model ?? 'claude-haiku-4-5-20251001'
    this.maxTokens = config.maxTokens ?? 300

    if (!this.apiKey) {
      throw new Error('ClaudeSummaryProvider: apiKey is required')
    }
    if (!Number.isFinite(this.maxTokens) || this.maxTokens <= 0 || !Number.isInteger(this.maxTokens)) {
      throw new Error(`ClaudeSummaryProvider: maxTokens must be a positive integer, got ${this.maxTokens}`)
    }
  }

  async summarizeImage(base64: string, mimeType: string, context?: string): Promise<string> {
    const systemPrompt = 'You are a precise image describer. Describe the image content in a way that would be useful for future text-based retrieval. Include key details, text visible in the image, and overall context. Be concise but thorough.'

    const userContent: Array<Record<string, unknown>> = [
      {
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data: base64 },
      },
    ]

    const textPrompt = context
      ? `Describe this image for memory storage. Context: ${context}`
      : 'Describe this image for memory storage.'
    userContent.push({ type: 'text', text: textPrompt })

    return this.callApi(systemPrompt, userContent)
  }

  async summarizeText(text: string, context?: string): Promise<string> {
    const systemPrompt = 'You are a precise document summarizer. Create a concise summary that captures the key information for future retrieval. Focus on facts, decisions, and actionable items.'

    const truncated = text.length > 8000 ? text.slice(0, 8000) + '\n...(truncated)' : text
    const prompt = context
      ? `Summarize this document for memory storage. Context: ${context}\n\n---\n\n${truncated}`
      : `Summarize this document for memory storage:\n\n${truncated}`

    return this.callApi(systemPrompt, [{ type: 'text', text: prompt }])
  }

  private async callApi(
    system: string,
    content: Array<Record<string, unknown>>,
  ): Promise<string> {
    const resp = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages: [{ role: 'user', content }],
      }),
    })

    if (!resp.ok) {
      const body = await resp.text().catch(() => '')
      const safeBody = body.slice(0, 200).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***')
      throw new Error(`Summary API error ${resp.status}: ${safeBody}`)
    }

    const json = await resp.json() as {
      content: Array<{ type: string; text?: string }>
    }

    const textBlock = json.content?.find(b => b.type === 'text')
    if (!textBlock?.text) {
      throw new Error('Summary API returned no text content')
    }
    return textBlock.text
  }
}

// ── Factory ──────────────────────────────────────

let _provider: SummaryProvider | null = null

export function summaryConfigFromEnv(): SummaryProviderConfig {
  const raw = process.env.SUMMARY_MAX_TOKENS
  let maxTokens = 300
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw.trim())) {
      throw new Error(`Invalid SUMMARY_MAX_TOKENS: "${raw}"`)
    }
    const parsed = Number(raw.trim())
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
      throw new Error(`Invalid SUMMARY_MAX_TOKENS: "${raw}"`)
    }
    maxTokens = parsed
  }

  return {
    apiKey: process.env.SUMMARY_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? '',
    baseUrl: process.env.SUMMARY_BASE_URL,
    model: process.env.SUMMARY_MODEL,
    maxTokens,
  }
}

export function getSummaryProvider(config?: SummaryProviderConfig): SummaryProvider {
  if (_provider) return _provider

  const cfg = config ?? summaryConfigFromEnv()
  _provider = new ClaudeSummaryProvider(cfg)
  return _provider
}

export function isSummaryAvailable(): boolean {
  const key = process.env.SUMMARY_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? ''
  return key.length > 0
}

export function resetSummaryProvider(): void {
  _provider = null
}

// ── High-level API ───────────────────────────────

/** Max file size for summarization (10 MB) */
const MAX_FILE_SIZE = 10 * 1024 * 1024

/**
 * Generate a text summary from a file path.
 *
 * Security: Only reads files under allowed directories (uploads, generated, /tmp).
 * Resolves symlinks and validates the real path before reading.
 *
 * @param filePath  Absolute path to the file
 * @param provider  Summary provider (or null to auto-create from env)
 * @param context   Optional context hint for the summarizer
 * @returns Summary result, or null if file type is unsupported or empty
 */
export async function summarizeFile(
  filePath: string,
  provider?: SummaryProvider | null,
  context?: string,
): Promise<SummaryResult | null> {
  // Validate path security first, before any file I/O or provider init
  const resolvedPath = await validateFilePath(filePath)

  const mimeType = detectMimeType(resolvedPath)
  if (!isImageMime(mimeType) && !isTextMime(mimeType)) {
    return null
  }

  // Open with O_NOFOLLOW | O_NONBLOCK then post-open revalidation:
  // 1. O_NOFOLLOW: reject final-component symlink swaps
  // 2. O_NONBLOCK: don't block on FIFOs/devices
  // 3. Post-open: resolve /proc/self/fd/<n> to verify actual path is still allowed
  //    (catches intermediate directory symlink swaps between validate and open)
  const handle = await open(
    resolvedPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  )
  try {
    const fileInfo = await handle.stat()
    if (!fileInfo.isFile()) {
      return null
    }

    // Post-open revalidation: verify the fd actually points to an allowed path
    // This catches intermediate-directory symlink swaps (TOCTOU on parents)
    const fdLink = process.platform === 'linux'
      ? `/proc/self/fd/${handle.fd}`
      : `/dev/fd/${handle.fd}`
    const actualPath = await realpath(fdLink)
    const resolvedAllowed: string[] = []
    for (const base of getAllowedBaseDirs()) {
      try { resolvedAllowed.push(await realpath(base)) } catch { /* skip */ }
    }
    const stillAllowed = resolvedAllowed.some(
      base => actualPath.startsWith(base + '/') || actualPath === base,
    )
    if (!stillAllowed) {
      throw new Error('summarizeFile: post-open path validation failed')
    }
    if (fileInfo.size > MAX_FILE_SIZE) {
      throw new Error(`File too large for summarization: ${fileInfo.size} bytes (max ${MAX_FILE_SIZE})`)
    }
    if (fileInfo.size === 0) {
      return null
    }

    // Provider init happens only after all validation passes
    const sp = provider ?? getSummaryProvider()

    if (isImageMime(mimeType)) {
      const data = await handle.readFile()
      const base64 = data.toString('base64')
      const summary = await sp.summarizeImage(base64, mimeType, context)
      return { summary, mimeType, fileSize: fileInfo.size }
    }

    const text = await handle.readFile({ encoding: 'utf-8' })
    const summary = await sp.summarizeText(text, context)
    return { summary, mimeType, fileSize: fileInfo.size }
  } finally {
    await handle.close()
  }
}
