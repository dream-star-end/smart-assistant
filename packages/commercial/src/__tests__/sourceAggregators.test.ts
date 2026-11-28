import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { readPgSessionsBackendSource } from './helpers/pgSessionsSource.js'
import { readAggregatedSource } from './helpers/sourceAggregate.js'
import { readSqliteSessionsSource } from './helpers/sqliteSessionsSource.js'
import { readUserChatBridgeSource } from './helpers/userChatBridgeSource.js'

describe('OCV5-928 commercial source aggregators', () => {
  test('readAggregatedSource recursively scans existing dirs, ignores missing dirs, deduplicates, and skips test/d.ts files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-src-agg-'))
    try {
      mkdirSync(join(dir, 'db', 'sessions', 'nested'), { recursive: true })
      mkdirSync(join(dir, 'db', 'sessions', '__tests__'), { recursive: true })
      writeFileSync(join(dir, 'db', 'pgSessionsBackend.ts'), '// entry\nexport const a = 1;\n')
      writeFileSync(join(dir, 'db', 'sessions', 'alpha.ts'), '// alpha\nexport const b = 2;\n')
      writeFileSync(join(dir, 'db', 'sessions', 'nested', 'beta.ts'), '// beta\nexport const c = 3;\n')
      writeFileSync(join(dir, 'db', 'sessions', 'ignored.test.ts'), '// test-ignored\n')
      writeFileSync(join(dir, 'db', 'sessions', 'ignored.d.ts'), '// dts-ignored\n')
      writeFileSync(join(dir, 'db', 'sessions', '__tests__', 'skip.ts'), '// testdir-ignored\n')

      const combined = readAggregatedSource({
        baseDir: dir,
        requiredEntryFiles: ['db/pgSessionsBackend.ts', 'db/sessions/alpha.ts'],
        optionalEntryFiles: ['db/absentOptional.ts'],
        scanDirs: ['db/sessions', 'db/not-created-yet'],
      })

      assert.match(combined, /\/\/ entry/)
      assert.match(combined, /\/\/ alpha/)
      assert.match(combined, /\/\/ beta/)
      assert.doesNotMatch(combined, /test-ignored/)
      assert.doesNotMatch(combined, /dts-ignored/)
      assert.doesNotMatch(combined, /testdir-ignored/)
      assert.equal(combined.split('// alpha').length - 1, 1, 'duplicate paths must be read once')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('production helpers load pgSessionsBackend, userChatBridge, and sqlite sessions sources', () => {
    const pgSrc = readPgSessionsBackendSource()
    assert.match(pgSrc, /export function createPgSessionsBackend/)

    const bridgeSrc = readUserChatBridgeSource()
    assert.match(bridgeSrc, /export function createUserChatBridge/)

    const sqliteSrc = readSqliteSessionsSource()
    assert.match(sqliteSrc, /export function rankSessionSearchHits/)
  })
})
