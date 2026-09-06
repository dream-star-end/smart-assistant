/**
 * 任务面板服务端开关 + server.ts 接线断言。
 *
 * Run: npx tsx --test packages/gateway/src/taskboard/__tests__/feature.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { TASKBOARD_ENABLED_ENV, isTaskboardEnabled, taskboardEnabledFromEnv } from '../feature.js'

const here = dirname(fileURLToPath(import.meta.url))

describe('taskboard 服务端开关', () => {
  it('缺省 / 非 0 一律启用,只有精确 0 才关', () => {
    assert.equal(taskboardEnabledFromEnv(undefined), true)
    assert.equal(taskboardEnabledFromEnv(''), true)
    assert.equal(taskboardEnabledFromEnv('1'), true)
    assert.equal(taskboardEnabledFromEnv('false'), true)
    assert.equal(taskboardEnabledFromEnv('0'), false)
    assert.equal(isTaskboardEnabled({}), true)
    assert.equal(isTaskboardEnabled({ [TASKBOARD_ENABLED_ENV]: '0' }), false)
  })

  it('server.ts 的巡检/通知启动必须包在 isTaskboardEnabled 门内', () => {
    const src = readFileSync(join(here, '../../server.ts'), 'utf8')
    const gate = src.indexOf('if (isTaskboardEnabled()) {')
    assert.ok(gate > 0, 'server.ts 必须以 if (isTaskboardEnabled()) 包住巡检启动')
    // 从 if 的 `{` 起按花括号配对找到块尾。
    const open = src.indexOf('{', gate)
    let depth = 0
    let close = -1
    for (let i = open; i < src.length; i++) {
      const ch = src[i]
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    assert.ok(close > open, 'if 块必须闭合')
    const block = src.slice(open, close)
    for (const needle of [
      'new TaskboardNotifier(',
      'new PatrolEngine(',
      'setPatrolExecutionHandler((job)',
      'this._taskboardTickTimer = setInterval(',
    ]) {
      assert.ok(block.includes(needle), `${needle} 必须在 isTaskboardEnabled 块内`)
      assert.equal(
        src.split(needle).length - 1,
        1,
        `${needle} 在 server.ts 里只能出现一次(否则可能有绕过开关的第二份接线)`,
      )
    }
  })
})
