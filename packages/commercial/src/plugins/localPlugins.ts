import { isPluginAvailable } from './catalogPolicy.js'
/**
 * 本机插件目录（OCV5-383）：随平台基线下发、在用户容器里运行的插件（如同花顺行情 ths）。
 *
 * 来源 = 当前 master 使用的 ccb-baseline（env OC_V3_CCB_BASELINE_DIR，与容器挂载同一份）的
 * `skills/<name>/plugin.json`，只看 V3_CCB_BASELINE_SKILL_NAMES 里声明过的目录；每份清单都经
 * parsePluginManifest 校验，不合格的跳过并记日志（不让一份坏清单拖垮整个插件页）。
 * 按文件 mtime 缓存，发版换目录或改文件后自动重读。
 */
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type PluginManifest, formatPluginManifestErrors, parsePluginManifest } from '@openclaude/protocol'
import { DEFAULT_V3_CCB_BASELINE_DIR, V3_CCB_BASELINE_SKILL_NAMES } from '../agent-sandbox/v3supervisor.js'
import { defaultOffPlugins, disabledPluginSet } from './enablement.js'

/** defaultEnabled = false：默认关闭（env OC_PLUGINS_DEFAULT_OFF），用户打开时插件页要同时写 enabled_plugins。 */
export type LocalPlugin = PluginManifest & { enabled: boolean; defaultEnabled: boolean }

type CacheEntry = { mtimeMs: number; size: number; manifest: PluginManifest | null }
const cache = new Map<string, CacheEntry>()

export function localBaselineDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.OC_V3_CCB_BASELINE_DIR?.trim() || DEFAULT_V3_CCB_BASELINE_DIR
}

function readManifest(path: string): PluginManifest | null {
  let st: { mtimeMs: number; size: number }
  try {
    st = statSync(path)
  } catch {
    return null // 这个技能没有 plugin.json：普通技能，不是插件
  }
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.manifest
  let manifest: PluginManifest | null = null
  if (st.size <= 64 * 1024) {
    try {
      const parsed = parsePluginManifest(JSON.parse(readFileSync(path, 'utf8')))
      if (parsed.ok) manifest = parsed.manifest
      else console.warn(`[plugins] invalid ${path}\n${formatPluginManifestErrors(parsed.errors)}`)
    } catch (err) {
      console.warn(`[plugins] unreadable ${path}: ${String(err)}`)
    }
  }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, manifest })
  return manifest
}

export function loadLocalPluginManifests(baselineDir: string = localBaselineDir()): PluginManifest[] {
  const out: PluginManifest[] = []
  for (const name of V3_CCB_BASELINE_SKILL_NAMES) {
    const m = readManifest(join(baselineDir, 'skills', name, 'plugin.json'))
    // 清单里的 name 必须与目录名一致：容器启动器按目录名找它。
    if (m && m.name === name && isPluginAvailable(name)) out.push(m)
  }
  return out
}

export async function localPluginsForUser(
  userId: bigint | string | number,
  baselineDir?: string,
): Promise<LocalPlugin[]> {
  const disabled = await disabledPluginSet(userId)
  const defaultOff = defaultOffPlugins()
  return loadLocalPluginManifests(baselineDir).map((m) => ({
    ...m,
    enabled: !disabled.has(m.name),
    defaultEnabled: !defaultOff.has(m.name),
  }))
}
