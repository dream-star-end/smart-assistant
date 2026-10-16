// Large source file ratchet (FINDINGS §7 / ARC-3): fixed baseline + small allowance.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  type Baseline,
  baselineRaises,
  evaluate,
  isRatchetSource,
  lineCount,
  validateExceptions,
} from '../check-file-size-ratchet.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const tsx = path.join(root, 'node_modules/.bin/tsx')
const B: Baseline = { limit: 3000, slack: 100, files: { 'big.ts': 5000 } }

describe('pure rules', () => {
  test('source filter: TS/TSX/JS/shell in, tests/generated/fork out', () => {
    assert.equal(isRatchetSource('packages/gateway/src/server.ts'), true)
    assert.equal(isRatchetSource('packages/web-react/src/App.tsx'), true)
    assert.equal(isRatchetSource('scripts/deploy-v5-selfhost.sh'), true)
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

  test('a baseline file may grow up to baseline + slack in total, not beyond', () => {
    assert.deepEqual(evaluate([{ path: 'big.ts', head: 5100 }], B, new Map()), [])
    assert.deepEqual(
      evaluate([{ path: 'big.ts', head: 5101 }], B, new Map()).map((v) => [v.kind, v.allowed]),
      [['over-baseline', 5100]],
    )
  })

  test('files not on the baseline may not cross the limit', () => {
    assert.deepEqual(evaluate([{ path: 'small.ts', head: 3000 }], B, new Map()), [])
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
          expires: '2026-10-20',
        },
      ],
    ])
    assert.deepEqual(evaluate([{ path: 'big.ts', head: 5300 }], B, ex), [])
    assert.equal(evaluate([{ path: 'big.ts', head: 5301 }], B, ex).length, 1)
  })

  test('the baseline may only go down', () => {
    assert.deepEqual(baselineRaises(B, { ...B, files: { 'big.ts': 4000 } }), [])
    assert.deepEqual(baselineRaises(B, { ...B, files: {} }), [])
    assert.equal(baselineRaises(B, { ...B, files: { 'big.ts': 5001 } }).length, 1)
    assert.equal(baselineRaises(B, { ...B, files: { 'big.ts': 5000, 'other.ts': 4000 } }).length, 1)
    assert.equal(baselineRaises(B, { ...B, slack: 200 }).length, 1)
  })

  test('exceptions need ticket, reason and an expiry within 30 days', () => {
    const today = '2026-10-16'
    const good = {
      path: 'a.ts',
      maxLines: 4000,
      ticket: 'OCV5-9',
      reason: 'split in progress',
      expires: '2026-10-30',
    }
    assert.equal(validateExceptions([good], today).ok.size, 1)
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...good, ticket: 'none' }, /ticket/],
      [{ ...good, reason: 'x' }, /reason/],
      [{ ...good, expires: '2026-10-01' }, /expired/],
      [{ ...good, expires: '2027-01-01' }, /30 days/],
      [{ ...good, maxLines: 0 }, /maxLines/],
    ]
    for (const [entry, re] of cases) {
      const r = validateExceptions([entry], today)
      assert.equal(r.ok.size, 0, JSON.stringify(entry))
      assert.match(r.problems.map((p) => p.message).join('\n'), re)
    }
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
    write('src/small.ts', lines(10))
    write(
      '.github/file-size-baseline.json',
      JSON.stringify({ limit: 3000, slack: 100, files: { 'src/big.ts': 3500 } }),
    )
    write('.github/file-size-ratchet-exceptions.json', '[]\n')
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    commit()
    git('tag', 'base')
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('a small fix inside the allowance passes; going past baseline + slack fails', () => {
    write('src/big.ts', lines(3520))
    commit()
    assert.equal(cli('--base', 'base').status, 0)
    write('src/big.ts', lines(3601))
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /::error file=src\/big\.ts::.*cap is 3600/)
  })

  test('a new file over the limit fails; a dated exception in the PR lets it through', () => {
    write('src/new.ts', lines(3100))
    commit()
    assert.equal(cli('--base', 'base').status, 1)
    const expires = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    write(
      '.github/file-size-ratchet-exceptions.json',
      JSON.stringify([
        {
          path: 'src/new.ts',
          maxLines: 3100,
          ticket: 'OCV5-1',
          reason: 'generated table, split next',
          expires,
        },
      ]),
    )
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 0, r.out)
  })

  test('raising the baseline in a PR fails', () => {
    write(
      '.github/file-size-baseline.json',
      JSON.stringify({ limit: 3000, slack: 100, files: { 'src/big.ts': 3900 } }),
    )
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /may only go down/)
  })

  test('after a split, --update-baseline lowers the entry and drops files under the limit', () => {
    write('src/big.ts', lines(3200))
    assert.equal(cli('--update-baseline').status, 0)
    let b = JSON.parse(readFileSync(path.join(repo, '.github/file-size-baseline.json'), 'utf8'))
    assert.deepEqual(b.files, { 'src/big.ts': 3200 })
    write('src/big.ts', lines(2900))
    assert.equal(cli('--update-baseline').status, 0)
    b = JSON.parse(readFileSync(path.join(repo, '.github/file-size-baseline.json'), 'utf8'))
    assert.deepEqual(b.files, {})
    commit()
    assert.equal(cli('--base', 'base').status, 0)
  })

  test('a stale exception for an untouched file only warns', () => {
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
    write('src/模块.ts', lines(3001))
    commit()
    const r = cli('--base', 'base')
    assert.equal(r.status, 1, r.out)
    assert.match(r.out, /src\/模块\.ts/)
  })

  test('a bad base ref is a usage error', () => {
    assert.equal(cli('--base', 'nope').status, 2)
  })
})
