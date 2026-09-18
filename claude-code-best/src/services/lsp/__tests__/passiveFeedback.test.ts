import { describe, expect, test } from 'bun:test'
import type { PublishDiagnosticsParams } from 'vscode-languageserver-protocol'
import { formatDiagnosticsForAttachment } from '../passiveFeedback.js'

function params(
  diagnostics: PublishDiagnosticsParams['diagnostics'],
  uri = 'file:///tmp/example.ts',
): PublishDiagnosticsParams {
  return { uri, diagnostics }
}

describe('formatDiagnosticsForAttachment', () => {
  test('keeps a string message and maps metadata', () => {
    const files = formatDiagnosticsForAttachment(
      params([
        {
          message: 'plain string diagnostic',
          severity: 2,
          range: {
            start: { line: 3, character: 1 },
            end: { line: 3, character: 8 },
          },
          source: 'ts',
          code: 2304,
        },
      ]),
    )
    expect(files).toHaveLength(1)
    expect(files[0]!.uri).toBe('/tmp/example.ts')
    expect(files[0]!.diagnostics).toEqual([
      {
        message: 'plain string diagnostic',
        severity: 'Warning',
        range: {
          start: { line: 3, character: 1 },
          end: { line: 3, character: 8 },
        },
        source: 'ts',
        code: '2304',
      },
    ])
  })

  test('normalizes MarkupContent plaintext and markdown to .value', () => {
    const files = formatDiagnosticsForAttachment(
      params([
        {
          message: { kind: 'plaintext', value: 'plaintext body' },
          severity: 1,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 4 },
          },
          source: 'eslint',
          code: 'no-undef',
        },
        {
          message: { kind: 'markdown', value: '**markdown** body' },
          severity: 3,
          range: {
            start: { line: 9, character: 2 },
            end: { line: 10, character: 0 },
          },
        },
      ]),
    )
    expect(files[0]!.diagnostics[0]).toEqual({
      message: 'plaintext body',
      severity: 'Error',
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 4 },
      },
      source: 'eslint',
      code: 'no-undef',
    })
    expect(files[0]!.diagnostics[1]).toEqual({
      message: '**markdown** body',
      severity: 'Info',
      range: {
        start: { line: 9, character: 2 },
        end: { line: 10, character: 0 },
      },
      source: undefined,
      code: undefined,
    })
  })

  test('defaults missing severity and omits nullish code', () => {
    const files = formatDiagnosticsForAttachment(
      params([
        {
          message: 'no extras',
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
        },
      ]),
    )
    expect(files[0]!.diagnostics[0]!.severity).toBe('Error')
    expect(files[0]!.diagnostics[0]!.code).toBeUndefined()
    expect(files[0]!.diagnostics[0]!.source).toBeUndefined()
  })
})
