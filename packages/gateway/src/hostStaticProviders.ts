/**
 * hostStaticProviders — host(master 进程、非容器身份)CCB 静态 provider 平台直连路由。
 *
 * 背景(2026-07-07 MAJOR-1,合成首帧非 codex 化的配套):v5 master host 上
 * `/root/.openclaude-v5/openclaude.json` 无 claudeOAuth、settings.json 不存在、进程 env
 * 无任何 ANTHROPIC_* —— subprocessRunner 的 "settings.json controls routing" 默认分支在
 * host 上完全落空。host 平台 agent 历史上没踩坑只因 `main` 恒 gpt-5.5(codex-native runner
 * 不走 CCB anthropic env)。合成首帧改路由到静态模型(deepseek-v4-pro)后,若不补路由,
 * CCB 会以零 provider 配置起进程 → 上游 401 死(比原来的闸拒更糟)。
 *
 * 模式(仓内先例):marketplaceAiReview / voiceTranscribe 的 deepseek「平台直连」——
 * 平台成本、不进用户 ledger,与 host 平台维护 agent 定位一致。CCB 子进程的等价物 =
 * spawn env 注入 ANTHROPIC_BASE_URL(provider 的 Anthropic 兼容 base)+ 平台静态 key。
 *
 * 权威源与依赖方向:
 *   - 路由元数据(endpoint / authScheme / model→provider 匹配)= @openclaude/protocol
 *     STATIC_KEY_PROVIDERS(findRouteProviderForModel),不另立第二套映射;
 *   - key 的 env 字段名权威在 commercial STATIC_PROVIDER_META.keyConfigField(gateway
 *     不能 import commercial)→ 由 commercial 启动时经 `setHostStaticProviderKeys` seam
 *     注入解析好的 key 值(setModelHintProvider 同模式);个人版/dev 不注入 = 本模块
 *     整体 no-op,settings.json 继续掌权,零行为变化。
 *
 * 硬约束:
 *   - **容器身份一律不动**(容器有自己的 ANTHROPIC_BASE_URL=master internal proxy env,
 *     绝不覆盖)。容器判定复用 subprocessRunner 既有双信号(OC_CONTAINER_ID /
 *     CLAUDE_CONFIG_DIR),不发明第三套 —— 单一权威收口在本文件 isV3ContainerRuntime。
 *   - key 缺失 → **throw fail-closed**(明确报错,不静默 spawn 一个必 401 的 CCB)。
 */
import { findRouteProviderForModel, type StaticProviderKeys } from '@openclaude/protocol'

/**
 * v3/v5 商业版用户容器判定。双信号 OR 兜底(自 subprocessRunner 收口迁此,单一权威):
 *  - OC_CONTAINER_ID:私有 env,v3supervisor 仅在 bridgeSecret 就位时注入(语义最清晰)。
 *  - CLAUDE_CONFIG_DIR === '/run/oc/claude-config':v3supervisor.ts 无条件注入,
 *    即使 bridgeSecret 缺失(降级模式,容器无 OC_CONTAINER_ID)依然能识别为容器。
 * 个人版 master / dev 都不会出现这两条之一,信号空间不重叠。
 */
export function isV3ContainerRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OC_CONTAINER_ID || env.CLAUDE_CONFIG_DIR === '/run/oc/claude-config'
}

// ── 平台静态 key seam(commercial 启动注入;个人版恒 null)────────────────────
let _hostStaticProviderKeys: StaticProviderKeys | null = null

/** commercial 启动时注入平台静态 provider key 表;shutdown 时传 null 清理。 */
export function setHostStaticProviderKeys(keys: StaticProviderKeys | null): void {
  _hostStaticProviderKeys = keys
}

export function getHostStaticProviderKeys(): StaticProviderKeys | null {
  return _hostStaticProviderKeys
}

export interface HostStaticProviderEnv {
  providerId: string
  env: Record<string, string>
}

