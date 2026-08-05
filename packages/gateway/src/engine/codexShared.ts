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
import {
  modelReasoningPolicy,
  type PlatformReasoningEffort,
} from '@openclaude/protocol'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'codexShared' })

const QWEN38_CODEX_MODEL_ID = 'qwen3.8-max'
const QWEN38_CODEX_REASONING_EFFORTS: ReadonlySet<PlatformReasoningEffort> = new Set([
  'low',
  'medium',
  'xhigh',
])
const QWEN38_CODEX_MODEL_CATALOG =
  '/run/oc/platform/current/etc-codex/model-catalog.local.json'

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
 * 把用户覆盖收敛到 protocol 的 per-model 思考权威。已知 Codex 型号在用户未覆盖
 * 或传入非法档位时回到该型号自身默认(Sol=low,Terra/Luna=medium),而不是旧版
 * 一律强制 high。`max` 在 Codex 0.144 已原生支持,直接透传,不再降成 xhigh。
 */
export function normalizeCodexReasoningEffort(
  modelId: string | undefined,
  level: string | undefined | null,
): PlatformReasoningEffort | null {
  // qwen3.8-max 通过签名 catalog authority 动态切到 Codex engine；它有意不进
  // baked CODEX_ENGINE_MODELS，避免旧镜像/无 authority 路径把静态 Bailian 型号
  // 误判成 Codex。Codex spawn 这里因此需要 exact-model 的三档策略，不能再让
  // 静态 provider 的 stripBodyFields 把 signed descriptor 已校验的 effort 丢掉。
  if (modelId === QWEN38_CODEX_MODEL_ID) {
    return typeof level === 'string'
      && QWEN38_CODEX_REASONING_EFFORTS.has(level as PlatformReasoningEffort)
      ? level as PlatformReasoningEffort
      : 'xhigh'
  }
  const policy = modelReasoningPolicy(modelId ?? '')
  if (
    typeof level === 'string' &&
    policy.supported.includes(level as PlatformReasoningEffort)
  ) {
    return level as PlatformReasoningEffort
  }
  return policy.codexModelDefault
}

/**
 * qwen3.8-max 的 Codex 模型元数据由 root-owned platform bundle 提供。只对 exact
 * canonical id 注入，不能按 provider 放大作用面；其它 Codex/GPT spawn argv 不变。
 */
export function buildCodexModelCatalogArgs(modelId: string | undefined): string[] {
  if (modelId !== QWEN38_CODEX_MODEL_ID) return []
  return ['-c', `model_catalog_json=${JSON.stringify(QWEN38_CODEX_MODEL_CATALOG)}`]
}

export function codexReasoningEffortConfig(
  modelId: string | undefined,
  level: string | undefined | null,
): string[] {
  const normalized = normalizeCodexReasoningEffort(modelId, level)
  return normalized ? ['-c', `model_reasoning_effort="${normalized}"`] : []
}

/** env 值是否为"显式打开"(on/1/true/yes)。默认关的开关用它。 */
function envFlagExplicitOn(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/**
 * T1 根治 —— 关闭 codex app-server 的原生多 agent 能力(`features.multi_agent_v2`)。
 *
 * 背景:codex 0.138 的 `features.multi_agent_v2` 一旦启用(gpt-5.5 服务端会推该
 * 能力),模型工具集里就会出现原生 `spawnAgent/sendInput/wait/closeAgent` 这套
 * 子 agent 编排工具。队长(gpt-5.5)倾向直接调原生 `spawnAgent`,而这条路径:
 *   - 子 agent 跑在 codex app-server 进程内部,openclaude 只能观测到"启动/终态"
 *     两个点(见 codexAppServerRunner.handleCollabAgentToolStarted),**全程零实时
 *     进度**——正是"任务卡出来但消息区长时间空白"的根因之一。
 *   - 绕开了 openclaude 的 `delegate_task`,也就绕开了计费 / 递归深度闸 / 并发资源
 *     闸 / 实时进度透传。等于在 delegate_task 之外又开了第二套委派权威源。
 *
 * v5 的委派唯一权威源是 `delegate_task`(mcp-memory 内置 MCP 工具,与本 feature
 * 完全解耦,恒带 streamProgress:true)。因此这里**每次 spawn 无条件关闭**原生多
 * agent(不仅团队模式),从底座消除"无计费/无进度的原生子 agent"一整类风险,而
 * 不是只堵团队模式这一个症状——config 是 per-spawn(app-server 长驻跨多 turn),
 * 按 turn 级 teamMode 切换需要反复 respawn,得不偿失;而原生 spawnAgent 在任何模式
 * 下都不该替代 delegate_task,全局关闭反而是对称、干净的根治。
 *
 * 逃生舱:`OC_CODEX_NATIVE_MULTI_AGENT=on`(或 1/true/yes)→ 不追加关闭参数,恢复
 * codex 原生多 agent,线上万一需要临时放开可即时切。默认(未设/其它值)= 关闭。
 *
 * 与 `delegate_task` 的关系已在 mcp-memory 侧核实:delegate_task 是纯 MCP 工具,
 * 不依赖 collaborationMode / multi_agent_v2,关闭本 feature 不影响其可用性。
 */
export function buildCodexMultiAgentDisableArgs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (envFlagExplicitOn(env.OC_CODEX_NATIVE_MULTI_AGENT)) return []
  return ['-c', 'features.multi_agent_v2=false']
}

