import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { githubDefault } from '../connectors/defaults/github.js'
import { prepareConnectorPublish } from '../marketplace/publishConnectorPipeline.js'

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'connector',
    version: '1.0.0',
    spec: structuredClone(githubDefault.spec),
    securityDecision: structuredClone(githubDefault.decision),
    category: 'coding-dev',
    useCases: ['让 AI 查询当前账号可见的代码仓库'],
    outcomeExamples: ['授权账号后返回当前用户和仓库列表'],
    tags: ['API插件', 'GitHub'],
    visibility: 'public',
    ...overrides,
  }
}

describe('prepareConnectorPublish validation receipt', () => {
  test('hash 对规范化有效草稿确定，权限摘要完全来自编译产物且不含凭据值', () => {
    const first = prepareConnectorPublish(draft())
    const reordered = prepareConnectorPublish({
      tags: ['API插件', 'GitHub'],
      useCases: [' 让 AI 查询当前账号可见的代码仓库 '],
      category: 'coding-dev',
      securityDecision: structuredClone(githubDefault.decision),
      spec: structuredClone(githubDefault.spec),
      outcomeExamples: ['授权账号后返回当前用户和仓库列表'],
      version: '1.0.0',
      kind: 'connector',
    })
    assert.equal(first.ok, true)
    assert.equal(reordered.ok, true)
    if (!first.ok || !reordered.ok) return

    assert.match(first.validationHash, /^[0-9a-f]{64}$/)
    assert.equal(first.validationHash, reordered.validationHash)
    assert.equal(first.permissionSummary.authMode, 'static-token')
    assert.equal(first.permissionSummary.clientProvisioning, null)
    assert.deepEqual(first.permissionSummary.requiredCredentialSources, ['access_token'])
    assert.deepEqual(first.permissionSummary.origins.apiOrigins, ['https://api.github.com:443'])
    assert.ok(first.permissionSummary.actions.every((action) => action.effect === 'read'))
    assert.deepEqual(first.permissionSummary.identity, githubDefault.spec.identity)
    assert.deepEqual(first.permissionSummary.credentialPlacements, [
      { source: 'access_token', placement: 'authorization-bearer' },
    ])
    assert.doesNotMatch(JSON.stringify(first.permissionSummary), /ghp_|client_secret_value|token-value/)
  })

  test('任一有效发布字段变化都会使确认 hash 失效', () => {
    const first = prepareConnectorPublish(draft())
    const changed = prepareConnectorPublish(draft({ tags: ['API插件', 'GitHub', '新版'] }))
    assert.equal(first.ok, true)
    assert.equal(changed.ok, true)
    if (!first.ok || !changed.ok) return
    assert.notEqual(first.validationHash, changed.validationHash)
  })
})
