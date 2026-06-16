import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import type { WebSocket } from 'ws'

import {
  CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  ClaudeTerminalForbiddenError,
  ClaudeTerminalManager,
  type ClaudeTerminalManagerOptions,
  buildOfficialClaudeArgs,
  buildOfficialClaudeEnv,
  clampTerminalSize,
  isAllowedClaudeTerminalOrigin,
  isClaudeTerminalEnabled,
  isValidClaudeSessionId,
  listClaudeSessions,
  resolveClaudeTerminalUserIdForAuth,
  resolveDetachedTerminalTtlMs,
  resolveMaxSessionsPerUser,
  resolveOfficialClaudeCwd,
} from '../claudeTerminal.js'
import { ClaudeTerminalOwners } from '../claudeTerminalOwners.js'
import type { Logger } from '../logger.js'

const SERVER_SRC = readFileSync(resolve(import.meta.dirname, '..', 'server.ts'), 'utf-8')

const BASE_ARGS = ['--permission-mode', 'bypassPermissions', '--dangerously-skip-permissions']

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

// Every manager gets a unique throwaway registry path so tests never touch the
// real ~/.openclaude/cc-terminal-owners.json.
const OWNERS_DIR = mkdtempSync(join(tmpdir(), 'oc-cc-owners-'))
let ownersCounter = 0
function freshOwnersPath(): string {
  return join(OWNERS_DIR, `owners-${ownersCounter++}.json`)
}

function makeManager(args: {
  env: NodeJS.ProcessEnv
  spawn?: ClaudeTerminalManagerOptions['spawn']
  ownersPath?: string
}): ClaudeTerminalManager {
  return new ClaudeTerminalManager({
    logger,
    ownersPath: args.ownersPath ?? freshOwnersPath(),
    env: args.env,
    spawn: args.spawn,
  })
}

class FakeWs extends EventEmitter {
  readyState = 1
  sent: unknown[] = []
  closes: Array<{ code?: number; reason?: string }> = []

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason })
    this.readyState = 3
    this.emit('close')
  }
}

class FakePty {
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  kills: string[] = []
  private readonly dataEmitter = new EventEmitter()
  private readonly exitEmitter = new EventEmitter()

  write(data: string) {
    this.writes.push(data)
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows })
  }

  kill(signal = 'SIGHUP') {
    this.kills.push(signal)
  }

  onData(callback: (data: string) => void) {
    this.dataEmitter.on('data', callback)
    return { dispose: () => this.dataEmitter.off('data', callback) }
  }

  onExit(callback: (event: { exitCode?: number; signal?: number | string }) => void) {
    this.exitEmitter.on('exit', callback)
    return { dispose: () => this.exitEmitter.off('exit', callback) }
  }

  emitData(data: string) {
    this.dataEmitter.emit('data', data)
  }

  emitExit(exitCode: number | undefined, signal?: number | string) {
    this.exitEmitter.emit('exit', { exitCode, signal })
  }
}

function asWs(ws: FakeWs): WebSocket {
  return ws as unknown as WebSocket
}

function messages(ws: FakeWs): Array<Record<string, unknown>> {
  return ws.sent as Array<Record<string, unknown>>
}

// The id the server assigned to the session the socket is attached to.
function runningSessionId(ws: FakeWs): string {
  const status = messages(ws).find((m) => m.type === 'status' && m.state === 'running')
  return String((status as { sessionId?: unknown } | undefined)?.sessionId ?? '')
}

