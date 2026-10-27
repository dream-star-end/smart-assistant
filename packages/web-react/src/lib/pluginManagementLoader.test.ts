import { describe, expect, test } from 'vitest'
import { createMemoryAuthSession } from './authSession'
import { loadPluginManagement } from './pluginManagementLoader'

const auth = createMemoryAuthSession(() => {}, 'fixture')
const sources = () => ({
  getConnectors: async () => ({ providers: [], connections: [] }),
  getDeclarativeManagement: async () => ({ connectors: [], connections: [] }),
  getPluginManagement: async () => ({ catalog: [], accounts: [] }),
  getLocalPlugins: async () => ({ plugins: [] }),
  getPreferences: async () => ({ prefs: { disabled_plugins: ['github'] } }),
})
const fail = async (): Promise<never> => { throw new Error('source unavailable') }

describe('plugin management loading', () => {
  test('each catalog can fail independently without erasing successful catalogs or preferences', async () => {
    for (const key of ['getConnectors', 'getDeclarativeManagement', 'getPluginManagement', 'getLocalPlugins'] as const) {
      const data = await loadPluginManagement({ ...sources(), [key]: fail }, auth)
      expect(data.degraded).toBe(true)
      expect(data.preferencesKnown).toBe(true)
      expect(data.preferences).toEqual({ prefs: { disabled_plugins: ['github'] } })
    }
  })
  test('unknown preferences are explicit and cannot masquerade as enabled defaults', async () => {
    const data = await loadPluginManagement({ ...sources(), getPreferences: fail }, auth)
    expect(data.preferencesKnown).toBe(false)
    expect(data.preferences).toBeNull()
    expect(data.degraded).toBe(false)
  })
  test('all catalogs failing is an error, not an empty installed catalog', async () => {
    await expect(loadPluginManagement({ ...sources(), getConnectors: fail, getDeclarativeManagement: fail,
      getPluginManagement: fail, getLocalPlugins: fail }, auth)).rejects.toThrow('暂时读不到你的插件')
  })
})
