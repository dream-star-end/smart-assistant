/**
 * 会话产出物自动归集 + 上传参考资料 excerpt 提取。
 *
 * 产出物:扫助手正文里的 `/home/agent/.openclaude/generated/...` 绝对路径,
 * 登记为 source='output' 的项目资产。失败不得影响回合收口。
 */
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import {
  createProjectAsset,
  parseProjectAssetContainerPath,
  parseProjectAssetExcerpt,
  PROJECT_ASSET_EXCERPT_MAX,
  PROJECT_ASSET_URL_RE,
} from '@openclaude/storage'
import { parseDocument } from './documentParser.js'
import { createLogger } from './logger.js'

const log = createLogger({ module: 'projectAssets' })

export const GENERATED_OUTPUT_PATH_RE = /\/home\/agent\/\.openclaude\/generated\/[^\s<"'\`>]+/g
export const PROJECT_ASSET_TURN_COLLECT_MAX = 5
const EXCERPT_PARSE_TIMEOUT_MS = 8_000
const EXCERPT_TEXT_BYTES_MAX = 16 * 1024

const TRAILING_PUNCT_RE = /[.,;:!?。，、)\]}>]+$/u

const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  html: 'text/html',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
}

export function mimeFromAssetName(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  return ext ? EXT_MIME[ext] : undefined
}

export function extractGeneratedOutputPaths(text: string): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(GENERATED_OUTPUT_PATH_RE)) {
    const raw = match[0].replace(TRAILING_PUNCT_RE, '')
    const parsed = parseProjectAssetContainerPath(raw)
    if (!parsed || !parsed.startsWith('/home/agent/.openclaude/generated/')) continue
    if (seen.has(parsed)) continue
    seen.add(parsed)
    out.push(parsed)
    if (out.length >= PROJECT_ASSET_TURN_COLLECT_MAX) break
  }
  return out
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

export function resolveUploadExcerptPath(url?: string | null, containerPath?: string | null): string | null {
  const parsedPath = containerPath ? parseProjectAssetContainerPath(containerPath) : null
  if (parsedPath) return parsedPath
  if (url && PROJECT_ASSET_URL_RE.test(url)) {
    return `/home/agent/.openclaude/uploads/${url.slice('/api/media/'.length)}`
  }
  return null
}

function isExcerptableMime(mime: string | undefined, pathOrName: string): boolean {
  const m = (mime ?? '').toLowerCase()
  const p = pathOrName.toLowerCase()
  if (m === 'application/pdf' || p.endsWith('.pdf')) return true
  if (m.includes('wordprocessingml.document') || p.endsWith('.docx')) return true
  if (m.startsWith('text/')) return true
  if (m === 'application/json' || m === 'application/csv' || m === 'text/csv' || m === 'text/markdown') return true
  if (/\.(md|markdown|csv|json|txt)$/.test(p)) return true
  return false
}

async function readPlainExcerpt(filePath: string): Promise<string | null> {
  const buf = await readFile(filePath)
  const slice = buf.subarray(0, Math.min(buf.length, EXCERPT_TEXT_BYTES_MAX))
  const text = slice.toString('utf8').replace(/\u0000/g, '')
  const excerpt = parseProjectAssetExcerpt(text)
  return excerpt
}

/** 尽力解析前 2000 字符;失败/超时返回 null,调用方不得因此拒绝登记。 */
export async function tryExtractProjectAssetExcerpt(opts: {
  source: string
  mime?: string | null
  url?: string | null
  containerPath?: string | null
  name?: string | null
}): Promise<string | null> {
  if (opts.source !== 'upload') return null
  const filePath = resolveUploadExcerptPath(opts.url, opts.containerPath)
  if (!filePath) return null
  const hint = `${opts.mime ?? ''} ${opts.name ?? ''} ${filePath}`
  if (!isExcerptableMime(opts.mime ?? undefined, hint)) return null
  try {
    const mime = (opts.mime ?? mimeFromAssetName(opts.name ?? filePath) ?? '').toLowerCase()
    const looksDoc =
      mime === 'application/pdf' ||
      mime.includes('wordprocessingml.document') ||
      filePath.toLowerCase().endsWith('.pdf') ||
      filePath.toLowerCase().endsWith('.docx')
    if (looksDoc) {
      const parsed = await withTimeout(
        parseDocument(filePath, mime || 'application/octet-stream'),
        EXCERPT_PARSE_TIMEOUT_MS,
        'asset excerpt parseDocument',
      )
      if (!parsed?.markdown) return null
      return parseProjectAssetExcerpt(parsed.markdown.slice(0, PROJECT_ASSET_EXCERPT_MAX))
    }
    return await withTimeout(readPlainExcerpt(filePath), EXCERPT_PARSE_TIMEOUT_MS, 'asset excerpt read')
  } catch (err) {
    log.warn('asset excerpt extraction failed', { filePath }, err)
    return null
  }
}

export async function collectSessionOutputAssets(opts: {
  userId: string
  sessionId: string
  assistantText: string
}): Promise<void> {
  const paths = extractGeneratedOutputPaths(opts.assistantText)
  if (paths.length === 0) return
  for (const containerPath of paths) {
    try {
      const st = await stat(containerPath)
      if (!st.isFile()) continue
      const name = basename(containerPath)
      const result = await createProjectAsset(opts.userId, {
        source: 'output',
        sessionId: opts.sessionId,
        name,
        containerPath,
        mime: mimeFromAssetName(name),
        size: st.size,
      })
      if (!result.ok && result.error !== 'limit_exceeded') {
        log.warn('collectSessionOutputAssets create failed', {
          sessionId: opts.sessionId,
          containerPath,
          error: result.error,
        })
      }
    } catch (err) {
      log.warn('collectSessionOutputAssets skipped', { sessionId: opts.sessionId, containerPath }, err)
    }
  }
}
