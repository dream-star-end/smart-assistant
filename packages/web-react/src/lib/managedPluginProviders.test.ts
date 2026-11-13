import { afterEach, expect, test, vi } from 'vitest'

const calls = vi.hoisted(() => [] as unknown[][])
vi.mock('./api', () => {
  const rec =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args])
      return Promise.resolve({})
    }
  return {
    api: Object.fromEntries(
      ['Weibo', 'Zhihu', 'KnowledgePlanet', 'Douyin'].flatMap((p) =>
        ['start', 'get', 'cancel'].map((op) => [`${op}${p}Setup`, rec(`${op}${p}Setup`)]).concat([
          [`get${p}SetupQr`, rec(`get${p}SetupQr`)],
        ]),
      ),
    ),
  }
})

import type { AuthSession } from './types'
import { managedPluginProvider, managedSetupFailureText } from './managedPluginProviders'

const auth = {} as AuthSession

afterEach(() => {
  calls.length = 0
})

test('未登记的 slug 回落到知识星球（与改造前的兜底一致）', () => {
  expect(managedPluginProvider('weibo').label).toBe('微博')
  expect(managedPluginProvider('zhihu').scanner).toBe('知乎 App')
  expect(managedPluginProvider(undefined).slug).toBe('knowledge-planet')
  expect(managedPluginProvider('something-else').slug).toBe('knowledge-planet')
})

test('只有微博 / 知乎支持原地重新扫码', () => {
  expect(managedPluginProvider('weibo').qrRelink).toBe(true)
  expect(managedPluginProvider('zhihu').qrRelink).toBe(true)
  expect(managedPluginProvider('knowledge-planet').qrRelink).toBe(false)
})

test('start：新建授权保持单参调用，重新登录才带账号 id；知识星球始终新建', async () => {
  await managedPluginProvider('weibo').start(auth)
  await managedPluginProvider('weibo').start(auth, 'acc-1')
  await managedPluginProvider('knowledge-planet').start(auth, 'acc-2')
  expect(calls).toEqual([['startWeiboSetup', auth], ['startWeiboSetup', auth, 'acc-1'], ['startKnowledgePlanetSetup', auth]])
})

test('get / qr / cancel 路由到各自 provider 的接口', async () => {
  const zhihu = managedPluginProvider('zhihu')
  await zhihu.get(auth, 's')
  await zhihu.qr(auth, 's')
  await zhihu.cancel(auth, 's')
  expect(calls.map((c) => c[0])).toEqual(['getZhihuSetup', 'getZhihuSetupQr', 'cancelZhihuSetup'])
})

test('失败文案：过期 > provider 风控说明 > 通用', () => {
  const weibo = managedPluginProvider('weibo')
  const zhihu = managedPluginProvider('zhihu')
  const kp = managedPluginProvider('knowledge-planet')
  expect(managedSetupFailureText(weibo, { status: 'expired', errorCode: 'UPSTREAM_FAILED' })).toBe(
    '二维码已过期，请重新授权。',
  )
  expect(managedSetupFailureText(weibo, { status: 'failed', errorCode: 'UPSTREAM_FAILED' })).toMatch(/^微博触发了安全验证/)
  expect(managedSetupFailureText(zhihu, { status: 'failed', errorCode: 'ZHIHU_UPSTREAM_CHALLENGE' })).toMatch(/^知乎触发了风控/)
  expect(managedSetupFailureText(weibo, { status: 'failed', errorCode: 'ZHIHU_UPSTREAM_CHALLENGE' })).toBe(
    '本次授权未完成，请重试。',
  )
  expect(managedSetupFailureText(kp, { status: 'failed', errorCode: 'UPSTREAM_FAILED' })).toBe('本次授权未完成，请重试。')
})

test('抖音（OCV5-553）：路由到抖音接口、可原地重新扫码、带风险提示；失败码专属说明优先', async () => {
  const douyin = managedPluginProvider('douyin')
  expect(douyin.slug).toBe('douyin')
  expect(douyin.qrRelink).toBe(true)
  expect(douyin.setupNotice).toMatch(/风控/)
  await douyin.start(auth)
  await douyin.start(auth, 'acc-9')
  await douyin.get(auth, 's')
  await douyin.qr(auth, 's')
  await douyin.cancel(auth, 's')
  expect(calls).toEqual([
    ['startDouyinSetup', auth],
    ['startDouyinSetup', auth, 'acc-9'],
    ['getDouyinSetup', auth, 's'],
    ['getDouyinSetupQr', auth, 's'],
    ['cancelDouyinSetup', auth, 's'],
  ])
  // setup 的 errorCode 是 worker 原始码。
  expect(managedSetupFailureText(douyin, { status: 'failed', errorCode: 'VERIFICATION_REQUIRED' })).toMatch(
    /^抖音要求账号本人完成身份验证/,
  )
  expect(managedSetupFailureText(douyin, { status: 'failed', errorCode: 'LOGIN_STATE_UNSUPPORTED' })).toMatch(
    /不要反复扫码/,
  )
  expect(managedSetupFailureText(douyin, { status: 'failed', errorCode: 'UPSTREAM_CHALLENGE' })).toMatch(
    /^抖音触发了验证码或风控/,
  )
  expect(managedSetupFailureText(douyin, { status: 'expired', errorCode: 'VERIFICATION_REQUIRED' })).toBe(
    '二维码已过期，请重新授权。',
  )
  expect(managedSetupFailureText(douyin, { status: 'failed', errorCode: 'WORKER_FAILED' })).toBe('本次授权未完成，请重试。')
  // 其它插件没有专属说明与风险提示，行为不变。
  expect(managedPluginProvider('weibo').codeTexts).toBeUndefined()
  expect(managedPluginProvider('weibo').setupNotice).toBeUndefined()
})
