import { describe, expect, it } from 'vitest'
import { CHAT_CREATE_TEMPLATES } from './chatCreateTemplates'

describe('connector chat creation template', () => {
  it('向当前会话提供完整双 JSON + oc-market 发布指令与 AI 审核语义', () => {
    const template = CHAT_CREATE_TEMPLATES.connector
    expect(template).toContain('ConnectorSpec JSON')
    expect(template).toContain('SecurityDecision JSON')
    expect(template).toContain('oc-market publish-connector --examples')
    expect(template).toContain('oc-market publish-connector')
    expect(template).toContain('--spec-file /tmp/connector-spec.json')
    expect(template).toContain('--security-decision-file /tmp/connector-security-decision.json')
    expect(template).toContain('AI 自动审核')
    expect(template).toContain('管理中心 → 插件账号')
    expect(template).not.toContain('平台人工审核')
    expect(template).not.toContain('packages/commercial/src/connectors')
  })
})
