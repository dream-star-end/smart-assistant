import { describe, expect, test } from 'bun:test'

import {
  normalizeBackgroundCommand,
  normalizeBashInput,
} from '../bashCommandNormalize'

describe('normalizeBackgroundCommand', () => {
  // ─── No-op when run_in_background is not true ─────────────────────
  test('returns command unchanged when run_in_background is undefined', () => {
    expect(normalizeBackgroundCommand('sleep 5 &', undefined)).toBe(
      'sleep 5 &',
    )
  })

  test('returns command unchanged when run_in_background is false', () => {
    expect(normalizeBackgroundCommand('sleep 5 &', false)).toBe('sleep 5 &')
  })

  // ─── Strips trailing `&` when run_in_background:true ──────────────
  test('strips trailing " &"', () => {
    expect(
      normalizeBackgroundCommand(
        'for i in $(seq 1 10); do echo $i; sleep 1; done &',
        true,
      ),
    ).toBe('for i in $(seq 1 10); do echo $i; sleep 1; done')
  })

  test('strips trailing "  &" with multiple spaces', () => {
    expect(normalizeBackgroundCommand('echo hi  &', true)).toBe('echo hi')
  })

  test('strips trailing "& " with trailing whitespace', () => {
    expect(normalizeBackgroundCommand('echo hi &  ', true)).toBe('echo hi')
  })

  test('strips trailing "&\\n"', () => {
    expect(normalizeBackgroundCommand('echo hi &\n', true)).toBe('echo hi')
  })

  test('strips when "&" follows a redirection like 2>&1', () => {
    // The middle 2>&1 must not be touched; only the final `&` is stripped.
    expect(normalizeBackgroundCommand('cmd 2>&1 &', true)).toBe('cmd 2>&1')
  })

  // ─── Conservatism: does NOT strip when no whitespace before `&` ───
  test('does NOT strip compact "cmd&" form', () => {
    // Documented limitation: avoids potentially mishandling shell tokens
    // that end with `&` adjacent to a non-whitespace character.
    expect(normalizeBackgroundCommand('sleep 1&', true)).toBe('sleep 1&')
  })

  test('does NOT strip a literal & inside quotes (not at end)', () => {
    expect(normalizeBackgroundCommand('echo "x &"', true)).toBe('echo "x &"')
  })

  // ─── Compound `&` use is left alone (only trailing position) ──────
  test('does not touch interior `&` (compound: cmd1 & cmd2)', () => {
    expect(normalizeBackgroundCommand('cmd1 & cmd2', true)).toBe('cmd1 & cmd2')
  })

  test('only strips the FINAL trailing `&` in compound `cmd1 & cmd2 &`', () => {
    // Known partial coverage: cmd1 still backgrounded by its own `&`. This
    // is better than the original bug (everything backgrounded → tail lost),
    // and a complete shell-aware fix is out of scope.
    expect(normalizeBackgroundCommand('cmd1 & cmd2 &', true)).toBe(
      'cmd1 & cmd2',
    )
  })

  // ─── No-op when no trailing `&` ───────────────────────────────────
  test('returns command unchanged when there is no trailing `&`', () => {
    expect(normalizeBackgroundCommand('echo hello', true)).toBe('echo hello')
  })

  test('returns command unchanged when `&&` is at the end (logical AND)', () => {
    // `&&` is not a background operator; we must not strip part of it.
    // The regex requires `\s+&\s*$`, so `&&` at end (no whitespace before
    // the final `&`) is not matched.
    expect(normalizeBackgroundCommand('a && b', true)).toBe('a && b')
  })

  // ─── Misc whitespace forms ────────────────────────────────────────
  test('strips trailing tab + `&`', () => {
    expect(normalizeBackgroundCommand('echo hi\t&', true)).toBe('echo hi')
  })

  test('strips trailing `&` followed by CRLF', () => {
    expect(normalizeBackgroundCommand('echo hi &\r\n', true)).toBe('echo hi')
  })
})

describe('normalizeBashInput', () => {
  test('returns the same reference when nothing to strip', () => {
    const input = { command: 'echo hi', run_in_background: true }
    expect(normalizeBashInput(input)).toBe(input)
  })

  test('returns a new object with normalized command when stripping', () => {
    const input = {
      command: 'echo hi &',
      run_in_background: true,
      description: 'demo',
    }
    const out = normalizeBashInput(input)
    expect(out).not.toBe(input)
    expect(out.command).toBe('echo hi')
    expect(out.description).toBe('demo')
    expect(out.run_in_background).toBe(true)
    // raw input untouched
    expect(input.command).toBe('echo hi &')
  })

  test('does not strip when run_in_background is undefined', () => {
    const input = { command: 'echo hi &' }
    expect(normalizeBashInput(input)).toBe(input)
  })

  test('preserves extra fields', () => {
    const input = {
      command: 'echo hi &',
      run_in_background: true,
      timeout: 30000,
      dangerouslyDisableSandbox: false,
    }
    const out = normalizeBashInput(input)
    expect(out.timeout).toBe(30000)
    expect(out.dangerouslyDisableSandbox).toBe(false)
  })
})
