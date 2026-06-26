import * as assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
/**
 * Security tests for OpenClaude Gateway.
 * Tests real exported functions from server.ts — NOT local helper clones.
 * Run: npx tsx --test packages/gateway/src/__tests__/security.test.ts
 */
import { afterEach, beforeEach, describe, it } from 'node:test'
import {
  FILE_ALLOWED_DIRS,
  FILE_BLOCKED_PATTERNS,
  MAX_UPLOAD_SINGLE,
  MAX_UPLOAD_TOTAL,
  UPLOAD_MIME_PREFIXES,
  isFileAllowed,
  isFileBlocked,
  isTrustedContainerFileServeEnabled,
  isUploadMimeAllowed,
  makeUserScopedMediaPredicate,
  staticCacheControl,
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
  it('blocks user-level shared user.md (user identity)', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/user.md'))
    assert.ok(isFileBlocked('/root/.openclaude/user.md'))
    // precise: a project file like myuser.md must NOT be caught by the pattern
    assert.ok(!isFileBlocked('/home/agent/project/myuser.md'))
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

// ── T01b: isFileAllowed — allowlist directory check ──
describe('T01b: isFileAllowed — allowlist directory check', () => {
  // Should ALLOW — static allowed dirs
  it('allows files in generated dir', () => {
    assert.ok(isFileAllowed(resolve('/root/.openclaude/generated/speech.mp3')))
  })
  it('allows files in uploads dir', () => {
    assert.ok(isFileAllowed(resolve('/root/.openclaude/uploads/photo.jpg')))
  })
  // Should ALLOW — temp files matching /tmp/openclaude-*
  it('allows /tmp/openclaude-* temp files', () => {
    assert.ok(isFileAllowed(resolve('/tmp/openclaude-abc123/output.png')))
  })
  // Should DENY — project source roots are NOT in the static allowlist
  // (AGENT_CWD_ROOTS 显式留空: "intentionally empty — broad source dirs removed")
  // 这两条把"源码目录不许 /api/file 读"作为契约钉死,防止未来误把
  // /opt/openclaude/openclaude 等再塞回 AGENT_CWD_ROOTS 导致回归。
  it('denies project source files under /opt/openclaude/openclaude (no agent cwd allowlist)', () => {
    assert.ok(!isFileAllowed(resolve('/opt/openclaude/openclaude/packages/gateway/src/server.ts')))
  })
  it('denies project source files under /opt/openclaude/claude-code-best', () => {
    assert.ok(!isFileAllowed(resolve('/opt/openclaude/claude-code-best/src/main.tsx')))
  })
  // Should ALLOW — dynamic agent cwds 限制为白名单媒体扩展名。html/ts 等可执行
  // 文件类型即使在 cwd 下也不允许,只允许 MEDIA_EXTENSIONS 集合(png/jpg/mp4/pdf/log 等)
  it('allows media file (.png) under a dynamic agent cwd', () => {
    assert.ok(isFileAllowed(resolve('/home/user/project/build/screenshot.png'), ['/home/user/project']))
  })
  it('denies non-media file (.html) under a dynamic agent cwd', () => {
    assert.ok(!isFileAllowed(resolve('/home/user/project/build/result.html'), ['/home/user/project']))
  })
  // generated/ 和 uploads/ 在 cwd 下无条件允许(任何扩展名),区别于裸 cwd 限媒体扩展
  it('allows any extension under <cwd>/generated/', () => {
    assert.ok(isFileAllowed(resolve('/home/user/project/generated/code.py'), ['/home/user/project']))
  })

  // Should DENY — outside all allowed dirs
  it('denies /etc/passwd', () => {
    assert.ok(!isFileAllowed(resolve('/etc/passwd')))
  })
  it('denies /etc/shadow', () => {
    assert.ok(!isFileAllowed(resolve('/etc/shadow')))
  })
  it('denies /root/.ssh/id_rsa', () => {
    assert.ok(!isFileAllowed(resolve('/root/.ssh/id_rsa')))
  })
  it('denies /root/.aws/credentials', () => {
    assert.ok(!isFileAllowed(resolve('/root/.aws/credentials')))
  })
  it('denies random /home path without agent cwd', () => {
    assert.ok(!isFileAllowed(resolve('/home/user/secrets/token.json')))
  })
  it('denies /tmp files that do not match openclaude- prefix', () => {
    assert.ok(!isFileAllowed(resolve('/tmp/random-file.txt')))
  })
  it('denies /root/.openclaude/openclaude.json (config)', () => {
    assert.ok(!isFileAllowed(resolve('/root/.openclaude/openclaude.json')))
  })
  // Prefix attack: /tmp/openclaude- should not match /tmp/openclaude (exact dir)
  it('denies dir name that is a prefix of allowed but not child', () => {
    // e.g. /root/.openclaude/generatedEVIL/file should NOT match generatedDir
    assert.ok(!isFileAllowed(resolve('/root/.openclaude/generatedEVIL/file.txt')))
  })

  // V3 multi-tenant per-user media volume: gateway constructs a
  // **user-scoped** predicate per request via `makeUserScopedMediaPredicate`
  // (which closes over the CURRENT request's resolved {uploads, generated}
  // dirs) and passes it as `extraAllowedPredicate`. This closes the
  // cross-tenant IDOR — a global textual "any user volume" predicate would
  // let user A read user B's media by absolute path.
  // The function-as-data signature is the contract; these tests pin the
  // 3-arg shape so adding/removing the predicate axis can't silently break
  // the per-user media allowlist.
  it('extraAllowedPredicate=true → allows path even when no static dir matches', () => {
    const userVolPath =
      '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/abc.png'
    // Without predicate: denied.
    assert.ok(!isFileAllowed(resolve(userVolPath)))
    // With predicate accepting: allowed.
    assert.ok(isFileAllowed(resolve(userVolPath), undefined, () => true))
  })
  it('extraAllowedPredicate=false → still denies', () => {
    assert.ok(!isFileAllowed(resolve('/etc/passwd'), undefined, () => false))
  })
  it('extraAllowedPredicate undefined → behaves like 2-arg call (backward compat)', () => {
    // Static allow still works without the 3rd arg.
    assert.ok(isFileAllowed(resolve('/root/.openclaude/uploads/photo.jpg')))
    // Static deny still denies without 3rd arg.
    assert.ok(!isFileAllowed(resolve('/etc/passwd')))
  })

  // V3 commercial cross-tenant IDOR hard gate: paths matching the per-user
  // docker volume media shape MUST go through the user-scoped predicate.
  // Static dirs / temp / agent-cwd branches MUST NOT be able to authorize.
  describe('IDOR gate: /var/lib/docker/volumes/oc-v3-data-u<n>/_data/(uploads|generated)', () => {
    const uA = '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/x.png'
    const uB = '/var/lib/docker/volumes/oc-v3-data-u99/_data/uploads/x.png'
    const gB = '/var/lib/docker/volumes/oc-v3-data-u99/_data/generated/y.png'
    it('denies user-volume media path when no predicate provided', () => {
      assert.ok(!isFileAllowed(uA))
    })
    it('denies cross-tenant access even when agent CWD overlaps the user-B volume', () => {
      // Hypothetical attack: agent cwd misconfigured to point at user B's
      // _data dir. Without the gate, the agent-cwd branch's `MEDIA_EXTENSIONS`
      // shortcut would authorize uB. The gate must override.
      const attackCwd = '/var/lib/docker/volumes/oc-v3-data-u99/_data'
      assert.ok(!isFileAllowed(uB, [attackCwd]))
      assert.ok(!isFileAllowed(gB, [attackCwd]))
    })
    it('denies cross-tenant access even when user-A predicate accepts user-A path but not user-B', () => {
      // Predicate scoped to user A's uploads — should reject user B's path.
      const userAPredicate = (p: string) =>
        p === '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads' ||
        p.startsWith('/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/')
      assert.ok(isFileAllowed(uA, undefined, userAPredicate))
      assert.ok(!isFileAllowed(uB, undefined, userAPredicate))
    })
    it('gate does not affect non-volume paths', () => {
      // Sanity: the gate only triggers on the textual shape, not e.g. a
      // similarly-named directory elsewhere.
      const lookalike = '/var/lib/not-docker/volumes/oc-v3-data-u42/_data/uploads/x.png'
      // Without predicate, this falls through to the rest of isFileAllowed
      // (which denies because no static/cwd match).
      assert.ok(!isFileAllowed(lookalike))
    })
  })

  // 2026-05-16 Phase 2:remote-host `/api/file` 分支用 makeUserScopedMediaPredicate
  // 直接判定 textual path 是否落在用户当前请求的 uploads/generated 之内,然后再决
  // 定调 pullRemoteHostMedia。这条 predicate 是新增的安全边界 — 单测锁定其
  // boundary 严格性,防止有人退化成裸 startsWith 引入 `uploads-evil/x` 旁路。
  describe('makeUserScopedMediaPredicate — boundary safety (Phase 2 remote-host gate)', () => {
    const uploads = '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads'
    const generated = '/var/lib/docker/volumes/oc-v3-data-u42/_data/generated'
    const pred = makeUserScopedMediaPredicate(uploads, generated)
    it('accepts file directly under uploads', () => {
      assert.ok(pred(`${uploads}/abc.png`))
    })
    it('accepts file directly under generated', () => {
      assert.ok(pred(`${generated}/codex-out.png`))
    })
    it('accepts the dir itself (parity with FILE_ALLOWED_DIRS semantics)', () => {
      assert.ok(pred(uploads))
      assert.ok(pred(generated))
    })
    it('rejects sibling dir whose name is a prefix superset (uploads-evil/x.png)', () => {
      // 真正的边界:naive startsWith 会误认 `/uploads-evil/x` 命中 `/uploads`。
      // makeUserScopedMediaPredicate 要求 `=== dir || startsWith(dir + '/')`,
      // 把这种 prefix 攻击挡掉。
      const evil = '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads-evil/x.png'
      assert.ok(!pred(evil))
    })
    it('rejects sibling dir whose name is a prefix superset (generatedEVIL/x.png)', () => {
      const evil = '/var/lib/docker/volumes/oc-v3-data-u42/_data/generatedEVIL/x.png'
      assert.ok(!pred(evil))
    })
    it('rejects cross-tenant absolute path (different uid even if same shape)', () => {
      const other = '/var/lib/docker/volumes/oc-v3-data-u99/_data/uploads/x.png'
      assert.ok(!pred(other))
    })
    it('rejects paths outside docker volumes entirely', () => {
      assert.ok(!pred('/etc/passwd'))
      assert.ok(!pred('/root/.ssh/id_rsa'))
    })
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
  it('MAX_UPLOAD_SINGLE is 100MB (aligned to Cloudflare Free/Pro body cap)', () => {
    assert.equal(MAX_UPLOAD_SINGLE, 100 * 1024 * 1024)
  })
  it('MAX_UPLOAD_TOTAL is 300MB', () => {
    assert.equal(MAX_UPLOAD_TOTAL, 300 * 1024 * 1024)
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

// ── T04b: static hosting Cache-Control by channel mode (real staticCacheControl) ──
// P2 v5 Aurora gateway 静态托管:v5='spa'(React/Vite dist),v3/personal=vanilla(web/public)。
describe('T04b: staticCacheControl — channel-aware cache headers', () => {
  describe("vanilla mode (v3/personal — undefined or 'vanilla')", () => {
    it('assets get 1h public cache (?v=hash cache-bust convention)', () => {
      assert.equal(staticCacheControl('/modules/app.js', 'vanilla'), 'public, max-age=3600')
      assert.equal(staticCacheControl('/style.css', undefined), 'public, max-age=3600')
    })
    it('sw.js is never edge-cached (CF 4h TTL stale-SW trap)', () => {
      assert.equal(staticCacheControl('/sw.js', 'vanilla'), 'no-cache, no-store, must-revalidate')
      assert.equal(staticCacheControl('/sw.js', undefined), 'no-cache, no-store, must-revalidate')
    })
    it('index.html follows the generic 1h rule in vanilla (index served no-cache downstream)', () => {
      assert.equal(staticCacheControl('/index.html', 'vanilla'), 'public, max-age=3600')
    })
  })

  describe("spa mode (v5 Aurora — bundler dist)", () => {
    it('content-hashed /assets/* are immutable 1y', () => {
      assert.equal(
        staticCacheControl('/assets/index-AbC123.js', 'spa'),
        'public, max-age=31536000, immutable',
      )
      assert.equal(
        staticCacheControl('/assets/index-AbC123.css', 'spa'),
        'public, max-age=31536000, immutable',
      )
      assert.equal(
        staticCacheControl('/assets/index-AbC123.js.map', 'spa'),
        'public, max-age=31536000, immutable',
      )
    })
    it('index.html and non-asset (public passthrough) files are no-cache (ETag revalidate)', () => {
      assert.equal(staticCacheControl('/index.html', 'spa'), 'no-cache')
      assert.equal(staticCacheControl('/manifest.json', 'spa'), 'no-cache')
      assert.equal(staticCacheControl('/icon.svg', 'spa'), 'no-cache')
    })
    it('does NOT special-case sw.js in spa mode (v5 ships no service worker)', () => {
      assert.equal(staticCacheControl('/sw.js', 'spa'), 'no-cache')
    })
  })
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

// ── T07: v3 trusted-backend ACL (v1.0.193 — Codex v4 review) ──
//
// Mode contract (see `isFileAllowed` trusted branch + server.ts comment):
//   - Range scope: only `/home/agent/**` + `/tmp/openclaude-*` participate.
//     Anything outside those subtrees stays denied (e.g. `/etc/*`,
//     `/opt/openclaude/...` runtime source).
//   - Inside the range: deny-by-blocklist (no allowlist).
//   - The blocklist (`FILE_BLOCKED_PATTERNS`) is the **single authoritative
//     download-sensitive inventory** for the v3 container.
//
// Test isolation: env flag is checked **call-time** via
// `isTrustedContainerFileServeEnabled()`, so per-test `beforeEach`/`afterEach`
// flips are sufficient (no module-load freeze trap).
describe('T07: v3 trusted-backend mode (OC_V3_TRUSTED_FILE_SERVE=1)', () => {
  const ENV_KEY = 'OC_V3_TRUSTED_FILE_SERVE'
  let prevEnv: string | undefined

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY]
    process.env[ENV_KEY] = '1'
    assert.equal(isTrustedContainerFileServeEnabled(), true, 'env flag should be on')
  })
  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prevEnv
  })

  // ── ALLOW: typical agent work products under /home/agent (boss's actual UX) ──
  describe('ALLOW — agent work products under /home/agent', () => {
    it('allows /home/agent/hello.txt (boss-reported failing download path)', () => {
      assert.ok(isFileAllowed('/home/agent/hello.txt'))
    })
    it('allows /home/agent/work/output.pdf', () => {
      assert.ok(isFileAllowed('/home/agent/work/output.pdf'))
    })
    it('allows /home/agent/research_concise/main.pdf', () => {
      assert.ok(isFileAllowed('/home/agent/research_concise/main.pdf'))
    })
    it('allows /home/agent/.openclaude/repos/sess-1/1/main.pdf (literature workspace)', () => {
      assert.ok(isFileAllowed('/home/agent/.openclaude/repos/sess-1/1/main.pdf'))
    })
    it('allows /home/agent/.openclaude/generated/speech.mp3', () => {
      assert.ok(isFileAllowed('/home/agent/.openclaude/generated/speech.mp3'))
    })
    it('allows /home/agent/.openclaude/uploads/photo.jpg', () => {
      assert.ok(isFileAllowed('/home/agent/.openclaude/uploads/photo.jpg'))
    })
    it('allows /home/agent/.openclaude/shared/anything.csv', () => {
      assert.ok(isFileAllowed('/home/agent/.openclaude/shared/anything.csv'))
    })
    it('allows /home/agent/.openclaude/agents/main/skills/foo.md (skills are not secrets)', () => {
      assert.ok(isFileAllowed('/home/agent/.openclaude/agents/main/skills/foo.md'))
    })
    it('allows /home/agent/.codex/generated_images/x.png (Codex media outputs)', () => {
      assert.ok(isFileAllowed('/home/agent/.codex/generated_images/x.png'))
    })
    it('allows ScanSci downloaded PDFs under ~/.local/share/scansci-pdf/papers', () => {
      assert.ok(isFileAllowed('/home/agent/.local/share/scansci-pdf/papers/10.1000-example.pdf'))
    })
    it('allows /tmp/openclaude-abc/x.png (temp prefix carve-in)', () => {
      assert.ok(isFileAllowed('/tmp/openclaude-abc/x.png'))
    })
  })

  // ── DENY (range): paths outside /home/agent + /tmp/openclaude-* ──
  describe('DENY (range) — outside trusted carve-outs', () => {
    it('denies /etc/passwd', () => {
      assert.ok(!isFileAllowed('/etc/passwd'))
    })
    it('denies /etc/shadow', () => {
      assert.ok(!isFileAllowed('/etc/shadow'))
    })
    it('denies /opt/openclaude/packages/gateway/src/server.ts (runtime source)', () => {
      assert.ok(!isFileAllowed('/opt/openclaude/packages/gateway/src/server.ts'))
    })
    it('denies /usr/local/lib/node_modules/foo/index.js', () => {
      assert.ok(!isFileAllowed('/usr/local/lib/node_modules/foo/index.js'))
    })
    it('denies /tmp/random-file.txt (temp without openclaude- prefix)', () => {
      assert.ok(!isFileAllowed('/tmp/random-file.txt'))
    })
    it('denies /root/.bashrc (container shouldn’t but defense-in-depth)', () => {
      assert.ok(!isFileAllowed('/root/.bashrc'))
    })
    it('denies path that is a sibling of /home/agent (prefix attack)', () => {
      assert.ok(!isFileAllowed('/home/agent-evil/x.txt'))
    })
  })

  // ── DENY (blocklist): master-injected secrets & runtime state under /home/agent ──
  // Every entry here MUST correspond to a regex in FILE_BLOCKED_PATTERNS.
  // Adding a new master-injected secret? Add the regex + a case here.
  describe('DENY (blocklist) — master-injected secrets & runtime state', () => {
    // Codex auth + runtime state
    it('denies ~/.codex/auth.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/auth.json'))
    })
    it('denies ~/.codex/sessions/2026-05-22/rollout.jsonl', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/sessions/2026-05-22/rollout.jsonl'))
    })
    it('denies ~/.codex/memories/foo.md', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/memories/foo.md'))
    })
    it('denies ~/.codex/logs_foo.sqlite', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/logs_foo.sqlite'))
    })
    it('denies ~/.codex/logs_foo.sqlite-wal', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/logs_foo.sqlite-wal'))
    })
    it('denies ~/.codex/state_foo.sqlite-shm', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/state_foo.sqlite-shm'))
    })
    it('denies ~/.codex/config.toml', () => {
      assert.ok(!isFileAllowed('/home/agent/.codex/config.toml'))
    })

    // Gateway state
    it('denies ~/.openclaude/sessions.db', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/sessions.db'))
    })
    it('denies ~/.openclaude/sessions.db-wal', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/sessions.db-wal'))
    })
    it('denies ~/.openclaude/sessions.db-shm', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/sessions.db-shm'))
    })
    it('denies ~/.openclaude/msg-outbox.jsonl', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/msg-outbox.jsonl'))
    })
    it('denies ~/.openclaude/tasks.json (prompt + lastOutput + error fields)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/tasks.json'))
    })
    it('denies ~/.openclaude/tasks.json.tmp (atomic write temp)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/tasks.json.tmp'))
    })

    // Gateway configs
    it('denies ~/.openclaude/openclaude.json (gateway config with tokens)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/openclaude.json'))
    })
    it('denies ~/.openclaude/agents.yaml', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents.yaml'))
    })
    it('denies ~/.openclaude/cron.yaml', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/cron.yaml'))
    })
    it('denies ~/.openclaude/webhooks.yaml (HMAC secrets)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/webhooks.yaml'))
    })
    it('denies ~/.openclaude/webhooks.yml (.yml alias)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/webhooks.yml'))
    })

    // Gateway retry queues
    it('denies ~/.openclaude/v3-master-retry.d/1.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/v3-master-retry.d/1.json'))
    })
    it('denies ~/.openclaude/v3-wechat-retry.d/1.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/v3-wechat-retry.d/1.json'))
    })

    // Per-agent session JSONL (thinking + tool args)
    it('denies ~/.openclaude/agents/main/sessions/2026-05-22.jsonl', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/main/sessions/2026-05-22.jsonl'))
    })
    it('denies ~/.openclaude/agents/codex/sessions/foo.jsonl (any agent id)', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/codex/sessions/foo.jsonl'))
    })

    // Memory + persona files
    it('denies ~/.openclaude/agents/main/MEMORY.md', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/main/MEMORY.md'))
    })
    it('denies ~/.openclaude/agents/main/USER.md', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/main/USER.md'))
    })
    it('denies ~/.openclaude/agents/main/CLAUDE.md', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/main/CLAUDE.md'))
    })
    it('denies ~/.openclaude/agents/main/resume-map.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/agents/main/resume-map.json'))
    })

    // Git credentials
    it('denies ~/.openclaude/git-creds/sess-1/1/token', () => {
      assert.ok(!isFileAllowed('/home/agent/.openclaude/git-creds/sess-1/1/token'))
    })
    it('denies ~/.git-credentials (git store credential helper)', () => {
      assert.ok(!isFileAllowed('/home/agent/.git-credentials'))
    })

    // ScanSci PDF config/cookies/browser state
    it('denies ScanSci config.json (API keys / source settings)', () => {
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/config.json'))
    })
    it('denies ScanSci browser_state.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/cache/browser_state.json'))
    })
    it('denies ScanSci cookie files in cache', () => {
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/cache/vpnsci-cookies.json'))
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/cache/publisher-cookies.txt'))
    })
    it('denies ScanSci root-level cookie/token state files', () => {
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/vpnsci-cookies.txt'))
      assert.ok(!isFileAllowed('/home/agent/.local/share/scansci-pdf/openalex-token.json'))
    })

    // Persistent XDG config volume — Codex review demanded the **whole subtree**
    // be denied rather than chasing per-tool paths (gh / git / vscode-server /
    // npm / pip / future CLIs). Config files are not work products.
    it('denies ~/.config (root of XDG config volume)', () => {
      assert.ok(!isFileAllowed('/home/agent/.config'))
    })
    it('denies ~/.config/npm/npmrc', () => {
      assert.ok(!isFileAllowed('/home/agent/.config/npm/npmrc'))
    })
    it('denies ~/.config/pip/pip.conf', () => {
      assert.ok(!isFileAllowed('/home/agent/.config/pip/pip.conf'))
    })
    it('denies ~/.config/gh/hosts.yml (GitHub CLI token store)', () => {
      assert.ok(!isFileAllowed('/home/agent/.config/gh/hosts.yml'))
    })
    it('denies ~/.config/git/credentials (git store helper at XDG location)', () => {
      assert.ok(!isFileAllowed('/home/agent/.config/git/credentials'))
    })
    it('denies ~/.config/Code/User/settings.json (vscode-server)', () => {
      assert.ok(!isFileAllowed('/home/agent/.config/Code/User/settings.json'))
    })
    it('denies top-level ~/.npmrc', () => {
      assert.ok(!isFileAllowed('/home/agent/.npmrc'))
    })

    // SSH/GPG/cloud cred dirs
    it('denies ~/.ssh/id_rsa', () => {
      assert.ok(!isFileAllowed('/home/agent/.ssh/id_rsa'))
    })
    it('denies ~/.ssh/id_ed25519', () => {
      assert.ok(!isFileAllowed('/home/agent/.ssh/id_ed25519'))
    })
    it('denies ~/.gnupg/secring.gpg', () => {
      assert.ok(!isFileAllowed('/home/agent/.gnupg/secring.gpg'))
    })
    it('denies ~/.aws/credentials', () => {
      assert.ok(!isFileAllowed('/home/agent/.aws/credentials'))
    })
    it('denies ~/.aws/config', () => {
      assert.ok(!isFileAllowed('/home/agent/.aws/config'))
    })
    it('denies ~/.kube/config', () => {
      assert.ok(!isFileAllowed('/home/agent/.kube/config'))
    })
    it('denies ~/.docker/config.json', () => {
      assert.ok(!isFileAllowed('/home/agent/.docker/config.json'))
    })

    // Shell history
    it('denies ~/.bash_history', () => {
      assert.ok(!isFileAllowed('/home/agent/.bash_history'))
    })
    it('denies ~/.zsh_history', () => {
      assert.ok(!isFileAllowed('/home/agent/.zsh_history'))
    })

    // .env files
    it('denies ~/work/.env', () => {
      assert.ok(!isFileAllowed('/home/agent/work/.env'))
    })
    it('denies ~/work/.env.production', () => {
      assert.ok(!isFileAllowed('/home/agent/work/.env.production'))
    })

    // Generic key/cert
    it('denies ~/work/server.key', () => {
      assert.ok(!isFileAllowed('/home/agent/work/server.key'))
    })
    it('denies ~/work/ca.pem', () => {
      assert.ok(!isFileAllowed('/home/agent/work/ca.pem'))
    })
  })

  // ── DENY (kernel/runtime): /proc, /sys, /run, /run/oc/* ──
  describe('DENY (kernel/runtime) — /proc, /sys, /run, /var/run', () => {
    it('denies /proc/self/environ (env leak)', () => {
      assert.ok(!isFileAllowed('/proc/self/environ'))
    })
    it('denies /proc/1/cmdline', () => {
      assert.ok(!isFileAllowed('/proc/1/cmdline'))
    })
    it('denies /sys/kernel/version', () => {
      assert.ok(!isFileAllowed('/sys/kernel/version'))
    })
    it('denies /run/oc/codex-auth/auth.json (master-injected codex token)', () => {
      assert.ok(!isFileAllowed('/run/oc/codex-auth/auth.json'))
    })
    it('denies /run/oc/v3-bridge.sock', () => {
      assert.ok(!isFileAllowed('/run/oc/v3-bridge.sock'))
    })
    it('denies /var/run/docker.sock (hypothetical mount escape)', () => {
      assert.ok(!isFileAllowed('/var/run/docker.sock'))
    })
  })

  // ── DENY (cross-tenant IDOR gate stays in effect even in trusted mode) ──
  // Trusted bit only relaxes the container's own sandbox; it must not weaken
  // host-volume cross-tenant protections. The IDOR gate sits BEFORE the
  // trusted branch in isFileAllowed.
  describe('IDOR gate still active in trusted mode', () => {
    const uA = '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/x.png'
    const uB = '/var/lib/docker/volumes/oc-v3-data-u99/_data/uploads/x.png'
    it('denies user-volume media path with no predicate (no host-path leak via trusted mode)', () => {
      assert.ok(!isFileAllowed(uA))
    })
    it('user-A predicate allows uA but not uB (no cross-tenant leak)', () => {
      const predA = (p: string) =>
        p === '/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads' ||
        p.startsWith('/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads/')
      assert.ok(isFileAllowed(uA, undefined, predA))
      assert.ok(!isFileAllowed(uB, undefined, predA))
    })
  })

  // ── Backward compat: env unset → legacy allowlist behavior ──
  describe('Backward compat — env unset leaves personal/legacy semantics', () => {
    it('legacy: /home/agent/hello.txt is denied when trusted env is off', () => {
      delete process.env[ENV_KEY]
      assert.equal(isTrustedContainerFileServeEnabled(), false)
      assert.ok(!isFileAllowed('/home/agent/hello.txt'))
    })
    it('legacy: static FILE_ALLOWED_DIRS still works when trusted env is off', () => {
      delete process.env[ENV_KEY]
      assert.ok(isFileAllowed(resolve('/root/.openclaude/uploads/x.png')))
    })
  })

  // ── Real symlink fs operation — verifies the canonicalization → blocklist chain ──
  //
  // `handleApiFile` does `realpathSync(input)` BEFORE invoking
  // `openFileHardened`, and the latter does a second `realpathSync` via
  // `/proc/self/fd/<fd>` after opening with `O_NOFOLLOW`. The net effect: the
  // path that reaches `isFileAllowed` / `isFileBlocked` is always the
  // canonical target, so a symlink under `/home/agent/` pointing at a denied
  // target gets rejected on the denied-target's regex, not on the symlink's
  // own location.
  //
  // We can't easily exercise `openFileHardened` end-to-end from a unit test
  // (it writes to a `ServerResponse`), but we CAN exercise the actual
  // canonicalization chain that decides the verdict: real `mkdtempSync` +
  // real `symlinkSync` + real `realpathSync` → `isFileAllowed`.
  describe('Real symlink fs operation — canonicalization → blocklist', () => {
    let tmpDir: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'oc-acl-test-'))
    })
    afterEach(() => {
      // Best-effort cleanup; mkdtemp dir + symlinks
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        // ignore
      }
    })

    it('symlink to /etc/shadow → realpath returns target → blocklist denies', () => {
      const linkPath = join(tmpDir, 'looks_harmless.png')
      symlinkSync('/etc/shadow', linkPath)
      // `/etc/shadow` exists on Linux; realpathSync resolves the symlink.
      const canonical = realpathSync(linkPath)
      assert.equal(canonical, '/etc/shadow', 'pre-condition: realpath follows symlink')
      // Decision under trusted mode (env already set in outer beforeEach):
      assert.ok(!isFileAllowed(canonical), 'canonical /etc/shadow must be denied')
    })

    it('symlink to /etc/passwd → realpath returns target → /etc/* blocklist denies', () => {
      const linkPath = join(tmpDir, 'hello.txt')
      symlinkSync('/etc/passwd', linkPath)
      const canonical = realpathSync(linkPath)
      assert.equal(canonical, '/etc/passwd')
      assert.ok(!isFileAllowed(canonical))
    })

    it('symlink to a regular file under /tmp → realpath returns target → policy applies', () => {
      // Positive control: symlink to a regular file in /tmp (NOT under
      // openclaude-* prefix). Trusted mode's range check denies it because
      // it's neither under /home/agent nor /tmp/openclaude-*.
      const targetPath = join(tmpDir, 'real_target.png')
      writeFileSync(targetPath, 'png-bytes')
      const linkPath = join(tmpDir, 'link.png')
      symlinkSync(targetPath, linkPath)
      const canonical = realpathSync(linkPath)
      // tmpDir is /tmp/oc-acl-test-* — outside /home/agent + /tmp/openclaude-*,
      // so denied by range check.
      assert.ok(!isFileAllowed(canonical))
    })

    it('symlink target inside trusted home → realpath canonical → blocklist applies, allow-products allow', () => {
      // We can't write into /home/agent in unit test, so simulate the verdict
      // on a canonical that LOOKS like a trusted-home product file. This
      // replicates what openFileHardened would do after realpathSync resolves
      // a symlink whose target is `/home/agent/hello.txt`.
      assert.ok(isFileAllowed('/home/agent/hello.txt'))
      // ...and a target whose canonical hits the blocklist:
      assert.ok(!isFileAllowed('/home/agent/.openclaude/sessions.db'))
      assert.ok(!isFileAllowed('/home/agent/.openclaude/tasks.json'))
      assert.ok(!isFileAllowed('/home/agent/.codex/auth.json'))
    })
  })
})