describe('official Claude terminal helpers', () => {
  test('env switch defaults on and accepts explicit disabled values', () => {
    assert.equal(isClaudeTerminalEnabled({}), true)
    assert.equal(isClaudeTerminalEnabled({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL: '0' }), false)
    assert.equal(isClaudeTerminalEnabled({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL: 'off' }), false)
    assert.equal(isClaudeTerminalEnabled({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL: '1' }), true)
  })

  test('default cwd is the server user home, not the canonical repository checkout', () => {
    assert.equal(resolveOfficialClaudeCwd({}), homedir())
    assert.notEqual(resolveOfficialClaudeCwd({}), '/opt/openclaude/openclaude')
  })

  test('builds a whitelist env and strips Anthropic/OpenClaude secrets', () => {
    const env = buildOfficialClaudeEnv({
      HOME: '/home/tester',
      PATH: '/usr/bin',
      TERM: 'screen-256color',
      SHELL: '/bin/zsh',
      LANG: 'en_US.UTF-8',
      HTTPS_PROXY: 'http://proxy.example:8080',
      ALL_PROXY: 'socks5://proxy.example:1080',
      ANTHROPIC_API_KEY: 'secret-anthropic',
      CLAUDE_CODE_OAUTH_TOKEN: 'secret-claude',
      OPENCLAUDE_GATEWAY_TOKEN: 'secret-openclaude',
    })

    assert.equal(env.HOME, '/home/tester')
    assert.equal(env.TERM, 'screen-256color')
    assert.equal(env.SHELL, '/bin/zsh')
    assert.equal(env.LANG, 'en_US.UTF-8')
    assert.equal(env.HTTPS_PROXY, 'http://proxy.example:8080')
    assert.equal(env.ALL_PROXY, 'socks5://proxy.example:1080')
    assert.equal(env.IS_SANDBOX, '1')
    assert.equal(env.PATH.startsWith('/home/tester/.local/bin:'), true)
    assert.equal('ANTHROPIC_API_KEY' in env, false)
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
    assert.equal('OPENCLAUDE_GATEWAY_TOKEN' in env, false)
  })

  test('builds full-permission Claude Code terminal args by default', () => {
    assert.deepEqual(buildOfficialClaudeArgs(), BASE_ARGS)
  })

  test('clamps terminal dimensions and detached ttl override', () => {
    assert.deepEqual(clampTerminalSize(999, 999), { cols: 240, rows: 80 })
    assert.deepEqual(clampTerminalSize(1, 1), { cols: 20, rows: 5 })
    assert.deepEqual(clampTerminalSize('bad', Number.NaN), { cols: 100, rows: 30 })
    assert.equal(
      resolveDetachedTerminalTtlMs({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_DETACHED_TTL_MS: '0' }),
      0,
    )
    assert.equal(
      resolveDetachedTerminalTtlMs({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_DETACHED_TTL_MS: 'bad' }),
      6 * 60 * 60_000,
    )
  })

  test('resolveMaxSessionsPerUser defaults to 5 and clamps invalid overrides', () => {
    assert.equal(resolveMaxSessionsPerUser({}), 5)
    assert.equal(
      resolveMaxSessionsPerUser({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_MAX_SESSIONS: '3' }),
      3,
    )
    assert.equal(
      resolveMaxSessionsPerUser({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_MAX_SESSIONS: '0' }),
      5,
    )
    assert.equal(
      resolveMaxSessionsPerUser({ OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_MAX_SESSIONS: 'bad' }),
      5,
    )
  })

  test('allows no-origin websocket clients but rejects cross-origin browsers', () => {
    assert.equal(isAllowedClaudeTerminalOrigin(undefined, '127.0.0.1:18790', 'http:'), true)
    assert.equal(
      isAllowedClaudeTerminalOrigin('https://openclaude.example', 'openclaude.example', 'https:'),
      true,
    )
    assert.equal(
      isAllowedClaudeTerminalOrigin('https://evil.example', 'openclaude.example', 'https:'),
      false,
    )
    assert.equal(
      isAllowedClaudeTerminalOrigin('http://openclaude.example', 'openclaude.example', 'https:'),
      false,
    )
  })

  test('requires a user-scoped JWT principal for terminal auth in multi-user mode', () => {
    assert.equal(
      resolveClaudeTerminalUserIdForAuth({
        jwtUserId: 'dx1',
        jwtUserAllowed: true,
        rawTokenValid: false,
        hasConfiguredUsers: true,
      }),
      'dx1',
    )
    assert.equal(
      resolveClaudeTerminalUserIdForAuth({
        jwtUserId: 'default',
        jwtUserAllowed: false,
        rawTokenValid: false,
        hasConfiguredUsers: true,
      }),
      null,
    )
    assert.equal(
      resolveClaudeTerminalUserIdForAuth({
        jwtUserId: null,
        jwtUserAllowed: false,
        rawTokenValid: true,
        hasConfiguredUsers: false,
      }),
      'default',
    )
    assert.equal(
      resolveClaudeTerminalUserIdForAuth({
        jwtUserId: null,
        jwtUserAllowed: false,
        rawTokenValid: true,
        hasConfiguredUsers: true,
      }),
      null,
    )
    assert.equal(
      resolveClaudeTerminalUserIdForAuth({
        jwtUserId: null,
        jwtUserAllowed: false,
        rawTokenValid: false,
        hasConfiguredUsers: false,
      }),
      null,
    )
  })
})

