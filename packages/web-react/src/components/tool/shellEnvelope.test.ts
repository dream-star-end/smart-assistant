import { describe, expect, test } from 'vitest'
import {
  cursorCliStreams,
  isCursorShellEnvelope,
  isShellResultObject,
  parseShellEnvelope,
  shellOutputReportsNonzeroExit,
  stripCommandEcho,
} from './shellEnvelope'

describe('parseShellEnvelope:Cursor shell 信封的唯一解包权威(T-03)', () => {
  test('严格信封 {success:{…}, isBackground?} → stdout/stderr/exitCode/background', () => {
    const env = parseShellEnvelope(
      JSON.stringify({
        success: { command: 'npm test', exitCode: 1, stdout: '1 passed\n', stderr: '1 failed' },
        isBackground: true,
      }),
    )
    expect(env).toEqual({ stdout: '1 passed\n', stderr: '1 failed', exitCode: 1, background: true })
  })

  test('裸 shell 结果对象(键名大小写/下划线容错)也解;缺 exitCode → null', () => {
    expect(
      parseShellEnvelope(JSON.stringify({ command: 'x', exit_code: 0, stdout: 'ok' })),
    ).toEqual({
      stdout: 'ok',
      stderr: '',
      exitCode: 0,
      background: false,
    })
    expect(parseShellEnvelope(JSON.stringify({ Command: 'x', StdErr: 'e' }))?.exitCode).toBeNull()
  })

  test('不是信封的 JSON / 非 JSON / 顶层多余键 → null(带 stdout 键的普通 JSON 当不透明正文)', () => {
    expect(parseShellEnvelope(JSON.stringify({ stdout: 'x' }))).toBeNull()
    expect(
      parseShellEnvelope(JSON.stringify({ success: { command: 'x', exitCode: 0 }, extra: 1 })),
    ).toBeNull()
    expect(
      parseShellEnvelope(JSON.stringify({ output: '/tmp/report.pdf', references: 3 })),
    ).toBeNull()
    expect(parseShellEnvelope('plain text')).toBeNull()
    expect(parseShellEnvelope('{not json')).toBeNull()
    expect(parseShellEnvelope(null)).toBeNull()
    expect(parseShellEnvelope(undefined)).toBeNull()
  })

  test('isCursorShellEnvelope / isShellResultObject 形状判定', () => {
    expect(isCursorShellEnvelope({ success: { command: 'x' } })).toBe(true)
    expect(isCursorShellEnvelope({ success: { command: 'x' }, isBackground: 'yes' })).toBe(false)
    expect(isCursorShellEnvelope({ success: 'x' })).toBe(false)
    expect(isShellResultObject({ command: 'x', stdout: '' })).toBe(true)
    expect(isShellResultObject({ command: 'x' })).toBe(false)
    expect(isShellResultObject({ stdout: 'x' })).toBe(false)
  })

  test('shellOutputReportsNonzeroExit 只认数字且非 0 的退出码', () => {
    expect(
      shellOutputReportsNonzeroExit(JSON.stringify({ success: { command: 'x', exitCode: 1 } })),
    ).toBe(true)
    expect(
      shellOutputReportsNonzeroExit(JSON.stringify({ success: { command: 'x', exitCode: 0 } })),
    ).toBe(false)
    expect(
      shellOutputReportsNonzeroExit(JSON.stringify({ success: { command: 'x', exitCode: '1' } })),
    ).toBe(false)
    expect(shellOutputReportsNonzeroExit('exit 1')).toBe(false)
  })
})

describe('cursorCliStreams(oc-* 卡取流口径)', () => {
  test('信封 → 两路流;命令回显与外部内容标记先剥掉;非信封整段作 stdout', () => {
    expect(
      cursorCliStreams(
        `$ oc-memory delegate\n${JSON.stringify({ success: { command: 'x', exitCode: 0, stdout: 'done', stderr: 'warn' } })}`,
      ),
    ).toEqual({ stdout: 'done', stderr: 'warn' })
    expect(cursorCliStreams('[外部内容开始 · x]\nhello\n[外部内容结束]')).toEqual({
      stdout: 'hello',
      stderr: '',
    })
    expect(cursorCliStreams(null)).toEqual({ stdout: '', stderr: '' })
    expect(cursorCliStreams('   ')).toEqual({ stdout: '', stderr: '' })
  })

  test('stripCommandEcho 只剥首行 `$ …`', () => {
    expect(stripCommandEcho('$ ls\na\nb')).toBe('a\nb')
    expect(stripCommandEcho('a\n$ ls')).toBe('a\n$ ls')
  })
})
