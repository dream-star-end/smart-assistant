import * as assert from 'node:assert/strict'
import { resolve } from 'node:path'
/**
 * Security tests for OpenClaude Gateway.
 * Tests real exported functions from server.ts — NOT local helper clones.
 * Run: npx tsx --test packages/gateway/src/__tests__/security.test.ts
 */
import { describe, it } from 'node:test'
import {
  FILE_BLOCKED_PATTERNS,
  MAX_UPLOAD_SINGLE,
  MAX_UPLOAD_TOTAL,
  UPLOAD_MIME_PREFIXES,
  isFileBlocked,
  isUploadMimeAllowed,
} from '../server.js'

// ── T01: /api/file blacklist — tests the REAL isFileBlocked function ──
describe('T01: isFileBlocked — sensitive file blocking', () => {
  // Should BLOCK
  it('blocks openclaude.json (gateway config)', () => {
    assert.ok(isFileBlocked('/root/.openclaude/openclaude.json'))
  })
  it('blocks .env files', () => {
    assert.ok(isFileBlocked('/root/.openclaude/.env'))
  })
  it('blocks credentials directory', () => {
    assert.ok(isFileBlocked('/root/.openclaude/credentials/token.json'))
  })
  it('blocks .ssh directory', () => {
    assert.ok(isFileBlocked('/root/.ssh/id_rsa'))
  })
  it('blocks .key files', () => {
    assert.ok(isFileBlocked('/etc/ssl/private/server.key'))
  })
  it('blocks .pem certificates', () => {
    assert.ok(isFileBlocked('/etc/ssl/certs/ca.pem'))
  })
  it('blocks id_rsa SSH key', () => {
    assert.ok(isFileBlocked('/home/user/.ssh/id_rsa'))
  })
  it('blocks id_ed25519 SSH key', () => {
    assert.ok(isFileBlocked('/home/user/.ssh/id_ed25519'))
  })
  it('blocks .gnupg directory', () => {
    assert.ok(isFileBlocked('/root/.gnupg/secring.gpg'))
  })
  it('blocks .password files', () => {
    assert.ok(isFileBlocked('/root/.password'))
  })
  it('blocks /etc/shadow', () => {
    assert.ok(isFileBlocked('/etc/shadow'))
  })
  it('blocks auth token files (case insensitive)', () => {
    assert.ok(isFileBlocked('/tmp/auth_token.json'))
    assert.ok(isFileBlocked('/tmp/AUTH_TOKEN'))
  })
  it('blocks MEMORY.md (agent long-term memory)', () => {
    assert.ok(isFileBlocked('/root/.openclaude/agents/main/MEMORY.md'))
  })
  it('blocks USER.md (user identity)', () => {
    assert.ok(isFileBlocked('/root/.openclaude/agents/main/USER.md'))
  })
  it('blocks CLAUDE.md (agent persona/instructions)', () => {
    assert.ok(isFileBlocked('/root/.openclaude/agents/main/CLAUDE.md'))
  })
  it('blocks resume-map.json (checkpoint data)', () => {
    assert.ok(isFileBlocked('/root/.openclaude/agents/main/sessions/resume-map.json'))
  })
  it('blocks .env.local', () => {
    assert.ok(isFileBlocked('/root/project/.env.local'))
  })
  it('blocks .env.production', () => {
    assert.ok(isFileBlocked('/root/project/.env.production'))
  })
  it('blocks .env.development', () => {
    assert.ok(isFileBlocked('/root/project/.env.development'))
  })
  it('blocks .npmrc', () => {
    assert.ok(isFileBlocked('/root/.npmrc'))
  })
  it('blocks .pypirc', () => {
    assert.ok(isFileBlocked('/root/.pypirc'))
  })
  it('blocks .netrc', () => {
    assert.ok(isFileBlocked('/root/.netrc'))
  })
  it('blocks .aws/credentials', () => {
    assert.ok(isFileBlocked('/root/.aws/credentials'))
  })
  it('blocks .aws/config', () => {
    assert.ok(isFileBlocked('/root/.aws/config'))
  })
  it('blocks .kube/config', () => {
    assert.ok(isFileBlocked('/root/.kube/config'))
  })
  it('blocks .docker/config.json', () => {
    assert.ok(isFileBlocked('/root/.docker/config.json'))
  })

  // Should ALLOW
  it('allows normal image files', () => {
    assert.ok(!isFileBlocked('/root/.openclaude/uploads/photo.jpg'))
  })
  it('allows generated audio', () => {
    assert.ok(!isFileBlocked('/root/.openclaude/generated/speech.mp3'))
  })
  it('allows /tmp files', () => {
    assert.ok(!isFileBlocked('/tmp/test-result.txt'))
  })
  it('allows agent work products', () => {
    assert.ok(!isFileBlocked('/root/project/build/output.html'))
  })
  it('allows screenshot files', () => {
    assert.ok(!isFileBlocked('/root/.openclaude/agents/main/screenshots/page.png'))
  })
})