/**
 * host CCB spawn 期的静态 provider 直连 env 解析。
 *
 * 返回:
 *   - `null`  = 不干预(容器身份 / seam 未注入(个人版) / 模型不属静态 provider),
 *     CCB 沿用既有语义(settings.json / 容器 proxy env);
 *   - `{providerId, env}` = 注入 spawn env(providerEnv 合并,压过继承的 process.env);
 *   - **throw** = host + seam 已注入 + 模型属静态 provider 但 key 缺失 —— fail-closed,
 *     调用方(subprocessRunner.start)不得 spawn。
 *
 * env 组成:
 *   - CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1:host 拥有路由权,CCB 忽略 settings.json
 *     的 provider 覆盖(与 claude-subscription 分支同款防线)。
 *   - ANTHROPIC_BASE_URL:spec.upstreamEndpoint 去掉尾部 /v1/messages(SDK 自拼)。
 *   - 鉴权按 spec.authScheme:bearer → ANTHROPIC_AUTH_TOKEN;x-api-key → ANTHROPIC_API_KEY。
 *     另一个显式置空,防 stray env 按 CCB 优先级(AUTH_TOKEN > API_KEY)串路由。
 *   - NO_PROXY/no_proxy 追加上游 host:静态 provider 现全员国内/亚洲端点,必须绕开
 *     全局出海代理直连(commercial STATIC_PROVIDER_META.egress='direct' 的教训:绕日本
 *     双重跨境长流式半路断)。仅追加该 provider 的 hostname,不影响其它出站。
 */
export function resolveHostStaticProviderEnv(
  model: string | undefined,
  opts: { keys?: StaticProviderKeys | null; env?: NodeJS.ProcessEnv } = {},
): HostStaticProviderEnv | null {
  const env = opts.env ?? process.env
  if (isV3ContainerRuntime(env)) return null
  const keys = opts.keys !== undefined ? opts.keys : _hostStaticProviderKeys
  if (!keys) return null
  if (!model) return null
  const spec = findRouteProviderForModel(model)
  if (!spec) return null
  const key = keys[spec.id]
  if (!key) {
    throw new Error(
      `[hostStaticProviders] host 静态 provider '${spec.id}'(model '${model}')的平台 key 未配置 — ` +
        `fail-closed,拒绝 spawn 必 401 的 CCB(key 字段名权威见 commercial STATIC_PROVIDER_META)`,
    )
  }
  const base = spec.upstreamEndpoint.replace(/\/v1\/messages$/, '')
  const upstreamHost = new URL(spec.upstreamEndpoint).hostname
  const existingNoProxy = (env.NO_PROXY ?? env.no_proxy ?? '').trim()
  const alreadyListed = existingNoProxy
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(upstreamHost)
  const noProxy = alreadyListed
    ? existingNoProxy
    : existingNoProxy
      ? `${existingNoProxy},${upstreamHost}`
      : upstreamHost
  const authEnv: Record<string, string> =
    spec.authScheme === 'x-api-key'
      ? { ANTHROPIC_API_KEY: key, ANTHROPIC_AUTH_TOKEN: '' }
      : { ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: '' }
  return {
    providerId: spec.id,
    env: {
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_BASE_URL: base,
      ...authEnv,
      // 显式清空继承自 process.env 的 OAuth 凭据(Codex round-3 加固):最终 spawn env
      // 是 { ...process.env, ...providerEnv },若宿主残留 CLAUDE_CODE_OAUTH_TOKEN,CCB 的
      // auth 优先级 ANTHROPIC_AUTH_TOKEN > CLAUDE_CODE_OAUTH_TOKEN 只在 bearer 路径遮蔽它;
      // x-api-key provider(OpenCode Go qwen)只设 ANTHROPIC_API_KEY,残留 OAuth token 会被
      // CCB 误判为 subscriber token。统一清空(含 ANTHROPIC_MODEL,防宿主 pin 串模型)。
      CLAUDE_CODE_OAUTH_TOKEN: '',
      ANTHROPIC_MODEL: '',
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    },
  }
}

/**
 * 自检(不 throw):`model` 在当前进程形态下是否可路由。
 * resolveSyntheticTurnModel 的降级决策消费 —— 兜底模型不可路由时**不降级**,保持原
 * CODEX_BILLING_GUARD fail-closed(闸的显式错误优于换一个必 401 的模型)。
 *   - 容器身份 → true(容器经 master internal proxy 按模型名路由静态 provider,恒可达);
 *   - host + seam 已注入 → 该模型对应 provider 的 key 是否存在;
 *   - host + seam 未注入(个人版/dev)→ false(个人版本就不该走到这:调用方已 gate
 *     commercial 运行时)。
 */
export function isHostRoutableStaticModel(
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isV3ContainerRuntime(env)) return true
  const keys = _hostStaticProviderKeys
  if (!keys) return false
  const spec = findRouteProviderForModel(model)
  return !!(spec && keys[spec.id])
}
