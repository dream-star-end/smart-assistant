import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildSingBoxConfig,
  decodeSubscriptionLines,
  metaText,
  parseSubscriptionNodes,
  redactEgressError,
  resolveEgressSettings,
  selectEgressNode,
} from '../egressSubscription.js'

const VLESS_URI =
  'vless://11111111-1111-4111-8111-111111111111@example.com:2053?encryption=none&security=tls&sni=edge.example.com&type=ws&host=ws.example.com&path=%2Fsecret-path&fp=chrome#US%20Node%201'
const REALITY_PUBLIC_KEY = 'abcdefghijklmnopqrstuvwxyzABCDE1234567890-_'
const REALITY_SHORT_ID = 'a1b2c3d4'
const REALITY_SNI = 'www.microsoft.com'
const REALITY_URI = `vless://22222222-2222-4222-8222-222222222222@reality.example.com:443?encryption=none&security=reality&sni=${REALITY_SNI}&type=tcp&fp=firefox&pbk=${REALITY_PUBLIC_KEY}&sid=${REALITY_SHORT_ID}&flow=xtls-rprx-vision#Reality%20Node`
const REALITY_URI_WITHOUT_TYPE = `vless://33333333-3333-4333-8333-333333333333@reality.example.com:8443?encryption=none&security=reality&sni=${REALITY_SNI}&fp=chrome&pbk=${REALITY_PUBLIC_KEY}&sid=${REALITY_SHORT_ID}#Reality%20No%20Type`

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
