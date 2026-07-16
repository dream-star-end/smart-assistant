import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { BrowserStorageStateV1 } from './accounts.js'
import { KNOWLEDGE_PLANET_PLUGIN_CONTRACT } from './knowledgePlanetContract.js'
import { runKnowledgePlanetActionSmoke } from './knowledgePlanetSmoke.js'

const emptyState: BrowserStorageStateV1 = { cookies: [], origins: [] }

describe('Knowledge Planet authenticated action smoke', () => {
  test('composes IDs from prior reads and returns only the complete declared action list', async () => {
    const calls: { actionId: string; params: Record<string, unknown> }[] = []
    const resultFor = (actionId: string): unknown => {
      switch (actionId) {
        case 'list_groups':
          return { groups: [{ id: '123456789', name: 'smoke group' }] }
        case 'list_topics':
          return { topics: [{ id: '223456789', title: 'smoke topic' }] }
        case 'list_hashtags':
          return { hashtags: [{ id: '323456789', name: 'smoke tag' }] }
        case 'list_columns':
          return { columns: [{ id: '423456789', name: 'smoke column' }] }
        case 'list_checkins':
          return { checkins: [{ id: '523456789', name: 'smoke checkin' }] }
        case 'get_unread_counts':
          return { counts: [{ groupId: '123456789', unreadCount: 0 }] }
        default:
          return {}
      }
    }
    const completed = await runKnowledgePlanetActionSmoke({
      storageState: emptyState,
      async run({ actionId, params, storageState }) {
        calls.push({ actionId, params })
        return { result: resultFor(actionId), storageState }
      },
    })

    assert.deepEqual(
      completed.passedActionIds,
      KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id),
    )
    assert.deepEqual(calls.find((call) => call.actionId === 'get_topic')?.params, {
      topicId: '223456789',
    })
    assert.deepEqual(calls.find((call) => call.actionId === 'list_column_topics')?.params, {
      groupId: '123456789',
      columnId: '423456789',
      count: 20,
    })
    assert.deepEqual(calls.find((call) => call.actionId === 'list_checkin_topics')?.params, {
      groupId: '123456789',
      checkinId: '523456789',
      count: 20,
    })
  })

  test('fails closed when an account cannot prove a dependent declared action', async () => {
    await assert.rejects(
      runKnowledgePlanetActionSmoke({
        storageState: emptyState,
        async run({ actionId, storageState }) {
          const result =
            actionId === 'list_groups'
              ? { groups: [{ id: '123456789' }] }
              : actionId === 'get_unread_counts'
                ? { counts: [{ groupId: '123456789', unreadCount: 0 }] }
                : actionId === 'list_topics'
                  ? { topics: [{ id: '223456789', title: 'topic' }] }
                  : actionId === 'list_hashtags'
                    ? { hashtags: [{ id: '323456789' }] }
                    : { columns: [] }
          return { result, storageState }
        },
      }),
      /list_columns produced no dependent resource/,
    )
  })
})
