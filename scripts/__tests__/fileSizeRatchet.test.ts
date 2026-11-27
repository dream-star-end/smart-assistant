// Large source file ratchet (FINDINGS §7 / ARC-3, OCV5-904): zero slack + 800-line new TS/TSX cap.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  type Baseline,
  baselineRaises,
  evaluate,
  exceptionRenewals,
  isApprovedCalibration,
  isRatchetSource,
  isTsProductionFile,
  lineCount,
  sha256Hex,
  validateExceptions,
} from '../check-file-size-ratchet.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const localTsx = path.join(root, 'node_modules/.bin/tsx')
const tsx = existsSync(localTsx) ? localTsx : 'tsx'

const B: Baseline = {
  limit: 3000,
  slack: 0,
  files: { 'big.ts': 5000 },
  yellowZoneLimit: 2000,
  yellowZoneSlack: 0,
  yellowZoneFiles: { 'mid.ts': 2500 },
  orangeZoneLimit: 800,
  orangeZoneSlack: 0,
  orangeZoneFiles: { 'legacy.ts': 1200 },
}

describe('pure rules', () => {
  test('source filter: TS/TSX/JS/shell in, tests/generated/fork out', () => {
    assert.equal(isRatchetSource('packages/gateway/src/server.ts'), true)
    assert.equal(isRatchetSource('packages/web-react/src/App.tsx'), true)
    assert.equal(isRatchetSource('scripts/deploy-v5-selfhost.sh'), true)
    assert.equal(isTsProductionFile('packages/gateway/src/server.ts'), true)
    assert.equal(isTsProductionFile('packages/web-react/src/App.tsx'), true)
    assert.equal(isTsProductionFile('scripts/deploy-v5-selfhost.sh'), false)
    assert.equal(isRatchetSource('packages/web-react/src/lib/chat/chat.test.ts'), false)
    assert.equal(isRatchetSource('packages/gateway/src/__tests__/x.ts'), false)
    assert.equal(isRatchetSource('packages/protocol/dist-types/src/index.d.ts'), false)
    assert.equal(isRatchetSource('claude-code-best/src/main.tsx'), false)
    assert.equal(isRatchetSource('docs/V5_DEV_PLAYBOOK.md'), false)
  })

  test('line count matches wc -l semantics', () => {
    assert.equal(lineCount(''), 0)
    assert.equal(lineCount('a\n'), 1)
    assert.equal(lineCount('a\nb'), 2)
  })

  test('zero slack: red, yellow, and orange baselined files fail on +1 line', () => {
    assert.deepEqual(evaluate([{ path: 'big.ts', head: 5000 }], B, new Map()), [])
    assert.deepEqual(evaluate([{ path: 'big.ts', head: 4990 }], B, new Map()), [])
    assert.deepEqual(
      evaluate([{ path: 'big.ts', head: 5001 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['over-baseline', 5000]],
    )
    assert.deepEqual(
      evaluate([{ path: 'mid.ts', head: 2501 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['over-yellow-zone', 2500]],
    )
    assert.deepEqual(
      evaluate([{ path: 'legacy.ts', head: 1201 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['over-orange-zone', 1200]],
    )
  })

  test('non-zero slack in red, yellow, or orange zone is rejected immediately', () => {
    assert.equal(
      evaluate([], { ...B, slack: 100 }, new Map()).some((v) => v.kind === 'slack-nonzero'),
      true,
    )
    assert.equal(
      evaluate([], { ...B, yellowZoneSlack: 10 }, new Map()).some((v) => v.kind === 'slack-nonzero'),
      true,
    )
    assert.equal(
      evaluate([], { ...B, orangeZoneSlack: 1 }, new Map()).some((v) => v.kind === 'slack-nonzero'),
      true,
    )
  })

  test('new production TS/TSX files have a hard 800-line cap; non-TS files follow yellow/red caps', () => {
    assert.deepEqual(evaluate([{ path: 'src/fresh.ts', head: 800 }], B, new Map()), [])
    assert.deepEqual(evaluate([{ path: 'src/fresh.tsx', head: 800 }], B, new Map()), [])
    assert.deepEqual(
      evaluate([{ path: 'src/fresh.ts', head: 801 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['new-over-orange-zone', 800]],
    )
    assert.deepEqual(
      evaluate([{ path: 'src/fresh.tsx', head: 1500 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['new-over-orange-zone', 800]],
    )
    // Non-TS script under yellowZoneLimit passes
    assert.deepEqual(evaluate([{ path: 'scripts/tool.sh', head: 900 }], B, new Map()), [])
    // Non-TS script crossing yellowZoneLimit fails
    assert.equal(
      evaluate([{ path: 'scripts/tool.sh', head: 2000 }], B, new Map())[0]?.kind,
      'new-over-yellow-zone',
    )
    // Any unlisted file crossing absolute limit fails
    assert.equal(
      evaluate([{ path: 'small.ts', head: 3001 }], B, new Map())[0]?.kind,
      'new-over-limit',
    )
  })

  test('a valid exception allows up to its maxLines only', () => {
    const ex = new Map([
      [
        'big.ts',
        {
          path: 'big.ts',
          maxLines: 5300,
          ticket: 'OCV5-1',
          reason: 'move pending',
          expires: '2026-12-10',
        },
      ],
    ])
    assert.deepEqual(evaluate([{ path: 'big.ts', head: 5300 }], B, ex), [])
    assert.equal(evaluate([{ path: 'big.ts', head: 5301 }], B, ex).length, 1)
  })

  test('the baseline may only go down across red, yellow, and orange zones', () => {
    assert.deepEqual(baselineRaises(B, { ...B, files: { 'big.ts': 4000 } }), [])
    assert.deepEqual(baselineRaises(B, { ...B, files: {} }), [])
    assert.equal(baselineRaises(B, { ...B, files: { 'big.ts': 5001 } }).length, 1)
    assert.equal(baselineRaises(B, { ...B, files: { 'big.ts': 5000, 'other.ts': 4000 } }).length, 1)
    assert.equal(baselineRaises(B, { ...B, slack: 1 }).length, 1)
    assert.equal(baselineRaises(B, { ...B, orangeZoneLimit: 900 }).length, 1)
    assert.equal(baselineRaises(B, { ...B, orangeZoneSlack: 1 }).length, 1)
    assert.equal(
      baselineRaises(B, { ...B, orangeZoneFiles: { 'legacy.ts': 1201 } }).length,
      1,
    )
    assert.equal(
      baselineRaises(B, { ...B, orangeZoneFiles: { 'legacy.ts': 1200, 'brandNew.ts': 900 } })
        .length,
      1,
    )
    // Legitimate demotion from yellow -> orange is allowed
    assert.deepEqual(
      baselineRaises(B, {
        ...B,
        yellowZoneFiles: {},
        orangeZoneFiles: { 'legacy.ts': 1100, 'mid.ts': 1900 },
      }),
      [],
    )
  })

  test('yellow/orange/css protection cannot be removed or loosened', () => {
    const baseFull: Baseline = {
      ...B,
      cssFiles: { 'studio.css': 3074 },
    }
    const { yellowZoneSlack: _ys, ...withoutYellowSlack } = baseFull
    const { orangeZoneSlack: _os, ...withoutOrangeSlack } = baseFull
    const { orangeZoneLimit: _ol, ...withoutOrangeLimit } = baseFull
    const { orangeZoneFiles: _of, ...withoutOrangeFiles } = baseFull
    const { cssFiles: _cf, ...withoutCss } = baseFull
    assert.equal(baselineRaises(baseFull, withoutYellowSlack).length, 1)
    assert.equal(baselineRaises(baseFull, withoutOrangeSlack).length, 1)
    assert.equal(baselineRaises(baseFull, withoutOrangeLimit).length, 1)
    assert.equal(baselineRaises(baseFull, withoutOrangeFiles).length, 1)
    assert.equal(baselineRaises(baseFull, withoutCss).length, 1)
  })

  test('exceptions need ticket, reason, unique path, and expiry within 30 days; renewals are blocked', () => {
    const today = '2026-11-26'
    const good = {
      path: 'a.ts',
      maxLines: 4000,
      ticket: 'OCV5-9',
      reason: 'split in progress',
      expires: '2026-12-10',
    }
    assert.equal(validateExceptions([good], today).ok.size, 1)
    // Duplicate path rejected
    assert.equal(validateExceptions([good, good], today).problems.length, 1)
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, ticket: 'none' }, /ticket/],
      [{ ...good, reason: 'x' }, /reason/],
      [{ ...good, expires: '2026-11-01' }, /expired/],
      [{ ...good, expires: '2027-01-01' }, /30 days/],
      [{ ...good, expires: '2026-02-31' }, /YYYY-MM-DD/],
      [{ ...good, maxLines: 0 }, /maxLines/],
    ]
    for (const [entry, re] of cases) {
      const r = validateExceptions([entry], today)
      assert.equal(r.ok.size, 0, JSON.stringify(entry))
      assert.match(r.problems.map((p) => p.message).join('\n'), re)
    }

    // Renewal / maxLines raise detection
    const renewed = exceptionRenewals([good], [{ ...good, expires: '2026-12-20' }])
    assert.equal(renewed.length, 1)
    assert.equal(renewed[0]?.kind, 'exception-renewed')

    const raised = exceptionRenewals([good], [{ ...good, maxLines: 4100 }])
    assert.equal(raised.length, 1)
    assert.equal(raised[0]?.kind, 'exception-raised')

    // Shortening expiry or lowering maxLines is allowed
    assert.deepEqual(
      exceptionRenewals([good], [{ ...good, expires: '2026-12-05', maxLines: 3900 }]),
      [],
    )
  })

  test('dual-hash approved calibration matches only exact raw bytes', () => {
    const fromRaw = '{"limit":3000,"slack":100,"files":{}}\n'
    const toRaw = '{"limit":3000,"slack":0,"files":{}}\n'
    const anchor = {
      ticket: 'OCV5-904',
      fromBaselineSha256: sha256Hex(fromRaw),
      toBaselineSha256: sha256Hex(toRaw),
    }
    assert.equal(isApprovedCalibration(fromRaw, toRaw, anchor), true)
    assert.equal(isApprovedCalibration(fromRaw, `${toRaw} `, anchor), false)
    assert.equal(isApprovedCalibration(toRaw, toRaw, anchor), false)
  })
})

describe('CLI against a temp git repo', () => {
  let repo: string
  const lines = (n: number) =>
    `${Array.from({ length: n }, (_, i) => `const a${i} = ${i}`).join('\n')}\n`
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout
  }
  const cli = (...args: string[]) => {
    const r = spawnSync(tsx, [path.join(repo, 'scripts/check-file-size-ratchet.ts'), ...args], {
      cwd: repo,
      encoding: 'utf8',
    })
    return { status: r.status, out: `${r.stdout}${r.stderr}` }
  }
  const write = (p: string, text: string) => writeFileSync(path.join(repo, p), text)
  const commit = () => {
    git('add', '-A')
    git('commit', '-qm', 'change')
  }

  beforeEach(() => {
    repo = mkdtempSync(path.join(tmpdir(), 'file-size-ratchet-'))
    for (const d of ['scripts', 'src', '.github']) mkdirSync(path.join(repo, d))
    copyFileSync(
      path.join(root, 'scripts/check-file-size-ratchet.ts'),
      path.join(repo, 'scripts/check-file-size-ratchet.ts'),
    )
    write('src/big.ts', lines(3500))
    write('src/legacy.ts', lines(1200))
    write('src/small.ts', lines(10))
    write(
      '.github/file-size-baseline.json',
      JSON.stringify(
        {
          limit: 3000,
          slack: 0,
          files: { 'src/big.ts': 3500 },
          yellowZoneLimit: 2000,
          yellowZoneSlack: 0,
          yellowZoneFiles: {},
          orangeZoneLimit: 800,
          orangeZoneSlack: 0,
          orangeZoneFiles: { 'src/legacy.ts': 1200 },
        },
        null,
        2,
      ),
    )
    write('.github/file-size-ratchet-exceptions.json', '[]\n')
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    commit()
    git('tag', 'base')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('zero slack: growing a baselined red or orange file by +1 line fails immediately; shrinking passes', () => {
    write('src/big.ts', lines(3501))
    commit()
    const rRed = cli('--base', 'base')
    assert.equal(rRed.status, 1, rRed.out)
    assert.match(rRed.out, /src\/big\.ts.*cap is 3500/)

    // Reset red file and grow orange file by +1
    write('src/big.ts', lines(3490))
    write('src/legacy.ts', lines(1201))
    commit()
    const rOrange = cli('--base', 'base')
    assert.equal(rOrange.status, 1, rOrange.out)
    assert.match(rOrange.out, /src\/legacy\.ts.*cap is 1200/)

    // Shrink both -> passes!
    write('src/legacy.ts', lines(1150))
    commit()
    assert.equal(cli('--base', 'base').status, 0)
  })

  test('new production TS file > 800 lines fails; <= 800 lines passes; dated exception lets overrun through', () => {
    write('src/ok800.ts', lines(800))
    commit()
    assert.equal(cli('--base', 'base').status, 0)

    write('src/new801.ts', lines(801))
    commit()
    const rFail = cli('--base', 'base')
    assert.equal(rFail.status, 1, rFail.out)
    assert.match(rFail.out, /new-over-orange-zone/)

    const expires = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        {
          path: 'src/new801.ts',
          maxLines: 850,
          ticket: 'OCV5-1',
          reason: 'temporary table, split next',
          expires,
        },
      ]),
    )
    commit()
    const rOk = cli('--base', 'base')
    assert.equal(rOk.status, 0, rOk.out)
  })

  test('renewing an existing or expired exception is blocked in --base mode', () => {
    const expires1 = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    const expires2 = new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10)
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        {
          path: 'src/big.ts',
          maxLines: 3550,
          ticket: 'OCV5-2',
          reason: 'initial short-term exception',
          expires: expires1,
        },
      ]),
    )
    commit()
    git('tag', '-f', 'base')

    // Attempt to renew expires1 -> expires2
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        {
          path: 'src/big.ts',
          maxLines: 3550,
          ticket: 'OCV5-2',
          reason: 'attempt auto renewal',
          expires: expires2,
        },
      ]),
    )
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /exception-renewed/)
  })

  test('raising the baseline or setting slack > 0 in a PR fails', () => {
    write(
      '.github/file-size-baseline.json',
      JSON.stringify({
        limit: 3000,
        slack: 100,
        files: { 'src/big.ts': 3500 },
        yellowZoneLimit: 2000,
        yellowZoneSlack: 0,
        yellowZoneFiles: {},
        orangeZoneLimit: 800,
        orangeZoneSlack: 0,
        orangeZoneFiles: { 'src/legacy.ts': 1200 },
      }),
    )
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /slack-nonzero|may only go down/)
  })

  test('after a split, --update-baseline lowers entries and demotes red -> yellow -> orange -> dropped', () => {
    write('src/big.ts', lines(1500))
    write('src/legacy.ts', lines(700))
    assert.equal(cli('--update-baseline').status, 0)
    const b = JSON.parse(readFileSync(path.join(repo, '.github/file-size-baseline.json'), 'utf8'))
    assert.deepEqual(b.files, {})
    assert.deepEqual(b.yellowZoneFiles, {})
    assert.deepEqual(b.orangeZoneFiles, { 'src/big.ts': 1500 })
    commit()
    assert.equal(cli('--base', 'base').status, 0)
  })

  test('a stale exception for an untouched file only warns in --base mode', () => {
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        {
          path: 'src/other.ts',
          maxLines: 4000,
          ticket: 'OCV5-1',
          reason: 'old entry, expired',
          expires: '2020-01-01',
        },
      ]),
    )
    commit()
    git('tag', '-f', 'base')
    write('src/small.ts', lines(30))
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 0, r.out)
    assert.match(r.out, /::warning file=\.github\/file-size-ratchet-exceptions\.json::.*expired/)
  })

  test('non-ASCII file names are checked too (git diff -z)', () => {
    write('src/模块.ts', lines(801))
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /src\/模块\.ts/)
  })

  test('a bad base ref is a usage error', () => {
    assert.equal(cli('--base', 'nope').status, 2)
  })
})
