// OCV5-455: one provider → config-key mapping for master, egress and the API-key pool import.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { STATIC_KEY_PROVIDERS, type StaticProviderId } from '@openclaude/protocol'

import { STATIC_PROVIDER_META, staticProviderKeysFromConfig } from '../http/proxy/staticProviderMeta.js'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ids = Object.keys(STATIC_PROVIDER_META) as StaticProviderId[]

test('every static-key provider has commercial meta, and nothing extra', () => {
  assert.deepEqual([...ids].sort(), STATIC_KEY_PROVIDERS.map((p) => p.id).sort())
})

test('each provider takes its key from its keyConfigField', () => {
  const cfg: Record<string, string> = {}
  for (const id of ids) {
    const field = STATIC_PROVIDER_META[id].keyConfigField
    cfg[field] = `key-for-${field}`
  }
  const keys = staticProviderKeysFromConfig(cfg)
  for (const id of ids) {
    assert.equal(keys[id], `key-for-${STATIC_PROVIDER_META[id].keyConfigField}`, id)
  }
  // kimi and ark-k3 share the Ark Agent Plan subscription key.
  assert.equal(keys.kimi, keys['ark-k3'])
})

test('missing, empty and whitespace-only keys are left out', () => {
  const keys = staticProviderKeysFromConfig({
    DEEPSEEK_API_KEY: '',
    MINIMAX_TOKEN_PLAN_KEY: '   ',
    ZAI_CODING_PLAN_KEY: 'z',
  })
  assert.equal('deepseek' in keys, false)
  assert.equal('minimax' in keys, false)
  assert.equal(keys.zai, 'z')
  assert.equal('moonshot' in keys, false)
})

test('master and egress no longer hand-copy the provider → key map', () => {
  // Only the map shape `<providerId>: cfg.<its keyConfigField>`. Other uses of a key
  // field (e.g. `apiKey: cfg.OPENCODE_GO_API_KEY` for one feature) are fine.
  // The external API-key proxy deliberately exposes deepseek only (see its comment in
  // index.ts); that single-provider literal is not a copy of the map.
  const deliberate = 'staticProviderKeys: { deepseek: cfg.DEEPSEEK_API_KEY }'
  for (const rel of ['index.ts', 'egress/main.ts']) {
    const text = readFileSync(path.join(src, rel), 'utf8').split(deliberate).join('')
    for (const id of ids) {
      const field = STATIC_PROVIDER_META[id].keyConfigField
      const pair = new RegExp(`(?:^|[\\s{,])["']?${id.replace('-', '\\-')}["']?\\s*:\\s*cfg\\.${field}\\b`, 'm')
      assert.equal(pair.test(text), false, `${rel} maps ${id} → ${field} by hand`)
    }
  }
})

test('the contract catches a hand-copied map', () => {
  const field = STATIC_PROVIDER_META.moonshot.keyConfigField
  const pair = new RegExp(`(?:^|[\\s{,])["']?moonshot["']?\\s*:\\s*cfg\\.${field}\\b`, 'm')
  assert.equal(pair.test(`const k = {\n  moonshot: cfg.${field},\n}`), true)
  assert.equal(pair.test(`const opts = { apiKey: cfg.${field} }`), false)
})
