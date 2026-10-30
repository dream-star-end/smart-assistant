import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'
import { assertTurnDispatchReceiptCoverage } from '../lib/turnDispatchReceiptCoverage.js'

const bridge = readFileSync(join(process.cwd(), 'packages/commercial/src/ws/userChatBridge.ts'), 'utf8')
const receipt = readFileSync(join(process.cwd(), 'packages/commercial/src/ws/turnDispatchReceipt.ts'), 'utf8')

function mutate(source: string, before: string, after: string): string {
  assert.ok(source.includes(before), `production fixture anchor must exist: ${before}`)
  const changed = source.replace(before, after)
  assert.notEqual(changed, source)
  const parsed = ts.createSourceFile('mutation.ts', changed, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal((parsed as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length, 0,
    'a coverage negative must preserve valid source syntax')
  return changed
}
const pattern = /\[turn-dispatch-receipt-coverage\]/

describe('extracted turn dispatch receipt source guard', () => {
  it('accepts the production bridge connection and extracted receipt handler', () => {
    assert.doesNotThrow(() => assertTurnDispatchReceiptCoverage(bridge, receipt))
  })
  it('ignores whitespace and comment/string decoys', () => {
    assert.doesNotThrow(() => assertTurnDispatchReceiptCoverage(
      bridge.replace('handleTurnDispatchReceipt(attestPeek,', 'handleTurnDispatchReceipt( attestPeek ,'),
      `${receipt}\n// classifyTurnDispatchReceipt(receipt, rec)\nconst decoy = "if (disposition === rejected)";\n`,
    ))
  })
  it('rejects an import of a different module', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(
      mutate(bridge, "import { handleTurnDispatchReceipt } from './turnDispatchReceipt.js';",
        "import { handleTurnDispatchReceipt } from './unrelatedReceipt.js';"), receipt,
    ), pattern)
  })
  it('rejects a disconnected handler even if its old invocation is left in a comment', () => {
    const changed = mutate(bridge, 'if (handleTurnDispatchReceipt(attestPeek, {', 'if (unrelatedReceipt(attestPeek, {')
    assert.throws(() => assertTurnDispatchReceiptCoverage(`${changed}\n// handleTurnDispatchReceipt(attestPeek, {})\n`, receipt), pattern)
  })
  it('rejects a disconnected admitted-record lookup context', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(
      mutate(bridge, 'pool: deps.pgPool, uid, admittedDispatches, enrichmentDispatches,',
        'pool: deps.pgPool, uid, admittedDispatches: unrelatedDispatches, enrichmentDispatches,'), receipt,
    ), pattern)
  })
  it('rejects a handler result that no longer consumes internal receipts', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(
      mutate(bridge, 'if (handleTurnDispatchReceipt(attestPeek, {', 'if (!handleTurnDispatchReceipt(attestPeek, {'), receipt,
    ), pattern)
  })
  it('rejects classifier markers hidden in comments or strings', () => {
    const changed = mutate(receipt, 'const disposition = classifyTurnDispatchReceipt(receipt, rec)', 'const disposition = unrelatedClassifier(receipt, rec)')
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      `${changed}\n// classifyTurnDispatchReceipt(receipt, rec)\nconst decoy = "classifyTurnDispatchReceipt(receipt, rec)";\n`), pattern)
  })
  it('rejects a lost rejected-receipt branch', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      mutate(receipt, "if (disposition === 'rejected') {", "if (disposition === 'invalid') {")), pattern)
  })
  it('rejects a lost durable rejection convergence', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      mutate(receipt, 'await casToTerminal(pool, {', 'await unrelatedTerminal(pool, {')), pattern)
  })
  it('rejects a definitive container rejection being released to the same recovery identity', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      mutate(receipt, 'persisted = await casToTerminal(pool, {',
        'await releaseRecoveryPreReceipt(pool, {}); persisted = await casToTerminal(pool, {')), pattern)
  })
  it('rejects weakening a terminal rejection into a different recovery outcome', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      mutate(receipt, "outcome: 'not_accepted', failureCode: 'DISPATCH_NOT_ACCEPTED'",
        "outcome: 'not_accepted', failureCode: 'OTHER_REJECTION'")), pattern)
  })
  it('rejects an enrichment fence that no longer stops a terminalized turn', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge,
      mutate(receipt, 'if (!context.acceptEnrichmentReceipt(rec)) return true', 'context.acceptEnrichmentReceipt(rec)')), pattern)
  })
  it('rejects malformed source instead of accepting a partial parse', () => {
    assert.throws(() => assertTurnDispatchReceiptCoverage(bridge, `${receipt}\nconst broken = (`), pattern)
  })
})
