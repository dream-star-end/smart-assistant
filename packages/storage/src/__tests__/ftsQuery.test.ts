import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import Database from 'better-sqlite3'

import { literalFtsQuery } from '../ftsQuery.js'

describe('literalFtsQuery', () => {
  test('turns punctuation into token boundaries and quotes every token', () => {
    assert.equal(literalFtsQuery('no-such-session'), '"no" "such" "session"')
    assert.equal(literalFtsQuery('field:value'), '"field" "value"')
    assert.equal(literalFtsQuery('10.1000/example'), '"10" "1000" "example"')
    assert.equal(literalFtsQuery('C++'), '"C"')
    assert.equal(literalFtsQuery('中文测试'), '"中文测试"')
    assert.equal(literalFtsQuery('---***'), '')
  })

  test('quotes FTS5 boolean keywords alone and between normal words', () => {
    for (const keyword of ['AND', 'OR', 'NOT']) {
      assert.equal(literalFtsQuery(keyword), `"${keyword}"`)
      assert.equal(literalFtsQuery(`foo ${keyword} bar`), `"foo" "${keyword}" "bar"`)
    }
  })

  test('produces executable FTS5 queries that match punctuation and boolean words literally', () => {
    const db = new Database(':memory:')
    try {
      db.exec('CREATE VIRTUAL TABLE docs USING fts5(content)')
      const insert = db.prepare('INSERT INTO docs(content) VALUES (?)')
      for (const content of ['no such session', 'foo AND bar', 'foo OR bar', 'foo NOT bar']) {
        insert.run(content)
      }

      const search = db.prepare('SELECT content FROM docs WHERE docs MATCH ?')
      for (const query of ['no-such-session', 'foo AND bar', 'foo OR bar', 'foo NOT bar']) {
        const rows = search.all(literalFtsQuery(query)) as Array<{ content: string }>
        assert.deepEqual(rows, [{ content: query.replaceAll('-', ' ') }])
      }
    } finally {
      db.close()
    }
  })
})
