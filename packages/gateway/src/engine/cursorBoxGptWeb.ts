/**
 * Route B interactive browser runner for ChatGPT Web Pro (box-gpt-6-astra-pro, OCV5-551).
 *
 * Uses the same Box exec channel, FIFO stdin, write execs, stop exec, and Route B
 * stream-json stdout framing as cursorBoxCcInteractive.ts, while running
 * box-gpt-web-mod/host.mjs + chatgptWebCore.mjs on the Box against the persistent
 * real Google Chrome profile (/home/box/.chatgpt-pro-<profile>) on DISPLAY=:1.
 *
 * Node built-ins only: the bridge is spawned as plain node.
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOX_CC_HOME,
  BOX_CC_REAP_FUNCTION,
  type BoxCcControl,
  type BoxCcExecRequest,
  boxGptWebModel,
  isBoxGptWebCatalogModel,
} from './cursorBoxCcExec.js'

const SAFE_FLAG = new Set([
  '--model',
  '--resume',
  '--session-id',
  '--profile',
  '--cdp-port',
  '--proxy',
])
const BOX_CC_PATH =
  '/home/box/.local/bin:/home/box/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const MAX_EXEC_STRING = 120 * 1024
const BOX_LOGIN_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/i
const FORBIDDEN_PROXY_PORTS = new Set([18991, 19095])

export const BOX_GPT_WEB_OWNER_UID = 3
export const BOX_GPT_WEB_OWNER_UID_STR = '3'
export const BOX_GPT_WEB_MAX_CONCURRENCY = 1
export const BOX_GPT_WEB_BUSY_CODE = 'BOX_GPT_WEB_BUSY'
export const BOX_GPT_WEB_BUSY_MESSAGE =
  'Pro 通道忙：当前已有 gpt-6-astra-pro 对话正在执行，一次只能运行一个 Pro 对话，请等待当前对话完成后再试。'

let activeBoxGptWebTurnOwner: string | null = null

export function isBoxGptWebAllowedContainerUser(env: NodeJS.ProcessEnv = {}): boolean {
  const raw = env.OC_USER_ID?.trim()
  if (!raw) {
    return !env.OC_CONTAINER_ID
  }
  return raw === BOX_GPT_WEB_OWNER_UID_STR
}

export function tryAcquireBoxGptWebTurnSlot(ownerId: string): boolean {
  if (!ownerId) return false
  if (activeBoxGptWebTurnOwner !== null && activeBoxGptWebTurnOwner !== ownerId) {
    return false
  }
  activeBoxGptWebTurnOwner = ownerId
  return true
}

export function releaseBoxGptWebTurnSlot(ownerId?: string): void {
  if (ownerId === undefined || activeBoxGptWebTurnOwner === ownerId) {
    activeBoxGptWebTurnOwner = null
  }
}

export function currentBoxGptWebTurnSlotOwner(): string | null {
  return activeBoxGptWebTurnOwner
}

export interface BoxGptWebMod {
  chatgptWebCoreMjs: string
  hostMjs: string
  sha256: string
}

export function boxGptWebModRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'box-gpt-web-mod')
}

export function loadBoxGptWebMod(root: string = boxGptWebModRoot()): BoxGptWebMod {
  const coreBuf = readFileSync(join(root, 'chatgptWebCore.mjs'))
  const hostBuf = readFileSync(join(root, 'host.mjs'))
  const h = createHash('sha256')
  h.update('chatgptWebCore.mjs\0')
  h.update(coreBuf)
  h.update('\0host.mjs\0')
  h.update(hostBuf)
  return {
    chatgptWebCoreMjs: coreBuf.toString('utf8'),
    hostMjs: hostBuf.toString('utf8'),
    sha256: h.digest('hex'),
  }
}

export function isBoxGptWebModelArgv(argv: readonly string[]): boolean {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--model') {
      const val = argv[i + 1]
      if (isBoxGptWebCatalogModel(val) || boxGptWebModel(val) !== undefined) {
        return true
      }
    }
  }
  return false
}

export function remoteInteractiveGptWebArgs(argv: readonly string[]): string[] {
  const out: string[] = []
  let sawModel = false
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!flag || !SAFE_FLAG.has(flag)) continue
    const value = argv[i + 1]
    if (!value || value.startsWith('-')) continue
    if (flag === '--model') {
      sawModel = true
      out.push('--model', boxGptWebModel(value) ?? value)
    } else {
      out.push(flag, value)
    }
    i++
  }
  if (!sawModel) {
    out.unshift('--model', 'gpt-6-astra-pro')
  }
  return out
}

/**
 * Validates that an optional local proxy URL for the Box Chrome profile binds strictly to
 * loopback (127.0.0.1 / localhost) and never touches kl-mirror's 18991 / 19095 ports.
 */
