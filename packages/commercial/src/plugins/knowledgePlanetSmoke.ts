import type { BrowserStorageStateV1 } from './accounts.js'
import { KNOWLEDGE_PLANET_PLUGIN_CONTRACT } from './knowledgePlanetContract.js'

export type KnowledgePlanetSmokeRunner = (input: {
  actionId: string
  params: Record<string, unknown>
  storageState: BrowserStorageStateV1
}) => Promise<{ result: unknown; storageState: BrowserStorageStateV1 }>

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function rows(value: unknown, key: string): Record<string, unknown>[] {
  const candidate = record(value)[key]
  return Array.isArray(candidate) ? candidate.map(record) : []
}

function resourceId(value: Record<string, unknown>): string | null {
  return typeof value.id === 'string' && /^\d{6,32}$/.test(value.id) ? value.id : null
}

function searchKeyword(topic: Record<string, unknown>, group: Record<string, unknown>): string {
  for (const candidate of [
    topic.title,
    topic.text,
    topic.question,
    topic.answer,
    record(topic.author).name,
    group.name,
  ]) {
    if (typeof candidate !== 'string') continue
    const normalized = candidate.replace(/\s+/g, ' ').trim().slice(0, 40)
    if (normalized) return normalized
  }
  return 'AI'
}

/**
 * Exercises every declared Knowledge Planet action against one authenticated,
 * in-memory browser state. Results are used only to discover IDs for dependent
 * reads; the returned evidence contains action IDs, never account content.
 */
export async function runKnowledgePlanetActionSmoke(input: {
  storageState: BrowserStorageStateV1
  run: KnowledgePlanetSmokeRunner
}): Promise<{ passedActionIds: string[]; storageState: BrowserStorageStateV1 }> {
  let storageState = input.storageState
  const passed = new Set<string>()
  const call = async (actionId: string, params: Record<string, unknown>) => {
    const completed = await input.run({ actionId, params, storageState })
    storageState = completed.storageState
    passed.add(actionId)
    return completed.result
  }

  const groupsResult = await call('list_groups', {})
  const groups = rows(groupsResult, 'groups').slice(0, 20)
  const firstGroup = groups.find((group) => resourceId(group))
  const firstGroupId = firstGroup ? resourceId(firstGroup) : null
  if (!firstGroup || !firstGroupId)
    throw new Error('Knowledge Planet action smoke requires at least one readable group')

  await call('get_group', { groupId: firstGroupId })
  await call('list_dynamics', { count: 20 })
  const unreadResult = await call('get_unread_counts', {})
  if (!rows(unreadResult, 'counts').length)
    throw new Error('Knowledge Planet action smoke get_unread_counts produced no group count')

  const findGroupResource = async (
    actionId: 'list_topics' | 'list_hashtags' | 'list_columns',
    resultKey: 'topics' | 'hashtags' | 'columns',
  ): Promise<{
    group: Record<string, unknown>
    groupId: string
    item: Record<string, unknown>
  }> => {
    for (const group of groups) {
      const groupId = resourceId(group)
      if (!groupId) continue
      const params = actionId === 'list_topics' ? { groupId, count: 20, scope: 'all' } : { groupId }
      const result = await call(actionId, params)
      const item = rows(result, resultKey).find((candidate) => resourceId(candidate))
      if (item) return { group, groupId, item }
    }
    throw new Error(`Knowledge Planet action smoke ${actionId} produced no dependent resource`)
  }

  const topicResource = await findGroupResource('list_topics', 'topics')
  const topicId = resourceId(topicResource.item)!
  await call('get_topic', { topicId })
  await call('list_comments', { topicId, count: 20, sort: 'asc' })
  await call('search_topics', {
    groupId: topicResource.groupId,
    keyword: searchKeyword(topicResource.item, topicResource.group),
    count: 20,
  })

  const hashtagResource = await findGroupResource('list_hashtags', 'hashtags')
  await call('list_hashtag_topics', {
    hashtagId: resourceId(hashtagResource.item)!,
    count: 20,
  })

  const columnResource = await findGroupResource('list_columns', 'columns')
  await call('list_column_topics', {
    groupId: columnResource.groupId,
    columnId: resourceId(columnResource.item)!,
    count: 20,
  })

  let checkinResource: { groupId: string; item: Record<string, unknown> } | undefined
  for (const group of groups) {
    const groupId = resourceId(group)
    if (!groupId) continue
    for (const scope of ['ongoing', 'closed', 'over'] as const) {
      const result = await call('list_checkins', { groupId, scope, count: 20 })
      const item = rows(result, 'checkins').find((candidate) => resourceId(candidate))
      if (item) {
        checkinResource = { groupId, item }
        break
      }
    }
    if (checkinResource) break
  }
  if (!checkinResource)
    throw new Error('Knowledge Planet action smoke list_checkins produced no dependent resource')
  const checkinId = resourceId(checkinResource.item)!
  await call('get_checkin', { groupId: checkinResource.groupId, checkinId })
  await call('list_checkin_topics', {
    groupId: checkinResource.groupId,
    checkinId,
    count: 20,
  })

  const expectedActionIds = KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions.map((action) => action.id)
  const missing = expectedActionIds.filter((actionId) => !passed.has(actionId))
  if (missing.length)
    throw new Error(`Knowledge Planet action smoke missed actions: ${missing.join(',')}`)
  return { passedActionIds: expectedActionIds, storageState }
}
