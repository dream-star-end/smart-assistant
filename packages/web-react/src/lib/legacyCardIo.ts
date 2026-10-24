import { api } from './api'
import type { RequestExecutionGuard } from './api/http'
import type { AuthSession } from './types'
import type { CommunityBlogDraftPayload } from '../components/tool/context'

/** Loaded only when an authenticated card is used, under its captured capability. */
export function createLegacyCardIo(auth: AuthSession, guard: RequestExecutionGuard) {
  return {
    connectorDetail: (id: string) => api.getConnectorConfirmation(auth, id, guard),
    connectorDecide: (id: string, decision: 'approve' | 'deny') => api.decideConnectorConfirmation(auth, id, decision, guard),
    taskGet: async (id: string) => {
      const { taskboardApi } = await import('./taskboard')
      guard.assertCurrent()
      return taskboardApi.getTicket(auth, id, guard)
    },
    taskApprove: async (id: string, version: number) => {
      const { taskboardApi } = await import('./taskboard')
      guard.assertCurrent()
      return taskboardApi.approve(auth, id, version, false, guard)
    },
    taskReject: async (id: string, version: number, reason: string) => {
      const { taskboardApi } = await import('./taskboard')
      guard.assertCurrent()
      return taskboardApi.reject(auth, id, version, reason, undefined, guard)
    },
    precheck: (draft: CommunityBlogDraftPayload) => api.precheckCommunityTutorial(auth, draft, guard),
    readContainerImage: async (path: string) => {
      const url = (await api.mediaSign(auth, [path])).urls[path]
      guard.assertCurrent()
      if (!url) throw new Error('图片签名失败')
      const res = await fetch(url, { signal: guard.signal })
      guard.assertCurrent()
      if (!res.ok) throw new Error(`读取图片失败（${res.status}）`)
      const image = await res.blob()
      guard.assertCurrent()
      return image
    },
    uploadImage: (image: Blob) => api.uploadTutorialImage(auth, image, guard),
    submit: (draft: CommunityBlogDraftPayload) => api.submitCommunityTutorial(auth, draft, guard),
    getMine: (id: string) => api.getMyCommunityTutorial(auth, id, guard),
  }
}
export type LegacyCardIo = ReturnType<typeof createLegacyCardIo>
