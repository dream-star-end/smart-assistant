/**
 * connectors/outboundPolicy 表驱动单测(无 DB;§11:私网/metadata/rebinding/协议端口矩阵):
 *   - IPv4/IPv6 global unicast 分类全矩阵
 *   - WebDAV URL 形状(https-only / userinfo / fragment / query / IP 字面量)
 *   - IMAP/SMTP 端口矩阵
 *   - DNS 全记录校验 + 钉死(含 rebinding 混合应答拒绝)
 *   - 固定域静态白名单
 *   - canary:错误信息不泄漏凭据
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ConnectorError } from '../connectors/errors.js'
import {
  assertFixedDomainUrl,
  assertHostnameShape,
  assertImapPort,
  assertSmtpPort,
  isGlobalUnicastIp,
  isGlobalUnicastIpv4,
  isGlobalUnicastIpv6,
  makePinnedLookup,
  pinnedHttpsFetch,
  resolvePinnedAddress,
  validateWebdavBaseUrl,
} from '../connectors/outboundPolicy.js'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
    assert.fail('expected throw')
  } catch (err) {
    assert.ok(err instanceof ConnectorError, `expected ConnectorError, got ${String(err)}`)
    assert.equal(err.code, code)
  }
}

async function expectCodeAsync(p: Promise<unknown>, code: string): Promise<void> {
  try {
    await p
    assert.fail('expected reject')
  } catch (err) {
    assert.ok(err instanceof ConnectorError, `expected ConnectorError, got ${String(err)}`)
    assert.equal(err.code, code)
  }
}

describe('isGlobalUnicastIpv4(拒绝表全矩阵)', () => {
  const denied = [
    '0.1.2.3', // this-network
    '10.0.0.1', // RFC1918
    '100.64.0.1', // CGN
    '127.0.0.1', // loopback
    '169.254.169.254', // 链路本地 / 云 metadata
    '172.16.0.1', // RFC1918 低界
    '172.31.255.254', // RFC1918 高界(平台网段显式含 172.30-31)
    '172.30.0.1', // 平台容器网段
    '192.0.0.1', // IETF
    '192.0.2.9', // TEST-NET-1
    '192.168.1.1', // RFC1918
    '198.18.0.1', // benchmarking
    '198.51.100.7', // TEST-NET-2
    '203.0.113.200', // TEST-NET-3
    '224.0.0.251', // multicast
    '240.0.0.1', // reserved
    '255.255.255.255', // broadcast
  ]
  for (const ip of denied) {
    test(`拒 ${ip}`, () => assert.equal(isGlobalUnicastIpv4(ip), false))
  }
  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '203.0.114.1',
    '100.63.0.1',
    '11.0.0.1',
    '223.255.255.254',
  ]
  for (const ip of allowed) {
    test(`放 ${ip}`, () => assert.equal(isGlobalUnicastIpv4(ip), true))
  }
  test('非 IP 输入 false', () => {
    assert.equal(isGlobalUnicastIpv4('not-an-ip'), false)
    assert.equal(isGlobalUnicastIpv4('1.2.3'), false)
    assert.equal(isGlobalUnicastIpv4('1.2.3.4.5'), false)
  })
  test('family 守卫:v6 串走 v4 判定 → false(P1#10)', () => {
    assert.equal(isGlobalUnicastIpv4('2606:4700::1'), false)
    assert.equal(isGlobalUnicastIpv4('::1'), false)
  })
})

describe('isGlobalUnicastIpv6(2000::/3 + IANA special 剔除;P1#10 收紧)', () => {
  const denied = [
    '::', // unspecified
    '::1', // loopback
    '::ffff:8.8.8.8', // IPv4-mapped(设计:直接拒)
    '::ffff:7f00:1', // IPv4-mapped 127.0.0.1(hex 形式)
    '64:ff9b::808:808', // NAT64
    'fc00::1', // ULA
    'fd12:3456::1', // ULA
    'fe80::1', // link-local
    'ff02::1', // multicast
    '2001:db8::1', // documentation(2001:db8::/32)
    // ── P1#10 新增:6to4 2002::/16 可把 loopback/私网 IPv4 编码进 v6 ──
    '2002::1', // 6to4 通配(整个 /16 拒)
    '2002:7f00:1::', // 6to4 编码 127.0.0.1(0x7f000001)
    '2002:a00:1::1', // 6to4 编码 10.0.0.1(私网)
    '2002:c0a8:101::', // 6to4 编码 192.168.1.1(私网)
    // ── 文档段 3fff::/20(RFC 9637;此前被误当可接受)──
    '3fff::1',
    '3fff:0fff::1', // /20 上界内
    // ── 2001::/23 IETF 协议块(Teredo / benchmarking / ORCHID / AS112 …)──
    '2001::1', // Teredo 2001::/32
    '2001:2::1', // benchmarking 2001:2::/48
    '2001:10::1', // ORCHID(已弃用)
    // ── discard-only ──
    '0100::1',
  ]
  for (const ip of denied) {
    test(`拒 ${ip}`, () => assert.equal(isGlobalUnicastIpv6(ip), false))
  }
  const allowed = [
    '2400:cb00::1',
    '2606:4700::1111',
    '2a06:98c0::1',
    '2001:4860:4860::8888', // Google DNS(2001:4860,在 2001::/23 之外 → 放行)
    '2600::1',
    '3fff:1000::1', // 3fff::/16 内、/20 之外 → 非文档段 → 放行
  ]
  for (const ip of allowed) {
    test(`放 ${ip}`, () => assert.equal(isGlobalUnicastIpv6(ip), true))
  }
  test('family 守卫:v4 串走 v6 判定 → false', () => {
    assert.equal(isGlobalUnicastIpv6('8.8.8.8'), false)
    assert.equal(isGlobalUnicastIpv6('not-an-ip'), false)
  })
})

describe('isGlobalUnicastIp(统一入口)', () => {
  test('v4/v6/垃圾输入', () => {
    assert.equal(isGlobalUnicastIp('8.8.8.8'), true)
    assert.equal(isGlobalUnicastIp('10.0.0.1'), false)
    assert.equal(isGlobalUnicastIp('2606:4700::1'), true)
    assert.equal(isGlobalUnicastIp('::1'), false)
    assert.equal(isGlobalUnicastIp('example.com'), false)
  })
})

describe('validateWebdavBaseUrl(URL 形状矩阵)', () => {
  test('http 拒绝(仅 https)', () => {
    expectCode(() => validateWebdavBaseUrl('http://dav.example.com/'), 'OUTBOUND_BLOCKED')
  })
  test('userinfo 拒绝 + 不泄漏凭据(canary)', () => {
    const canary = 'sekret-canary-9f2'
    try {
      validateWebdavBaseUrl(`https://user:${canary}@dav.example.com/`)
      assert.fail('expected throw')
    } catch (err) {
      assert.ok(err instanceof ConnectorError)
      assert.equal(err.code, 'OUTBOUND_BLOCKED')
      assert.ok(!err.message.includes(canary), 'error message must not leak credentials')
    }
  })
  test('fragment 拒绝', () => {
    expectCode(() => validateWebdavBaseUrl('https://dav.example.com/#frag'), 'OUTBOUND_BLOCKED')
  })
  test('query 拒绝(基址禁 query,顺带禁 query 凭据)', () => {
    expectCode(() => validateWebdavBaseUrl('https://dav.example.com/?token=x'), 'OUTBOUND_BLOCKED')
  })
  test('IPv4 字面量拒绝', () => {
    expectCode(() => validateWebdavBaseUrl('https://8.8.8.8/dav'), 'OUTBOUND_BLOCKED')
  })
  test('IPv6 字面量拒绝', () => {
    expectCode(() => validateWebdavBaseUrl('https://[2606:4700::1]/dav'), 'OUTBOUND_BLOCKED')
  })
  test('烂 URL → BAD_REQUEST', () => {
    expectCode(() => validateWebdavBaseUrl('not a url'), 'BAD_REQUEST')
  })
  test('合法 URL 规范化:默认端口省略/尾斜杠剥离/host 小写', () => {
    const v = validateWebdavBaseUrl('https://DAV.Jianguoyun.com:443/dav/')
    assert.equal(v.origin, 'https://dav.jianguoyun.com')
    assert.equal(v.port, 443)
    assert.equal(v.basePath, '/dav')
  })
  test('自定义 https 端口允许(IP 策略才是内网防线)', () => {
    const v = validateWebdavBaseUrl('https://nc.example.com:8443/remote.php/dav')
    assert.equal(v.origin, 'https://nc.example.com:8443')
    assert.equal(v.basePath, '/remote.php/dav')
  })
})

describe('端口矩阵', () => {
  test('imap:993 唯一合法', () => {
    assert.doesNotThrow(() => assertImapPort(993))
    for (const p of [143, 25, 465, 587, 80]) {
      expectCode(() => assertImapPort(p), 'OUTBOUND_BLOCKED')
    }
  })
  test('smtp:465/587 合法,25/2525 拒绝(禁明文)', () => {
    assert.doesNotThrow(() => assertSmtpPort(465))
    assert.doesNotThrow(() => assertSmtpPort(587))
    for (const p of [25, 2525, 993, 80]) {
      expectCode(() => assertSmtpPort(p), 'OUTBOUND_BLOCKED')
    }
  })
})

describe('assertHostnameShape', () => {
  test('IP 字面量 / 非法字符 / 超长拒绝', () => {
    expectCode(() => assertHostnameShape('127.0.0.1'), 'OUTBOUND_BLOCKED')
    expectCode(() => assertHostnameShape('[::1]'), 'OUTBOUND_BLOCKED')
    expectCode(() => assertHostnameShape('bad_host!'), 'OUTBOUND_BLOCKED')
    expectCode(() => assertHostnameShape(`${'a'.repeat(254)}.com`), 'OUTBOUND_BLOCKED')
  })
  test('正常域名通过', () => {
    assert.doesNotThrow(() => assertHostnameShape('imap.qq.com'))
    assert.doesNotThrow(() => assertHostnameShape('smtp.163.com'))
  })
})

describe('resolvePinnedAddress(DNS 全记录校验 + 钉死)', () => {
  const resolver = (v4: string[], v6: string[]) => ({
    resolve4: async () => v4,
    resolve6: async () => v6,
  })
  const noRecord = { code: 'ENODATA' } as NodeJS.ErrnoException

  test('全公网 A 记录 → 钉第一条 v4', async () => {
    const pin = await resolvePinnedAddress('ok.example.com', resolver(['8.8.8.8', '1.1.1.1'], []))
    assert.deepEqual(pin, { ip: '8.8.8.8', family: 4 })
  })
  test('混合应答(1 公网 + 1 私网)整体拒绝 —— rebinding/挑好用不允许', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('mix.example.com', resolver(['8.8.8.8', '10.0.0.1'], [])),
      'OUTBOUND_BLOCKED',
    )
  })
  test('AAAA 含 ULA 时即使 A 全好也拒绝(全记录校验)', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('mix6.example.com', resolver(['8.8.8.8'], ['fd00::1'])),
      'OUTBOUND_BLOCKED',
    )
  })
  test('metadata IP(169.254.169.254)拒绝', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('meta.example.com', resolver(['169.254.169.254'], [])),
      'OUTBOUND_BLOCKED',
    )
  })
  test('AAAA 为 6to4 编码 loopback(2002:7f00:1::)整体拒绝(P1#10)', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('sixfour.example.com', resolver([], ['2002:7f00:1::'])),
      'OUTBOUND_BLOCKED',
    )
  })
  test('AAAA 为文档段 3fff::1 拒绝(P1#10)', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('doc6.example.com', resolver([], ['3fff::1'])),
      'OUTBOUND_BLOCKED',
    )
  })
  test('空应答拒绝', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('none.example.com', {
        resolve4: async () => {
          throw noRecord
        },
        resolve6: async () => {
          throw noRecord
        },
      }),
      'OUTBOUND_BLOCKED',
    )
  })
  test('仅 AAAA(公网)→ 钉 v6', async () => {
    const pin = await resolvePinnedAddress('v6.example.com', {
      resolve4: async () => {
        throw noRecord
      },
      resolve6: async () => ['2606:4700::1111'],
    })
    assert.deepEqual(pin, { ip: '2606:4700::1111', family: 6 })
  })
  test('resolver 硬错误(非 ENODATA)→ 拒绝', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('err.example.com', {
        resolve4: async () => {
          throw Object.assign(new Error('boom'), { code: 'ECONNREFUSED' })
        },
        resolve6: async () => [],
      }),
      'OUTBOUND_BLOCKED',
    )
  })
  test('hostname 形状先于 DNS(IP 字面量直接拒)', async () => {
    await expectCodeAsync(
      resolvePinnedAddress('127.0.0.1', resolver(['8.8.8.8'], [])),
      'OUTBOUND_BLOCKED',
    )
  })
})

describe('makePinnedLookup(net/tls lookup 覆盖)', () => {
  test('all=false → (ip, family);all=true → 数组形态', () => {
    const lookup = makePinnedLookup({ ip: '8.8.8.8', family: 4 })
    lookup('whatever.example.com', {}, (err, addr, family) => {
      assert.equal(err, null)
      assert.equal(addr, '8.8.8.8')
      assert.equal(family, 4)
    })
    lookup('whatever.example.com', { all: true }, (err, addrs) => {
      assert.equal(err, null)
      assert.deepEqual(addrs, [{ address: '8.8.8.8', family: 4 }])
    })
  })
})

describe('pinnedHttpsFetch caller lifecycle', () => {
  test('caller abort cancels an in-flight per-request resolver before fetch', async () => {
    let rejectDns!: (error: Error) => void
    let markStarted!: () => void
    let cancellations = 0
    let fetches = 0
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const controller = new AbortController()
    const pending = pinnedHttpsFetch(
      new URL('https://example.com/public'),
      { method: 'GET' },
      {
        resolver: {
          resolve4: async () =>
            new Promise<string[]>((_resolve, reject) => {
              rejectDns = reject
              markStarted()
            }),
          resolve6: async () => [],
          cancel: () => {
            cancellations += 1
            rejectDns(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
          },
        },
        fetchImpl: async () => {
          fetches += 1
          return new Response('unexpected')
        },
        signal: controller.signal,
      },
    )
    await started
    controller.abort()
    await assert.rejects(pending)
    assert.equal(cancellations, 1)
    assert.equal(fetches, 0)
  })
})

describe('assertFixedDomainUrl(静态白名单)', () => {
  test('各 provider 白名单命中', () => {
    assert.doesNotThrow(() => assertFixedDomainUrl('notion', 'https://api.notion.com/v1/search'))
    assert.doesNotThrow(() => assertFixedDomainUrl('github', 'https://api.github.com/user'))
    assert.doesNotThrow(() =>
      assertFixedDomainUrl('feishu', 'https://open.feishu.cn/open-apis/authen/v1/user_info'),
    )
  })
  test('跨 provider 域名拒绝(白名单按 provider 隔离)', () => {
    expectCode(() => assertFixedDomainUrl('notion', 'https://api.github.com/x'), 'OUTBOUND_BLOCKED')
    expectCode(
      () => assertFixedDomainUrl('feishu', 'https://evil.example.com/x'),
      'OUTBOUND_BLOCKED',
    )
  })
  test('http / 未知 provider 拒绝', () => {
    expectCode(() => assertFixedDomainUrl('notion', 'http://api.notion.com/x'), 'OUTBOUND_BLOCKED')
    expectCode(() => assertFixedDomainUrl('nope', 'https://api.notion.com/x'), 'OUTBOUND_BLOCKED')
  })
})
