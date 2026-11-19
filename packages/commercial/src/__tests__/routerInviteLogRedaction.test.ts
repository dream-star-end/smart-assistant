import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { afterEach, describe, test } from 'node:test'
import type { Pool } from 'pg'

import { signAccess } from '../auth/jwt.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import { createCommercialHandler, sanitizeCommercialLogPath } from '../http/router.js'
import { createLogger } from '../logging/logger.js'
import { _clearMaintenanceCache } from '../middleware/maintenanceMode.js'
import type { SitesService } from '../sites/service.js'

const JWT_SECRET = 'r'.repeat(64)
const SYNTH_TOKEN = 'SYNTH_INVITE_SECRET_TOKEN_807_DO_NOT_LOG'

afterEach(async () => {
  _clearMaintenanceCache()
  await resetPool()
})

function makeFakePool(isMaintenance: () => boolean): Pool {
  return {
    async query(sql: string) {
      const text = sql.replace(/\s+/g, ' ')
      if (text.includes('FROM system_settings')) {
        return {
          rowCount: 1,
          rows: [
            {
              value: isMaintenance(),
              description: null,
              updated_at: new Date('2026-11-19T00:00:00Z'),
              updated_by: '9',
            },
          ],
        }
      }
      if (text.includes('FROM users')) {
        return { rowCount: 1, rows: [{ role: 'user', status: 'active' }] }
      }
      return { rowCount: 0, rows: [] }
    },
    async connect() {
      throw new Error('not used')
    },
    async end() {},
    on() {
      return this
    },
  } as unknown as Pool
}

function noopRedis() {
  return {
    async incr() {
      return 1
    },
    async expire() {
      return 1
    },
  }
}

function makeReq(method: string, url: string, token?: string): IncomingMessage {
  const stream = Readable.from([])
  const headers: Record<string, string> = { host: 'claudeai.chat' }
  if (token) headers.authorization = `Bearer ${token}`
  Object.assign(stream, {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  })
  return stream as unknown as IncomingMessage
}

function makeRes() {
  const out = {
    statusCode: 200,
    headers: {} as Record<string, string | number | string[]>,
    body: '',
    headersSent: false,
    writableEnded: false,
  }
  const res = new EventEmitter() as EventEmitter & ServerResponse
  Object.assign(res, {
    setHeader(name: string, value: string | number | string[]) {
      out.headers[name.toLowerCase()] = value
    },
    getHeader(name: string) {
      return out.headers[name.toLowerCase()]
    },
    writeHead(status: number, headers?: Record<string, string | number>) {
      out.statusCode = status
      out.headersSent = true
      if (headers) {
        for (const [k, v] of Object.entries(headers)) out.headers[k.toLowerCase()] = v
      }
    },
    end(chunk?: string | Buffer) {
      if (chunk !== undefined) out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      out.writableEnded = true
      out.headersSent = true
      res.emit('close')
    },
    write(chunk: string | Buffer) {
      out.headersSent = true
      out.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
      return true
    },
  })
  Object.defineProperty(res, 'statusCode', {
    get: () => out.statusCode,
    set: (v: number) => {
      out.statusCode = v
    },
  })
  Object.defineProperty(res, 'headersSent', { get: () => out.headersSent })
  Object.defineProperty(res, 'writableEnded', { get: () => out.writableEnded })
  return { out, res: res as unknown as ServerResponse }
}

describe('commercial router invite path log redaction (OCV5-807 B5)', () => {
  test('sanitizeCommercialLogPath templates invite token routes', () => {
    assert.equal(sanitizeCommercialLogPath(`/api/site-invites/${SYNTH_TOKEN}`), '/api/site-invites/:token')
    assert.equal(
      sanitizeCommercialLogPath(`/api/site-invites/${SYNTH_TOKEN}/accept`),
      '/api/site-invites/:token/accept',
    )
    assert.equal(sanitizeCommercialLogPath('/api/sites/my-site'), '/api/sites/my-site')
  })

  test('normal, maintenance (503), and error (405) log records never contain invite token', async () => {
    const jwt = (await signAccess({ sub: '7', role: 'user' }, JWT_SECRET)).token
    const captured: string[] = []
    const logger = createLogger({
      level: 'info',
      out: (line) => {
        captured.push(line)
      },
    })
    const fakeSites = {
      async previewInvite() {
        return {
          valid: true,
          site: { id: 's1', slug: 'demo', title: 'Demo', url: 'https://demo.congjianai.com' },
          role: 'editor',
          ownerEmail: 'owner@example.com',
          ownerDisplayName: 'Owner',
          expiresAt: null,
          alreadyRole: null,
        }
      },
      async acceptInvite() {
        return {
          site: {
            id: 's1',
            slug: 'demo',
            url: 'https://demo.congjianai.com',
            accessRole: 'editor',
          },
          alreadyMember: false,
        }
      },
    } as unknown as SitesService

    const handler = createCommercialHandler(
      {
        jwtSecret: JWT_SECRET,
        mailer: { async send() {} },
        redis: noopRedis(),
        turnstileBypass: true,
        refreshCookieSecure: false,
        sites: fakeSites,
      },
      { logger },
    )

    let maintenanceOn = true
    await resetPool()
    setPoolOverride(makeFakePool(() => maintenanceOn))

    // 1. Maintenance mode active -> 503 MAINTENANCE, redacted path logged
    _clearMaintenanceCache()
    for (const req of [
      makeReq('GET', `/api/site-invites/${SYNTH_TOKEN}`, jwt),
      makeReq('POST', `/api/site-invites/${SYNTH_TOKEN}/accept`, jwt),
    ]) {
      const { out, res } = makeRes()
      const handled = await handler(req, res)
      assert.equal(handled, true)
      assert.equal(out.statusCode, 503)
    }

    // 2. Normal & error paths -> 200 & 405, zero invite token in logs
    maintenanceOn = false
    _clearMaintenanceCache()
    {
      const { out, res } = makeRes()
      await handler(makeReq('GET', `/api/site-invites/${SYNTH_TOKEN}`, jwt), res)
      assert.equal(out.statusCode, 200)
    }
    {
      const { out, res } = makeRes()
      await handler(makeReq('POST', `/api/site-invites/${SYNTH_TOKEN}/accept`, jwt), res)
      assert.equal(out.statusCode, 200)
    }
    {
      const { out, res } = makeRes()
      await handler(makeReq('DELETE', `/api/site-invites/${SYNTH_TOKEN}`, jwt), res)
      assert.equal(out.statusCode, 405)
    }

    const combined = captured.join('\n')
    assert.ok(captured.length >= 5, 'expected maintenance + normal + error log lines')
    assert.match(combined, /"path":"\/api\/site-invites\/:token"/)
    assert.match(combined, /"path":"\/api\/site-invites\/:token\/accept"/)
    assert.equal(
      combined.includes(SYNTH_TOKEN),
      false,
      `invite token leaked into logs:\n${combined}`,
    )
  })
})
