import { describe, expect, test } from 'bun:test'
import {
  extractOutputRedirections,
  filterControlOperators,
  isUnsafeCompoundCommand_DEPRECATED,
  splitCommand_DEPRECATED,
} from '../commands.js'

describe('filterControlOperators', () => {
  test('strips supported operators and keeps command words', () => {
    expect(
      filterControlOperators([
        'echo',
        '&&',
        'ls',
        '||',
        'cat',
        ';',
        'true',
        ';;',
        'false',
        '|',
        'wc',
        '>&',
        '2',
        '>',
        'out',
        '>>',
        'log',
      ]),
    ).toEqual(['echo', 'ls', 'cat', 'true', 'false', 'wc', '2', 'out', 'log'])
  })

  test('keeps tokens that are not operators', () => {
    expect(filterControlOperators(['echo', 'hello-world', '$(date)'])).toEqual([
      'echo',
      'hello-world',
      '$(date)',
    ])
    expect(filterControlOperators(['&', '|&', '<'])).toEqual(['&', '|&', '<'])
  })
})

describe('isUnsafeCompoundCommand_DEPRECATED', () => {
  test('allows a parsed command list of supported separators', () => {
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a && echo b')).toBe(false)
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a || echo b')).toBe(false)
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a; echo b')).toBe(false)
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a | cat')).toBe(false)
  })

  test('allows a single simple command', () => {
    expect(isUnsafeCompoundCommand_DEPRECATED('echo hello')).toBe(false)
    expect(splitCommand_DEPRECATED('echo hello')).toEqual(['echo hello'])
  })

  test('rejects unparsable input and unsupported operators', () => {
    expect(isUnsafeCompoundCommand_DEPRECATED('echo $((')).toBe(true)
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a & echo b')).toBe(true)
    expect(isUnsafeCompoundCommand_DEPRECATED('echo a |& echo b')).toBe(true)
  })
})

describe('extractOutputRedirections', () => {
  test('captures simple redirects without executing', () => {
    const extracted = extractOutputRedirections('echo hi > /tmp/a6-out.txt')
    expect(extracted.hasDangerousRedirection).toBe(false)
    expect(extracted.redirections).toEqual([
      { target: '/tmp/a6-out.txt', operator: '>' },
    ])
    expect(extracted.commandWithoutRedirections).toContain('echo')
  })
})
