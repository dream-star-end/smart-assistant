import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { CursorContextTier, ServiceTier } from '@openclaude/protocol/browser'
import type { Session } from '../lib/types'
import type { UseChatSocket } from './useChatSocket'
import type { PreferenceEffort } from '../lib/modelPreferences'
import { accountDraftKey, moveDraft, NEW_COMPOSER_DRAFT_KEY } from '../lib/composerDraft'
import { moveComposerAttachments } from '../components/Composer'
import { writeSessionEffort } from '../lib/sessionEffort'
import { writeContextTier } from '../lib/sessionContextTier'
import { writeSessionServiceTier } from '../lib/sessionServiceTier'

/** Only explicit Goal/GitHub actions materialize an otherwise memory-only draft. */
export function useDraftSessionMaterialization(args: {
  demo: boolean
  userId: string | undefined
  activeId: string | undefined
  draftSessionId: string
  stopPreparing: () => void
  agentId: string
  modelId: string | undefined
  promoteDraftCollab?: (sessionId: string) => void
  sessionEffort: PreferenceEffort | null | undefined
  contextTier: CursorContextTier
  serviceTier: ServiceTier | null
  sockRef: RefObject<Pick<UseChatSocket, 'ensureSession' | 'setSessionModel'> | null>
  setSessions: Dispatch<SetStateAction<Session[]>>
  setActiveId: Dispatch<SetStateAction<string | undefined>>
}): () => string | undefined {
  const { demo, userId, activeId, draftSessionId, stopPreparing, agentId, modelId,
    promoteDraftCollab, sessionEffort, contextTier, serviceTier, sockRef, setSessions, setActiveId } = args
  return useCallback(() => {
    if (demo || !userId || activeId) return activeId
    stopPreparing()
    const id = draftSessionId
    const session: Session = { id, title: '新对话', ownerUserId: userId,
      updatedAt: new Date().toISOString(), messageCount: 0, ...(modelId ? { modelId } : {}) }
    promoteDraftCollab?.(id)
    if (sessionEffort !== undefined) writeSessionEffort(id, sessionEffort)
    writeContextTier(id, contextTier)
    writeSessionServiceTier(id, serviceTier)
    sockRef.current?.ensureSession(id, agentId, '新对话')
    if (modelId) sockRef.current?.setSessionModel(id, modelId)
    setSessions(current => [session, ...current])
    // Identity promotion preserves the unsent text/attachments.
    moveDraft(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, userId), accountDraftKey(id, userId))
    moveComposerAttachments(accountDraftKey(NEW_COMPOSER_DRAFT_KEY, userId), accountDraftKey(id, userId))
    setActiveId(id)
    return id
  }, [demo, userId, activeId, draftSessionId, stopPreparing, agentId, modelId,
    promoteDraftCollab, sessionEffort, contextTier, serviceTier, sockRef, setSessions, setActiveId])
}
