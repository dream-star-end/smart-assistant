/**
 * codexShared — codex spawn 路径的共享 helper(M1a 复活)。
 *
 * 来源:P1f(0bed2f76)删除的旧 codexRunner.ts(`codex exec` legacy runner)。
 * exec 路径本身**不复活**(方案红线,见 v5-engine-adapter-PLAN M1),但其中 6 个
 * 符号被 codexAppServerRunner(app-server 形态,复活)依赖,按复活底稿抽到本文件:
 *   - _sanitizeThreadId / copyImagePathsToPublicDir(image_gen 落盘命名)
 *   - codexReasoningEffortConfig(effort → `-c model_reasoning_effort` 归一)
 *   - CodexProviderConfigOverride / buildCodexProviderConfigArgs(API relay 路由覆盖)
 *   - buildCodexEnv(env scrub —— 防 OpenClaude/Anthropic 凭证泄给 codex 进程)
 * 闭包只依赖 node 内建 + logger,与旧文件逐行为一致;exec 路径其余代码不进树。
 */
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'codexShared' })

/**
 * Per-thread directory where codex CLI persists images created via the built-in
 * `image_gen` skill. threadId is sanitized: codex thread_ids are ULID-like
 * (alphanumeric + hyphens) but we sanitize defensively so future format drift
 * cannot escape the dir.
 *
 * Exported so codexAppServerRunner (and tests) can construct expected paths
 * consistently.
 */
export function _sanitizeThreadId(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '')
}

/**
 * Copy a list of absolute image paths into OpenClaude's public generated/ dir.
 * Module-level helper so any codex runner shape (exec legacy scanned a
 * per-thread dir; app-server gets `savedPath` directly on the `imageGeneration`
 * thread item) can use the same copy + naming strategy.
 *
 * Naming: `codex-${sanitizedThreadId}-${basename(srcPath)}` — the basename is
 * already a content-addressable hash from codex (`ig_<hash>.png`), and the
 * thread id prefix prevents cross-thread collisions in the shared public dir.
 *
 * Caller is expected to pre-resolve `srcPaths` to absolute filesystem paths.
 * Failures (ENOENT, EACCES, EROFS) are logged once at warn and surfaced via
 * `failedNames` so the caller can render an "image copy failed" line.
 */
export async function copyImagePathsToPublicDir(
  threadId: string,
  srcPaths: string[],
  dstDir: string,
): Promise<{
  copied: Array<{ srcPath: string; publicPath: string }>
  failedNames: string[]
}> {
  const safeThread = _sanitizeThreadId(threadId)
  try {
    await mkdir(dstDir, { recursive: true })
  } catch (err) {
    log.warn('codex image public dir mkdir failed', {
      dstDir,
      err: (err as Error).message,
    })
  }
  const copied: Array<{ srcPath: string; publicPath: string }> = []
  const failedNames: string[] = []
  for (const src of srcPaths) {
    const name = basename(src)
    const dst = join(dstDir, `codex-${safeThread}-${name}`)
    try {
      await copyFile(src, dst)
      copied.push({ srcPath: src, publicPath: dst })
    } catch (err) {
      log.warn('codex image copy failed', {
        src,
        dst,
        err: (err as Error).message,
      })
      failedNames.push(name)
    }
  }
  return { copied, failedNames }
}

/**
 * Codex CLI 接受 `-c model_reasoning_effort=<val>`,合法值实测:
 *   none, minimal, low, medium, high, xhigh
 * 协议 `InboundMessage.effortLevel` 允许 low/medium/high/xhigh/max(对齐
 * DeepSeek/GLM 的统一前端模型)。这里:
 *   - low/medium/high/xhigh → 透传
 *   - max → 显式映射 xhigh(用户意图"最高",不能静默退回 codex 默认 medium)
 *   - 其他/缺失 → 不带 effort flag,让 codex 用它的默认(medium)
 *
 * 公共归一逻辑必须一处定义,否则 `max → xhigh` 映射 / allowlist 任一改动都会
 * 在多个 spawn 路径间漂移(原 codexRunner.ts / codexAppServerRunner.ts 教训)。
 */
const CODEX_EFFORT_DIRECT = new Set(['low', 'medium', 'high', 'xhigh'])
export function codexReasoningEffortConfig(level: string | undefined | null): string[] {
  if (typeof level !== 'string' || level.length === 0) return []
  const normalized = level === 'max' ? 'xhigh' : level
  if (!CODEX_EFFORT_DIRECT.has(normalized)) return []
  return ['-c', `model_reasoning_effort="${normalized}"`]
}

const CODEX_PROVIDER_ID_RE = /^[A-Za-z0-9_-]+$/

function tomlString(value: string): string {
  return JSON.stringify(value)
}