/**
 * T3 思考可见 —— 给 chatgpt/官方 OAuth(codex-native)provider 的 codex 启动追加
 * `model_reasoning_summary="auto"`,让 gpt-5.5 队长的思考阶段吐出 summary 流。
 *
 * codex 把 `item/reasoning/summaryTextDelta` 映射成 CCB `thinking_delta`(见
 * codexAppServerRunner.handleNotification),前端渲染 💭 思考卡;不加本参数时
 * gpt-5.5 relay 不产 summary,队长思考阶段一张 thinking 卡都不出。
 *
 * 作用面收敛:仅当 provider === 'codex-native' 时才加(codex app-server 底座
 * 的 agentProvider 被 codexAdapter 强制归一为 'codex-native',即 v5 的 gpt-5.5
 * 官方 OAuth 路径)。别的 provider / 别的引擎(CCB 走 subprocessRunner,根本不经
 * 本 helper)零变化。
 *
 * env 开关:`OC_CODEX_REASONING_SUMMARY=off`(0/false/no/off)→ 不加该参数,线上
 * 出问题可秒关。默认(未设)= 打开。
 */
export function buildCodexReasoningSummaryArgs(
  provider: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (provider !== 'codex-native') return []
  if (!envFlagDefaultTrue(env.OC_CODEX_REASONING_SUMMARY)) return []
  return ['-c', 'model_reasoning_summary="auto"']
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
    // ── 原生 API 重试旋钮(turn-retry 批,2026-07-18)────────────────────
    // codex 0.144 `--strict-config` 下两键实测被接受(两 key 分别用真实 relay
    // key 验证通过;bogus provider id 被 CODEX_PROVIDER_ID_RE 拒证明校验真实)。
    // 两旋钮对 5xx/上游过载**乘性**生效:单个 API 调用的总尝试 = (request+1)×
    // (stream+1)。此处 request_max_retries=1、stream_max_retries=5 → 单调用最多
    // 12 次尝试(默认 request=0×stream=5 = 6 次,约 7.3s 指数退避)。
    // 目的:把 mid-turn capacity 血崩窗口从 ~7s 拉宽到 ~30s+。这是**无副作用**的
    // 正确重试层 —— 底座在同一个 HTTP 调用内做透明重放,不重发 turn、不重复
    // user input(与 runner 上层「仅 turn/start 请求本身被拒」的窄路径重试正交,
    // 见 codexAppServerRunner.runTurn 实测②注释)。
    '-c',
    `model_providers.${providerId}.request_max_retries=1`,
    '-c',
    `model_providers.${providerId}.stream_max_retries=5`,
    ...(requiresOpenaiAuth
      ? ['-c', `model_providers.${providerId}.requires_openai_auth=true`]
      : []),
    '-c',
    `preferred_auth_method=${tomlString(authMethod)}`,
    '-c',
    `disable_response_storage=${disableResponseStorage ? 'true' : 'false'}`,
  ]
}