export function validateBoxGptWebLoopbackProxy(proxyUrl: string | undefined | null): string | null {
  if (!proxyUrl) return null
  const raw = proxyUrl.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(`BOX_GPT_WEB_PROXY_INVALID_URL: ${raw}`)
  }
  if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    throw new Error(`BOX_GPT_WEB_PROXY_UNSUPPORTED_PROTOCOL: ${parsed.protocol}`)
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`BOX_GPT_WEB_PROXY_NOT_LOOPBACK: ${parsed.hostname}`)
  }
  const port = Number(parsed.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`BOX_GPT_WEB_PROXY_MISSING_PORT: ${raw}`)
  }
  if (FORBIDDEN_PROXY_PORTS.has(port)) {
    throw new Error(`BOX_GPT_WEB_PROXY_FORBIDDEN_PORT: ${port}`)
  }
  return `${parsed.protocol}//${parsed.hostname}:${port}`
}

/**
 * Returns the default trusted upload roots on the gateway (`~/.openclaude/uploads`
 * or `$OPENCLAUDE_HOME/uploads`), matching `paths.uploadsDir` in `@openclaude/storage`
 * using Node built-ins only so `cursorBoxCcBridge` can run as plain `node`.
 */
export function defaultTrustedUploadRoots(env: NodeJS.ProcessEnv = {}): string[] {
  const ocHome = env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  return [join(ocHome, 'uploads')]
}

export function defaultGeneratedOutputDir(env: NodeJS.ProcessEnv = {}): string {
  const ocHome = env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')
  return join(ocHome, 'generated')
}

export interface GptWebOutputAttachmentPayload {
  name?: string
  sandboxUrl?: string
  sandboxPath?: string
  fileId?: string
  mimeType?: string
  size?: number
  base64?: string
}

export interface MaterializedGptWebOutputArtifact {
  name: string
  sandboxUrl?: string
  sandboxPath?: string
  fileId?: string
  mimeType?: string
  mediaUrl: string
  generatedPath: string
  containerGeneratedPath: string
  isImage: boolean
}

const MIME_EXT_MAP: Record<string, string> = {
  'text/html': '.html',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
}

function sanitizeOutputFilename(rawName: string | undefined, mimeType?: string): string {
  const base = basename(String(rawName || 'output')).replace(/[^a-zA-Z0-9._-]/g, '_')
  const cleaned = base.replace(/\.{2,}/g, '_').replace(/^[._-]+/, '') || 'output'
  const existingExt = extname(cleaned)
  if (existingExt && /^\.[a-zA-Z0-9]{1,10}$/.test(existingExt)) {
    return cleaned.slice(0, 120)
  }
  const normalizedMime = String(mimeType || '')
    .split(';')[0]
    ?.trim()
    .toLowerCase()
  const fallbackExt = (normalizedMime && MIME_EXT_MAP[normalizedMime]) || '.bin'
  return `${cleaned.slice(0, 110)}${fallbackExt}`
}

