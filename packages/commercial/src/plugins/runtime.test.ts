import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { QueryResult, QueryResultRow } from 'pg'

import { PluginRuntimeFacade, PluginRuntimeFacadeError } from './runtime.js'

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }
}

describe('Plugin runtime facade', () => {
  test('catalog/list expose only installed current runtime Plugins and stable target ids', async () => {
    // Contract verification itself is covered in review.test; this test pins facade SQL and
    // empty-safe behavior without manufacturing signed DB rows.
    const calls: string[] = []
    const pool = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        calls.push(sql)
        return result([])
      },
    }
    const facade = new PluginRuntimeFacade({ pool: pool as never, redis: null })
    assert.deepEqual(await facade.catalog(7), [])
    assert.deepEqual(await facade.list(7), [])
    assert.deepEqual(await facade.management(7), { catalog: [], accounts: [] })
    assert.ok(calls.some((sql) => sql.includes('marketplace_installs')))
    assert.ok(calls.some((sql) => sql.includes("l.plugin_type = 'managed-browser'")))
    assert.ok(calls.some((sql) => sql.includes('NOT EXISTS')))
  })

  test('classifyTarget starts from a user-scoped current install and rejects absent targets', async () => {
    const calls: string[] = []
    const pool = {
      async query<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
        calls.push(sql)
        return result([])
      },
    }
    const facade = new PluginRuntimeFacade({ pool: pool as never, redis: null })
    assert.equal(await facade.classifyTarget(7, 'github'), null)
    assert.equal(await facade.classifyTarget(7, 'plugin:42'), null)
    assert.equal(await facade.classifyTarget(7, '41'), null)
    assert.equal(calls.length, 2)
    assert.match(calls[0]!, /i\.user_id = \$1 AND i\.version_id = \$2::bigint/)
    assert.match(calls[0]!, /l\.current_approved_version_id = v\.id/)
    assert.match(calls[1]!, /JOIN marketplace_installs i/)
    assert.match(calls[1]!, /i\.uninstalled_at IS NULL/)
    assert.match(calls[1]!, /v\.exec_revoked_at IS NULL/)
  })

  test('seals a nested reply deletion against exactly the supplied comment page', async () => {
    const facade = new PluginRuntimeFacade({
      pool: { query: async () => result([]) } as never,
      redis: null,
    })
    const calls: Array<{ actionId: string; params: Record<string, unknown> }> = []
    ;(facade as unknown as { call: PluginRuntimeFacade['call'] }).call = async (input) => {
      calls.push({ actionId: input.actionId, params: input.params })
      return {
        comments: [
          {
            id: '223456789',
            rootCommentId: '123456789',
            parentCommentId: '123456789',
            depth: 1,
            text: 'nested reply',
            contentDigest: 'a'.repeat(64),
          },
        ],
      }
    }
    const prepare = (
      facade as unknown as {
        prepareKnowledgePlanetWriteParams(input: {
          userId: number
          targetId: string
          actionId: string
          params: Record<string, unknown>
        }): Promise<Record<string, unknown>>
      }
    ).prepareKnowledgePlanetWriteParams.bind(facade)
    const lookupPage = {
      count: 20,
      sort: 'asc',
      beginTime: '2026-07-01T00:00:00.000+0800',
    }
    const prepared = await prepare({
      userId: 7,
      targetId: '41',
      actionId: 'delete_comment',
      params: { topicId: '123456789', commentId: '223456789', lookupPage },
    })
    assert.deepEqual(calls, [
      {
        actionId: 'list_comments',
        params: { topicId: '123456789', ...lookupPage },
      },
    ])
    assert.deepEqual(prepared.lookupPage, lookupPage)
    assert.deepEqual(prepared.deleteSnapshot, {
      expectedDigest: 'a'.repeat(64),
      preview: 'nested reply',
    })
    ;(facade as unknown as { call: PluginRuntimeFacade['call'] }).call = async () => ({
      comments: [],
    })
    await assert.rejects(
      prepare({
        userId: 7,
        targetId: '41',
        actionId: 'delete_comment',
        params: {
          topicId: '123456789',
          commentId: '223456789',
          lookupPage: { count: 20, sort: 'desc' },
        },
      }),
      (error: unknown) =>
        error instanceof PluginRuntimeFacadeError &&
        error.code === 'BAD_REQUEST' &&
        /snapshot/.test(error.message),
    )
  })

  test('seals exact topic media removals as an ordered final keep set and rejects stale or ambiguous ids', async () => {
    const facade = new PluginRuntimeFacade({
      pool: { query: async () => result([]) } as never,
      redis: null,
    })
    const topic = {
      id: '123456789',
      type: 'talk',
      text: 'body',
      contentDigest: 'b'.repeat(64),
      images: [{ id: '223456789' }, { id: '323456789' }],
      files: [{ id: '423456789' }, { id: '523456789' }],
    }
    ;(facade as unknown as { call: PluginRuntimeFacade['call'] }).call = async () => ({ topic })
    const prepare = (
      facade as unknown as {
        prepareKnowledgePlanetWriteParams(input: {
          userId: number
          targetId: string
          actionId: string
          params: Record<string, unknown>
        }): Promise<Record<string, unknown>>
      }
    ).prepareKnowledgePlanetWriteParams.bind(facade)
    const base = {
      userId: 7,
      targetId: '41',
      actionId: 'edit_topic',
    }
    const prepared = await prepare({
      ...base,
      params: {
        groupId: '623456789',
        topicId: '123456789',
        text: 'body',
        removeImageIds: ['323456789', '323456789'],
        removeFileIds: ['423456789'],
      },
    })
    assert.deepEqual(prepared.removeImageIds, ['323456789'])
    assert.deepEqual(prepared.removeFileIds, ['423456789'])
    assert.deepEqual(prepared.editSnapshot, {
      expectedDigest: 'b'.repeat(64),
      previousText: 'body',
      keepImageIds: ['223456789'],
      keepFileIds: ['523456789'],
    })

    for (const params of [
      {
        groupId: '623456789',
        topicId: '123456789',
        text: 'body',
        removeImageIds: ['999999999'],
      },
      {
        groupId: '623456789',
        topicId: '123456789',
        text: 'body',
        removeImageIds: ['423456789'],
      },
      {
        groupId: '623456789',
        topicId: '123456789',
        text: 'body',
        preserveExistingMedia: false,
        removeImageIds: [],
      },
    ])
      await assert.rejects(
        prepare({ ...base, params }),
        (error: unknown) =>
          error instanceof PluginRuntimeFacadeError && error.code === 'BAD_REQUEST',
      )

    await assert.rejects(
      prepare({
        ...base,
        params: {
          groupId: '623456789',
          topicId: '123456789',
          text: '',
          removeImageIds: ['223456789', '323456789'],
          removeFileIds: ['423456789', '523456789'],
        },
      }),
      (error: unknown) =>
        error instanceof PluginRuntimeFacadeError &&
        error.code === 'BAD_REQUEST' &&
        /cannot be empty/.test(error.message),
    )
  })
})