/**
 * Telemetry / self-update hardening `-c` overrides for `codex app-server`
 * (v5 feat/v5-codex-telemetry-block —— C1 配置面双保险).
 *
 * 与 provider 路由(buildCodexProviderConfigArgs)是**不同关注点**,单独成函数
 * 并在 codexAppServerRunner 每次 spawn **无条件** spread —— 不能挂在 provider
 * override 成功路径上(那条早返回 [] 时遥测保护会一起丢)。三层防御的中间层:
 *   1. 镜像 root-owned /etc/codex/managed_config.toml(用户不可覆盖层,主权威)
 *   2. 本函数的每-spawn `-c`(managed_config 万一被非法值整份丢弃时兜底)
 *   3. host 侧 ipset REJECT(网络面 fail-closed 终极兜底)
 *
 * 键名/枚举值经 codex 0.137 二进制 + 运行时探针实测(2026-07-03,镜像
 * v5-ccb-5af8167f):
 *   - `analytics.enabled=false` —— 关 chatgpt.com backend-api analytics-events 上报
 *   - `otel.trace_exporter="none"` / `otel.metrics_exporter="none"` —— 关 OTLP/statsig
 *     遥测(合法枚举实测 = none/statsig/otlp-http/otlp-grpc;方案原写的
 *     `log_exporter` 在 0.137 不是有效键,已剔除,见 commit)
 *   - `check_for_update_on_startup=false` —— 关启动期 api.github.com release 检查
 *   - `chatgpt_base_url`(顶层键,独立于数据面 model_providers.<id>.base_url)——
 *     把 codex 对 ChatGPT backend-api 的残余请求(agent-identity 等)引到容器
 *     loopback relay;relay allowlist 外 → 404,不出容器、不计费。
 *
 * ⚠️ 只放**实测有效**的键 —— codex 0.137 对已知键的非法值会把整份配置丢弃
 * 回落默认(`Invalid configuration; using defaults`),连带 managed_config 的
 * 保护也失效。任何新增键必须先探针。
 */
export function buildCodexTelemetryHardeningArgs(chatgptRelayBaseUrl?: string | null): string[] {
  const args: string[] = [
    '-c',
    'analytics.enabled=false',
    '-c',
    'otel.trace_exporter="none"',
    '-c',
    'otel.metrics_exporter="none"',
    '-c',
    'check_for_update_on_startup=false',
  ]
  const base = chatgptRelayBaseUrl?.trim()
  if (base) {
    args.push('-c', `chatgpt_base_url=${tomlString(base)}`)
  }
  return args
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

/** Proxy env keys scrubbed from the codex subprocess(v5 telemetry-block nit1,
 *  A 网络面 fail-closed 的前提)。
 *
 *  容器把 HTTP(S)_PROXY 指向内部 Anthropic egress 代理(supervisor.ts 注入
 *  HTTP_PROXY/HTTPS_PROXY=172.31.0.1:18892)。codex reqwest 若继承,它对
 *  chatgpt.com / ab.chatgpt.com 的遥测直连会先 CONNECT 到内部代理 —— 于是
 *  host 侧网络层 A(按 dst IP 匹配 chatgpt 网段)看到的 TCP dst 是代理 IP
 *  而非 chatgpt,规则不命中 → 不 fail-closed → 遥测经代理外泄破坏账号 IP 纯净。
 *  剥掉全大小写变体后,codex 的唯一合法出口 = 容器 loopback relay(127.0.0.1
 *  直连),其余对外遥测走直连 → 落进网络层 A 的 dst 匹配 → REJECT。 */
const ENV_SCRUB_PROXY_KEYS = new Set<string>([
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
])

/** codex 子进程强制 NO_PROXY:loopback + v5 网关。正向声明直连,不能只靠
 *  scrub —— 即便某代理键漏网/被下游重设,loopback relay(数据面)与网关仍直连,
 *  绝不被代理劫走。172.31.0.1 = v5 桥网关(与本封堵方案同为 v5-image 作用域)。 */
const CODEX_FORCED_NO_PROXY = '127.0.0.1,localhost,172.31.0.1'

/**
 * Build the env passed to a codex subprocess. Shared scrubbing rules for any
 * codex CLI spawn shape (`codex app-server` today) — codex's own CLI must not
 * see OpenClaude/Anthropic credentials, nor inherit the container-wide egress
 * proxy(遥测直连必须走直连,才能被 host 网络层 A 按 dst 匹配封堵)。
 */
export function buildCodexEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (ENV_SCRUB_KEYS.has(k)) continue
    if (ENV_SCRUB_PROXY_KEYS.has(k)) continue
    if (ENV_SCRUB_PREFIXES.some((p) => k.startsWith(p))) continue
    out[k] = v
  }
  // nit1:正向覆盖 NO_PROXY(大小写两变体,reqwest/undici 各认不同大小写)。
  out.NO_PROXY = CODEX_FORCED_NO_PROXY
  out.no_proxy = CODEX_FORCED_NO_PROXY
  return out
}