function rewriteTextWithMaterializedArtifacts(
  text: string,
  artifacts: readonly MaterializedGptWebOutputArtifact[],
): string {
  if (!artifacts.length) return text
  let out = text
  for (const art of artifacts) {
    if (art.sandboxUrl) {
      out = out.split(art.sandboxUrl).join(art.mediaUrl)
    }
    if (art.sandboxPath) {
      out = out.split(`sandbox:${art.sandboxPath}`).join(art.mediaUrl)
    }
    out = out.split(`sandbox:/mnt/data/${art.name}`).join(art.mediaUrl)
  }

  const missingDeliverables = artifacts.filter(
    (art) => !out.includes(art.containerGeneratedPath),
  )
  if (missingDeliverables.length > 0) {
    const lines: string[] = ['', '', '---', '**已取回 Pro 生成的文件（可直接点击下载）：**']
    for (const art of missingDeliverables) {
      if (art.isImage && !out.includes(`(${art.mediaUrl})`)) {
        lines.push(`![${art.name}](${art.mediaUrl})`)
      }
      lines.push(`- [${art.name}](${art.mediaUrl}) (\`${art.containerGeneratedPath}\`)`)
    }
    out = `${out.trimEnd()}\n${lines.join('\n')}`
  }
  return out
}

/**
 * Intercepts a Route B stdout JSON line from `host.mjs`, materializes any `outputAttachments`
 * into both `~/.openclaude/uploads/<sha256>.<ext>` (served by `/api/media/<sha256>.<ext>`) and
 * `~/.openclaude/generated/<safeName>` (collected by `collectSessionOutputAssets` into the
 * Personal Edition Outputs panel), and rewrites `sandbox:/...` links in `text_delta`,
 * `assistant`, and `result` frames.
 */
export function materializeGptWebOutputAttachmentsInStdoutLine(
  line: string,
  opts?: {
    env?: NodeJS.ProcessEnv
    uploadsDir?: string
    generatedDir?: string
  },
): string {
  if (!line || !line.includes('"outputAttachments"')) return line
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return line
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(trimmed) as Record<string, any>
  } catch {
    return line
  }
  if (!parsed || typeof parsed !== 'object') return line
  const rawList = parsed.outputAttachments
  delete parsed.outputAttachments
  if (!Array.isArray(rawList) || rawList.length === 0) {
    return JSON.stringify(parsed)
  }

  const uploadsDir =
    opts?.uploadsDir ?? defaultTrustedUploadRoots(opts?.env)[0] ?? join(homedir(), '.openclaude', 'uploads')
  const generatedDir = opts?.generatedDir ?? defaultGeneratedOutputDir(opts?.env)

  try {
    mkdirSync(uploadsDir, { recursive: true, mode: 0o700 })
    mkdirSync(generatedDir, { recursive: true, mode: 0o700 })
  } catch {}

  const materialized: MaterializedGptWebOutputArtifact[] = []
  for (const item of rawList as GptWebOutputAttachmentPayload[]) {
    if (!item || typeof item.base64 !== 'string' || !item.base64) continue
    let buf: Buffer
    try {
      buf = Buffer.from(item.base64, 'base64')
    } catch {
      continue
    }
    if (buf.byteLength === 0) continue

    const safeName = sanitizeOutputFilename(item.name, item.mimeType)
    const ext = extname(safeName).toLowerCase() || '.bin'
    const digest = createHash('sha256').update(buf).digest('hex')
    const casFilename = `${digest}${ext}`
    const casPath = join(uploadsDir, casFilename)
    const genPath = join(generatedDir, safeName)

    try {
      writeFileSync(casPath, buf, { mode: 0o600 })
    } catch {}
    try {
      writeFileSync(genPath, buf, { mode: 0o600 })
    } catch {}

    const isImage =
      /^image\//i.test(String(item.mimeType || '')) ||
      /\.(png|jpe?g|gif|webp|svg)$/i.test(safeName)

    materialized.push({
      name: safeName,
      ...(item.sandboxUrl ? { sandboxUrl: item.sandboxUrl } : {}),
      ...(item.sandboxPath ? { sandboxPath: item.sandboxPath } : {}),
      ...(item.fileId ? { fileId: item.fileId } : {}),
      ...(item.mimeType ? { mimeType: item.mimeType } : {}),
      mediaUrl: `/api/media/${casFilename}`,
      generatedPath: genPath,
      containerGeneratedPath: `/home/agent/.openclaude/generated/${safeName}`,
      isImage,
    })
  }

  if (materialized.length === 0) {
    return JSON.stringify(parsed)
  }

  if (
    parsed.type === 'stream_event' &&
    parsed.event?.type === 'content_block_delta' &&
    parsed.event?.delta?.type === 'text_delta' &&
    typeof parsed.event.delta.text === 'string'
  ) {
    parsed.event.delta.text = rewriteTextWithMaterializedArtifacts(
      parsed.event.delta.text,
      materialized,
    )
  } else if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
    for (const block of parsed.message.content) {
      if (block && block.type === 'text' && typeof block.text === 'string') {
        block.text = rewriteTextWithMaterializedArtifacts(block.text, materialized)
      }
    }
  } else if (parsed.type === 'result' && typeof parsed.result === 'string') {
    parsed.result = rewriteTextWithMaterializedArtifacts(parsed.result, materialized)
  }

  return JSON.stringify(parsed)
}

