import { describe, expect, test } from 'vitest'
import { connectorErrorText } from './connectors'

describe('connectorErrorText', () => {
  test('通用错误码不写死「微博」：知乎 / 知识星球账号出这些码时不能被告知是微博', () => {
    for (const code of [
      'UPSTREAM_FAILED',
      'CONNECTION_ERROR',
      'EXECUTION_FAILED',
      'LOGIN_EXPIRED_ACCOUNT',
    ]) {
      const text = connectorErrorText(code)
      expect(text, code).not.toMatch(/微博/)
      expect(text, code).not.toBe('操作失败，请重试')
    }
    expect(connectorErrorText('UPSTREAM_FAILED')).toMatch(/验证码或风控/)
    expect(connectorErrorText('CONNECTION_ERROR')).toMatch(/重新扫码绑定/)
  })

  test('微博专属码保留微博措辞', () => {
    expect(connectorErrorText('WEIBO_ACTION_FAILED')).toMatch(/^微博/)
    expect(connectorErrorText('WEIBO_WORKER_BUSY')).toMatch(/^微博/)
    expect(connectorErrorText('ZHIHU_UPSTREAM_CHALLENGE')).toMatch(/^知乎/)
  })

  test('未知码 / 空码回退通用文案，绝不暴露裸码', () => {
    expect(connectorErrorText('SOMETHING_NEW')).toBe('操作失败，请重试')
    expect(connectorErrorText(null)).toBe('操作失败，请重试')
    expect(connectorErrorText(undefined)).toBe('操作失败，请重试')
    expect(connectorErrorText('SOMETHING_NEW')).not.toMatch(/SOMETHING_NEW/)
  })
})
