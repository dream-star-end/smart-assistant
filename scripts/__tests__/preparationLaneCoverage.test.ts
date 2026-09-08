import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'
import { assertPreparationLaneCoverage } from '../lib/preparationLaneCoverage.js'

const source = readFileSync(join(process.cwd(), 'packages/commercial/src/ws/userChatBridge.ts'), 'utf8')
const file = ts.createSourceFile('userChatBridge.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const calls: ts.CallExpression[] = []
function visit(node: ts.Node): void {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'trackPreparation') {
    calls.push(node)
  }
  ts.forEachChild(node, visit)
}
visit(file)
assert.equal(calls.length, 6, 'fixture must locate the six real production calls')

// Independent fixture anchors; do not import the checker's classification table.
const lanes = [
  ['cursor', 'cursorTurnIdentity'],
  ['zcode', 'zcodeTurnIdentity'],
  ['annotated', 'dispatchRecordA'],
  ['codex-grok', 'dispatchRecordB'],
  ['ccb', 'dispatchRecordC'],
  ['identity', 'identityPreparationBytes'],
] as const

function laneCall(marker: string): ts.CallExpression {
  const matches = calls.filter((call) => call.arguments[0]?.getText(file).includes(marker))
  assert.equal(matches.length, 1, `fixture anchor must select exactly one callback: ${marker}`)
  return matches[0]!
}

function callback(call: ts.CallExpression): ts.ArrowFunction {
  const fn = call.arguments[0]!
  assert.ok(ts.isArrowFunction(fn) && ts.isBlock(fn.body))
  return fn
}

function replace(node: ts.Node, text: string): string {
  return source.slice(0, node.getStart(file)) + text + source.slice(node.end)
}

function assertValidMutation(input: string, expectedCalls: number): void {
  const parsed = ts.createSourceFile('mutation.ts', input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const diagnostics = (parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics
  assert.equal(diagnostics.length, 0, 'a coverage negative must be syntactically valid')
  let count = 0
  function countCalls(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'trackPreparation') count += 1
    ts.forEachChild(node, countCalls)
  }
  countCalls(parsed)
  assert.equal(count, expectedCalls, 'mutation call-count precondition')
  assert.notEqual(input, source, 'mutation must change source')
}

function rejects(input: string, expectedCalls: number): void {
  assertValidMutation(input, expectedCalls)
  assert.throws(() => assertPreparationLaneCoverage(input), /\[preparation-lane-coverage\]/)
}

describe('preparation lane coverage', () => {
  it('accepts the six production preparation lanes', () => {
    assert.doesNotThrow(() => assertPreparationLaneCoverage(source))
  })

  it('ignores formatting and comment or string decoys', () => {
    const formatted = source.replaceAll('trackPreparation(async', 'trackPreparation( /* same call */ async')
      + '\n// trackPreparation(async () => { cursorTurnIdentity; });\n'
      + 'const textDecoy = "trackPreparation(async () => { dispatchRecordB; })";\n'
    assertValidMutation(formatted, 6)
    assert.doesNotThrow(() => assertPreparationLaneCoverage(formatted))
  })

  for (const [lane, marker] of lanes) {
    it(`rejects untracked ${lane} work`, () => {
      const call = laneCall(marker)
      // Preserve the real work and its invocation, remove only its tracking wrapper.
      rejects(replace(call, `(${callback(call).getText(file)})()`), 5)
    })

    it(`rejects empty tracking substituted for ${lane}`, () => {
      const call = laneCall(marker)
      const realWork = `(${callback(call).getText(file)})()`
      const decoy = `trackPreparation(async () => { /* ${marker} */ void '${marker}'; })`
      rejects(replace(call, `(${realWork}, ${decoy})`), 6)
    })

    it(`rejects ${lane} work hidden in an uncalled function`, () => {
      const call = laneCall(marker)
      rejects(replace(call, `trackPreparation(async () => { const neverCalled = ${callback(call).getText(file)}; })`), 6)
    })
  }

  it('rejects an extra tracked callback', () => {
    rejects(source + '\ntrackPreparation(async () => {});\n', 7)
  })

  it('rejects a duplicate lane replacing another lane', () => {
    rejects(replace(laneCall('zcodeTurnIdentity'), laneCall('cursorTurnIdentity').getText(file)), 6)
  })

  it('rejects a non-async tracking callback', () => {
    rejects(replace(laneCall('cursorTurnIdentity'), 'trackPreparation(() => {})'), 6)
  })

  it('rejects malformed source instead of accepting a partial parse', () => {
    assert.throws(() => assertPreparationLaneCoverage(source + '\nconst broken = ('), /\[preparation-lane-coverage\]/)
  })
})
