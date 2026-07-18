import * as assert from 'node:assert/strict'
/**
 * /api/dev-status 看板纯函数层(2026-07-18 并行开发审计条6)。
 *
 * 锁定三个不变量:
 *  1. /proc/locks 解析只认 inode 命中的行,坏行/无关行静默跳过 —— 看板不因内核
 *     格式差异 500。
 *  2. 日志尾提取容忍截断行与非 JSON 行(尾读从 256KB 边界起,首行几乎必截断)。
 *  3. HTML 渲染对会话键/日志内容全量转义 —— 日志里出现 <script> 不能变成注入面。
 */
import { describe, it } from 'node:test'
import {
  collectDevStatus,
  extractLogErrors,
  parseProcLocks,
  renderDevStatusHtml,
} from '../devStatus.js'

describe('parseProcLocks', () => {
  it('按 inode 关联 flock 持有者,无关行与坏行跳过', () => {
    const text = [
      '1: FLOCK  ADVISORY  WRITE 4242 fd:01:111 0 EOF',
      '2: POSIX  ADVISORY  WRITE 5555 fd:01:222 0 EOF',
      '3: garbage line',
      '4: FLOCK  ADVISORY  WRITE 9999 fd:01:999 0 EOF',
    ].join('\n')
    const held = parseProcLocks(
      text,
      new Map([
        [111, 'oc-v5-deploy.lock'],
        [222, 'oc-test-commercial.lock'],
      ]),
    )
    assert.equal(held.get('oc-v5-deploy.lock'), 4242)
    assert.equal(held.get('oc-test-commercial.lock'), 5555)
    assert.equal(held.size, 2)
  })

  it('同文件多行只取第一条(首个持有者)', () => {
    const text = [
      '1: FLOCK  ADVISORY  WRITE 100 fd:01:7 0 EOF',
      '2: FLOCK  ADVISORY  WRITE 200 fd:01:7 0 EOF',
    ].join('\n')
    const held = parseProcLocks(text, new Map([[7, 'a.lock']]))
    assert.equal(held.get('a.lock'), 100)
  })
})

describe('extractLogErrors', () => {
  it('从尾部向前取 error/warn,截断行与 info 行跳过,msg 截断到 200', () => {
    const lines = [
      '{"ts":"t0","level":"info","msg":"noise"}',
      '{"ts":"t1","level":"error","msg":"' + 'x'.repeat(300) + '","sessionKey":"agent:codex:webchat:dm:web-1"}',
      '{"ts":"t2","level":"warn","msg":"w1"}',
      '{"ts":"t3","level":"er', // 模拟尾读边界截断
    ]
    const rows = extractLogErrors(lines.join('\n'), 10)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].ts, 't2') // 最新在前
    assert.equal(rows[1].ts, 't1')
    assert.equal(rows[1].msg.length, 200)
    assert.equal(rows[1].sessionKey, 'agent:codex:webchat:dm:web-1')
  })

  it('limit 生效', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `{"ts":"t${i}","level":"warn","msg":"m"}`).join('\n')
    assert.equal(extractLogErrors(raw, 25).length, 25)
  })
})

describe('collectDevStatus + renderDevStatusHtml', () => {
  const deps = {
    sessions: () => [
      {
        sessionKey: 'agent:codex:webchat:dm:web-x',
        agentId: 'codex',
        lastUsedAt: Date.now(),
        turns: 3,
        totalCostUSD: 1.5,
        runnerRunning: true,
        turnActiveSince: Date.now() - 60_000,
      },
      {
        sessionKey: 'agent:main:cron:daily',
        agentId: 'main',
        lastUsedAt: Date.now() - 3_600_000,
        turns: 1,
        totalCostUSD: 0,
        runnerRunning: false,
        turnActiveSince: null,
      },
    ],
    terminals: () => [
      {
        sessionId: 'term-1',
        userId: 'boss',
        createdAt: Date.now() - 7_200_000,
        cwd: '/opt/openclaude/openclaude-parallel-dev-ops',
        lastOutputAt: Date.now() - 5_000,
        outputBytes: 1024,
      },
    ],
    // 指到不存在的路径 → 各降级为空,不 throw
    lockDir: '/nonexistent-lockdir',
    procLocksPath: '/nonexistent-proc-locks',
    registryPath: '/nonexistent-registry.json',
    logPath: '/nonexistent-log',
    loadavg: () => [1.5, 2.0, 2.5],
  }

  it('inFlightTurns 只数 turnActiveSince 非空的会话;数据源缺失全部降级不 throw', () => {
    const s = collectDevStatus(deps)
    assert.equal(s.inFlightTurns, 1)
    assert.equal(s.sessions.length, 2)
    assert.equal(s.sessions[0].sessionKey, 'agent:codex:webchat:dm:web-x') // 活跃排前
    assert.deepEqual(s.locks, [])
    assert.deepEqual(s.worktrees, [])
    assert.deepEqual(s.recentErrors, [])
  })

  it('HTML 全量转义:恶意 sessionKey/日志不产生可执行标签', () => {
    const evil = collectDevStatus({
      ...deps,
      sessions: () => [
        {
          sessionKey: '<script>alert(1)</script>',
          agentId: 'codex',
          lastUsedAt: Date.now(),
          turns: 0,
          totalCostUSD: 0,
          runnerRunning: false,
          turnActiveSince: null,
        },
      ],
      terminals: () => [],
    })
    const html = renderDevStatusHtml(evil)
    assert.ok(!html.includes('<script>alert'))
    assert.ok(html.includes('&#60;script&#62;'))
    assert.ok(html.includes('in-flight turns'))
  })
})
