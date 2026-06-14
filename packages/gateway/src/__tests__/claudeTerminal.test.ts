import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import type { WebSocket } from 'ws'

import {
  CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  ClaudeTerminalManager,
  buildOfficialClaudeArgs,
  buildOfficialClaudeEnv,
  clampTerminalSize,
  isAllowedClaudeTerminalOrigin,
  isClaudeTerminalEnabled,
  isValidClaudeSessionId,
  listClaudeSessions,
  resolveClaudeTerminalUserIdForAuth,
  resolveDetachedTerminalTtlMs,
  resolveOfficialClaudeCwd,
} from '../claudeTerminal.js'
import type { Logger } from '../logger.js'

const SERVER_SRC = readFileSync(resolve(import.meta.dirname, '..', 'server.ts'), 'utf-8')

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
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
    assert.deepEqual(buildOfficialClaudeArgs(), [
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ])
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
  test('server exposes an authenticated HTTP terminate route', () => {
    assert.match(SERVER_SRC, /url\.pathname === '\/api\/claude-terminal\/terminate'/)
    assert.match(SERVER_SRC, /req\.method !== 'POST'/)
    assert.match(SERVER_SRC, /const userId = this\.getClaudeTerminalUserId\(req\)/)
    assert.match(SERVER_SRC, /claudeTerminal\?\.terminate\(userId\)/)
  })

  test('server terminal routes use the terminal-specific principal', () => {
    assert.match(SERVER_SRC, /private getClaudeTerminalUserId\(req: IncomingMessage\)/)
    assert.match(SERVER_SRC, /configuredUsers\.some\(\(u\) => u\.id === jwtUserId\)/)
    assert.match(
      SERVER_SRC,
      /handleClaudeTerminalConnection[\s\S]*const userId = this\.getClaudeTerminalUserId\(req\)[\s\S]*handleConnection\(ws, userId/,
    )
    assert.doesNotMatch(
      SERVER_SRC,
      /claudeTerminal\?\.handleConnection\(ws, this\.getUserId\(req\)\)/,
    )
  })

  test('spawns per user, forwards output/input, clamps resize, detaches on close, and terminates explicitly', () => {
    const ptys: FakePty[] = []
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
        HOME: '/root',
        PATH: '/usr/bin',
      },
      spawn: (file, args, opts) => {
        assert.equal(file, '/bin/echo')
        assert.deepEqual(args, buildOfficialClaudeArgs())
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
    assert.equal(messages(ws).at(-1)?.type, 'status')

    ptys[0]!.emitData('hello')
    assert.deepEqual(messages(ws).at(-1), { type: 'output', data: 'hello' })

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\n' })))
    assert.deepEqual(ptys[0]!.writes, ['ls\n'])

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 999, rows: 999 })))
    assert.deepEqual(ptys[0]!.resizes.at(-1), { cols: 240, rows: 80 })

    ws.emit('close')
    assert.equal(manager.activeCount(), 1)
    assert.equal(ptys[0]!.kills.length, 0)

    assert.equal(manager.terminate('user-a'), true)
    assert.equal(manager.activeCount(), 0)
    assert.equal(ptys[0]!.kills.length, 1)
    assert.equal(manager.workingDirectory('user-a'), '/tmp')
    assert.equal(manager.terminate('user-a'), false)
  })

  test('reconnects the same user to the same pty, replays output, and fences stale sockets', () => {
    const ptys: FakePty[] = []
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
      },
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

  test('replaces an active websocket for the same user without killing the pty or touching another user', () => {
    const ptys: FakePty[] = []
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
      },
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

  test('explicit websocket kill still closes and deletes the session', () => {
    const pty = new FakePty()
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
      },
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
    const manager = new ClaudeTerminalManager({
      logger,
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
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
      },
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
    const manager = new ClaudeTerminalManager({
      logger,
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

describe('Claude session listing + resume', () => {
  test('isValidClaudeSessionId only accepts UUIDs', () => {
    assert.equal(isValidClaudeSessionId(SAMPLE_SESSION_ID), true)
    assert.equal(isValidClaudeSessionId(`  ${SAMPLE_SESSION_ID}  `), true)
    assert.equal(isValidClaudeSessionId('not-a-uuid'), false)
    assert.equal(isValidClaudeSessionId('../../etc/passwd'), false)
    assert.equal(isValidClaudeSessionId(''), false)
    assert.equal(isValidClaudeSessionId(undefined), false)
  })

  test('buildOfficialClaudeArgs prepends --resume only for valid ids', () => {
    assert.deepEqual(buildOfficialClaudeArgs(), [
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ])
    assert.deepEqual(buildOfficialClaudeArgs(SAMPLE_SESSION_ID), [
      '--resume',
      SAMPLE_SESSION_ID,
      '--permission-mode',
      'bypassPermissions',
      '--dangerously-skip-permissions',
    ])
    // Injection / garbage ids are ignored, never passed to the shell.
    assert.deepEqual(buildOfficialClaudeArgs('; rm -rf /'), buildOfficialClaudeArgs())
  })

  test('listClaudeSessions reads transcripts for the terminal cwd, newest first', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-home-'))
    try {
      const cwd = home // resolveOfficialClaudeCwd resolves to this dir
      // Encoded project dir: replace `/` and `.` with `-`.
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
      // First user record is a synthetic slash-command wrapper that must be skipped.
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
      // Non-uuid file is ignored.
      writeFileSync(join(projectDir, 'notes.jsonl'), 'garbage\n')
      // Pin distinct mtimes so ordering is deterministic (fs mtime resolution is coarse).
      utimesSync(join(projectDir, `${olderId}.jsonl`), new Date(1000), new Date(1000))
      utimesSync(join(projectDir, `${newerId}.jsonl`), new Date(5000), new Date(5000))

      const env = { HOME: home, OPENCLAUDE_OFFICIAL_CLAUDE_CWD: cwd }
      const sessions = listClaudeSessions(env)
      assert.equal(sessions.length, 2)
      assert.equal(sessions[0]?.sessionId, newerId, 'newest mtime first')
      assert.equal(sessions[0]?.title, 'newest session topic')
      assert.equal(sessions[1]?.sessionId, olderId)
      assert.equal(sessions[1]?.title, 'first real question')
      assert.equal(sessions[0]?.cwd, cwd)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('listClaudeSessions returns [] when the project dir is absent', () => {
    const home = mkdtempSync(join(tmpdir(), 'oc-claude-empty-'))
    try {
      assert.deepEqual(listClaudeSessions({ HOME: home, OPENCLAUDE_OFFICIAL_CLAUDE_CWD: home }), [])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('handleConnection action=new replaces the live PTY with a fresh process', () => {
    const ptys: FakePty[] = []
    const spawnArgs: string[][] = []
    const manager = new ClaudeTerminalManager({
      logger,
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: (_file, args) => {
        spawnArgs.push(args)
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    manager.handleConnection(asWs(new FakeWs()), 'user-a')
    assert.equal(ptys.length, 1)
    manager.handleConnection(asWs(new FakeWs()), 'user-a', { action: 'new' })
    assert.equal(ptys.length, 2, 'a second PTY is spawned')
    assert.equal(ptys[0]!.kills.length, 1, 'old PTY is killed')
    assert.deepEqual(spawnArgs[1], buildOfficialClaudeArgs(), 'fresh process, no --resume')
    assert.equal(manager.activeCount(), 1)
  })

  test('handleConnection action=resume spawns claude --resume <id>', () => {
    const spawnArgs: string[][] = []
    const manager = new ClaudeTerminalManager({
      logger,
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: (_file, args) => {
        spawnArgs.push(args)
        return new FakePty()
      },
    })

    manager.handleConnection(asWs(new FakeWs()), 'user-a', {
      action: 'resume',
      resumeSessionId: SAMPLE_SESSION_ID,
    })
    assert.deepEqual(spawnArgs[0], buildOfficialClaudeArgs(SAMPLE_SESSION_ID))
  })

  test('handleConnection action=resume rejects invalid session ids without spawning', () => {
    let spawned = false
    const manager = new ClaudeTerminalManager({
      logger,
      env: { OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo', OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp' },
      spawn: () => {
        spawned = true
        return new FakePty()
      },
    })

    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a', { action: 'resume', resumeSessionId: 'bogus' })
    assert.equal(spawned, false)
    assert.equal(manager.activeCount(), 0)
    assert.equal(messages(ws).at(-1)?.state, 'error')
    assert.equal(ws.closes.at(-1)?.code, 1008)
  })
})
