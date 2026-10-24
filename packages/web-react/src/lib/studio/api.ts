// OCV5-593 typed client for /api/studio/*. Same auth fence as MediaTaskCenter: every call goes
// through callWithRefresh, and a response from a previous identity is never handed to the UI.

import { assertAuthResponseCurrent, bearerHeaders, callWithRefresh } from '../api'
import type { AuthSession } from '../types'
import type {
  ProvidersView,
  StudioAspect,
  StudioProject,
  StudioProjectPage,
  StudioProjectView,
} from './types'

export const STUDIO_API = '/api/studio'

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'StudioApiError'
  }
}

async function call<T>(auth: AuthSession, path: string, init?: RequestInit): Promise<T> {
  const response = await callWithRefresh(auth, (token) =>
    fetch(`${STUDIO_API}${path}`, {
      ...init,
      credentials: 'include',
      headers: { ...bearerHeaders(token, init?.body !== undefined), ...init?.headers },
    }),
  )
  assertAuthResponseCurrent(response)
  const value = (await response.json().catch(() => ({}))) as Record<string, unknown>
  assertAuthResponseCurrent(response)
  if (!response.ok) {
    const err = (value.error ?? {}) as { code?: string; message?: string }
    throw new StudioApiError(
      response.status,
      typeof err.code === 'string' ? err.code : `HTTP_${response.status}`,
      typeof err.message === 'string' ? err.message : `HTTP ${response.status}`,
    )
  }
  return value as T
}

export interface ProjectDraft {
  title?: string
  brief?: string
  aspect?: StudioAspect
  targetSec?: number
  budgetCredits?: number
  autonomy?: 'max' | 'confirm'
}

export const studioApi = {
  providers: (auth: AuthSession) => call<ProvidersView>(auth, '/providers'),
  listProjects: (auth: AuthSession, before?: string) =>
    call<StudioProjectPage>(
      auth,
      `/projects${before ? `?before=${encodeURIComponent(before)}` : ''}`,
    ),
  createProject: async (auth: AuthSession, draft: ProjectDraft) =>
    (
      await call<{ project: StudioProject }>(auth, '/projects', {
        method: 'POST',
        body: JSON.stringify(draft),
      })
    ).project,
  project: (auth: AuthSession, id: string) =>
    call<StudioProjectView>(auth, `/projects/${encodeURIComponent(id)}`),
  updateProject: async (auth: AuthSession, id: string, expectedRev: number, patch: ProjectDraft) =>
    (
      await call<{ project: StudioProject }>(auth, `/projects/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, expectedRev }),
      })
    ).project,
  deleteProject: (auth: AuthSession, id: string) =>
    call<{ ok: true }>(auth, `/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  transition: async (auth: AuthSession, id: string, action: 'pause' | 'resume' | 'cancel') =>
    (
      await call<{ project: StudioProject }>(
        auth,
        `/projects/${encodeURIComponent(id)}/${action}`,
        { method: 'POST' },
      )
    ).project,
  blobTicket: (auth: AuthSession, sha: string) =>
    call<{ url: string; expiresInSeconds: number }>(auth, `/blobs/${sha}/ticket`, {
      method: 'POST',
    }),
}

/** User-facing text for an API failure; 409s are told apart by code (FE plan review P2). */
export function studioErrorText(err: unknown): string {
  if (err instanceof StudioApiError) {
    switch (err.code) {
      case 'STUDIO_REV_CONFLICT':
        return '项目已在别处更新，已为你刷新'
      case 'STUDIO_NOT_DRAFT':
        return '项目已开拍，需求和画幅不能再改'
      case 'STUDIO_BUDGET_BELOW_SPENT':
        return '预算不能低于已花费的积分'
      case 'STUDIO_BAD_TRANSITION':
        return '项目当前的状态不能这样操作'
      case 'STUDIO_PROJECT_LIMIT':
        return '项目数量已达上限，先删除不需要的项目'
      case 'STUDIO_QUOTA':
        return '工作台存储空间已满'
      case 'ERR_INSUFFICIENT_CREDITS':
        return '积分不足'
      default:
        if (err.status === 404) return '项目不存在或已删除'
        if (err.status >= 500) return '服务暂时不可用，请稍后再试'
        return err.message
    }
  }
  return '网络异常，请稍后再试'
}
