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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
 * Scans a Route B user JSON line for local gateway attachment paths (from `inboundDispatch`
 * `buildImageAttachmentHint` / unparsed file hints or `files` array) and embeds their bytes
 * as `inlineAttachments` so `host.mjs` on the Box can materialize and upload them to ChatGPT Web.
 */
export function inlineGptWebAttachmentsInUserLine(line: string): string {
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
  const msg = parsed.message ?? parsed
  const content = msg?.content ?? parsed.prompt ?? ''
  const candidatePaths: string[] = Array.isArray(parsed.files) ? [...parsed.files] : []

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
          candidatePaths.push(block.path)
        }
      }
    }
  }

  const bulletRe = /^-\s+`(\/[^`\n]+)`\s+\([^)\n]*原名:\s*([^)\n]+)\)/gm
  let match = bulletRe.exec(textContent)
  while (match !== null) {
    const p = match[1]
    if (p && !candidatePaths.includes(p)) {
      candidatePaths.push(p)
    }
    match = bulletRe.exec(textContent)
  }

  if (candidatePaths.length === 0) return line

  const inlineAttachments: Array<{ name: string; base64: string }> = []
  for (const fp of candidatePaths) {
    try {
      if (existsSync(fp) && statSync(fp).isFile()) {
        const buf = readFileSync(fp)
        inlineAttachments.push({
          name: basename(fp),
          base64: buf.toString('base64'),
        })
      }
    } catch {}
  }

  if (inlineAttachments.length === 0) return line
  parsed.inlineAttachments = inlineAttachments
  return JSON.stringify(parsed)
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
  env: NodeJS.ProcessEnv = process.env,
): BoxCcExecRequest {
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
