import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  type AsyncCommand,
  type Command,
  PropertyFailureError,
  assertAsyncProperty,
  assertProperty,
  asyncModelRun,
  createPrng,
  fc,
  modelRun,
  resolvePbtRuns,
} from '../propertyCheck.js'

describe('propertyCheck deterministic PRNG & arbitraries', () => {
  it('produces identical streams for the same seed and diverges across seeds', () => {
    const a = createPrng(20261126)
    const b = createPrng(20261126)
    const c = createPrng(20261127)

    const seqA = Array.from({ length: 50 }, () => a.nextUint32())
    const seqB = Array.from({ length: 50 }, () => b.nextUint32())
    const seqC = Array.from({ length: 50 }, () => c.nextUint32())

    assert.deepEqual(seqA, seqB)
    assert.notDeepEqual(seqA, seqC)
  })

  it('generates values within bounds for integer, nat, bigInt, boolean, string, oneof, array, record, constantFrom', () => {
    const arb = fc.record({
      i: fc.integer({ min: -25, max: 25 }),
      n: fc.nat(100),
      big: fc.bigInt({ min: 10n, max: 10_000_000_000n }),
      flag: fc.boolean(),
      str: fc.string({ minLength: 2, maxLength: 8, alphabet: 'abc' }),
      tag: fc.constantFrom('alpha', 'beta', 'gamma'),
      union: fc.oneof(fc.constant('zero'), fc.integer({ min: 1, max: 9 })),
      list: fc.array(fc.nat(5), { minLength: 1, maxLength: 6 }),
      opt: fc.option(fc.nat(3)),
    })

    const res = assertProperty(
      arb,
      (v) => {
        assert.ok(v.i >= -25 && v.i <= 25)
        assert.ok(v.n >= 0 && v.n <= 100)
        assert.ok(v.big >= 10n && v.big <= 10_000_000_000n)
        assert.equal(typeof v.flag, 'boolean')
        assert.ok(v.str.length >= 2 && v.str.length <= 8 && /^[abc]+$/.test(v.str))
        assert.ok(['alpha', 'beta', 'gamma'].includes(v.tag))
        assert.ok(v.union === 'zero' || (typeof v.union === 'number' && v.union >= 1 && v.union <= 9))
        assert.ok(v.list.length >= 1 && v.list.length <= 6)
        assert.ok(v.opt === null || (v.opt >= 0 && v.opt <= 3))
      },
      { numRuns: 250, seed: 1337 },
    )
    assert.equal(res.numRuns, 250)
  })

  it('shrinks failing scalar counterexamples to minimal boundary and reports reproducible seed', () => {
    let caught: PropertyFailureError<number> | null = null
    try {
      assertProperty(
        fc.integer({ min: 0, max: 10_000 }),
        (n) => {
          assert.ok(n < 42, `expected ${n} < 42`)
        },
        { numRuns: 200, seed: 424242, label: 'less-than-42' },
      )
    } catch (err) {
      caught = err as PropertyFailureError<number>
    }
    assert.ok(caught instanceof PropertyFailureError)
    assert.equal(caught.counterexample, 42)
    assert.equal(caught.seed, 424242)
    assert.match(caught.message, /seed\s*:\s*424242/)
    assert.match(caught.message, /counterexample:\s*42/)

    // Replay with the reported seed reproduces the exact same minimal counterexample.
    assert.throws(
      () =>
        assertProperty(
          fc.integer({ min: 0, max: 10_000 }),
          (n) => n < 42,
          { numRuns: 200, seed: caught!.seed },
        ),
      (err: unknown) =>
        err instanceof PropertyFailureError && err.counterexample === 42 && err.runIndex === caught!.runIndex,
    )
  })

  it('delta-debugs stateful modelRun command sequences to minimal failing trace', () => {
    // Buggy bounded bank account: withdrawal succeeds when amount === balance,
    // EXCEPT a planted bug corrupts state if deposit(>=50) is followed by double-freeze!
    interface Model {
      balance: number
      frozen: boolean
      depositCount: number
    }
    interface Real {
      balance: number
      frozen: boolean
      bugTriggered: boolean
    }

    class DepositCmd implements Command<Model, Real> {
      constructor(readonly amount: number) {}
      check(m: Readonly<Model>): boolean {
        return !m.frozen
      }
      run(m: Model, r: Real): void {
        m.balance += this.amount
        m.depositCount += 1
        r.balance += this.amount
        assert.equal(r.balance, m.balance)
      }
      toString(): string {
        return `Deposit(${this.amount})`
      }
    }

    class FreezeCmd implements Command<Model, Real> {
      check(): boolean {
        return true
      }
      run(m: Model, r: Real): void {
        if (m.frozen && m.balance >= 50) {
          // Planted bug: freezing twice after holding >= 50 zeros balance!
          r.balance = 0
          r.bugTriggered = true
        }
        m.frozen = true
        r.frozen = true
        assert.equal(r.balance, m.balance, 'balance vanished on second freeze')
      }
      toString(): string {
        return 'Freeze()'
      }
    }

    class NoopCmd implements Command<Model, Real> {
      check(): boolean {
        return true
      }
      run(): void {}
      toString(): string {
        return 'Noop()'
      }
    }

    const cmdsArb = fc.commands<Model, Real, Command<Model, Real>>(
      [
        fc.integer({ min: 10, max: 120 }).map((amt) => new DepositCmd(amt)),
        fc.constant(new FreezeCmd()),
        fc.constant(new NoopCmd()),
      ],
      { minLength: 1, maxLength: 30 },
    )

    let caught: PropertyFailureError<Command<Model, Real>[]> | null = null
    try {
      assertProperty(
        cmdsArb,
        (cmds) => {
          modelRun(
            () => ({
              model: { balance: 0, frozen: false, depositCount: 0 },
              real: { balance: 0, frozen: false, bugTriggered: false },
            }),
            cmds,
          )
        },
        { numRuns: 300, seed: 9001, label: 'double-freeze-bug' },
      )
    } catch (err) {
      caught = err as PropertyFailureError<Command<Model, Real>[]>
    }

    assert.ok(caught instanceof PropertyFailureError)
    // Minimal sequence needs 1 deposit (>=50) + 2 freezes = 3 commands (or 2 deposits + 2 freezes = 4 if no single deposit >= 50).
    assert.ok(
      caught.counterexample.length <= 4,
      `expected ddmin shrunk sequence <= 4 commands, got ${caught.counterexample.length}: ${caught.message}`,
    )
    assert.ok(caught.counterexample.length < caught.originalCounterexample.length)
    assert.equal(
      caught.counterexample.filter((c) => c.toString() === 'Noop()').length,
      0,
      'ddmin must eliminate irrelevant Noop commands',
    )
    assert.match(caught.message, /Freeze\(\)/)
  })

  it('supports asyncModelRun with teardown and shrinking', async () => {
    let teardowns = 0
    interface M {
      items: string[]
    }
    interface R {
      items: string[]
    }
    class PushAsync implements AsyncCommand<M, R> {
      constructor(readonly v: string) {}
      check(): boolean {
        return true
      }
      async run(m: M, r: R): Promise<void> {
        await Promise.resolve()
        m.items.push(this.v)
        r.items.push(this.v)
        assert.deepEqual(r.items, m.items)
      }
      toString(): string {
        return `Push(${this.v})`
      }
    }

    const cmdsArb = fc.commands<M, R, AsyncCommand<M, R>>(
      [fc.string({ minLength: 1, maxLength: 4 }).map((s) => new PushAsync(s))],
      { minLength: 1, maxLength: 8 },
    )

    const out = await assertAsyncProperty(
      cmdsArb,
      async (cmds) => {
        await asyncModelRun(
          () => ({ model: { items: [] }, real: { items: [] } }),
          cmds,
          () => {
            teardowns += 1
          },
        )
      },
      { numRuns: 100, seed: 77 },
    )
    assert.equal(out.numRuns, 100)
    assert.equal(teardowns, 100)
  })

  it('resolves PBT_RUNS safely with fallback', () => {
    assert.equal(resolvePbtRuns(200, undefined), 200)
    assert.equal(resolvePbtRuns(200, ''), 200)
    assert.equal(resolvePbtRuns(200, '-5'), 200)
    assert.equal(resolvePbtRuns(200, 'abc'), 200)
    assert.equal(resolvePbtRuns(200, '2000'), 2000)
  })
})
