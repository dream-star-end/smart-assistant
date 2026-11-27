import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { analyzeDeadCode, isEntrypointFile } from '../check-dead-code-weekly.ts'

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../check-dead-code-weekly.ts',
)

describe('check-dead-code-weekly import/export AST & entrypoint exclusions', () => {
  test('identifies standard entrypoints (index, main, server, cli, migrations, test helpers)', () => {
    assert.equal(isEntrypointFile('packages/gateway/src/index.ts'), true)
    assert.equal(isEntrypointFile('packages/commercial/src/egress/main.ts'), true)
    assert.equal(isEntrypointFile('packages/gateway/src/server.ts'), true)
    assert.equal(isEntrypointFile('packages/cli/src/commands/doctor.ts'), true)
    assert.equal(isEntrypointFile('packages/commercial/src/db/migrations/0042_init.ts'), true)
    assert.equal(isEntrypointFile('packages/kernel/src/testing/propertyCheck.ts'), true)

    assert.equal(isEntrypointFile('packages/gateway/src/orphanHelper.ts'), false)
    assert.equal(isEntrypointFile('packages/commercial/src/billing/unusedCalc.ts'), false)
  })

  test('detects unused exported symbols and orphan production files across workspace packages and writes --out JSON', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oc-deadcode-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const put = (rel: string, content: string) => {
      const abs = path.join(dir, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    }

    // Package A (`@openclaude/core`)
    put(
      'packages/core/package.json',
      JSON.stringify({ name: '@openclaude/core', main: './dist/index.js' }, null, 2),
    )
    put(
      'packages/core/src/index.ts',
      "export { activeUtil } from './math.js'\n",
    )
    put(
      'packages/core/src/math.ts',
      [
        'export function activeUtil(x: number): number { return x * 2 }',
        'export function deadExportFn(x: number): number { return x * 3 }',
        'export const DEAD_CONST = 42',
      ].join('\n'),
    )
    put(
      'packages/core/src/totallyOrphan.ts',
      'export function nobodyImportsMe(): string { return "orphan" }\n',
    )
    // Migration & CLI files must be excluded from dead-code / orphan candidates
    put(
      'packages/core/src/migrations/001_init.ts',
      'export async function up(): Promise<void> {}\n',
    )

    // Package B (`@openclaude/app`) imports `@openclaude/core`
    put(
      'packages/app/package.json',
      JSON.stringify({ name: '@openclaude/app' }, null, 2),
    )
    put(
      'packages/app/src/server.ts',
      "import { activeUtil } from '@openclaude/core'\nimport { runTask } from './workerHelper.js'\nexport function boot() { return activeUtil(runTask()) }\n",
    )
    put(
      'packages/app/src/workerHelper.ts',
      'export function runTask(): number { return 7 }\nexport interface UnusedConfig { flag: boolean }\n',
    )

    // Direct programmatic check
    const report = analyzeDeadCode(dir)
    assert.equal(report.schemaVersion, 1)
    assert.deepEqual(
      report.orphanFiles.map((o) => o.file),
      ['packages/core/src/totallyOrphan.ts'],
    )

    const unusedKeys = report.unusedExports.map((u) => `${u.file}::${u.symbol}`).sort()
    assert.deepEqual(unusedKeys, [
      'packages/app/src/workerHelper.ts::UnusedConfig',
      'packages/core/src/math.ts::DEAD_CONST',
      'packages/core/src/math.ts::deadExportFn',
      'packages/core/src/totallyOrphan.ts::nobodyImportsMe',
    ])
    assert.equal(report.byPackage.core?.orphanFileCount, 1)
    assert.equal(report.byPackage.core?.unusedExportCount, 3)
    assert.equal(report.byPackage.app?.orphanFileCount, 0)
    assert.equal(report.byPackage.app?.unusedExportCount, 1)

    // CLI `--out <path>` check
    const outFile = path.join(dir, 'out/dead-code.json')
    const cli = spawnSync(
      process.execPath,
      ['--import', 'tsx', SCRIPT, '--root', dir, '--out', outFile],
      { encoding: 'utf8' },
    )
    assert.equal(cli.status, 0, cli.stderr)
    const written = JSON.parse(readFileSync(outFile, 'utf8'))
    assert.equal(written.summary.orphanFileCount, 1)
    assert.equal(written.summary.unusedExportCount, 4)
  })
})