describe('ClaudeTerminalManager lifecycle', () => {
  test('server exposes an authenticated, session-scoped HTTP terminate route', () => {
    assert.match(SERVER_SRC, /url\.pathname === '\/api\/claude-terminal\/terminate'/)
    assert.match(SERVER_SRC, /req\.method !== 'POST'/)
    assert.match(SERVER_SRC, /const userId = this\.getClaudeTerminalUserId\(req\)/)
    assert.match(SERVER_SRC, /claudeTerminal\?\.terminate\(userId, sessionId\)/)
  })

  test('server exposes an ownership-checked DELETE route for sessions', () => {
    assert.match(SERVER_SRC, /url\.pathname === '\/api\/claude-terminal\/session'/)
    assert.match(SERVER_SRC, /req\.method !== 'DELETE'/)
    assert.match(SERVER_SRC, /claudeTerminal\?\.deleteSession\(userId, sessionId\)/)
    assert.match(SERVER_SRC, /ClaudeTerminalForbiddenError[\s\S]*sendError\(res, 403/)
  })

  test('server lists sessions scoped to the requesting user', () => {
    assert.match(SERVER_SRC, /listClaudeSessions\(\{/)
    assert.match(SERVER_SRC, /ownerOf: \(id\) => manager\.ownerOf\(id\)/)
    assert.match(SERVER_SRC, /liveIds: manager\.liveSessionIds\(userId\)/)
  })

  test('server exposes narrow path-bound tickets for browser terminal downloads', () => {
    assert.match(SERVER_SRC, /const TERMINAL_DOWNLOAD_TICKET_TTL_MS = 5 \* 60_000/)
    assert.match(
      SERVER_SRC,
      /private _terminalDownloadTickets = new Map<string, TerminalDownloadTicketState>\(\)/,
    )
    assert.match(SERVER_SRC, /url\.pathname === '\/api\/claude-terminal\/download-ticket'/)
    assert.match(SERVER_SRC, /randomBytes\(32\)\.toString\('base64url'\)/)
    assert.match(SERVER_SRC, /entry\.path !== rawPath/)
    assert.match(
      SERVER_SRC,
      /url\.pathname === '\/api\/claude-terminal\/download'[\s\S]*getClaudeTerminalDownloadTicketUserId\(url\) !== null/,
    )
    assert.match(
      SERVER_SRC,
      /this\.getClaudeTerminalUserId\(req\) \|\| this\.getClaudeTerminalDownloadTicketUserId\(url\)/,
    )
    assert.doesNotMatch(SERVER_SRC, /searchParams\.get\(['"]token['"]\)/)
  })

  test('server terminal routes use the terminal-specific principal', () => {
    assert.match(SERVER_SRC, /private getClaudeTerminalUserId\(req: IncomingMessage\)/)
    assert.match(SERVER_SRC, /configuredUsers\.some\(\(u\) => u\.id === jwtUserId\)/)
    assert.match(
      SERVER_SRC,
      /handleClaudeTerminalConnection[\s\S]*const userId = this\.getClaudeTerminalUserId\(req\)[\s\S]*handleConnection\(ws, userId/,
    )
  })

  test('spawns a session keyed by id, forwards output/input, clamps resize, detaches on close, terminates by id+owner', () => {
    const ptys: FakePty[] = []
    const manager = makeManager({
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
        HOME: '/root',
        PATH: '/usr/bin',
      },
      spawn: (file, args, opts) => {
        assert.equal(file, '/bin/echo')
        // A fresh session pins its id via --session-id <uuid>.
        assert.equal(args[0], '--session-id')
        assert.equal(isValidClaudeSessionId(args[1]), true)
        assert.deepEqual(args.slice(2), BASE_ARGS)
        assert.equal(opts.cwd, '/tmp')
        assert.equal(opts.env.HOME, '/root')
        assert.equal(opts.env.IS_SANDBOX, '1')
        assert.equal('ANTHROPIC_API_KEY' in opts.env, false)
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    assert.equal(manager.activeCount(), 1)
    assert.equal(manager.workingDirectory('user-a'), '/tmp')
    const sid = runningSessionId(ws)
    assert.equal(isValidClaudeSessionId(sid), true)

    ptys[0]!.emitData('hello')
    assert.deepEqual(messages(ws).at(-1), { type: 'output', data: 'hello' })

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\n' })))
    assert.deepEqual(ptys[0]!.writes, ['ls\n'])

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 999, rows: 999 })))
    assert.deepEqual(ptys[0]!.resizes.at(-1), { cols: 240, rows: 80 })

    ws.emit('close')
    assert.equal(manager.activeCount(), 1)
    assert.equal(ptys[0]!.kills.length, 0)

    // Another user cannot terminate this session.
    assert.equal(manager.terminate('user-b', sid), false)
    assert.equal(ptys[0]!.kills.length, 0)

    assert.equal(manager.terminate('user-a', sid), true)
    assert.equal(manager.activeCount(), 0)
    assert.equal(ptys[0]!.kills.length, 1)
    assert.equal(manager.terminate('user-a', sid), false)
  })

  test('cold reconnect re-attaches the user to their live session, replays output, fences stale sockets', () => {
    const ptys: FakePty[] = []
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => {
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    const ws1 = new FakeWs()
    manager.handleConnection(asWs(ws1), 'user-a')
    ptys[0]!.emitData('first')
    ws1.emit('close')

    const ws2 = new FakeWs()
    manager.handleConnection(asWs(ws2), 'user-a')
    assert.equal(ptys.length, 1)
    assert.equal(manager.activeCount(), 1)
    assert.deepEqual(messages(ws2).at(-1), { type: 'replay', data: 'first' })

    ws1.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'stale\n' })))
    ws1.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 20, rows: 5 })))
    ws1.emit('message', Buffer.from(JSON.stringify({ type: 'kill' })))
    assert.deepEqual(ptys[0]!.writes, [])
    assert.deepEqual(ptys[0]!.resizes, [])
    assert.equal(ptys[0]!.kills.length, 0)

    ws2.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'fresh\n' })))
    assert.deepEqual(ptys[0]!.writes, ['fresh\n'])
    ptys[0]!.emitData(' live')
    assert.deepEqual(messages(ws2).at(-1), { type: 'output', data: ' live' })
  })

  test('replaces an active websocket for the same session without killing the pty or touching another user', () => {
    const ptys: FakePty[] = []
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => {
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    const wsA1 = new FakeWs()
    const wsB = new FakeWs()
    manager.handleConnection(asWs(wsA1), 'user-a')
    manager.handleConnection(asWs(wsB), 'user-b')
    assert.equal(manager.activeCount(), 2)

    const wsA2 = new FakeWs()
    manager.handleConnection(asWs(wsA2), 'user-a')
    assert.equal(manager.activeCount(), 2)
    assert.equal(ptys.length, 2)
    assert.equal(ptys[0]!.kills.length, 0)
    assert.equal(ptys[1]!.kills.length, 0)
    assert.equal(wsA1.closes.at(-1)?.reason, 'replaced')

    wsA1.emit('message', Buffer.from(JSON.stringify({ type: 'kill' })))
    assert.equal(ptys[0]!.kills.length, 0)
    assert.equal(ptys[1]!.kills.length, 0)
  })

  test('action=new starts a parallel session without killing existing ones', () => {
    const ptys: FakePty[] = []
    const spawnArgs: string[][] = []
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: (_file, args) => {
        spawnArgs.push(args)
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    manager.handleConnection(asWs(new FakeWs()), 'user-a')
    manager.handleConnection(asWs(new FakeWs()), 'user-a', { action: 'new' })
    assert.equal(ptys.length, 2)
    assert.equal(ptys[0]!.kills.length, 0, 'first session is NOT killed')
    assert.equal(manager.activeCount(), 2)
    // Both are fresh sessions with distinct pinned ids.
    assert.equal(spawnArgs[0]![0], '--session-id')
    assert.equal(spawnArgs[1]![0], '--session-id')
    assert.notEqual(spawnArgs[0]![1], spawnArgs[1]![1])
  })

  test('enforces the per-user concurrency cap without blocking other users', () => {
    const ptys: FakePty[] = []
    const manager = makeManager({
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
        OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_MAX_SESSIONS: '2',
      },
      spawn: () => {
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    manager.handleConnection(asWs(new FakeWs()), 'user-a', { action: 'new' })
    manager.handleConnection(asWs(new FakeWs()), 'user-a', { action: 'new' })
    assert.equal(ptys.length, 2)

    const ws3 = new FakeWs()
    manager.handleConnection(asWs(ws3), 'user-a', { action: 'new' })
    assert.equal(ptys.length, 2, 'no third spawn for the capped user')
    assert.equal(messages(ws3).at(-1)?.state, 'error')
    assert.match(String(messages(ws3).at(-1)?.message), /2/)
    assert.equal(ws3.closes.at(-1)?.code, 1013)

    manager.handleConnection(asWs(new FakeWs()), 'user-b', { action: 'new' })
    assert.equal(ptys.length, 3, 'a different user is unaffected by the cap')
  })

  test("attach to another user's live session is rejected", () => {
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => new FakePty(),
    })

    const wsB = new FakeWs()
    manager.handleConnection(asWs(wsB), 'user-b')
    const sid = runningSessionId(wsB)
    assert.equal(isValidClaudeSessionId(sid), true)

    const wsA = new FakeWs()
    manager.handleConnection(asWs(wsA), 'user-a', { action: 'attach', sessionId: sid })
    assert.equal(messages(wsA).at(-1)?.state, 'error')
    assert.equal(wsA.closes.at(-1)?.code, 1008)
    assert.equal(manager.activeCount(), 1, 'no second PTY spawned')
  })

  test('explicit websocket kill still closes and deletes the session', () => {
    const pty = new FakePty()
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => pty,
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'kill' })))
    assert.equal(manager.activeCount(), 0)
    assert.equal(pty.kills.length, 1)
  })

  test('detached sessions are killed after the configured ttl with timer ownership checks', async () => {
    const pty = new FakePty()
    const manager = makeManager({
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
        OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL_DETACHED_TTL_MS: '1',
      },
      spawn: () => pty,
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    ws.emit('close')
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(manager.activeCount(), 0)
    assert.equal(pty.kills.length, 1)
  })

  test('rejects oversized websocket messages before parsing JSON without killing the detached pty', () => {
    const pty = new FakePty()
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => pty,
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    ws.emit('message', Buffer.alloc(CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES + 1, 'x'))
    assert.equal(ws.closes.at(-1)?.code, 1009)
    assert.equal(manager.activeCount(), 1)
    assert.equal(pty.kills.length, 0)
  })

  test('honors the runtime disabled switch', () => {
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_TERMINAL: 'disabled' },
      spawn: () => {
        throw new Error('must not spawn')
      },
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    assert.equal(manager.activeCount(), 0)
    assert.equal(messages(ws)[0]?.type, 'status')
    assert.equal(messages(ws)[0]?.state, 'disabled')
    assert.equal(ws.closes.at(-1)?.code, 1013)
  })
})

