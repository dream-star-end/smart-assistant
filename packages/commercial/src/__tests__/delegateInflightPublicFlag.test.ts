/**
 * 公开配置广告 OC_DELEGATE_INFLIGHT_SURFACE，谓词与 gateway 一致。
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/delegateInflightPublicFlag.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { delegateInflightSurfaceAdvertised } from '../http/handlers.js'

const here = dirname(fileURLToPath(import.meta.url))
const handlers = readFileSync(join(here, '../http/handlers.ts'), 'utf8')

describe('delegateInflightSurfaceAdvertised', () => {
  it('只认 1|true|on，缺省关', () => {
    assert.equal(delegateInflightSurfaceAdvertised({}), false)
    assert.equal(delegateInflightSurfaceAdvertised({ OC_DELEGATE_INFLIGHT_SURFACE: '' }), false)
    assert.equal(delegateInflightSurfaceAdvertised({ OC_DELEGATE_INFLIGHT_SURFACE: '0' }), false)
    assert.equal(delegateInflightSurfaceAdvertised({ OC_DELEGATE_INFLIGHT_SURFACE: 'off' }), false)
    assert.equal(delegateInflightSurfaceAdvertised({ OC_DELEGATE_INFLIGHT_SURFACE: 'yes' }), false)
    for (const raw of ['1', 'true', 'on', ' TRUE ', 'On']) {
      assert.equal(delegateInflightSurfaceAdvertised({ OC_DELEGATE_INFLIGHT_SURFACE: raw }), true, raw)
    }
  })

  it('公开配置下发 feature_delegate_inflight', () => {
    assert.ok(handlers.includes('feature_delegate_inflight: delegateInflightSurfaceAdvertised()'))
  })
})
