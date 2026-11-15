import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCcbSpawnProcessEnv } from '../subprocessRunner.js'

describe('buildCcbSpawnProcessEnv', () => {
  it('strips platform-only controls without changing ordinary inherited env', () => {
    const got = buildCcbSpawnProcessEnv({
      HOME: '/home/agent',
      OPENCLAUDE_CCB_HTTPS_PROXY: '',
      OPENCLAUDE_CCB_NO_PROXY: '',
      OPENCLAUDE_CCB_TZ: '',
    })
    assert.equal(got.HOME, '/home/agent')
    assert.equal('OPENCLAUDE_CCB_HTTPS_PROXY' in got, false)
    assert.equal('OPENCLAUDE_CCB_NO_PROXY' in got, false)
    assert.equal('OPENCLAUDE_CCB_TZ' in got, false)
  })

  it('routes external HTTPS through the stable proxy while pinning internal HTTP to NO_PROXY', () => {
    const got = buildCcbSpawnProcessEnv({
      ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892',
      OPENCLAUDE_CCB_HTTPS_PROXY: 'http://172.31.0.1:18991',
      OPENCLAUDE_CCB_NO_PROXY: 'localhost,127.0.0.1,::1,172.31.0.1',
      OPENCLAUDE_CCB_TZ: 'Asia/Tokyo',
      HTTP_PROXY: 'http://legacy-http:8080',
      ALL_PROXY: 'socks5://legacy-all:1080',
    })
    assert.equal(got.HTTPS_PROXY, 'http://172.31.0.1:18991')
    assert.equal(got.https_proxy, 'http://172.31.0.1:18991')
    assert.equal(got.NO_PROXY, 'localhost,127.0.0.1,::1,172.31.0.1')
    assert.equal(got.no_proxy, got.NO_PROXY)
    assert.equal(got.HTTP_PROXY, undefined)
    assert.equal(got.ALL_PROXY, undefined)
    assert.equal(got.TZ, undefined)
    assert.equal('OPENCLAUDE_CCB_TZ' in got, false)
  })

  // OCV5-754: 不再注入 Asia/Tokyo 到子进程 TZ;OC_USER_TZ 原样透传、OPENCLAUDE_CCB_TZ 被剥离。
  it('strips OPENCLAUDE_CCB_TZ without mutating TZ and preserves OC_USER_TZ', () => {
    const got = buildCcbSpawnProcessEnv({
      ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892',
      OPENCLAUDE_CCB_TZ: 'Asia/Tokyo',
      OC_USER_TZ: 'America/New_York',
    })
    assert.equal(got.TZ, undefined)
    assert.equal('OPENCLAUDE_CCB_TZ' in got, false)
    assert.equal(got.OC_USER_TZ, 'America/New_York')
  })

  it('fails closed if proxy credentials or internal bypass are invalid', () => {
    const base = {
      ANTHROPIC_BASE_URL: 'http://172.31.0.1:18892',
      OPENCLAUDE_CCB_NO_PROXY: 'localhost,127.0.0.1',
    }
    assert.throws(
      () =>
        buildCcbSpawnProcessEnv({
          ...base,
          OPENCLAUDE_CCB_HTTPS_PROXY: 'http://user:pass@172.31.0.1:18991',
        }),
      /credential-free/,
    )
    assert.throws(
      () =>
        buildCcbSpawnProcessEnv({
          ...base,
          OPENCLAUDE_CCB_HTTPS_PROXY: 'http://172.31.0.1:18991',
        }),
      /must include the ANTHROPIC_BASE_URL host/,
    )
  })
})
