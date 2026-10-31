/**
 * OCV5-704: figcheck vision-round ledger and turn-id resolution.
 *
 * The CLI integration cases live in ocFigCheckSpec.test.ts. These cover the
 * pure helpers: which id counts, how the ledger splits images and turns, and
 * the sentence the agent sees once the cap is hit.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import {
  figcheckCapHint,
  figcheckRoundsDir,
  figcheckTurnIdEnv,
  peekFigcheckVisionRounds,
  recordFigcheckVisionRound,
  resolveFigcheckTurnId,
} from '../figcheckRounds.js'

const KEY = 'cd'.repeat(32)

function ledgerPath(dir: string, turnId: string): string {
  return join(dir, `${createHash('sha256').update(turnId).digest('hex')}.json`)
}

describe('figcheckTurnIdEnv', () => {
  test('64-hex turn key is forwarded; anything else clears the id', () => {
    const key = 'ab'.repeat(32)
    assert.deepEqual(figcheckTurnIdEnv(key), { OC_FIGCHECK_TURN_ID: key })
    assert.deepEqual(figcheckTurnIdEnv('turn-key'), { OC_FIGCHECK_TURN_ID: '' })
    assert.deepEqual(figcheckTurnIdEnv(undefined), { OC_FIGCHECK_TURN_ID: '' })
    assert.deepEqual(figcheckTurnIdEnv(key.toUpperCase()), { OC_FIGCHECK_TURN_ID: '' })
  })
})

describe('resolveFigcheckTurnId', () => {
  test('explicit id wins over metadata', () => {
    const id = resolveFigcheckTurnId({
      OC_FIGCHECK_TURN_ID: 'turn-cap-main',
      CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: KEY }),
    })
    assert.equal(id, 'turn-cap-main')
  })

  test('empty explicit falls through to a 64-hex oc_turn_key', () => {
    const id = resolveFigcheckTurnId({
      OC_FIGCHECK_TURN_ID: '   ',
      CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: KEY }),
    })
    assert.equal(id, KEY)
  })

  test('invalid explicit falls through; malformed metadata is not an id', () => {
    assert.equal(
      resolveFigcheckTurnId({
        OC_FIGCHECK_TURN_ID: 'has space',
        CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: KEY }),
      }),
      KEY,
    )
    assert.equal(
      resolveFigcheckTurnId({
        OC_FIGCHECK_TURN_ID: '',
        CLAUDE_CODE_EXTRA_METADATA: '{',
      }),
      null,
    )
    assert.equal(resolveFigcheckTurnId({}), null)
    assert.equal(
      resolveFigcheckTurnId({
        CLAUDE_CODE_EXTRA_METADATA: JSON.stringify({ oc_turn_key: 'short' }),
      }),
      null,
    )
  })
})

describe('figcheckCapHint', () => {
  test('tells the agent to deliver and explains why', () => {
    const hint = figcheckCapHint(3, 2)
    assert.match(hint, /^已达上限，按当前结果交付/)
    assert.match(hint, /不再做视觉复核/)
    assert.match(hint, /原因：/)
    assert.match(hint, /2 项未过/)
    assert.match(figcheckCapHint(3, 0), /确定性检查没有新的硬伤/)
  })
})

describe('figcheckRoundsDir', () => {
  test('prefers OPENCLAUDE_HOME over HOME', () => {
    assert.equal(
      figcheckRoundsDir({ OPENCLAUDE_HOME: '/oc-home', HOME: '/other' }),
      '/oc-home/figcheck-rounds',
    )
    assert.equal(figcheckRoundsDir({ HOME: '/other' }), '/other/figcheck-rounds')
  })
})

describe('vision round ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'figcheck-rounds-'))
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('counts per image path and per turn', () => {
    const image = '/uploads/a.png'
    const otherImage = '/uploads/b.png'
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-a', image), 0)
    assert.equal(recordFigcheckVisionRound(dir, 'turn-a', image), 1)
    assert.equal(recordFigcheckVisionRound(dir, 'turn-a', image), 2)
    assert.equal(recordFigcheckVisionRound(dir, 'turn-a', otherImage), 1)
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-a', image), 2)
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-b', image), 0)
    assert.equal(recordFigcheckVisionRound(dir, 'turn-b', image), 1)
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-a', image), 2)
  })

  test('a corrupt ledger counts as empty and a later record starts at 1', () => {
    writeFileSync(ledgerPath(dir, 'turn-corrupt'), 'not-json')
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-corrupt', '/uploads/a.png'), 0)
    assert.equal(recordFigcheckVisionRound(dir, 'turn-corrupt', '/uploads/a.png'), 1)
  })

  test('drops non-integer counts', () => {
    writeFileSync(
      ledgerPath(dir, 'turn-bad'),
      JSON.stringify({ images: { '/x.png': 1.5, '/y.png': -1, '/z.png': 2 } }),
    )
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-bad', '/x.png'), 0)
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-bad', '/z.png'), 2)
  })

  test('record drops ledgers older than 48h', () => {
    const stale = ledgerPath(dir, 'turn-stale')
    writeFileSync(stale, JSON.stringify({ images: { '/old.png': 2 } }))
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000)
    utimesSync(stale, old, old)
    recordFigcheckVisionRound(dir, 'turn-fresh', '/new.png')
    assert.equal(existsSync(stale), false)
    assert.equal(peekFigcheckVisionRounds(dir, 'turn-fresh', '/new.png'), 1)
  })
})
