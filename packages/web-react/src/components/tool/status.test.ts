import { describe, expect, test } from 'vitest'
import { errorSummaryLine, resolveToolStatus } from './status'

describe('resolveToolStatus:卡片与面板共用的单一权威状态(T-05)', () => {
  test('四态 + 受阻 + 取消', () => {
    expect(resolveToolStatus({ name: 'Bash', tool: { _completed: false } }).kind).toBe('running')
    expect(resolveToolStatus({ name: 'Bash', tool: { _completed: true } }).kind).toBe('done')
    expect(resolveToolStatus({ name: 'Write', tool: { _completed: true, error: true } }).kind).toBe(
      'error',
    )
    expect(
      resolveToolStatus({
        name: 'Bash',
        tool: { _completed: true, output: 'oc-web: blocked: Cloudflare' },
      }).kind,
    ).toBe('blocked')
    expect(
      resolveToolStatus({ name: 'Bash', tool: { _completed: true, cancelled: true } }).kind,
    ).toBe('cancelled')
    expect(
      resolveToolStatus({
        name: 'Agent',
        tool: { _completed: false, _timelineRecord: true, _dispatchOutcome: 'interrupted' },
      }).kind,
    ).toBe('cancelled')
  })

  test('Bash 启发式:Cursor 信封非 0 exitCode / markdown Error 算未成功;exitCode 0 的 stderr 前缀不算', () => {
    const failed = JSON.stringify({
      success: { command: 'x', exitCode: 1, stdout: '', stderr: 'boom' },
    })
    expect(
      resolveToolStatus({ name: 'Bash', tool: { _completed: true, output: failed } }).kind,
    ).toBe('error')
    const ok = JSON.stringify({
      success: { command: 'x', exitCode: 0, stdout: '', stderr: 'oc-cursor: slot 2/3' },
    })
    expect(resolveToolStatus({ name: 'Bash', tool: { _completed: true, output: ok } }).kind).toBe(
      'done',
    )
    expect(
      resolveToolStatus({
        name: 'Bash',
        tool: { _completed: true, output: '### Error\nTimeout 30000ms' },
      }).kind,
    ).toBe('error')
    // 非 Bash 工具不套 Bash 启发式
    expect(
      resolveToolStatus({ name: 'Read', tool: { _completed: true, output: failed } }).kind,
    ).toBe('done')
  })

  test('label / tone 随 kind 走,F1 口径是「未成功」而非「失败」', () => {
    const s = resolveToolStatus({
      name: 'Write',
      tool: { _completed: true, error: true, output: 'denied' },
    })
    expect(s.label).toBe('未成功')
    expect(s.tone).toBe('danger')
    expect(s.errorFirstLine).toBe('denied')
    const b = resolveToolStatus({
      name: 'Bash',
      tool: { _completed: true, output: 'oc-web: blocked: x' },
    })
    expect(b.label).toBe('受阻')
    expect(b.tone).toBe('warning')
    expect(b.errorFirstLine).toBe('')
  })

  test('确认触发标记', () => {
    const s = resolveToolStatus({
      name: 'Bash',
      tool: { _completed: true, output: '{"oc_connect":{"type":"confirmation_required"}}' },
    })
    expect(s.isConfirmation).toBe(true)
  })
})

describe('errorSummaryLine:表头错误摘要不露 JSON(T-02)', () => {
  test('Cursor 信封 → stderr 首行;没有 stderr → 退出码', () => {
    expect(
      errorSummaryLine(
        JSON.stringify({
          success: {
            command: 'npm test',
            exitCode: 1,
            stdout: '',
            stderr: 'FAIL a.test.ts\nAssertionError',
          },
          isBackground: false,
        }),
      ),
    ).toBe('FAIL a.test.ts')
    expect(
      errorSummaryLine(
        JSON.stringify({ success: { command: 'x', exitCode: 2, stdout: '', stderr: '' } }),
      ),
    ).toBe('退出码 2')
    // 裸 shell 结果对象同样解
    expect(errorSummaryLine(JSON.stringify({ command: 'x', exit_code: 1, stderr: 'nope' }))).toBe(
      'nope',
    )
  })

  test('确认触发 → 固定文案「待确认」', () => {
    expect(errorSummaryLine('{"oc_connect":{"type":"confirmation_required","id":"cf_1"}}')).toBe(
      '待确认',
    )
  })

  test('其它 JSON:取 error / error.message / message;认不出 → 空,绝不回吐原始 JSON', () => {
    expect(errorSummaryLine('{"ok":false,"error":"Invalid IP address"}')).toBe('Invalid IP address')
    expect(errorSummaryLine('{"error":{"message":"quota exceeded"}}')).toBe('quota exceeded')
    expect(errorSummaryLine('{"message":"not found"}')).toBe('not found')
    expect(errorSummaryLine('{"foo":"bar"}')).toBe('')
    expect(errorSummaryLine('{"success":{"command":"x","exitCo')).toBe('')
  })

  test('普通文本:首个非空行,剥 markdown # 与 error: 前缀,夹到 120 字', () => {
    expect(errorSummaryLine('\n### Error\nTimeout 30000ms exceeded')).toBe(
      'Timeout 30000ms exceeded',
    )
    expect(errorSummaryLine('### Error')).toBe('Error')
    expect(errorSummaryLine('error: 创建提醒失败: bad cron')).toBe('创建提醒失败: bad cron')
    const long = 'x'.repeat(200)
    expect(errorSummaryLine(long)).toHaveLength(121)
    expect(errorSummaryLine(long).endsWith('…')).toBe(true)
    expect(errorSummaryLine('   ')).toBe('')
  })
})
