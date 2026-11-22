import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { checkDocsLinks, expandBracePath, formatGateError } from '../check-docs-links.ts'

const tempDirs: string[] = []

function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ocv5-docs-links-'))
  tempDirs.push(dir)

  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  mkdirSync(path.join(dir, 'scripts'), { recursive: true })
  mkdirSync(path.join(dir, 'packages/web-react/src'), { recursive: true })
  mkdirSync(path.join(dir, 'packages/commercial'), { recursive: true })
  mkdirSync(path.join(dir, 'packages/gateway'), { recursive: true })

  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-repo',
        private: true,
        workspaces: ['packages/web-react', 'packages/commercial', 'packages/gateway'],
        scripts: {
          'check:docs-links': 'tsx scripts/check-docs-links.ts',
          'test:web-react': 'vitest run',
          'build:web-react': 'vite build',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(
    path.join(dir, 'packages/web-react/package.json'),
    JSON.stringify(
      {
        name: '@openclaude/web-react',
        scripts: {
          'typecheck:preview': 'tsc -p tsconfig.browser-tests.json',
        },
      },
      null,
      2,
    ),
  )
  writeFileSync(path.join(dir, 'CLAUDE.md'), '# Shared rules\n')
  writeFileSync(path.join(dir, 'scripts/check-docs-links.ts'), '// stub\n')
  writeFileSync(path.join(dir, 'packages/web-react/src/styles.css'), ':root {}\n')
  writeFileSync(path.join(dir, 'packages/web-react/AGENTS.md'), '# Web React\n')
  writeFileSync(path.join(dir, 'packages/commercial/AGENTS.md'), '# Commercial\n')
  writeFileSync(path.join(dir, 'packages/gateway/AGENTS.md'), '# Gateway\n')
  writeFileSync(path.join(dir, 'docs/UI_DESIGN_SYSTEM.md'), '# UI\n')
  writeFileSync(path.join(dir, 'docs/V5_SELFHOST_PLAYBOOK.md'), '# Playbook\n')
  writeFileSync(path.join(dir, '.claude/CLAUDE.md'), 'Read `AGENTS.md` and `CLAUDE.md`.\n')
  writeFileSync(
    path.join(dir, 'AGENTS.md'),
    [
      '# Map',
      'Not container `/opt/openclaude/AGENTS.md`.',
      'See [Playbook](docs/V5_SELFHOST_PLAYBOOK.md) and `docs/UI_DESIGN_SYSTEM.md`.',
      'Scoped: `packages/{web-react,commercial,gateway}/AGENTS.md`.',
      'Styles: `packages/web-react/src/styles.css`.',
      'Glob example: `scripts/check-*.ts` and `packages/<pkg>/AGENTS.md`.',
      'Future roadmap: `scripts/future-vlm-judge.ts`（P2 计划）.',
      'Run `npm run check:docs-links` and `npm run typecheck:preview --workspace packages/web-react`.',
      '```bash',
      'npm run test:web-react && npm run build:web-react',
      'npx tsx scripts/check-docs-links.ts',
      '```',
    ].join('\n'),
  )

  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('check-docs-links', () => {
  it('passes valid governance docs with real paths, brace expansions, globs, planned markers, and workspace npm scripts', () => {
    const rootDir = makeFixtureRepo()
    const res = checkDocsLinks({ rootDir })

    assert.equal(res.violations.length, 0)
    assert.equal(res.checkedFiles, 7)
    assert.ok(res.checkedPaths >= 8, `expected >=8 verified paths, got ${res.checkedPaths}`)
    assert.equal(res.checkedNpmScripts, 4)
  })

  it('blocks non-existent repo path `scripts/does-not-exist.ts` and invalid `npm run fake:script` with [GATE-ERROR]', () => {
    const rootDir = makeFixtureRepo()
    writeFileSync(
      path.join(rootDir, 'docs/V5_SELFHOST_PLAYBOOK.md'),
      [
        '# Playbook',
        'Broken script ref: `scripts/does-not-exist.ts`.',
        'Broken link: [Ghost](docs/NO_SUCH_DOC.md).',
        'Broken npm command: `npm run fake:script`.',
        'Broken workspace command: `npm run missing:ws --workspace packages/web-react`.',
        'Broken brace expansion: `packages/{web-react,ghost-pkg}/AGENTS.md`.',
      ].join('\n'),
    )

    const res = checkDocsLinks({ rootDir })
    assert.equal(res.violations.length, 5)

    const byRef = new Map(res.violations.map((v) => [v.reference, v]))
    assert.equal(byRef.get('scripts/does-not-exist.ts')?.ruleId, 'DOCS-DEAD-PATH')
    assert.equal(byRef.get('scripts/does-not-exist.ts')?.line, 2)
    assert.equal(byRef.get('docs/NO_SUCH_DOC.md')?.ruleId, 'DOCS-DEAD-PATH')
    assert.equal(byRef.get('docs/NO_SUCH_DOC.md')?.line, 3)
    assert.equal(byRef.get('npm run fake:script')?.ruleId, 'DOCS-INVALID-NPM-SCRIPT')
    assert.equal(byRef.get('npm run fake:script')?.line, 4)
    assert.equal(
      byRef.get('npm run missing:ws --workspace packages/web-react')?.ruleId,
      'DOCS-INVALID-NPM-SCRIPT',
    )
    assert.equal(byRef.get('packages/ghost-pkg/AGENTS.md')?.ruleId, 'DOCS-DEAD-PATH')

    const formatted = formatGateError(byRef.get('scripts/does-not-exist.ts')!)
    assert.match(formatted, /^\[GATE-ERROR\] DOCS-DEAD-PATH at docs\/V5_SELFHOST_PLAYBOOK\.md:2/m)
    assert.match(formatted, /How to Fix:/m)
    assert.match(formatted, /Re-verify : npm run check:docs-links/m)
  })

  it('does not let a planned marker in one table cell silence a dead path in another cell on the same row', () => {
    const rootDir = makeFixtureRepo()
    writeFileSync(
      path.join(rootDir, 'docs/UI_DESIGN_SYSTEM.md'),
      '| L5 | `scripts/does-not-exist.ts` | LHCI（P2 计划） |\n',
    )

    const res = checkDocsLinks({ rootDir })
    assert.equal(res.violations.length, 1)
    assert.equal(res.violations[0].reference, 'scripts/does-not-exist.ts')
  })

  it('exits non-zero via CLI on injected dead path and invalid npm script, and exits 0 on clean fixture', () => {
    const rootDir = makeFixtureRepo()
    const scriptPath = path.resolve(process.cwd(), 'scripts/check-docs-links.ts')

    // Positive CLI run
    const okOut = execFileSync('npx', ['tsx', scriptPath, '--root', rootDir], {
      encoding: 'utf8',
    })
    assert.match(okOut, /\[check-docs-links\] OK:/)

    // Negative CLI run
    writeFileSync(
      path.join(rootDir, 'AGENTS.md'),
      'Bad ref: `scripts/does-not-exist.ts` and `npm run fake:script`.\n',
    )

    let failed = false
    try {
      execFileSync('npx', ['tsx', scriptPath, '--root', rootDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      failed = true
      const e = err as { status?: number; stderr?: string }
      assert.equal(e.status, 1)
      assert.match(e.stderr ?? '', /\[GATE-ERROR\] DOCS-DEAD-PATH/)
      assert.match(e.stderr ?? '', /scripts\/does-not-exist\.ts/)
      assert.match(e.stderr ?? '', /\[GATE-ERROR\] DOCS-INVALID-NPM-SCRIPT/)
      assert.match(e.stderr ?? '', /npm run fake:script/)
    }
    assert.equal(failed, true, 'CLI should exit 1 on dead links and invalid npm scripts')
  })

  it('expands single-level brace lists and rejects placeholder braces', () => {
    assert.deepEqual(expandBracePath('packages/{web-react,gateway}/AGENTS.md'), [
      'packages/web-react/AGENTS.md',
      'packages/gateway/AGENTS.md',
    ])
    assert.equal(expandBracePath('packages/{single}/AGENTS.md'), null)
    assert.deepEqual(expandBracePath('docs/UI_DESIGN_SYSTEM.md'), ['docs/UI_DESIGN_SYSTEM.md'])
  })
})
