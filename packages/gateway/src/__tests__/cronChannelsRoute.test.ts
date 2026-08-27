/**
 * GET /api/cron/channels 网关接线:pathname 字面量须在 :id 之前,并进 allowlist / KNOWN_ROUTES。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronChannelsRoute.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const serverSrc = readFileSync(join(here, '../server.ts'), 'utf8')
const allowlistSrc = readFileSync(join(here, '../bridgeApiAllowlist.ts'), 'utf8')

describe('GET /api/cron/channels 网关接线', () => {
  it('pathname 字面量写在 /api/cron/:id 匹配之前', () => {
    const channelsAt = serverSrc.indexOf("url.pathname === '/api/cron/channels'")
    const cronAt = serverSrc.indexOf("url.pathname === '/api/cron'")
    const itemAt = serverSrc.indexOf("url.pathname.match(/^\\/api\\/cron\\/([a-zA-Z0-9_-]+)$/)")
    assert.ok(channelsAt >= 0, 'server.ts 必须有 url.pathname === \'/api/cron/channels\'')
    assert.ok(cronAt >= 0)
    assert.ok(itemAt > channelsAt, '/api/cron/channels 必须在 :id 正则之前,否则会被当成 job id')
    assert.match(serverSrc, /handleCronChannels\(/)
    assert.match(serverSrc, /listCronDeliverChannels\(/)
  })

  it('KNOWN_ROUTES 含 /api/cron/channels', () => {
    assert.ok(
      serverSrc.includes("'/api/cron/channels'"),
      'KNOWN_ROUTES 漏 /api/cron/channels 会塌成 /api/cron/:id',
    )
  })

  it('allowlist 先匹配 /api/cron/channels 再匹配 /api/cron/:id', () => {
    const channelsAt = allowlistSrc.indexOf("label: '/api/cron/channels'")
    const itemAt = allowlistSrc.indexOf("label: '/api/cron/:id'")
    assert.ok(channelsAt >= 0, 'BRIDGE_API_ALLOWLIST 必须有 /api/cron/channels')
    assert.ok(itemAt > channelsAt, 'first-match:channels 规则必须写在 :id 之前')
  })
})
