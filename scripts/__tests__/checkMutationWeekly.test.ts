import * as assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  applyMutantToSource,
  generateAstMutants,
  isEligibleT2CoreFile,
  main,
  runWeeklyMutationCheck,
} from '../check-mutation-weekly.js'

describe('check-mutation-weekly: AST mutation & isolated execution', () => {
  it('generates targeted AST mutants without mutating comments, strings, or type annotations', () => {
    const src = [
      'export interface GuardConfig {',
      '  readonly enabled: boolean',
      '}',
      '// comment with a >= b && c === true must never be mutated',
      'export function canDebit(balance: number, cost: number, active: boolean): boolean {',
      '  const msg = "balance >= cost && active === true"',
      '  void msg',
      '  if (active && balance >= cost) {',
      '    return true',
      '  }',
      '  return false',
      '}',
    ].join('\n')

    const mutants = generateAstMutants('packages/commercial/src/billing/demo.ts', src, 20)
    assert.ok(mutants.length >= 4, `expected >=4 AST mutants, got ${mutants.length}`)
    assert.ok(mutants.every((m) => m.line >= 8), 'comments, types, and string literals must not be mutated')
    assert.ok(mutants.some((m) => m.operator === 'logical_and_to_or'))
    assert.ok(mutants.some((m) => m.operator === 'boundary_gte_to_gt'))
    assert.ok(mutants.some((m) => m.operator === 'if_cond_negate'))
    assert.ok(mutants.some((m) => m.operator === 'bool_true_to_false'))

    const boundaryMutant = mutants.find((m) => m.operator === 'boundary_gte_to_gt')!
    const mutated = applyMutantToSource(src, boundaryMutant)
    assert.ok(mutated.includes('if (active && balance > cost)'))
  })

  it('filters T2 core paths accurately', () => {
    assert.equal(isEligibleT2CoreFile('packages/commercial/src/billing/spend.ts'), true)
    assert.equal(isEligibleT2CoreFile('packages/gateway/src/delegateCutover.ts'), true)
    assert.equal(isEligibleT2CoreFile('packages/storage/src/sessionFileIo.ts'), true)
    assert.equal(isEligibleT2CoreFile('packages/commercial/src/billing/__tests__/spend.test.ts'), false)
    assert.equal(isEligibleT2CoreFile('packages/web-react/src/App.tsx'), false)
  })

  it('supports --dry-run JSON reporting without executing tests', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-mut-dry-'))
    try {
      mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true })
      writeFileSync(
        path.join(dir, 'src/guard.ts'),
        'export function allow(x: number): boolean { return x >= 10 }\n',
      )
      writeFileSync(
        path.join(dir, 'src/__tests__/guard.test.ts'),
        "import assert from 'node:assert/strict'\nimport { test } from 'node:test'\nimport { allow } from '../guard.js'\ntest('ok', () => assert.equal(allow(10), true))\n",
      )
      const report = runWeeklyMutationCheck({
        root: dir,
        files: ['src/guard.ts'],
        dryRun: true,
      })
      assert.equal(report.dryRun, true)
      assert.equal(report.passed, true)
      assert.ok(report.totalMutants >= 1)
      assert.ok(report.mutants.every((m) => m.status === 'dry_run'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills mutants under strong boundary tests and catches surviving mutants under weak tests without touching source files', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-mut-real-'))
    try {
      mkdirSync(path.join(dir, 'src/__tests__'), { recursive: true })
      const sourcePath = path.join(dir, 'src/budgetGuard.ts')
      const originalSource = [
        'export function withinBudget(balance: number, cost: number): boolean {',
        '  if (balance >= cost) {',
        '    return true',
        '  }',
        '  return false',
        '}',
        '',
      ].join('\n')
      writeFileSync(sourcePath, originalSource, 'utf8')

      // Strong test suite: checks exact boundary balance === cost, above, and below.
      const strongTest = path.join(dir, 'src/__tests__/budgetGuard.strong.test.ts')
      writeFileSync(
        strongTest,
        [
          "import * as assert from 'node:assert/strict'",
          "import { test } from 'node:test'",
          "import { withinBudget } from '../budgetGuard.js'",
          "test('strong boundary checks', () => {",
          '  assert.equal(withinBudget(10, 10), true)',
          '  assert.equal(withinBudget(11, 10), true)',
          '  assert.equal(withinBudget(9, 10), false)',
          '})',
          '',
        ].join('\n'),
        'utf8',
      )

      const strongReport = runWeeklyMutationCheck({
        root: dir,
        files: ['src/budgetGuard.ts'],
        testFilesOverride: ['src/__tests__/budgetGuard.strong.test.ts'],
        minScore: 1.0,
        maxMutants: 10,
      })
      assert.equal(strongReport.passed, true, `expected strong tests to kill 100% of mutants: ${JSON.stringify(strongReport)}`)
      assert.equal(strongReport.survived, 0)
      assert.equal(strongReport.mutationScore, 1)

      // Weak test suite: never tests exact boundary `balance === cost`, so `>=` -> `>` survives!
      const weakTest = path.join(dir, 'src/__tests__/budgetGuard.weak.test.ts')
      writeFileSync(
        weakTest,
        [
          "import * as assert from 'node:assert/strict'",
          "import { test } from 'node:test'",
          "import { withinBudget } from '../budgetGuard.js'",
          "test('weak non-boundary check', () => {",
          '  assert.equal(withinBudget(100, 10), true)',
          '  assert.equal(withinBudget(0, 10), false)',
          '})',
          '',
        ].join('\n'),
        'utf8',
      )

      const weakReport = runWeeklyMutationCheck({
        root: dir,
        files: ['src/budgetGuard.ts'],
        testFilesOverride: ['src/__tests__/budgetGuard.weak.test.ts'],
        minScore: 1.0,
        maxMutants: 10,
      })
      assert.equal(weakReport.passed, false, 'weak test missing boundary assertion must fail 100% threshold')
      assert.ok(
        weakReport.mutants.some((m) => m.operator === 'boundary_gte_to_gt' && m.status === 'survived'),
        `expected >= to > mutant to survive weak test: ${JSON.stringify(weakReport.mutants)}`,
      )

      // CLI exit code 1 when min-score threshold is not met.
      const rc = main([
        '--root',
        dir,
        '--files',
        'src/budgetGuard.ts',
        '--test-files',
        'src/__tests__/budgetGuard.weak.test.ts',
        '--min-score',
        '1.0',
      ])
      assert.equal(rc, 1)

      // Working tree source file must remain 100% untouched!
      assert.equal(readFileSync(sourcePath, 'utf8'), originalSource)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