const SAMPLE_SESSION_ID = '4b062d84-12bf-46b0-929b-5c1f8738655d'

describe('Claude session args, listing, attach + delete', () => {
  test('isValidClaudeSessionId only accepts UUIDs', () => {
    assert.equal(isValidClaudeSessionId(SAMPLE_SESSION_ID), true)
    assert.equal(isValidClaudeSessionId(`  ${SAMPLE_SESSION_ID}  `), true)
    assert.equal(isValidClaudeSessionId('not-a-uuid'), false)
    assert.equal(isValidClaudeSessionId('../../etc/passwd'), false)
    assert.equal(isValidClaudeSessionId(''), false)
    assert.equal(isValidClaudeSessionId(undefined), false)
  })

  test('buildOfficialClaudeArgs: base / --resume / --session-id, ignoring garbage ids', () => {
    assert.deepEqual(buildOfficialClaudeArgs(), BASE_ARGS)
    assert.deepEqual(buildOfficialClaudeArgs({ resumeSessionId: SAMPLE_SESSION_ID }), [
      '--resume',
      SAMPLE_SESSION_ID,
      ...BASE_ARGS,
    ])
    assert.deepEqual(buildOfficialClaudeArgs({ newSessionId: SAMPLE_SESSION_ID }), [
      '--session-id',
      SAMPLE_SESSION_ID,
      ...BASE_ARGS,
    ])
    // Resume wins when both are present.
    assert.deepEqual(
      buildOfficialClaudeArgs({
        newSessionId: SAMPLE_SESSION_ID,
        resumeSessionId: SAMPLE_SESSION_ID,
      }),
      ['--resume', SAMPLE_SESSION_ID, ...BASE_ARGS],
    )
    // Injection / garbage ids are ignored, never passed to the shell.
    assert.deepEqual(buildOfficialClaudeArgs({ resumeSessionId: '; rm -rf /' }), BASE_ARGS)
    assert.deepEqual(buildOfficialClaudeArgs({ newSessionId: 'bogus' }), BASE_ARGS)
  })

  test('listClaudeSessions reads transcripts for the terminal cwd, newest first', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-home-'))
    try {
      const cwd = home
      const projectDir = join(home, '.claude', 'projects', cwd.replace(/[/.]/g, '-'))
      mkdirSync(projectDir, { recursive: true })
      const olderId = '11111111-1111-4111-8111-111111111111'
      const newerId = '22222222-2222-4222-8222-222222222222'
      writeFileSync(
        join(projectDir, `${olderId}.jsonl`),
        `${JSON.stringify({ type: 'mode', sessionId: olderId })}\n${JSON.stringify({
          type: 'user',
          message: { content: 'first real question' },
        })}\n`,
      )
      writeFileSync(
        join(projectDir, `${newerId}.jsonl`),
        `${JSON.stringify({
          type: 'user',
          isMeta: true,
          message: { content: '<command-name>/foo</command-name>' },
        })}\n${JSON.stringify({
          type: 'user',
          message: { content: [{ type: 'text', text: 'newest session topic' }] },
        })}\n`,
      )
      writeFileSync(join(projectDir, 'notes.jsonl'), 'garbage\n')
      utimesSync(join(projectDir, `${olderId}.jsonl`), new Date(1000), new Date(1000))
      utimesSync(join(projectDir, `${newerId}.jsonl`), new Date(5000), new Date(5000))

      const env = { HOME: home, OPENCLAUDE_OFFICIAL_CLAUDE_CWD: cwd }
      const sessions = listClaudeSessions({
        userId: 'user-a',
        ownerOf: () => undefined,
        liveIds: new Set([newerId]),
        env,
      })
      assert.equal(sessions.length, 2)
      assert.equal(sessions[0]?.sessionId, newerId, 'newest mtime first')
      assert.equal(sessions[0]?.title, 'newest session topic')
      assert.equal(sessions[0]?.live, true)
      assert.equal(sessions[0]?.owned, false, 'legacy (unowned) sessions are not owned')
      assert.equal(sessions[1]?.sessionId, olderId)
      assert.equal(sessions[1]?.live, false)
      assert.equal(sessions[0]?.cwd, cwd)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('listClaudeSessions hides sessions owned by other users, shows owned + legacy', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-own-'))
    try {
      const projectDir = join(home, '.claude', 'projects', home.replace(/[/.]/g, '-'))
      mkdirSync(projectDir, { recursive: true })
      const otherId = '11111111-1111-4111-8111-111111111111' // owned by user-b
      const legacyId = '22222222-2222-4222-8222-222222222222' // unowned
      const mineId = '33333333-3333-4333-8333-333333333333' // owned by user-a
      for (const id of [otherId, legacyId, mineId]) {
        writeFileSync(
          join(projectDir, `${id}.jsonl`),
          `${JSON.stringify({ type: 'user', message: { content: id } })}\n`,
        )
      }
      const env = { HOME: home, OPENCLAUDE_OFFICIAL_CLAUDE_CWD: home }
      const ownerOf = (id: string) =>
        id === otherId ? 'user-b' : id === mineId ? 'user-a' : undefined

      const aIds = listClaudeSessions({ userId: 'user-a', ownerOf, liveIds: new Set(), env })
        .map((s) => s.sessionId)
        .sort()
      assert.deepEqual(
        aIds,
        [legacyId, mineId].sort(),
        'user-a sees their own + legacy, not user-b',
      )

      const bIds = listClaudeSessions({ userId: 'user-b', ownerOf, liveIds: new Set(), env })
        .map((s) => s.sessionId)
        .sort()
      assert.deepEqual(
        bIds,
        [legacyId, otherId].sort(),
        'user-b sees their own + legacy, not user-a',
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('listClaudeSessions returns [] when the project dir is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-empty-'))
    try {
      assert.deepEqual(
        listClaudeSessions({
          userId: 'user-a',
          ownerOf: () => undefined,
          liveIds: new Set(),
          env: { HOME: home, OPENCLAUDE_OFFICIAL_CLAUDE_CWD: home },
        }),
        [],
      )
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a new session records ownership to the registry file', () => {
    const ownersPath = freshOwnersPath()
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => new FakePty(),
      ownersPath,
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'dx1')
    const sid = runningSessionId(ws)
    assert.equal(manager.ownerOf(sid), 'dx1')
    const reg = JSON.parse(readFileSync(ownersPath, 'utf8')) as {
      owners: Record<string, { userId: string }>
    }
    assert.equal(reg.owners[sid]?.userId, 'dx1')
  })

  test('action=attach to a non-live legacy session spawns claude --resume <id>', () => {
    const spawnArgs: string[][] = []
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: (_file, args) => {
        spawnArgs.push(args)
        return new FakePty()
      },
    })

    manager.handleConnection(asWs(new FakeWs()), 'user-a', {
      action: 'attach',
      sessionId: SAMPLE_SESSION_ID,
    })
    assert.deepEqual(spawnArgs[0], buildOfficialClaudeArgs({ resumeSessionId: SAMPLE_SESSION_ID }))
  })

  test('action=attach rejects invalid session ids without spawning', () => {
    let spawned = false
    const manager = makeManager({
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => {
        spawned = true
        return new FakePty()
      },
    })

    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a', { action: 'attach', sessionId: 'bogus' })
    assert.equal(spawned, false)
    assert.equal(manager.activeCount(), 0)
    assert.equal(messages(ws).at(-1)?.state, 'error')
    assert.equal(ws.closes.at(-1)?.code, 1008)
  })

  test('deleteSession removes a legacy transcript for any user', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-del-'))
    try {
      const projectDir = join(home, '.claude', 'projects', home.replace(/[/.]/g, '-'))
      mkdirSync(projectDir, { recursive: true })
      const file = join(projectDir, `${SAMPLE_SESSION_ID}.jsonl`)
      writeFileSync(file, '{}\n')
      const manager = makeManager({
        env: {
          OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
          HOME: home,
          OPENCLAUDE_OFFICIAL_CLAUDE_CWD: home,
        },
      })
      const res = manager.deleteSession('user-a', SAMPLE_SESSION_ID)
      assert.deepEqual(res, { deleted: true, terminated: false })
      assert.equal(existsSync(file), false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test("deleteSession denies deleting another user's owned session and keeps the file", () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-del2-'))
    try {
      const projectDir = join(home, '.claude', 'projects', home.replace(/[/.]/g, '-'))
      mkdirSync(projectDir, { recursive: true })
      const file = join(projectDir, `${SAMPLE_SESSION_ID}.jsonl`)
      writeFileSync(file, '{}\n')
      const ownersPath = freshOwnersPath()
      writeFileSync(
        ownersPath,
        JSON.stringify({
          version: 1,
          owners: { [SAMPLE_SESSION_ID]: { userId: 'user-b', createdAt: 1 } },
        }),
      )
      const manager = makeManager({
        env: {
          OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
          HOME: home,
          OPENCLAUDE_OFFICIAL_CLAUDE_CWD: home,
        },
        ownersPath,
      })
      assert.throws(
        () => manager.deleteSession('user-a', SAMPLE_SESSION_ID),
        (err) => err instanceof ClaudeTerminalForbiddenError,
      )
      assert.equal(existsSync(file), true, 'denied delete must not remove the file')
      assert.equal(manager.ownerOf(SAMPLE_SESSION_ID), 'user-b', 'ownership preserved')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('deleteSession kills a live owned session and removes its ownership record', () => {
    const ptys: FakePty[] = []
    const manager = makeManager({
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
        HOME: '/root',
      },
      spawn: () => {
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'dx1')
    const sid = runningSessionId(ws)
    assert.equal(manager.ownerOf(sid), 'dx1')

    // No transcript on disk for this synthetic id; unlink ENOENT is treated as
    // already-gone, the live PTY is still killed and the record removed.
    const res = manager.deleteSession('dx1', sid)
    assert.equal(res.terminated, true)
    assert.equal(ptys[0]!.kills.length, 1)
    assert.equal(manager.activeCount(), 0)
    assert.equal(manager.ownerOf(sid), undefined)
  })
})

describe('ClaudeTerminalOwners registry', () => {
  const ANY_ID = '11111111-1111-4111-8111-111111111111'

  test('an absent registry is empty and healthy: unknown sessions are legacy (visible to all)', () => {
    const owners = new ClaudeTerminalOwners(freshOwnersPath(), logger)
    assert.equal(owners.ownerOf(ANY_ID), undefined)
    assert.equal(owners.isVisibleTo(ANY_ID, 'anyone'), true)
  })

  test('record + remove persist round-trip', () => {
    const path = freshOwnersPath()
    const owners = new ClaudeTerminalOwners(path, logger)
    owners.record(SAMPLE_SESSION_ID, 'dx2')
    assert.equal(owners.ownerOf(SAMPLE_SESSION_ID), 'dx2')
    // A fresh instance reading the same file sees the record.
    assert.equal(new ClaudeTerminalOwners(path, logger).ownerOf(SAMPLE_SESSION_ID), 'dx2')
    owners.remove(SAMPLE_SESSION_ID)
    assert.equal(owners.ownerOf(SAMPLE_SESSION_ID), undefined)
    assert.equal(new ClaudeTerminalOwners(path, logger).ownerOf(SAMPLE_SESSION_ID), undefined)
  })

  test('a malformed existing registry fails closed: unknown sessions are hidden, not legacy', () => {
    const path = freshOwnersPath()
    writeFileSync(path, 'this is not json{')
    const owners = new ClaudeTerminalOwners(path, logger)
    // Unknown session resolves to a sentinel (not undefined) -> hidden from all.
    assert.notEqual(owners.ownerOf(ANY_ID), undefined)
    assert.equal(owners.isVisibleTo(ANY_ID, 'anyone'), false)
    // Newly recorded sessions still work, and self-heal the file.
    owners.record(SAMPLE_SESSION_ID, 'dx1')
    assert.equal(owners.ownerOf(SAMPLE_SESSION_ID), 'dx1')
    assert.equal(owners.isVisibleTo(SAMPLE_SESSION_ID, 'dx1'), true)
  })

  test('degraded state survives a restart: a fresh instance keeps failing closed', () => {
    const path = freshOwnersPath()
    writeFileSync(path, 'corrupt{')
    // First process degrades and persists the marker.
    const first = new ClaudeTerminalOwners(path, logger)
    first.record(SAMPLE_SESSION_ID, 'dx1')
    // Simulate a restart: a new instance reads the persisted file.
    const restarted = new ClaudeTerminalOwners(path, logger)
    // Recorded sessions are still owned...
    assert.equal(restarted.ownerOf(SAMPLE_SESSION_ID), 'dx1')
    // ...but unknown sessions must still be hidden, not silently legacy.
    assert.notEqual(restarted.ownerOf(ANY_ID), undefined)
    assert.equal(restarted.isVisibleTo(ANY_ID, 'anyone'), false)
  })

  test('a clean registry restored by a human clears the degraded state on restart', () => {
    const path = freshOwnersPath()
    writeFileSync(path, 'corrupt{')
    new ClaudeTerminalOwners(path, logger) // degrades + persists marker
    // Human restores a clean registry (no degraded flag).
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        owners: { [SAMPLE_SESSION_ID]: { userId: 'dx1', createdAt: 1 } },
      }),
    )
    const recovered = new ClaudeTerminalOwners(path, logger)
    assert.equal(recovered.ownerOf(SAMPLE_SESSION_ID), 'dx1')
    // Healthy again: unknown sessions are legacy (visible to all).
    assert.equal(recovered.ownerOf(ANY_ID), undefined)
    assert.equal(recovered.isVisibleTo(ANY_ID, 'anyone'), true)
  })
})