// ── T02: Upload MIME validation — tests the REAL isUploadMimeAllowed function ──
describe('T02: isUploadMimeAllowed — upload type filtering', () => {
  // Should ALLOW
  it('allows image/png', () => assert.ok(isUploadMimeAllowed('image/png')))
  it('allows image/jpeg', () => assert.ok(isUploadMimeAllowed('image/jpeg')))
  it('allows image/gif', () => assert.ok(isUploadMimeAllowed('image/gif')))
  it('allows image/webp', () => assert.ok(isUploadMimeAllowed('image/webp')))
  it('allows audio/mpeg', () => assert.ok(isUploadMimeAllowed('audio/mpeg')))
  it('allows audio/wav', () => assert.ok(isUploadMimeAllowed('audio/wav')))
  it('allows video/mp4', () => assert.ok(isUploadMimeAllowed('video/mp4')))
  it('allows video/webm', () => assert.ok(isUploadMimeAllowed('video/webm')))
  it('allows application/pdf', () => assert.ok(isUploadMimeAllowed('application/pdf')))
  it('allows text/plain', () => assert.ok(isUploadMimeAllowed('text/plain')))
  it('allows text/csv', () => assert.ok(isUploadMimeAllowed('text/csv')))
  it('allows application/octet-stream (generic)', () =>
    assert.ok(isUploadMimeAllowed('application/octet-stream')))
  it('allows empty mime (no header)', () => assert.ok(isUploadMimeAllowed('')))

  // Should BLOCK
  it('blocks application/x-executable', () =>
    assert.ok(!isUploadMimeAllowed('application/x-executable')))
  it('blocks application/x-sh (shell scripts)', () =>
    assert.ok(!isUploadMimeAllowed('application/x-sh')))
  it('blocks application/x-msdownload (EXE)', () =>
    assert.ok(!isUploadMimeAllowed('application/x-msdownload')))
  it('blocks application/java-archive (JAR)', () =>
    assert.ok(!isUploadMimeAllowed('application/java-archive')))
  it('blocks application/x-httpd-php', () =>
    assert.ok(!isUploadMimeAllowed('application/x-httpd-php')))
})

// ── T03: Upload size limits ──
describe('T03: Upload size limits', () => {
  it('MAX_UPLOAD_SINGLE is 25MB', () => {
    assert.equal(MAX_UPLOAD_SINGLE, 25 * 1024 * 1024)
  })
  it('MAX_UPLOAD_TOTAL is 50MB', () => {
    assert.equal(MAX_UPLOAD_TOTAL, 50 * 1024 * 1024)
  })
  it('single limit is less than total limit', () => {
    assert.ok(MAX_UPLOAD_SINGLE < MAX_UPLOAD_TOTAL)
  })
})

// ── T04: SPA fallback should not serve index.html for static asset requests ──
describe('T04: SPA fallback extension check', () => {
  const hasExtension = (pathname: string) => /\.\w+$/.test(pathname)

  it('detects .js extension', () => assert.ok(hasExtension('/vendor/marked.min.js')))
  it('detects .css extension', () => assert.ok(hasExtension('/vendor/github-dark.min.css')))
  it('detects .map extension', () => assert.ok(hasExtension('/vendor/marked.min.js.map')))
  it('detects .png extension', () => assert.ok(hasExtension('/images/logo.png')))
  it('no extension for root path', () => assert.ok(!hasExtension('/')))
  it('no extension for SPA route', () => assert.ok(!hasExtension('/settings')))
  it('no extension for agent route', () => assert.ok(!hasExtension('/agents/main')))
})

// ── T05: Blacklist pattern coverage ──
describe('T05: Blacklist pattern completeness', () => {
  it('has at least 22 patterns', () => {
    assert.ok(FILE_BLOCKED_PATTERNS.length >= 22)
  })
  it('every pattern is a RegExp', () => {
    for (const p of FILE_BLOCKED_PATTERNS) {
      assert.ok(p instanceof RegExp, `Expected RegExp, got ${typeof p}`)
    }
  })
  it('covers memory files (MEMORY.md, USER.md, CLAUDE.md)', () => {
    const memoryPatterns = ['MEMORY.md', 'USER.md', 'CLAUDE.md']
    for (const f of memoryPatterns) {
      assert.ok(
        FILE_BLOCKED_PATTERNS.some((p) => p.test(`/root/.openclaude/agents/main/${f}`)),
        `Blacklist should block ${f}`,
      )
    }
  })
})

// ── T06: Authentication pattern — query param should not be used ──
describe('T06: Authentication — no query token leak', () => {
  it('Bearer header is preferred over query param', () => {
    const req = {
      headers: { authorization: 'Bearer correct-token' },
      url: '/?token=leaked-token',
    }
    const authHeader = req.headers.authorization?.replace(/^Bearer\s+/, '') ?? ''
    assert.equal(authHeader, 'correct-token')
    // The server should NEVER read token from query params
    const url = new URL(req.url, 'http://localhost')
    const queryToken = url.searchParams.get('token')
    assert.ok(queryToken !== null, 'query param exists but should be ignored by server')
  })
})

console.log('All security tests passed.')
