/**
 * Unit tests for the master-side agent→model authority snapshot.
 *
 * 关键锚点:manifest.model = AGENT_MODEL_AUTO(「不锁模型」声明)必须归一为
 * PLATFORM_DEFAULT_MODEL —— bridge 对「帧无 model」的帧用它做 codex 分类与计费,
 * auto 若原样透出会被 catalog 当未知模型(fail-closed 拒/错分类),若当 null 处理
 * 又会让显式 auto 的预设 agent 无法在无 model 帧上执行。归一到平台默认与容器侧
 * resolveExecutionModel 的兜底同构(defaults.model 权威 = main seed 声明,阶段 A
 * 与本常量字面相等,锚测试锁死)。
 *
 * Run: npx tsx --test packages/commercial/src/ws/__tests__/agentModelAuthority.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { AGENT_MODEL_AUTO } from '@openclaude/protocol'

import { PLATFORM_DEFAULT_MODEL } from '../../platformDefaults.js'
import { buildAgentModelSnapshot } from '../agentModelAuthority.js'
import type { InstalledAgent } from '../../marketplace/marketplaceDb.js'

function agent(slug: string, model: unknown): InstalledAgent {
  return {
    slug,
    version: '1.0.0',
    versionId: `${slug}-v1`,
    rawManifest: JSON.stringify({ name: slug, model }),
    artifactHash: `hash-${slug}`,
  }
}

describe('buildAgentModelSnapshot', () => {
  it('keeps a concrete manifest model verbatim', () => {
    const map = buildAgentModelSnapshot([agent('office-assistant', 'MiniMax-M3')], [])
    assert.equal(map.get('office-assistant'), 'MiniMax-M3')
  })

  it('normalizes AGENT_MODEL_AUTO to the platform default (not null, not "auto")', () => {
    const map = buildAgentModelSnapshot([agent('general-assistant', AGENT_MODEL_AUTO)], [])
    assert.equal(map.get('general-assistant'), PLATFORM_DEFAULT_MODEL)
  })

  it('lets presets override an installed manifest of the same slug (auto wins over concrete)', () => {
    const map = buildAgentModelSnapshot(
      [agent('general-assistant', 'glm-5.3')],
      [agent('general-assistant', AGENT_MODEL_AUTO)],
    )
    assert.equal(map.get('general-assistant'), PLATFORM_DEFAULT_MODEL)
  })

  it('drops manifests with a non-string/empty model (shape defense unchanged)', () => {
    const map = buildAgentModelSnapshot(
      [agent('broken-json', 42)],
      [],
    )
    // 非法形状 → 不设条目(resolver 返 null,bridge 对无 model 帧 fail-closed)。
    assert.equal(map.has('broken-json'), false)
  })
})
