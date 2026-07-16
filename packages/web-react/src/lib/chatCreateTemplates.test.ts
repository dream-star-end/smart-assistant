import { describe, expect, it } from 'vitest'
import { CHAT_CREATE_TEMPLATES } from './chatCreateTemplates'

describe('connector chat creation template', () => {
  it('向当前会话提供单文件校验、摘要确认、hash 绑定发布与 AI 审核语义', () => {
    const template = CHAT_CREATE_TEMPLATES.connector
    expect(template).toContain('oc-market plugin examples')
    expect(template).toContain('oc-market plugin validate --file /tmp/openclaude-plugin.json')
    expect(template).toContain('permissionSummary')
    expect(template).toContain('publishCommand')
    expect(template).toContain('重新确认')
    expect(template).toContain('AI 自动审核')
    expect(template).toContain('管理中心 → 插件账号')
    expect(template).toContain('市场 → 发现')
    expect(template).not.toContain('--security-decision-file')
    expect(template).not.toContain('平台人工审核')
    expect(template).not.toContain('packages/commercial/src/connectors')
  })
})
