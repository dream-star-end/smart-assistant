// Built-in assertion judges for the evaluation framework.

import type { Assertion } from '../types.js'

/** Evaluate a single assertion against a result value. Returns null if passed, error string if failed. */
export function evaluate(assertion: Assertion, result: unknown): string | null {
  const { type, value } = assertion
  const str = typeof result === 'string' ? result : JSON.stringify(result)

  switch (type) {
    case 'contains': {
      const needles = Array.isArray(value) ? value : [value]
      for (const needle of needles) {
        if (!str.includes(String(needle))) {
          return `expected result to contain "${needle}", got: ${truncate(str)}`
        }
      }
      return null
    }
    case 'not_contains': {
      const needles = Array.isArray(value) ? value : [value]
      for (const needle of needles) {
        if (str.includes(String(needle))) {
          return `expected result NOT to contain "${needle}", got: ${truncate(str)}`
        }
      }
      return null
    }
    case 'regex': {
      const re = new RegExp(String(value))
      if (!re.test(str)) {
        return `expected result to match /${value}/, got: ${truncate(str)}`
      }
      return null
    }
    case 'exact': {
      if (str !== String(value)) {
        return `expected exact "${value}", got: ${truncate(str)}`
      }
      return null
    }
    case 'truthy': {
      const want = value !== false
      const got = Boolean(result)
      if (got !== want) {
        return `expected ${want ? 'truthy' : 'falsy'}, got: ${truncate(str)}`
      }
      return null
    }
    case 'throws':
      // Handled by the runner directly (checks error message). No-op here.
      return null
    default: {
      // Exhaustive check — all JudgeType variants handled above
      const _exhaustive: never = type
      return `unknown assertion type: ${_exhaustive}`
    }
  }
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + '...' : s
}
