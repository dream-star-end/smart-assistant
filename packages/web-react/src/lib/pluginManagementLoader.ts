import type { api } from './api'
import type { AuthSession } from './types'

type PluginManagementApi = Pick<typeof api,
  'getConnectors' | 'getDeclarativeManagement' | 'getPluginManagement' | 'getLocalPlugins' | 'getPreferences'>

/** No backend is a prerequisite for the others. Unknown preferences must never be written back. */
export async function loadPluginManagement(client: PluginManagementApi, auth: AuthSession) {
  const [v1, declarative, runtime, local, preferences] = await Promise.allSettled([
    client.getConnectors(auth), client.getDeclarativeManagement(auth),
    client.getPluginManagement(auth), client.getLocalPlugins(auth), client.getPreferences(auth),
  ])
  const sources = [v1, declarative, runtime, local]
  if (sources.every((source) => source.status === 'rejected'))
    throw new Error('暂时读不到你的插件，请稍后重试。')
  return {
    v1: v1.status === 'fulfilled' ? v1.value : { providers: [], connections: [] },
    declarative: declarative.status === 'fulfilled' ? declarative.value : { connectors: [], connections: [] },
    runtime: runtime.status === 'fulfilled' ? runtime.value : { catalog: [], accounts: [] },
    local: local.status === 'fulfilled' ? local.value.plugins : [],
    preferences: preferences.status === 'fulfilled' ? preferences.value : null,
    preferencesKnown: preferences.status === 'fulfilled' && preferences.value != null,
    degraded: sources.some((source) => source.status === 'rejected'),
  }
}
