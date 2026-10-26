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
import { readGatewaySource } from './helpers/gatewaySource.js'

const here = dirname(fileURLToPath(import.meta.url))
// OCV5-493: KNOWN_ROUTES / normalizePath moved with the HTTP entry to gatewayHttp.ts; read the source set.
const serverSrc = readGatewaySource()
// FINDINGS §7.5 2b: /api/features and /api/config dispatch live in the APP_CONFIG_ROUTES table.
const routeSrc = readFileSync(join(here, '../routes/appConfig.ts'), 'utf8')

describe('GET /api/features', () => {
  it('body shape: { features: { chips, recipeSchedule, unfiledSuggest, timelineShadow } } from env', () => {
    const body = { features: readServerFeatures({ OC_P5_CHIPS: 'on', OC_P5_RECIPE_SCHEDULE: 'TRUE' }) }
    // OCV5-630 added timelineShadow to SERVER_FEATURE_ENV; unset here, so it reads off.
    assert.deepEqual(body, {
      features: { chips: true, recipeSchedule: true, unfiledSuggest: false, timelineShadow: false },
    })
    assert.deepEqual(JSON.parse(JSON.stringify(body)), body)
  })

  it('server.ts serves it from process.env, GET only, and /api/config carries the same object', () => {
    const at = routeSrc.indexOf("url.pathname === '/api/features'")
    assert.ok(at >= 0, "routes/appConfig.ts must dispatch url.pathname === '/api/features'")
    const block = routeSrc.slice(at, at + 400)
    assert.match(block, /req\.method !== 'GET'/)
    assert.match(block, /features: readServerFeatures\(process\.env\)/)
    const cfgAt = routeSrc.indexOf("url.pathname === '/api/config'")
    assert.ok(cfgAt > at)
    const cfgBlock = routeSrc.slice(cfgAt, routeSrc.indexOf('return true\n', cfgAt))
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