function resolveTrustedUploadFile(
  filePath: string,
  allowedUploadRoots: readonly string[],
): string | null {
  if (!filePath || allowedUploadRoots.length === 0) return null
  let real: string
  try {
    real = realpathSync(filePath)
  } catch {
    return null
  }
  for (const rootDir of allowedUploadRoots) {
    if (!rootDir) continue
    let rootReal: string
    try {
      rootReal = realpathSync(rootDir)
    } catch {
      continue
    }
    const prefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
    if (real.startsWith(prefix)) {
      try {
        if (statSync(real).isFile()) return real
      } catch {}
    }
  }
  return null
}

const INBOUND_IMAGE_HINT_BLOCK_RE =
  /\n*---\n用户附带了以下图片\(已保存到服务器本地\):\n((?:- `\/[^`\r\n]+` \([^\r\n]*?原名: [^\r\n]+\)\r?\n?)+)\n如果需要看图片内容:\n1\. 用 Read 工具读图片路径\(原生多模态 provider 会直接看到图像\)。\n2\. 如果当前 provider 不支持图片识别,告诉用户。/g

const INBOUND_UNPARSED_DOC_BLOCK_RE =
  /\n*---\n用户还附带了以下文档\(已保存到服务器本地,gateway 没能预解析 ——\n可能因为格式不支持、解析失败或解析超时\):\n((?:- `\/[^`\r\n]+` \([^\r\n]*?原名: [^\r\n]+\)\r?\n?)+)\n可以用 Read 工具读取文档内容\(对纯文本、CSV、源码、PDF 等都有效\n—— 大 PDF 即便预解析超时,Read 也可能能拿到部分文本\)。\n若是 \.doc 老格式 Word 二进制,Read 会看到乱码 —— 礼貌地请用户转存为 \.docx 重传。/g

/**
 * Scans a Route B user JSON line for local gateway attachment paths (from `inboundDispatch`
 * `buildImageAttachmentHint` / unparsed file hints or `files` array), verifies that every path
 * resolves inside `allowedUploadRoots` (`paths.uploadsDir`), and embeds their bytes
 * as `inlineAttachments` so `host.mjs` on the Box can materialize and upload them to ChatGPT Web.
 */
