import { createRoot } from 'react-dom/client'
import { ConnectorsTab } from '../src/components/settings/ConnectorsTab'
import { ToastProvider } from '../src/components/ui'
import { api } from '../src/lib/api'
import { createMemoryAuthSession } from '../src/lib/authSession'

// Local fixture: exercise the real merged directory and dialogs without third-party credentials.
const fixture = { oauth: 0, preferenceWrites: 0 }
Object.assign(window, { pluginFixture: fixture })
const prefsFail = new URLSearchParams(location.search).has('prefs-fail')
api.getConnectors = async () => ({ providers: [{ id: 'github', label: 'GitHub',
  description: '检索 Issue', authKind: 'oauth2_byoa', formFields: [] }], connections: [] })
api.getDeclarativeManagement = async () => ({ connectors: [{
  slug: 'github', label: 'GitHub', description: 'GitHub 访问令牌连接', installation: 'default', official: true,
  available: true, canBind: true, listingState: 'active', installedVersion: '1.0.0', installedVersionId: '42',
  latestVersion: '1.0.0', latestVersionId: '42', updateAvailable: false, connectionCount: 0,
  contract: { versionId: 42, slug: 'github', label: 'GitHub', description: 'GitHub 访问令牌连接',
    authMode: 'static-token', requiredBindSources: ['access_token'], actions: [{ id: 'search_issues', effect: 'read' }] },
}], connections: [] })
api.getPluginManagement = async () => ({ catalog: [], accounts: [] })
api.getLocalPlugins = async () => ({ plugins: [] })
api.getPreferences = async () => {
  if (prefsFail) throw new Error('preferences unavailable')
  return { prefs: {} }
}
api.patchPreferences = async () => { fixture.preferenceWrites++; return { prefs: {} } }
api.startGithubOAuth = async () => { fixture.oauth++; return { authorizeUrl: '#authorized', state: 'fixture' } }

createRoot(document.getElementById('root')!).render(
  <ToastProvider><ConnectorsTab auth={createMemoryAuthSession(() => {}, 'fixture')} /></ToastProvider>,
)