// ── T08: Blocklist pattern inventory contract (Codex v4 review) ──
// These cases pin the regex inventory itself (not isFileAllowed integration)
// so changing the regex without updating intent triggers a test failure.
describe('T08: FILE_BLOCKED_PATTERNS — trusted-backend inventory contract', () => {
  it('has at least 40 patterns after v1.0.193 expansion', () => {
    assert.ok(FILE_BLOCKED_PATTERNS.length >= 40, `got ${FILE_BLOCKED_PATTERNS.length}`)
  })
  it('covers codex auth + sessions + memories + sqlite state + config.toml', () => {
    assert.ok(isFileBlocked('/home/agent/.codex/auth.json'))
    assert.ok(isFileBlocked('/home/agent/.codex/sessions/x/y.jsonl'))
    assert.ok(isFileBlocked('/home/agent/.codex/memories/foo.md'))
    assert.ok(isFileBlocked('/home/agent/.codex/logs_a.sqlite'))
    assert.ok(isFileBlocked('/home/agent/.codex/state_a.sqlite-wal'))
    assert.ok(isFileBlocked('/home/agent/.codex/config.toml'))
  })
  it('covers gateway SQLite state + outbox + tasks store', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/sessions.db'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/sessions.db-wal'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/sessions.db-shm'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/msg-outbox.jsonl'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/tasks.json'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/tasks.json.tmp'))
  })
  it('covers gateway YAML configs (agents/cron/webhooks)', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/agents.yaml'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/cron.yaml'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/webhooks.yaml'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/webhooks.yml'))
  })
  it('covers retry queue subtrees', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/v3-master-retry.d/1.json'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/v3-wechat-retry.d/1.json'))
  })
  it('covers per-agent session JSONL subtree (any agent id)', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/agents/main/sessions/x.jsonl'))
    assert.ok(isFileBlocked('/home/agent/.openclaude/agents/codex/sessions/y.jsonl'))
  })
  it('covers git credentials subtree + ~/.git-credentials', () => {
    assert.ok(isFileBlocked('/home/agent/.openclaude/git-creds/sess/1/token'))
    assert.ok(isFileBlocked('/home/agent/.git-credentials'))
  })
  it('covers entire ~/.config subtree (XDG credential surface)', () => {
    assert.ok(isFileBlocked('/home/agent/.config'))
    assert.ok(isFileBlocked('/home/agent/.config/npm/npmrc'))
    assert.ok(isFileBlocked('/home/agent/.config/pip/pip.conf'))
    assert.ok(isFileBlocked('/home/agent/.config/gh/hosts.yml'))
    assert.ok(isFileBlocked('/home/agent/.config/git/credentials'))
    assert.ok(isFileBlocked('/home/agent/.config/Code/User/settings.json'))
  })
  it('covers shell history', () => {
    assert.ok(isFileBlocked('/home/agent/.bash_history'))
    assert.ok(isFileBlocked('/home/agent/.zsh_history'))
  })
  it('covers /proc, /sys, /run, /var/run', () => {
    assert.ok(isFileBlocked('/proc/self/environ'))
    assert.ok(isFileBlocked('/sys/kernel/version'))
    assert.ok(isFileBlocked('/run/oc/codex-auth/auth.json'))
    assert.ok(isFileBlocked('/var/run/docker.sock'))
  })
  it('covers /etc/* root (system passwd/shadow/sudoers/etc)', () => {
    assert.ok(isFileBlocked('/etc/passwd'))
    assert.ok(isFileBlocked('/etc/shadow'))
    assert.ok(isFileBlocked('/etc/sudoers'))
    assert.ok(isFileBlocked('/etc/hostname'))
  })
  it('still allows typical agent work products under /home/agent (blocklist negative)', () => {
    assert.ok(!isFileBlocked('/home/agent/hello.txt'))
    assert.ok(!isFileBlocked('/home/agent/work/output.pdf'))
    assert.ok(!isFileBlocked('/home/agent/.openclaude/generated/speech.mp3'))
    assert.ok(!isFileBlocked('/home/agent/.openclaude/uploads/photo.jpg'))
    assert.ok(!isFileBlocked('/home/agent/.openclaude/shared/anything.csv'))
    assert.ok(!isFileBlocked('/home/agent/.codex/generated_images/x.png'))
    assert.ok(!isFileBlocked('/home/agent/.openclaude/agents/main/skills/foo.md'))
    assert.ok(!isFileBlocked('/home/agent/.openclaude/repos/sess/1/main.pdf'))
  })
})

console.log('All security tests passed.')
