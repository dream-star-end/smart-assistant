/**
 * GET /api/features: the web UI's only window onto server-side feature flags.
 * The container serves it, the master proxies it, and /api/config stays host-only.
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/serverFeaturesRoute.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { readServerFeatures } from '@openclaude/protocol'
import { matchBridgeApiAllowlist, matchCommercialContainerApiProxy } from '../bridgeApiAllowlist.js'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')

describe('GET /api/features', () => {
  it('body shape: { features: { chips, recipeSchedule, unfiledSuggest } } from env', () => {
    const body = { features: readServerFeatures({ OC_P5_CHIPS: 'on', OC_P5_RECIPE_SCHEDULE: 'TRUE' }) }
    assert.deepEqual(body, { features: { chips: true, recipeSchedule: true, unfiledSuggest: false } })
    assert.deepEqual(JSON.parse(JSON.stringify(body)), body)
  })

  it('server.ts serves it from process.env, GET only, and /api/config carries the same object', () => {
    const at = serverSrc.indexOf("url.pathname === '/api/features'")
    assert.ok(at >= 0, "server.ts must dispatch url.pathname === '/api/features'")
    const block = serverSrc.slice(at, at + 400)
    assert.match(block, /req\.method !== 'GET'/)
    assert.match(block, /features: readServerFeatures\(process\.env\)/)
    const cfgAt = serverSrc.indexOf("url.pathname === '/api/config'")
    assert.ok(cfgAt > at)
    const cfgBlock = serverSrc.slice(cfgAt, serverSrc.indexOf('return\n', cfgAt))
    assert.match(cfgBlock, /features: readServerFeatures\(process\.env\)/)
    assert.ok(serverSrc.includes("'/api/features'"), 'KNOWN_ROUTES must list /api/features')
  })

  it('master proxies GET /api/features only; /api/config is not proxied', () => {
    assert.equal(matchCommercialContainerApiProxy('/api/features', 'GET')?.label, '/api/features')
    assert.equal(matchBridgeApiAllowlist('/api/features', 'POST'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/features/x', 'GET'), null)
    assert.equal(matchCommercialContainerApiProxy('/api/config', 'GET'), null)
  })
})
