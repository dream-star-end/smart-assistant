/**
 * OCV5-376 P2: routes moved out of gateway server.ts into gateway/src/routes/*.ts must stay in the
 * container route inventory, or the bridge-allowlist closure checks would silently stop seeing them.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readContainerApiRoutes } from './helpers/containerRouteInventory.js'

test('routes dispatched from gateway/src/routes/*.ts are in the inventory with their file', async () => {
  const routes = await readContainerApiRoutes()
  const find = (declared: string) => routes.find((r) => r.declared === declared)
  assert.equal(find('/api/chat-projects')?.file, 'routes/chatProjects.ts')
  assert.equal(find('/api/project-assets')?.file, 'routes/projectAssets.ts')
  const assetItem = routes.find((r) => r.kind === 'regex' && r.declared.includes('project-assets') && r.declared.endsWith('$') && !r.declared.includes('versions') && !r.declared.includes('restore'))
  assert.equal(assetItem?.file, 'routes/projectAssets.ts')
  assert.ok(routes.some((r) => r.file === 'server.ts'), 'server.ts routes are still read')
})
