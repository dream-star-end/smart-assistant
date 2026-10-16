// OCV5-455: one provider → config-key mapping for master, egress and the API-key pool import.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { STATIC_KEY_PROVIDERS, type StaticProviderId } from '@openclaude/protocol'

import {
  STATIC_PROVIDER_META,
  staticProviderKeysFromConfig,
} from '../http/proxy/staticProviderMeta.js'

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('every static-key provider has commercial meta, and nothing extra', () => {
  assert.deepEqual(
    Object.keys(STATIC_PROVIDER_META).sort(),
    STATIC_KEY_PROVIDERS.map((p) => p.id).sort(),
  )
})

test('each provider takes its key from its keyConfigField', () => {
  const cfg: Record<string, string> = {}
  for (const id of Object.keys(STATIC_PROVIDER_META) as StaticProviderId[]) {
    cfg[STATIC_PROVIDER_META[id].keyConfigField] =
      `key-for-${STATIC_PROVIDER_META[id].keyConfigField}`
  }
  const keys = staticProviderKeysFromConfig(cfg)
  for (const id of Object.keys(STATIC_PROVIDER_META) as StaticProviderId[]) {
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
  for (const rel of ['index.ts', 'egress/main.ts']) {
    const text = readFileSync(path.join(src, rel), 'utf8')
    for (const field of [
      'MOONSHOT_CODING_PLAN_KEY',
      'BAILIAN_TOKEN_PLAN_KEY',
      'OPENCODE_GO_API_KEY',
      'ZAI_CODING_PLAN_KEY',
    ]) {
      assert.equal(
        new RegExp(`[a-z"-]+:\\s*cfg\\.${field}\\b`).test(text),
        false,
        `${rel} maps ${field} by hand`,
      )
    }
  }
})
