import { isPluginAvailable } from './catalogPolicy.js'
/**
 * 插件启用状态（OCV5-383）：管理中心 → 插件 一级列表的启用开关。
 *
 * 存在 `user_preferences.prefs.disabled_plugins`（slug 列表；缺省 = 全部启用）。
 * 读失败按「启用」处理并记一行日志：开关是用户偏好，不是安全边界 —— 不能因为数据库抖动
 * 把用户在用的插件变成不可用（与容器侧 plugin-exec 的 fail-open 一致）。
 *
 * 默认关闭（OCV5-388，商业版的同花顺）：master env `OC_PLUGINS_DEFAULT_OFF`（逗号分隔 slug）
 * 里的插件对没打开过它的用户算停用；用户在插件页打开时记进 `prefs.enabled_plugins`。
 * 未设置 = 没有默认关闭的插件（个人版不变）。读偏好失败时默认关闭的插件仍按停用处理。
 */
import { type Preferences, getPreferences } from '../user/preferences.js'

export type PluginDisabledCheck = (userId: bigint | string, slug: string) => Promise<boolean>

/** 注入点：master 装配时用 `{ disabledSet: disabledPluginSet }`；测试可注入假实现。 */
export interface PluginEnablement {
  disabledSet(userId: bigint | string | number): Promise<ReadonlySet<string>>
}

export const PLUGIN_DISABLED_MESSAGE = (label: string) =>
  `插件「${label}」已停用，请在 管理中心 → 插件 里打开后再用`

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/

/** env `OC_PLUGINS_DEFAULT_OFF` 里的合法 slug；未设置或为空 = 空集。 */
export function defaultOffPlugins(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(
    (env.OC_PLUGINS_DEFAULT_OFF ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => SLUG.test(s)),
  )
}

/** 停用 = 用户停用的 ∪（默认关闭 − 用户打开过的）。 */
export function effectiveDisabledPlugins(
  prefs: Pick<Preferences, 'disabled_plugins' | 'enabled_plugins'>,
  defaultOff: ReadonlySet<string> = defaultOffPlugins(),
): ReadonlySet<string> {
  const out = new Set(prefs.disabled_plugins ?? [])
  const optedIn = new Set(prefs.enabled_plugins ?? [])
  for (const slug of defaultOff) if (!optedIn.has(slug)) out.add(slug)
  return out
}

export async function disabledPluginSet(userId: bigint | string | number): Promise<ReadonlySet<string>> {
  const defaultOff = defaultOffPlugins()
  try {
    const { prefs } = await getPreferences(String(userId))
    return effectiveDisabledPlugins(prefs, defaultOff)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[plugins] disabled_plugins read failed; only default-off plugins count as disabled', String(err))
    return new Set(defaultOff)
  }
}

export const isPluginDisabled: PluginDisabledCheck = async (userId, slug) =>
  !isPluginAvailable(slug) || (await disabledPluginSet(userId)).has(slug)

export const PREFS_PLUGIN_ENABLEMENT: PluginEnablement = { disabledSet: disabledPluginSet }
