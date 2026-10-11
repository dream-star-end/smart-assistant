/**
 * 平台 seed agent 的 artifact hash 按 slug@version 钉住(OCV5-376)。
 *
 * approvePlatformVersion 只批准与代码定义 hash 一致的 (slug, version)。改了 body 却没 bump
 * version 时,库里已存在的同版本 hash 对不上,启动 seed 每次都拒批,listing 停在旧内容上
 * (general-assistant@1.0.0 就这样把 GLM-5.3 锁了近两个月)。这里在单测阶段就把它拦下:
 *   - 改 body 不 bump → 同一个 slug@version 的 hash 变了 → 红,提示 bump version;
 *   - bump 了 → 新的 slug@version 不在表里 → 红,提示把新 hash 写进表(旧行删掉)。
 * hash 流水线与 seedAgentDefs 相同:validateAgentManifest → canonicalizeAgentManifest →
 * marketplaceArtifactHash。表里的值与个人版库中已批准版本的 artifact_hash 逐一核对过。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { marketplaceArtifactHash } from '@openclaude/storage'

import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from '../marketplace/agentManifest.js'
import {
  PLATFORM_SEED_AGENT_DEFS,
  PLATFORM_SEED_AGENT_MODEL_IDS,
} from '../marketplace/seedPlatformAgents.js'

const PINNED: Record<string, string> = {
  'office-assistant@1.0.3': '932778674a9a5579f16f3ead635d86db214d6970478d24c9e61157c1038bba1e',
  'coding-assistant@1.0.4': '48a6b31028c7701ed19a7593777a51935acaf9ea8372bd5fb9fd056f924cc4c9',
  'general-assistant@1.0.1': '396cc0515cae85f424992c650625c3dfdf1eec856e24e6888499643a94269c3b',
  'research-assistant@1.0.2': '715567a658045f1d0af2200ea874f23b90799c756d20be82b3dfa6079df7f46d',
}

function currentHashes(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const def of PLATFORM_SEED_AGENT_DEFS) {
    const result = validateAgentManifest(def.body, {
      vettedToolsets: VETTED_AGENT_TOOLSETS,
      allowedModels: new Set(PLATFORM_SEED_AGENT_MODEL_IDS),
    })
    assert.ok(result.ok, `${def.slug}: invalid manifest ${result.ok ? '' : result.errors.join('; ')}`)
    out[`${def.slug}@${result.manifest.version}`] = marketplaceArtifactHash(
      canonicalizeAgentManifest(result.manifest),
    )
  }
  return out
}

test('every platform seed agent keeps the artifact hash pinned for its slug@version', () => {
  const current = currentHashes()
  for (const [key, hash] of Object.entries(current)) {
    const pinned = PINNED[key]
    assert.ok(
      pinned !== undefined,
      `${key} is new: add it to PINNED with hash ${hash} and remove the previous version of that slug`,
    )
    assert.equal(
      hash,
      pinned,
      `${key}: the manifest changed but the version did not. Bump the version in seedPlatformAgents.ts; the seed refuses to approve a different artifact under an existing version`,
    )
  }
  assert.deepEqual(Object.keys(PINNED).sort(), Object.keys(current).sort(), 'PINNED lists exactly the current seed versions')
})

test('general-assistant does not pin a model (auto follows the user)', () => {
  const def = PLATFORM_SEED_AGENT_DEFS.find((item) => item.slug === 'general-assistant')
  assert.equal(def?.body.model, 'auto')
})
