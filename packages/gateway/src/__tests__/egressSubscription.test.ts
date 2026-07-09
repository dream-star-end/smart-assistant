import * as assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { type Server as HttpServer, createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  buildSingBoxConfig,
  decodeSubscriptionLines,
  metaText,
  parseSubscriptionNodes,
  redactEgressError,
  refreshEgressNodes,
  resolveEgressSettings,
  selectEgressNode,
  testEgressProxy,
} from '../egressSubscription.js'

const VLESS_URI =
  'vless://11111111-1111-4111-8111-111111111111@example.com:2053?encryption=none&security=tls&sni=edge.example.com&type=ws&host=ws.example.com&path=%2Fsecret-path&fp=chrome#US%20Node%201'
const REALITY_PUBLIC_KEY = 'abcdefghijklmnopqrstuvwxyzABCDE1234567890-_'
const REALITY_SHORT_ID = 'a1b2c3d4'
const REALITY_SNI = 'www.microsoft.com'
const REALITY_URI = `vless://22222222-2222-4222-8222-222222222222@reality.example.com:443?encryption=none&security=reality&sni=${REALITY_SNI}&type=tcp&fp=firefox&pbk=${REALITY_PUBLIC_KEY}&sid=${REALITY_SHORT_ID}&flow=xtls-rprx-vision#Reality%20Node`
const REALITY_URI_WITHOUT_TYPE = `vless://33333333-3333-4333-8333-333333333333@reality.example.com:8443?encryption=none&security=reality&sni=${REALITY_SNI}&fp=chrome&pbk=${REALITY_PUBLIC_KEY}&sid=${REALITY_SHORT_ID}#Reality%20No%20Type`
const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const

function saveProxyEnv(): Record<(typeof PROXY_ENV_KEYS)[number], string | undefined> {
  const saved = {} as Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>
  for (const key of PROXY_ENV_KEYS) saved[key] = process.env[key]
  return saved
}

function restoreProxyEnv(saved: Record<(typeof PROXY_ENV_KEYS)[number], string | undefined>) {
  for (const key of PROXY_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

function listenLocal(server: HttpServer): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (typeof address === 'object' && address?.port) resolve(`http://127.0.0.1:${address.port}`)
      else reject(new Error('server did not bind a tcp port'))
    })
  })
}

function closeServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

describe('egress subscription parsing', () => {
  it('decodes both plain and base64 subscription bodies', () => {
    assert.deepEqual(decodeSubscriptionLines(`${VLESS_URI}\n`), [VLESS_URI])
    const b64 = Buffer.from(`${VLESS_URI}\n`, 'utf-8').toString('base64')
    assert.deepEqual(decodeSubscriptionLines(b64), [VLESS_URI])
  })

  it('returns sanitized public nodes without URI credentials or transport secrets', () => {
    const nodes = parseSubscriptionNodes([VLESS_URI], 1)
    assert.equal(nodes.length, 1)
    assert.deepEqual(nodes[0], {
      idx: 1,
      name: 'US Node 1',
      scheme: 'vless',
      server: 'example.com',
      port: 2053,
      transport: 'ws',
      security: 'tls',
      supported: true,
      active: true,
      error: undefined,
    })
    const exposed = JSON.stringify(nodes[0])
    assert.equal(exposed.includes('11111111-1111-4111-8111-111111111111'), false)
    assert.equal(exposed.includes('secret-path'), false)
    assert.equal(exposed.includes('edge.example.com'), false)
    assert.equal(exposed.includes('ws.example.com'), false)
  })

  it('marks unsupported nodes instead of throwing while listing', () => {
    const nodes = parseSubscriptionNodes(['trojan://pass@example.com:443#Legacy'])
    assert.equal(nodes[0].supported, false)
    assert.equal(nodes[0].scheme, 'trojan')
    assert.match(nodes[0].error || '', /unsupported scheme/)
  })

  it('supports sanitized VLESS tcp+reality nodes', () => {
    const nodes = parseSubscriptionNodes([REALITY_URI], 1)
    assert.deepEqual(nodes[0], {
      idx: 1,
      name: 'Reality Node',
      scheme: 'vless',
      server: 'reality.example.com',
      port: 443,
      transport: 'tcp',
      security: 'reality',
      supported: true,
      active: true,
      error: undefined,
    })
    const exposed = JSON.stringify(nodes[0])
    assert.equal(exposed.includes('22222222-2222-4222-8222-222222222222'), false)
    assert.equal(exposed.includes(REALITY_PUBLIC_KEY), false)
    assert.equal(exposed.includes(REALITY_SHORT_ID), false)
    assert.equal(exposed.includes(REALITY_SNI), false)
  })

  it('treats missing Reality type as tcp while keeping explicit non-tcp unsupported', () => {
    const nodes = parseSubscriptionNodes([
      REALITY_URI_WITHOUT_TYPE,
      REALITY_URI.replace('type=tcp', 'type=grpc'),
    ])
    assert.equal(nodes[0].supported, true)
    assert.equal(nodes[0].transport, 'tcp')
    assert.equal(nodes[0].security, 'reality')
    assert.equal(nodes[1].supported, false)
    assert.match(nodes[1].error || '', /grpc\+reality/)
  })
})