function envFlagDefaultTrue(value: string | undefined): boolean {
  if (value === undefined) return true
  const normalized = value.trim().toLowerCase()
  return !(normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off')
}

/**
 * Optional OpenAI-compatible relay configuration for codex CLI.
 *
 * v3 commercial uses this for relay providers such as Yunwu: the API key
 * still lives in CODEX_HOME/auth.json, while non-secret provider routing is
 * injected per spawn via `-c` overrides so user-writable config.toml cannot
 * accidentally route platform Codex traffic back to api.openai.com.
 */
export interface CodexProviderConfigOverride {
  modelProvider?: string
  baseUrl?: string
  providerName?: string | null
  wireApi?: string | null
  preferredAuthMethod?: string | null
  disableResponseStorage?: boolean | null
  /** v5 official_oauth relay override(方案 A2):true → 追加
   *  `-c model_providers.<id>.requires_openai_auth=true`,让 codex CLI 对自定义
   *  provider 仍走 auth.json 的 ChatGPT token(Authorization 发到容器 loopback
   *  relay,由 master egress 强制代理转发)。仅 override 路径支持 —— env
   *  OC_CODEX_* 六键属 api_relay 遗产(v5 部署已删),不为它新增第七键。 */
  requiresOpenaiAuth?: boolean | null
}

export function buildCodexProviderConfigArgs(
  env: NodeJS.ProcessEnv = process.env,
  override: CodexProviderConfigOverride | null = null,
): string[] {
  const hasOverride = override !== null
  const providerId = (hasOverride ? override.modelProvider ?? '' : env.OC_CODEX_MODEL_PROVIDER ?? '').trim()
  const baseUrl = (hasOverride ? override.baseUrl ?? '' : env.OC_CODEX_BASE_URL ?? '').trim()
  if (!providerId && !baseUrl) return []
  if (!providerId || !baseUrl) {
    log.warn('codex provider override incomplete; ignoring OC_CODEX_* relay config', {
      hasProvider: providerId.length > 0,
      hasBaseUrl: baseUrl.length > 0,
    })
    return []
  }
  if (!CODEX_PROVIDER_ID_RE.test(providerId)) {
    log.warn('codex provider override has invalid provider id; ignoring', { providerId })
    return []
  }

  const providerName = (
    hasOverride ? override.providerName ?? '' : env.OC_CODEX_PROVIDER_NAME ?? ''
  ).trim() || providerId
  const wireApi = (
    hasOverride ? override.wireApi ?? '' : env.OC_CODEX_WIRE_API ?? ''
  ).trim() || 'responses'
  const authMethod = (
    hasOverride ? override.preferredAuthMethod ?? '' : env.OC_CODEX_PREFERRED_AUTH_METHOD ?? ''
  ).trim() || 'apikey'
  const disableResponseStorage = hasOverride
    ? override.disableResponseStorage ?? true
    : envFlagDefaultTrue(env.OC_CODEX_DISABLE_RESPONSE_STORAGE)
  // requires_openai_auth 只有 override 路径(master 下发 official_oauth relay
  // override)会置 true;env 路径恒 false(不新增 env 键)。
  const requiresOpenaiAuth = hasOverride ? override.requiresOpenaiAuth === true : false

  return [
    '-c',
    `model_provider=${tomlString(providerId)}`,
    '-c',
    `model_providers.${providerId}.name=${tomlString(providerName)}`,
    '-c',
    `model_providers.${providerId}.base_url=${tomlString(baseUrl)}`,
    '-c',
    `model_providers.${providerId}.wire_api=${tomlString(wireApi)}`,
    ...(requiresOpenaiAuth
      ? ['-c', `model_providers.${providerId}.requires_openai_auth=true`]
      : []),
    '-c',
    `preferred_auth_method=${tomlString(authMethod)}`,
    '-c',
    `disable_response_storage=${disableResponseStorage ? 'true' : 'false'}`,
  ]
}

/** Env keys scrubbed from the codex subprocess environment.
 *  Rationale: codex CLI uses ChatGPT oauth from ~/.codex/auth.json — it has
 *  no need for Anthropic / CCB / gateway auth tokens, and passing them
 *  through would silently leak secrets to a different provider's process.
 *  Matched as exact keys OR as prefixes (for the _TOKEN/_KEY families).
 *
 *  安全红线:这条 scrub 与 promptSlots 的 `provider !== 'codex-native'`
 *  literature gate 成对 —— 一个断凭证 env,一个断"会用但调不通"的提示注入。
 *  任何一侧松动都要过安全评审。 */
const ENV_SCRUB_KEYS = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'OPENCLAUDE_GATEWAY_TOKEN',
  'OPENCLAUDE_ACCESS_TOKEN',
  'GATEWAY_AUTH_TOKEN',
  'MINIMAX_API_KEY',
  'DEEPSEEK_API_KEY',
])
const ENV_SCRUB_PREFIXES = ['ANTHROPIC_', 'CLAUDE_CODE_', 'OPENCLAUDE_']

/**
 * Build the env passed to a codex subprocess. Shared scrubbing rules for any
 * codex CLI spawn shape (`codex app-server` today) — codex's own CLI must not
 * see OpenClaude/Anthropic credentials.
 */
export function buildCodexEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ENV_SCRUB_KEYS.has(k)) continue
    if (ENV_SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  return out
}
