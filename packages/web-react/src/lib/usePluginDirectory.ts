import { useEffect, useState } from 'react'
import { api } from './api'
import { effectiveDisabledOf } from './connectors'
import { buildPluginDirectory, type PluginEntry } from './pluginDirectory'
import type { AuthSession } from './types'

/**
 * AI 市场里读插件目录（状态徽标 + 并入内置插件）。
 *
 * 只做**叠加**：三个来源各自失败降级为空，全部失败时返回 null（调用方当作「没有状态」，
 * 卡片照常渲染）。市场搜索、详情、安装流不依赖它。`reloadKey` 变化时重新拉取
 * （安装 / 卸载之后）。
 */
export function usePluginDirectory(
  auth: AuthSession | null,
  enabled: boolean,
  reloadKey = 0,
): PluginEntry[] | null {
  const [entries, setEntries] = useState<PluginEntry[] | null>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey 是重新拉取的触发键（安装 / 卸载之后）
  useEffect(() => {
    if (!auth || !enabled) return
    let alive = true
    let failures = 0
    // 同步抛错（如接口缺失）与异步失败一样只算降级。
    async function soft<T>(load: () => Promise<T>): Promise<T | null> {
      try {
        return await load()
      } catch {
        failures += 1
        return null
      }
    }
    Promise.all([
      soft(() => api.getConnectors(auth)),
      soft(() => api.getDeclarativeManagement(auth)),
      soft(() => api.getPluginManagement(auth)),
      soft(() => api.getLocalPlugins(auth)),
      soft(() => api.getPreferences(auth)),
    ]).then(([v1, declarative, runtime, local, prefs]) => {
      if (!alive) return
      const disabled = effectiveDisabledOf(prefs, local?.plugins)
      setEntries(
        failures >= 5
          ? null
          : buildPluginDirectory({ v1, declarative, runtime, local: local?.plugins ?? null, disabled }),
      )
    })
    return () => {
      alive = false
    }
  }, [auth, enabled, reloadKey])
  return entries
}
