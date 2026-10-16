// OCV5-462: backend QR-setup providers and the frontend registry name the same slugs.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { MANAGED_SETUP_PROVIDERS } from '../http/plugins.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

test('frontend managed plugin registry and backend setup providers list the same slugs', () => {
  const web = readFileSync(path.join(repo, 'packages/web-react/src/lib/managedPluginProviders.ts'), 'utf8')
  const union = /export type ManagedQrProvider = ([^\n]+)/.exec(web)?.[1] ?? ''
  const frontend = [...union.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]).sort()
  assert.ok(frontend.length > 0, 'ManagedQrProvider union not found')
  assert.deepEqual(frontend, [...MANAGED_SETUP_PROVIDERS].sort())
})

test('the backend list has no duplicates and only URL-safe slugs', () => {
  assert.equal(new Set(MANAGED_SETUP_PROVIDERS).size, MANAGED_SETUP_PROVIDERS.length)
  for (const p of MANAGED_SETUP_PROVIDERS) assert.match(p, /^[a-z][a-z-]*$/)
})
