/**
 * 插件启用状态（OCV5-383）：管理中心 → 插件 一级列表的启用开关。
 *
 * 存在 `user_preferences.prefs.disabled_plugins`（slug 列表；缺省 = 全部启用）。
 * 读失败按「启用」处理并记一行日志：开关是用户偏好，不是安全边界 —— 不能因为数据库抖动
 * 把用户在用的插件变成不可用（与容器侧 plugin-exec 的 fail-open 一致）。
 */
import { getPreferences } from '../user/preferences.js'

export type PluginDisabledCheck = (userId: bigint | string, slug: string) => Promise<boolean>

/** 注入点：master 装配时用 `{ disabledSet: disabledPluginSet }`；测试可注入假实现。 */
export interface PluginEnablement {
  disabledSet(userId: bigint | string | number): Promise<ReadonlySet<string>>
}

export const PLUGIN_DISABLED_MESSAGE = (label: string) =>
  `插件「${label}」已停用，请在 管理中心 → 插件 里打开后再用`

export async function disabledPluginSet(userId: bigint | string | number): Promise<ReadonlySet<string>> {
  try {
    const { prefs } = await getPreferences(String(userId))
    return new Set(prefs.disabled_plugins ?? [])
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[plugins] disabled_plugins read failed; treating every plugin as enabled', String(err))
    return new Set()
  }
}

export const isPluginDisabled: PluginDisabledCheck = async (userId, slug) =>
  (await disabledPluginSet(userId)).has(slug)

export const PREFS_PLUGIN_ENABLEMENT: PluginEnablement = { disabledSet: disabledPluginSet }