export function inlineGptWebAttachmentsInUserLine(
  line: string,
  opts?: { allowedUploadRoots?: readonly string[]; env?: NodeJS.ProcessEnv },
): string {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return line
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(trimmed) as Record<string, any>
  } catch {
    return line
  }
  if (!parsed || typeof parsed !== 'object' || (parsed.type && parsed.type !== 'user')) {
    return line
  }
  const allowedRoots = opts?.allowedUploadRoots ?? defaultTrustedUploadRoots(opts?.env)
  const msg = parsed.message ?? parsed
  const content = msg?.content ?? parsed.prompt ?? ''
  const verifiedFiles: string[] = []

  const addIfTrusted = (fp: string): boolean => {
    const resolved = resolveTrustedUploadFile(fp, allowedRoots)
    if (!resolved) return false
    if (!verifiedFiles.includes(resolved)) {
      verifiedFiles.push(resolved)
    }
    return true
  }

  if (Array.isArray(parsed.files)) {
    for (const fp of parsed.files) {
      if (typeof fp === 'string') addIfTrusted(fp)
    }
  }

  let textContent = ''
  if (typeof content === 'string') {
    textContent = content
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        if (block.type === 'text' && typeof block.text === 'string') {
          textContent += `${block.text}\n`
        } else if (
          (block.type === 'image' || block.type === 'file') &&
          typeof block.path === 'string'
        ) {
          addIfTrusted(block.path)
        }
      }
    }
  }

  const bulletRe = /^-\s+`(\/[^`\r\n]+)`\s+\([^\r\n]*?原名:\s*([^\r\n]+)\)\s*$/gm
  const processBlock = (fullMatch: string, bulletSection: string) => {
    const blockPaths: string[] = []
    bulletRe.lastIndex = 0
    let m = bulletRe.exec(bulletSection)
    while (m !== null) {
      if (m[1]) blockPaths.push(m[1])
      m = bulletRe.exec(bulletSection)
    }
    if (blockPaths.length === 0) return fullMatch
    const resolvedBlock: string[] = []
    for (const p of blockPaths) {
      const resolved = resolveTrustedUploadFile(p, allowedRoots)
      if (!resolved) return fullMatch
      resolvedBlock.push(resolved)
    }
    for (const rp of resolvedBlock) {
      if (!verifiedFiles.includes(rp)) {
        verifiedFiles.push(rp)
      }
    }
    return ''
  }

  let cleanedText = textContent.replace(INBOUND_IMAGE_HINT_BLOCK_RE, processBlock)
  cleanedText = cleanedText.replace(INBOUND_UNPARSED_DOC_BLOCK_RE, processBlock)

  if (verifiedFiles.length === 0) return line

  const inlineAttachments: Array<{ name: string; base64: string }> = []
  for (const fp of verifiedFiles) {
    try {
      const buf = readFileSync(fp)
      inlineAttachments.push({
        name: basename(fp),
        base64: buf.toString('base64'),
      })
    } catch {}
  }

  if (inlineAttachments.length === 0) return line
  if (typeof msg?.content === 'string') {
    msg.content = cleanedText.trim() || '请分析上传的附件。'
  } else if (typeof parsed.prompt === 'string') {
    parsed.prompt = cleanedText.trim() || '请分析上传的附件。'
  }
  parsed.inlineAttachments = inlineAttachments
  return JSON.stringify(parsed)
}

/**
 * Ensures a Route B user JSON line carries a stable `ocTurnId` across mid-turn
 * bridge reconnects so `host.mjs` can distinguish a reconnect of the same turn
 * from a subsequent user turn with identical text.
 */
export function stampGptWebTurnIdInUserLine(line: string): string {
  if (!line || !line.trim().startsWith('{')) return line
  const hasTrailingNewline = line.endsWith('\n')
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(line.trim()) as Record<string, any>
  } catch {
    return line
  }
  if (!parsed || typeof parsed !== 'object') return line
  if (parsed.type && parsed.type !== 'user') return line
  if (typeof parsed.ocTurnId === 'string' && parsed.ocTurnId.trim()) {
    return line
  }
  const rest = { ...parsed }
  delete rest.type
  const ordered = {
    ...(parsed.type ? { type: parsed.type } : {}),
    ...rest,
    ocTurnId: randomUUID(),
  }
  return `${JSON.stringify(ordered)}${hasTrailingNewline ? '\n' : ''}`
}

export const BOX_GPT_WEB_INTERACTIVE_LAUNCH_SCRIPT = [
  'set -eu',
  'fifo="$1"',
  'shift 1',
  ...BOX_CC_REAP_FUNCTION,
  'for old in "${fifo%.*.fifo}".*.fifo; do',
  '  if [ "$old" = "$fifo" ] || [ ! -p "$old" ]; then continue; fi',
  '  reap "$old"',
  '  rm -f "$old" "$old.in" "$old.seq" "$old.lock"',
  '  rm -rf "${old%.fifo}.d"',
  'done',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'run="${fifo%.fifo}.d"',
  'rm -rf "$run"',
  'mkdir -p -m 700 "$run"',
  'printf "%s" "$OC_BOX_GPT_WEB_CORE_MJS" > "$run/chatgptWebCore.mjs"',
  'printf "%s" "$OC_BOX_GPT_WEB_HOST_MJS" > "$run/host.mjs"',
  'chmod 700 "$run/host.mjs"',
  'mkfifo -m 600 "$fifo"',
  'exec 3<>"$fifo"',
  'echo "$$" > "$run/host.pid"',
  'printf "BOX_INTERACTIVE_READY\\n" >&2',
  'set +e',
  'node "$run/host.mjs" "$@" <"$fifo"',
  'status=$?',
  'set -e',
  'exec 3>&-',
  'rm -f "$fifo" "$fifo.in" "$fifo.seq" "$fifo.lock"',
  'rm -rf "$run"',
  'exit "$status"',
].join('\n')

export function boxGptWebInteractiveLaunchExec(
  control: BoxCcControl,
  remoteArgs: readonly string[],
  mod: BoxGptWebMod = loadBoxGptWebMod(),
  profile = 'default',
  env: NodeJS.ProcessEnv = {},
): BoxCcExecRequest {
  if (!isBoxGptWebAllowedContainerUser(env)) {
    throw new Error('BOX_GPT_WEB_FORBIDDEN_USER')
  }
  if (profile !== 'default' && !BOX_LOGIN_NAME.test(profile)) {
    throw new Error('BOX_INTERACTIVE_PROFILE_INVALID')
  }
  const validatedProxy = validateBoxGptWebLoopbackProxy(env.OC_BOX_GPT_WEB_PROXY)
  const environment: Record<string, string> = {
    HOME: BOX_CC_HOME,
    PATH: BOX_CC_PATH,
    LANG: 'C.UTF-8',
    DISPLAY: env.OC_BOX_GPT_WEB_DISPLAY || ':1',
    OC_BOX_GPT_WEB_PROFILE: profile,
    ...(env.OC_BOX_GPT_WEB_CDP_PORT
      ? { OC_BOX_GPT_WEB_CDP_PORT: env.OC_BOX_GPT_WEB_CDP_PORT }
      : {}),
    ...(env.OC_BOX_GPT_WEB_MAX_TIMEOUT_MS
      ? { OC_BOX_GPT_WEB_MAX_TIMEOUT_MS: env.OC_BOX_GPT_WEB_MAX_TIMEOUT_MS }
      : {}),
    ...(env.OC_BOX_GPT_WEB_STALL_TIMEOUT_MS
      ? { OC_BOX_GPT_WEB_STALL_TIMEOUT_MS: env.OC_BOX_GPT_WEB_STALL_TIMEOUT_MS }
      : {}),
    OC_BOX_GPT_WEB_CORE_MJS: mod.chatgptWebCoreMjs,
    OC_BOX_GPT_WEB_HOST_MJS: mod.hostMjs,
    OC_BOX_GPT_WEB_MOD_SHA256: mod.sha256,
    ...(validatedProxy ? { OC_BOX_GPT_WEB_PROXY: validatedProxy } : {}),
  }
  for (const value of Object.values(environment)) {
    if (Buffer.byteLength(value) > MAX_EXEC_STRING) {
      throw new Error('BOX_INTERACTIVE_MOD_TOO_LARGE')
    }
  }
  return {
    command: 'sh',
    args: ['-c', BOX_GPT_WEB_INTERACTIVE_LAUNCH_SCRIPT, 'sh', control.fifo, ...remoteArgs],
    cwd: control.cwd,
    environment,
  }
}
