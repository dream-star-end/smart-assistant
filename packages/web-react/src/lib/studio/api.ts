// OCV5-593 typed client for /api/studio/*. Same auth fence as MediaTaskCenter: every call goes
// through callWithRefresh, and a response from a previous identity is never handed to the UI.

import { assertAuthResponseCurrent, bearerHeaders, callWithRefresh } from '../api'
import type { AuthSession } from '../types'
import type {
  ProvidersView,
  StudioAspect,
  StudioAsset,
  StudioProject,
  StudioProjectPage,
  StudioProjectView,
} from './types'

export const STUDIO_API = '/api/studio'
export const UPLOAD_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp']
/** Voice clone samples (the server sniffs the bytes; mp3 or wav, 10 s – 5 min). */
export const UPLOAD_AUDIO_TYPES = ['audio/mpeg', 'audio/wav']
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024

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
  /** Upload (images by default, or audio for a clone sample; ≤ 25 MB); the server checks the bytes. */
  uploadAsset: async (
    auth: AuthSession,
    projectId: string,
    file: File,
    allowed: readonly string[] = UPLOAD_IMAGE_TYPES,
  ) => {
    if (!allowed.includes(file.type)) {
      throw new StudioApiError(415, 'STUDIO_UNSUPPORTED_MEDIA', 'unsupported upload type')
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      throw new StudioApiError(413, 'STUDIO_UPLOAD_TOO_LARGE', 'upload exceeds 25 MB')
    }
    return (
      await call<{ asset: StudioAsset }>(
        auth,
        `/projects/${encodeURIComponent(projectId)}/uploads`,
        {
          method: 'POST',
          body: file,
          headers: {
            'content-type': file.type,
            'x-filename': encodeURIComponent(file.name.slice(0, 200)),
          },
        },
      )
    ).asset
  },
  /** Design or clone a voice with MiniMax; it runs as a studio task (watch the voice asset). */
  createVoice: (
    auth: AuthSession,
    projectId: string,
    body:
      | { mode: 'design'; name: string; prompt: string; previewText: string }
      | { mode: 'clone'; name: string; sampleAssetId: string; consent: true; previewText?: string },
  ) =>
    call<{ assetId: string }>(auth, `/projects/${encodeURIComponent(projectId)}/voices`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  useVoiceForNarration: (auth: AuthSession, assetId: string) =>
    call<{ projectId: string }>(auth, `/assets/${encodeURIComponent(assetId)}/narration`, {
      method: 'POST',
    }),
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
      case 'STUDIO_UNSUPPORTED_MEDIA':
        return '文件格式不支持（图片用 PNG、JPEG、WebP；声音样本用 MP3、WAV）'
      case 'STUDIO_UPLOAD_TOO_LARGE':
        return '文件不能超过 25 MB'
      case 'STUDIO_BUDGET_TOO_LOW':
        return '项目预算不够了：新建一个音色需要 990 积分，先调高预算'
      case 'STUDIO_VOICE_UNAVAILABLE':
        return '配音服务未配置'
      case 'STUDIO_VOICE_NOT_READY':
        return '这个音色还没准备好'
      case 'CLONE_CONSENT_REQUIRED':
        return '请先确认声音样本是你本人的，或你已获得授权'
      case 'STUDIO_ORCHESTRATOR_OFF':
        return '导演 agent 暂时没有运行'
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

/** Why a voice task failed, from its take error code (the MiniMax plan / account limits included). */
export function voiceFailureText(code: string | null): string {
  switch (code) {
    case 'MINIMAX_PLAN_NO_VOICE_DESIGN':
      return '当前 MiniMax 套餐不包含声音设计，需要升级套餐后再试'
    case 'MINIMAX_CLONE_NOT_ENABLED':
      return 'MiniMax 账号还没有开通声音克隆（通常需要先完成认证）'
    case 'MINIMAX_CLONE_REJECTED':
      return '声音样本没有通过审核，换一段清晰的本人录音再试'
    case 'ERR_INSUFFICIENT_CREDITS':
      return '积分不足'
    case 'BAD_BODY':
      return '样本格式或时长不符合要求（MP3 / WAV，10 秒到 5 分钟）'
    default:
      return code ? `没有成功（${code}）` : '没有成功'
  }
}
