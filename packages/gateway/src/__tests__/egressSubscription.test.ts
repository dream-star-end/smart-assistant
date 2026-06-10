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
    assert.equal(config.route.final, 'proxy')
    assert.equal(meta.idx, 7)
    assert.equal(meta.server, 'example.com:2053')
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
        `failed https://secret.example/sub and ${VLESS_URI} uuid 11111111-1111-4111-8111-111111111111`,
      ),
    )
    assert.equal(msg.includes('secret.example'), false)
    assert.equal(msg.includes('11111111-1111-4111-8111-111111111111'), false)
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
