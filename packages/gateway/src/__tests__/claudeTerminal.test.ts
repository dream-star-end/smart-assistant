import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { homedir } from 'node:os'
import { describe, test } from 'node:test'
import type { WebSocket } from 'ws'

import {
  CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES,
  ClaudeTerminalManager,
  buildOfficialClaudeEnv,
  clampTerminalSize,
  isAllowedClaudeTerminalOrigin,
  isClaudeTerminalEnabled,
  resolveOfficialClaudeCwd,
} from '../claudeTerminal.js'
import type { Logger } from '../logger.js'

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
    assert.equal(env.PATH.startsWith('/home/tester/.local/bin:'), true)
    assert.equal('ANTHROPIC_API_KEY' in env, false)
    assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false)
    assert.equal('OPENCLAUDE_GATEWAY_TOKEN' in env, false)
  })

  test('clamps terminal dimensions', () => {
    assert.deepEqual(clampTerminalSize(999, 999), { cols: 240, rows: 80 })
    assert.deepEqual(clampTerminalSize(1, 1), { cols: 20, rows: 5 })
    assert.deepEqual(clampTerminalSize('bad', Number.NaN), { cols: 100, rows: 30 })
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
})

describe('ClaudeTerminalManager lifecycle', () => {
  test('spawns per user, forwards output/input, clamps resize, and kills on close', () => {
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
        assert.deepEqual(args, [])
        assert.equal(opts.cwd, '/tmp')
        assert.equal(opts.env.HOME, '/root')
        assert.equal('ANTHROPIC_API_KEY' in opts.env, false)
        const fake = new FakePty()
        ptys.push(fake)
        return fake
      },
    })

    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    assert.equal(manager.activeCount(), 1)
    assert.equal(messages(ws).at(-1)?.type, 'status')

    ptys[0]!.emitData('hello')
    assert.deepEqual(messages(ws).at(-1), { type: 'output', data: 'hello' })

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'input', data: 'ls\n' })))
    assert.deepEqual(ptys[0]!.writes, ['ls\n'])

    ws.emit('message', Buffer.from(JSON.stringify({ type: 'resize', cols: 999, rows: 999 })))
    assert.deepEqual(ptys[0]!.resizes.at(-1), { cols: 240, rows: 80 })

    ws.emit('close')
    assert.equal(manager.activeCount(), 0)
    assert.equal(ptys[0]!.kills.length, 1)
  })

  test('replaces an existing session for the same user without touching another user', () => {
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
    assert.equal(ptys[0]!.kills.length, 1)
    assert.equal(ptys[1]!.kills.length, 0)
    assert.equal(wsA1.closes.at(-1)?.reason, 'replaced')
  })

  test('rejects oversized websocket messages before parsing JSON', () => {
    const manager = new ClaudeTerminalManager({
      logger,
      env: {
        OPENCLAUDE_OFFICIAL_CLAUDE_PATH: '/bin/echo',
        OPENCLAUDE_OFFICIAL_CLAUDE_CWD: '/tmp',
      },
      spawn: () => new FakePty(),
    })
    const ws = new FakeWs()
    manager.handleConnection(asWs(ws), 'user-a')
    ws.emit('message', Buffer.alloc(CLAUDE_TERMINAL_MAX_CLIENT_MESSAGE_BYTES + 1, 'x'))
    assert.equal(ws.closes.at(-1)?.code, 1009)
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
