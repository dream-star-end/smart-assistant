/**
 * list_reminders 文本拼装纯逻辑测试:标题压平(现网 bug 根治)+ 系统任务友好名 +
 * 逐行格式契约钉死。前端 web-react parseReminderListOutput 依赖这里的逐行格式;任何
 * 分隔符/顺序/换行变化都会击穿前端逐行解析,故此处把契约锁死。
 *
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/reminderFormat.test.ts
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  SYSTEM_REMINDER_LABELS,
  formatReminderLine,
  formatReminderList,
  reminderTitle,
} from '../reminderFormat.js'

describe('reminderTitle — 标题压平 + 系统任务友好名', () => {
  it('三个已知系统任务 ID → 中文友好名 + isSystem=true', () => {
    assert.deepEqual(
      reminderTitle({ id: 'daily-reflection', schedule: '', prompt: 'You are doing a DAILY\n\n1' }),
      { title: '记忆日结', isSystem: true },
    )
    assert.deepEqual(reminderTitle({ id: 'weekly-curation', schedule: '' }), {
      title: '记忆周整理',
      isSystem: true,
    })
    assert.deepEqual(reminderTitle({ id: 'skill-check', schedule: '' }), {
      title: '技能沉淀巡检',
      isSystem: true,
    })
  })

  it('SYSTEM_REMINDER_LABELS 覆盖 cron.ts seed 的三个自省任务(权威源镜像)', () => {
    assert.deepEqual(Object.keys(SYSTEM_REMINDER_LABELS).sort(), [
      'daily-reflection',
      'skill-check',
      'weekly-curation',
    ])
  })

  it('含 \\n\\n / 制表符 / 连续空白的 prompt 标题被压平成单行(现网击穿逐行解析器的根因)', () => {
    const { title } = reminderTitle({
      id: 'remind-x',
      schedule: '',
      prompt: '买牛奶\n\n和鸡蛋,然后\t打扫   房间',
    })
    assert.doesNotMatch(title, /[\n\r\t]/, '标题不得含换行/回车/制表符')
    assert.doesNotMatch(title, /\s{2,}/, '标题不得含连续空白')
  })

  it('label 优先且压平、不截断(与现网一致);label 内嵌换行同样根治', () => {
    const { title, isSystem } = reminderTitle({
      id: 'remind-y',
      schedule: '',
      label: '买牛奶\n和鸡蛋',
      prompt: 'ignored',
    })
    assert.equal(title, '买牛奶 和鸡蛋')
    assert.equal(isSystem, false)
  })

  it('无 label 时 prompt 压平后截断 40 字 + 省略号(保留现网行为)', () => {
    const long = 'A'.repeat(80)
    const { title } = reminderTitle({ id: 'remind-z', schedule: '', prompt: long })
    assert.equal(title, `${'A'.repeat(40)}…`)
  })

  it('label 与 prompt 均缺 → id 兜底', () => {
    assert.deepEqual(reminderTitle({ id: 'remind-w', schedule: '' }), {
      title: 'remind-w',
      isSystem: false,
    })
  })
})

describe('formatReminderLine — 逐行格式契约(前端 parseReminderListOutput 依赖)', () => {
  it('系统任务:`系统` 位插在 deliver 之后、`下次` 之前,标题为中文友好名', () => {
    const line = formatReminderLine({
      id: 'daily-reflection',
      schedule: '17 3 * * *',
      enabled: true,
      oneshot: false,
      deliver: 'local',
      nextRunAt: '2026-07-10T19:17:00.000Z',
      prompt: 'You are doing a DAILY REFLECTION pass.\n\n1. ...',
    })
    assert.equal(
      line,
      '- **记忆日结** (ID: `daily-reflection`) — `17 3 * * *` · 重复 · 启用中 · 仅记录 · 系统 · 下次 2026-07-10T19:17:00.000Z',
    )
  })

  it('系统任务无 nextRunAt:结尾即 `系统` 位', () => {
    const line = formatReminderLine({
      id: 'weekly-curation',
      schedule: '31 4 * * 0',
      enabled: true,
      oneshot: false,
      deliver: 'local',
      prompt: 'You are doing a WEEKLY CURATION pass.\n\n1',
    })
    assert.equal(
      line,
      '- **记忆周整理** (ID: `weekly-curation`) — `31 4 * * 0` · 重复 · 启用中 · 仅记录 · 系统',
    )
  })

  it('非系统(用户)任务:无 `系统` 位,格式与现网逐字一致', () => {
    const line = formatReminderLine({
      id: 'remind-abc',
      schedule: '30 15 10 7 *',
      enabled: true,
      oneshot: true,
      deliver: 'webchat',
      label: '开会提醒',
    })
    assert.equal(
      line,
      '- **开会提醒** (ID: `remind-abc`) — `30 15 10 7 *` · 一次性 · 启用中 · 推送对话',
    )
  })

  it('已停用 + telegram deliver 映射正确', () => {
    const line = formatReminderLine({
      id: 'r1',
      schedule: '* * * * *',
      enabled: false,
      oneshot: false,
      deliver: 'telegram',
      label: 't',
    })
    assert.equal(line, '- **t** (ID: `r1`) — `* * * * *` · 重复 · 已停用 · Telegram')
  })

  it('整行恒为单行:即便 prompt 多段换行,行内也无换行(逐行解析不被击穿)', () => {
    const line = formatReminderLine({
      id: 'skill-check',
      schedule: '47 */6 * * *',
      enabled: true,
      oneshot: false,
      deliver: 'local',
      prompt: 'multi\n\nline\n\nprompt',
    })
    assert.equal(line.split('\n').length, 1)
  })
})

describe('formatReminderList — 首行计数 + 每任务恰一行', () => {
  it('现网三系统任务全部渲染,不再 malformed 回退整卡', () => {
    const out = formatReminderList([
      {
        id: 'daily-reflection',
        schedule: '17 3 * * *',
        enabled: true,
        oneshot: false,
        deliver: 'local',
        nextRunAt: '2026-07-10T19:17:00.000Z',
        prompt: 'A\n\nB',
      },
      {
        id: 'weekly-curation',
        schedule: '31 4 * * 0',
        enabled: true,
        oneshot: false,
        deliver: 'local',
        prompt: 'C\n\nD',
      },
      {
        id: 'skill-check',
        schedule: '47 */6 * * *',
        enabled: true,
        oneshot: false,
        deliver: 'local',
        nextRunAt: '2026-07-10T16:47:00.000Z',
        prompt: 'E\n\nF',
      },
    ])
    const lines = out.split('\n')
    assert.equal(lines[0], '共 3 个定时提醒/任务:')
    assert.equal(lines.length, 4, '首行 + 3 任务行,不得因内嵌换行多出行')
    assert.match(out, /记忆日结/)
    assert.match(out, /记忆周整理/)
    assert.match(out, /技能沉淀巡检/)
    assert.equal((out.match(/·\s*系统/g) || []).length, 3, '三条系统任务各有一个「系统」位')
  })
})