describe('egress sing-box config construction', () => {
  it('materializes private node fields only into local sing-box config', () => {
    const node = {
      idx: 7,
      uri: VLESS_URI,
      name: 'US Node 1',
      scheme: 'vless',
      server: 'example.com',
      port: 2053,
      transport: 'ws',
      security: 'tls',
      supported: true,
      active: false,
      uuid: '11111111-1111-4111-8111-111111111111',
      sni: 'edge.example.com',
      wsHost: 'ws.example.com',
      path: '/secret-path',
      fingerprint: 'chrome',
    }
    const { config, meta } = buildSingBoxConfig(node, '127.0.0.1', 19999)
    assert.equal(config.inbounds[0].listen_port, 19999)
    assert.equal(config.outbounds[0].uuid, node.uuid)
    assert.equal(config.outbounds[0].tls.server_name, node.sni)
    assert.equal(config.outbounds[0].transport.path, node.path)
    assert.equal(config.outbounds[0].tls.reality, undefined)
    assert.equal(config.route.final, 'proxy')
    assert.equal(meta.idx, 7)
    assert.equal(meta.server, 'example.com:2053')
  })

  it('materializes VLESS Reality fields only into local sing-box config', () => {
    const node = {
      idx: 8,
      uri: REALITY_URI,
      name: 'Reality Node',
      scheme: 'vless',
      server: 'reality.example.com',
      port: 443,
      transport: 'tcp',
      security: 'reality',
      supported: true,
      active: false,
      uuid: '22222222-2222-4222-8222-222222222222',
      sni: REALITY_SNI,
      fingerprint: 'firefox',
      flow: 'xtls-rprx-vision',
      realityPublicKey: REALITY_PUBLIC_KEY,
      realityShortId: REALITY_SHORT_ID,
    }
    const { config, meta } = buildSingBoxConfig(node, '127.0.0.1', 19998)
    const outbound = config.outbounds[0]
    assert.equal(config.inbounds[0].listen_port, 19998)
    assert.equal(outbound.uuid, node.uuid)
    assert.equal(outbound.flow, 'xtls-rprx-vision')
    assert.equal(outbound.tls.server_name, REALITY_SNI)
    assert.equal(outbound.tls.utls.fingerprint, 'firefox')
    assert.deepEqual(outbound.tls.reality, {
      enabled: true,
      public_key: REALITY_PUBLIC_KEY,
      short_id: REALITY_SHORT_ID,
    })
    assert.equal(outbound.transport, undefined)
    assert.equal(config.route.final, 'proxy')
    assert.equal(meta.idx, 8)
    assert.equal(meta.server, 'reality.example.com:443')
  })
})

describe('egress settings and redaction', () => {
  it('disables mutations by default on the personal dev instance', () => {
    const settings = resolveEgressSettings({
      gatewayPort: 18790,
      env: { OPENCLAUDE_HOME: '/root/.openclaude-dev' },
    })
    assert.equal(settings.mutationsEnabled, false)
    assert.match(settings.mutationDisabledReason || '', /dev instance/)
  })

  it('allows explicit mutation opt-in and strict false values', () => {
    assert.equal(
      resolveEgressSettings({ env: { OC_EGRESS_UI_MUTATIONS: 'yes' } }).mutationsEnabled,
      true,
    )
    assert.equal(
      resolveEgressSettings({ env: { OC_EGRESS_UI_MUTATIONS: '0' } }).mutationsEnabled,
      false,
    )
  })

  it('rejects node switching before fetching subscription when mutations are disabled', async () => {
    await assert.rejects(
      () =>
        selectEgressNode(1, {
          gatewayPort: 18790,
          env: { OPENCLAUDE_HOME: '/root/.openclaude-dev' },
        }),
      /disabled on dev instance/,
    )
  })

  it('redacts subscription and node URLs from public errors', () => {
    const msg = redactEgressError(
      new Error(
        `failed https://secret.example/sub and ${VLESS_URI} uuid 11111111-1111-4111-8111-111111111111 public_key=${REALITY_PUBLIC_KEY} short_id=${REALITY_SHORT_ID} server_name=${REALITY_SNI} ?pbk=${REALITY_PUBLIC_KEY}&sid=${REALITY_SHORT_ID}&sni=${REALITY_SNI}`,
      ),
    )
    assert.equal(msg.includes('secret.example'), false)
    assert.equal(msg.includes('11111111-1111-4111-8111-111111111111'), false)
    assert.equal(msg.includes(REALITY_PUBLIC_KEY), false)
    assert.equal(msg.includes(REALITY_SHORT_ID), false)
    assert.equal(msg.includes(REALITY_SNI), false)
    assert.match(msg, /\[redacted-url\]/)
    assert.match(msg, /\[redacted-node-uri\]/)
    assert.match(msg, /\[redacted-uuid\]/)
  })

  it('serializes meta values as single-line fields', () => {
    const text = metaText({
      idx: 9,
      name: 'safe\nidx=1\nhealth_healthy=false',
      server: 'example.com:443',
    })
    assert.match(text, /^name=safe idx=1 health_healthy=false$/m)
    assert.equal(text.includes('\nidx=1\nhealth_healthy=false'), false)
  })
})

