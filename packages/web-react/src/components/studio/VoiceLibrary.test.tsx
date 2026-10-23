import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const createVoice = vi.fn()
const uploadAsset = vi.fn()
const useVoiceForNarration = vi.fn()
vi.mock('../../lib/studio/api', async () => {
  const actual =
    await vi.importActual<typeof import('../../lib/studio/api')>('../../lib/studio/api')
  return {
    ...actual,
    studioApi: {
      blobTicket: vi.fn(async (_a: unknown, sha: string) => ({
        url: `/blob/${sha}`,
        expiresInSeconds: 900,
      })),
      createVoice: (...a: unknown[]) => createVoice(...a),
      uploadAsset: (...a: unknown[]) => uploadAsset(...a),
      useVoiceForNarration: (...a: unknown[]) => useVoiceForNarration(...a),
    },
  }
})
vi.mock('../../lib/api', () => ({
  callWithRefresh: vi.fn(),
  bearerHeaders: vi.fn(),
  assertAuthResponseCurrent: vi.fn(),
  AuthEpochStaleError: class extends Error {},
}))

import type { StudioProjectView } from '../../lib/studio/types'
import { VoiceLibrary } from './VoiceLibrary'

afterEach(() => {
  cleanup()
  createVoice.mockReset()
  uploadAsset.mockReset()
  useVoiceForNarration.mockReset()
})

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const base = (over: Partial<StudioProjectView> = {}): StudioProjectView => ({
  project: { id: 'p' } as never,
  shots: [],
  lines: [],
  assets: [],
  takes: [],
  events: [],
  ...over,
})
const voiceAsset = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: 'voice' as const,
  name: `音色${id}`,
  locked: false,
  descriptor: '沉稳男声',
  blobSha: null,
  voiceId: null,
  meta: { mode: 'design' },
  createdAt: '',
  ...over,
})
const take = (ownerId: string, status: string, errorCode: string | null = null) => ({
  id: `t-${ownerId}`,
  ownerKind: 'bible' as const,
  ownerId,
  version: 1,
  provider: 'minimax-speech',
  model: 'voice-design',
  op: 'voice.design',
  status: status as never,
  errorCode,
  costCredits: '0',
  qa: null,
  blobSha: null,
  createdAt: '',
  finishedAt: null,
})

describe('VoiceLibrary (OCV5-593 FE-4)', () => {
  test('design dialog sends the request with name, description and preview line', async () => {
    createVoice.mockResolvedValue({ assetId: 'v9' })
    const onReload = vi.fn()
    render(<VoiceLibrary auth={auth} view={base()} voiceReady onReload={onReload} />)
    fireEvent.click(screen.getByRole('button', { name: /一句话设计/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '纪录片旁白' } })
    fireEvent.change(screen.getByLabelText('声音描述'), { target: { value: '沉稳温暖的中年男声' } })
    fireEvent.change(screen.getByLabelText('试听句子'), { target: { value: '清晨的雪松林。' } })
    expect(screen.getByRole('dialog', { name: '一句话设计音色' })).toHaveTextContent(
      '每个新音色 990 积分',
    )
    fireEvent.click(screen.getByRole('button', { name: /设计音色 · 990/ }))
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    expect(createVoice).toHaveBeenCalledWith(auth, 'p', {
      mode: 'design',
      name: '纪录片旁白',
      prompt: '沉稳温暖的中年男声',
      previewText: '清晨的雪松林。',
    })
  })

  test('clone needs the consent box; the sample is uploaded as audio first', async () => {
    uploadAsset.mockResolvedValue({ id: 'up1' })
    createVoice.mockResolvedValue({ assetId: 'v2' })
    render(<VoiceLibrary auth={auth} view={base()} voiceReady onReload={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: /上传克隆/ }))
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的声音' } })
    const f = new File([new Uint8Array([0x49, 0x44, 0x33])], 'me.mp3', { type: 'audio/mpeg' })
    fireEvent.change(screen.getByLabelText(/^声音样本（/), { target: { files: [f] } })
    const submit = screen.getByRole('button', { name: /复刻音色 · 990/ })
    expect(submit).toBeDisabled()
    fireEvent.click(screen.getByLabelText(/这是我本人的声音/))
    fireEvent.click(submit)
    await waitFor(() => expect(createVoice).toHaveBeenCalled())
    expect(uploadAsset).toHaveBeenCalledWith(auth, 'p', f, ['audio/mpeg', 'audio/wav'])
    expect(createVoice.mock.calls[0]![2]).toEqual({
      mode: 'clone',
      name: '我的声音',
      sampleAssetId: 'up1',
      consent: true,
    })
  })

  test('card states: working, failed with the MiniMax plan reason, ready with "设为旁白"', async () => {
    useVoiceForNarration.mockResolvedValue({ projectId: 'p' })
    const view = base({
      assets: [
        voiceAsset('a'),
        voiceAsset('b'),
        voiceAsset('c', { voiceId: 'oc247xabc', blobSha: 'c'.repeat(64) }),
      ],
      takes: [
        take('a', 'running'),
        take('b', 'failed', 'MINIMAX_PLAN_NO_VOICE_DESIGN'),
        take('c', 'succeeded'),
      ],
    })
    render(<VoiceLibrary auth={auth} view={view} voiceReady onReload={() => {}} />)
    expect(screen.getByText('设计中…')).toBeInTheDocument()
    expect(
      screen.getByText('当前 MiniMax 套餐不包含声音设计，需要升级套餐后再试'),
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '设为旁白' }))
    await waitFor(() => expect(useVoiceForNarration).toHaveBeenCalledWith(auth, 'c'))
  })

  test('buttons stay disabled when no voice provider is ready', () => {
    render(<VoiceLibrary auth={auth} view={base()} voiceReady={false} onReload={() => {}} />)
    expect(screen.getByRole('button', { name: /一句话设计/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传克隆/ })).toBeDisabled()
  })
})
