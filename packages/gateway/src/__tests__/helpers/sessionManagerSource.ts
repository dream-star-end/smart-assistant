/**
 * sessionManager.ts plus the modules split out of it (FINDINGS §7.6 M1/M2). Source-reading guard
 * tests that assert "the session manager does X" read this instead of sessionManager.ts alone, so
 * moving code between these files keeps the guard meaningful. Add each new split-out module here.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const gatewaySrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const SESSION_MANAGER_SOURCE_FILES: readonly string[] = [
  'sessionManager.ts',
  'sessionTurnRunner.ts',
  'sessionSubmit.ts',
]

export function readSessionManagerSource(): string {
  return SESSION_MANAGER_SOURCE_FILES.map((f) => readFileSync(join(gatewaySrc, f), 'utf8')).join(
    '\n',
  )
}

/**
 * The implementation of a SessionManager method: the `export [async] function name(` a split-out
 * module holds (the class keeps a one-line forwarder), else the class method in sessionManager.ts.
 */
export function sessionManagerMethodBody(name: string): string {
  for (const f of SESSION_MANAGER_SOURCE_FILES.filter((x) => x !== 'sessionManager.ts')) {
    const src = readFileSync(join(gatewaySrc, f), 'utf8')
    const m = new RegExp(`^export (?:async )?function ${name}\\(`, 'm').exec(src)
    if (!m) continue
    const rest = src.slice(m.index + m[0].length)
    const next =
      /^(?:export |function |async function |const |let |class |interface |type |\/\*\*)/m.exec(
        rest,
      )
    return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
  }
  const src = readFileSync(join(gatewaySrc, 'sessionManager.ts'), 'utf8')
  const m = new RegExp(`^ {2}(?:private |public |protected )?(?:async )?${name}\\(`, 'm').exec(src)
  if (!m) throw new Error(`method ${name} not found in the session manager source set`)
  const rest = src.slice(m.index + m[0].length)
  const next = /^ {2}(?:private|public|protected|async|static)\b/m.exec(rest)
  return src.slice(m.index, next ? m.index + m[0].length + next.index : src.length)
}