describe('egress proxy failover isolation', () => {
  it('fetches subscriptions directly even when the gateway global fetch uses HTTP_PROXY', async () => {
    let subscriptionHits = 0
    const subscriptionServer = createHttpServer((_req, res) => {
      subscriptionHits++
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`${VLESS_URI}\n`)
    })
    let brokenProxyHits = 0
    const brokenProxyServer = createHttpServer((_req, res) => {
      brokenProxyHits++
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('broken current proxy')
    })
    const oldDispatcher = getGlobalDispatcher()
    const savedEnv = saveProxyEnv()
    try {
      const subscriptionBase = await listenLocal(subscriptionServer)
      const brokenProxyBase = await listenLocal(brokenProxyServer)
      for (const key of PROXY_ENV_KEYS) delete process.env[key]
      process.env.HTTP_PROXY = brokenProxyBase
      setGlobalDispatcher(new EnvHttpProxyAgent())

      const data = await refreshEgressNodes({
        env: {
          OC_EGRESS_SUB_URL: `${subscriptionBase}/sub`,
          OC_EGRESS_SERVICE: 'missing-openclaude-egress-test.service',
        },
      })

      assert.equal(data.nodes.length, 1)
      assert.equal(data.nodes[0]?.name, 'US Node 1')
      assert.equal(subscriptionHits, 1)
      assert.equal(brokenProxyHits, 0)
    } finally {
      setGlobalDispatcher(oldDispatcher)
      restoreProxyEnv(savedEnv)
      await Promise.all([closeServer(subscriptionServer), closeServer(brokenProxyServer)])
    }
  })

  it('tests candidate nodes through their temporary proxy without inherited proxy env', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-egress-test-'))
    const singBoxPath = join(dir, 'fake-sing-box.cjs')
    const curlPath = join(dir, 'fake-curl.cjs')
    const savedEnv = saveProxyEnv()
    try {
      await writeFile(
        singBoxPath,
        `#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const args = process.argv.slice(2)
const cfgPath = args[args.indexOf('-c') + 1]
if (args[0] === 'check') process.exit(0)
if (args[0] !== 'run') process.exit(64)
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
const inbound = cfg.inbounds[0]
const server = net.createServer((socket) => socket.end())
server.listen(inbound.listen_port, inbound.listen)
process.on('SIGTERM', () => server.close(() => process.exit(0)))
setInterval(() => {}, 1000)
`,
        { mode: 0o700 },
      )
      await writeFile(
        curlPath,
        `#!/usr/bin/env node
const proxyEnvKeys = ${JSON.stringify(PROXY_ENV_KEYS)}
const leaked = proxyEnvKeys.filter((key) => process.env[key])
if (leaked.length) {
  console.error('proxy env leaked: ' + leaked.join(','))
  process.exit(2)
}
const args = process.argv.slice(2)
const proxyIdx = args.indexOf('-x')
const proxy = proxyIdx >= 0 ? args[proxyIdx + 1] : ''
if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+$/.test(proxy)) {
  console.error('missing candidate proxy: ' + proxy)
  process.exit(3)
}
const noProxyIdx = args.indexOf('--noproxy')
if (noProxyIdx < 0 || args[noProxyIdx + 1] !== '') {
  console.error('missing --noproxy empty override')
  process.exit(4)
}
const url = args[args.length - 1]
if (url.includes('ipinfo.io')) {
  process.stdout.write(JSON.stringify({
    ip: '203.0.113.10',
    org: 'AS64500 Test Network',
    city: 'Example City',
    country: 'US',
  }))
} else if (url.includes('generate_204')) {
  process.stdout.write('204')
} else {
  process.stdout.write('404')
}
`,
        { mode: 0o700 },
      )
      await chmod(singBoxPath, 0o700)
      await chmod(curlPath, 0o700)
      process.env.HTTP_PROXY = 'http://127.0.0.1:18991'
      process.env.HTTPS_PROXY = 'http://127.0.0.1:18991'
      process.env.NO_PROXY = '*'

      const data = await testEgressProxy([1], {
        env: {
          OC_EGRESS_SUB_URL: `data:text/plain,${encodeURIComponent(`${VLESS_URI}\n`)}`,
          OC_EGRESS_SING_BOX: singBoxPath,
          OC_EGRESS_CURL: curlPath,
        },
      })

      const health = data.results[0]?.health
      assert.equal(health?.healthy, true)
      assert.equal(health?.anthropicCode, '404')
      assert.equal(health?.cfCode, '204')
      assert.equal(health?.ip, '203.0.113.10')
    } finally {
      restoreProxyEnv(savedEnv)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
