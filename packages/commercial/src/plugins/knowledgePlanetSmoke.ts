import type { BrowserStorageStateV1 } from './accounts.js'
import { KNOWLEDGE_PLANET_PLUGIN_CONTRACT } from './knowledgePlanetContract.js'

export type KnowledgePlanetSmokeRunner = (input: {
  actionId: string
  params: Record<string, unknown>
  storageState: BrowserStorageStateV1
}) => Promise<{ result: unknown; storageState: BrowserStorageStateV1 }>

export const KNOWLEDGE_PLANET_RESOURCE_DEPENDENT_ACTION_IDS = Object.freeze([
  'get_topic',
  'list_comments',
  'list_hashtag_topics',
  'list_column_topics',
  'get_checkin',
  'list_checkin_topics',
])

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
 * Exercises every declared Knowledge Planet action that the authenticated
 * account has a real resource for. A successful empty parent list classifies
 * only its dependent reads as resource-unavailable. Evidence contains action
 * IDs, never account content.
 */
export async function runKnowledgePlanetActionSmoke(input: {
  storageState: BrowserStorageStateV1
  run: KnowledgePlanetSmokeRunner
}): Promise<{
  passedActionIds: string[]
  resourceUnavailableActionIds: string[]
  writeActionIdsSkipped: string[]
  storageState: BrowserStorageStateV1
}> {
  let storageState = input.storageState
  const passed = new Set<string>()
  const resourceUnavailable = new Set<string>()
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
  await call('get_unread_counts', {})

  const findGroupResource = async (
    actionId: 'list_topics' | 'list_hashtags' | 'list_columns',
    resultKey: 'topics' | 'hashtags' | 'columns',
  ): Promise<{
    group: Record<string, unknown>
    groupId: string
    item: Record<string, unknown>
  } | null> => {
    for (const group of groups) {
      const groupId = resourceId(group)
      if (!groupId) continue
      const params = actionId === 'list_topics' ? { groupId, count: 20, scope: 'all' } : { groupId }
      const result = await call(actionId, params)
      const item = rows(result, resultKey).find((candidate) => resourceId(candidate))
      if (item) return { group, groupId, item }
    }
    return null
  }

  const topicResource = await findGroupResource('list_topics', 'topics')
  if (topicResource) {
    const topicId = resourceId(topicResource.item)!
    await call('get_topic', { topicId })
    await call('list_comments', { topicId, count: 20, sort: 'asc' })
    await call('search_topics', {
      groupId: topicResource.groupId,
      keyword: searchKeyword(topicResource.item, topicResource.group),
      count: 20,
    })
  } else {
    resourceUnavailable.add('get_topic')
    resourceUnavailable.add('list_comments')
    await call('search_topics', {
      groupId: firstGroupId,
      keyword: searchKeyword({}, firstGroup),
      count: 20,
    })
  }

  const hashtagResource = await findGroupResource('list_hashtags', 'hashtags')
  if (hashtagResource) {
    await call('list_hashtag_topics', {
      hashtagId: resourceId(hashtagResource.item)!,
      count: 20,
    })
  } else {
    resourceUnavailable.add('list_hashtag_topics')
  }

  const columnResource = await findGroupResource('list_columns', 'columns')
  if (columnResource) {
    await call('list_column_topics', {
      groupId: columnResource.groupId,
      columnId: resourceId(columnResource.item)!,
      count: 20,
    })
  } else {
    resourceUnavailable.add('list_column_topics')
  }

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
  if (checkinResource) {
    const checkinId = resourceId(checkinResource.item)!
    await call('get_checkin', { groupId: checkinResource.groupId, checkinId })
    await call('list_checkin_topics', {
      groupId: checkinResource.groupId,
      checkinId,
      count: 20,
    })
  } else {
    resourceUnavailable.add('get_checkin')
    resourceUnavailable.add('list_checkin_topics')
  }

  const expectedActionIds = KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions
    .filter((action) => action.effect === 'read')
    .map((action) => action.id)
  const writeActionIdsSkipped = KNOWLEDGE_PLANET_PLUGIN_CONTRACT.actions
    .filter((action) => action.effect === 'write')
    .map((action) => action.id)
  const allowedUnavailable = new Set(KNOWLEDGE_PLANET_RESOURCE_DEPENDENT_ACTION_IDS)
  const invalidUnavailable = [...resourceUnavailable].filter(
    (actionId) => !allowedUnavailable.has(actionId),
  )
  const overlap = [...resourceUnavailable].filter((actionId) => passed.has(actionId))
  const missing = expectedActionIds.filter(
    (actionId) => !passed.has(actionId) && !resourceUnavailable.has(actionId),
  )
  if (invalidUnavailable.length || overlap.length)
    throw new Error('Knowledge Planet action smoke produced invalid resource coverage')
  if (missing.length)
    throw new Error(`Knowledge Planet action smoke missed actions: ${missing.join(',')}`)
  return {
    passedActionIds: expectedActionIds.filter((actionId) => passed.has(actionId)),
    resourceUnavailableActionIds: expectedActionIds.filter((actionId) =>
      resourceUnavailable.has(actionId),
    ),
    writeActionIdsSkipped,
    storageState,
  }
}
