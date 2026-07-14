import type { ProductFeatureId } from './productCapabilities'
import { TUTORIAL_CATALOG_SCHEMA, TUTORIAL_TOPICS } from './tutorialCatalog'

const STORAGE_KEY = `oc:v5:tutorial-read:v${TUTORIAL_CATALOG_SCHEMA}`

export type TutorialProgress = {
  schema: number
  read: Partial<Record<ProductFeatureId, number>>
}

function emptyProgress(): TutorialProgress {
  return { schema: TUTORIAL_CATALOG_SCHEMA, read: {} }
}

export function readTutorialProgress(storage: Storage | null = safeStorage()): TutorialProgress {
  if (!storage) return emptyProgress()
  try {
    const parsed = JSON.parse(
      storage.getItem(STORAGE_KEY) ?? 'null',
    ) as Partial<TutorialProgress> | null
    if (!parsed || parsed.schema !== TUTORIAL_CATALOG_SCHEMA || typeof parsed.read !== 'object') {
      return emptyProgress()
    }
    const read: TutorialProgress['read'] = {}
    for (const id of Object.keys(TUTORIAL_TOPICS) as ProductFeatureId[]) {
      const value = parsed.read?.[id]
      if (Number.isInteger(value) && (value as number) > 0) read[id] = value
    }
    return { schema: TUTORIAL_CATALOG_SCHEMA, read }
  } catch {
    return emptyProgress()
  }
}

export function markTutorialRead(
  id: ProductFeatureId,
  storage: Storage | null = safeStorage(),
): TutorialProgress {
  const current = readTutorialProgress(storage)
  const version = TUTORIAL_TOPICS[id].contentVersion
  if (current.read[id] === version) return current
  const next: TutorialProgress = { ...current, read: { ...current.read, [id]: version } }
  if (storage) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式/存储满：阅读进度是非关键增强，静默退化为当前内存态。
    }
  }
  return next
}

export function tutorialIsRead(progress: TutorialProgress, id: ProductFeatureId): boolean {
  return progress.read[id] === TUTORIAL_TOPICS[id].contentVersion
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
