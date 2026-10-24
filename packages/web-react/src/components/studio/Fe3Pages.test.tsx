import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    blobTicket: vi.fn(async (_a: unknown, sha: string) => ({
      url: `/blob/${sha}`,
      expiresInSeconds: 900,
    })),
  },
}))

import type { ProvidersView, StudioProjectView, StudioTake } from '../../lib/studio/types'
import { FinalPage, costBreakdown } from './pages/Final'
import { MusicPage } from './pages/Music'
import { VoicePage } from './pages/Voice'

afterEach(cleanup)

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const prov = (voice: 'ready' | 'unconfigured', music: 'ready' | 'unconfigured'): ProvidersView => ({
  kinds: [
    {
      kind: 'voice',
      state: voice,
      providers:
        voice === 'ready'
          ? [{ id: 'minimax-speech', label: 'MiniMax 语音', state: 'ready', models: [] }]
          : [],
    },
    { kind: 'music', state: music, providers: [] },
  ],
})
const take = (over: Partial<StudioTake>): StudioTake => ({
  id: 't',
  ownerKind: 'line',
  ownerId: 'l0',
  version: 1,
  provider: 'minimax-speech',
  model: 'speech-2.8-turbo',
  op: 'voice.tts',
  status: 'succeeded',
  errorCode: null,
  costCredits: '1',
  qa: null,
  blobSha: 'a'.repeat(64),
  createdAt: '',
  finishedAt: null,
  ...over,
})
function view(over: Partial<StudioProjectView> = {}): StudioProjectView {
  return {
    project: {
      id: 'p',
      title: '冬日来客',
      status: 'running',
      autonomy: 'max',
      aspect: '16:9',
      fps: 24,
      budgetCredits: '2000',
      spentCredits: '742',
      reservedCredits: '0',
    } as never,
    shots: [
      { id: 's0', ordinal: 0, spec: { durationSec: 5 }, status: 'ready', activeTakeId: null },
    ],
    lines: [
      {
        id: 'l0',
        shotId: 's0',
        ordinal: 0,
        speakerAssetId: null,
        text: '清晨，北方的雪松林慢慢醒来。',
        emotion: '沉稳',
        speed: 0.95,
        status: 'ready',
        activeTakeId: null,
      },
      {
        id: 'l1',
        shotId: 's0',
        ordinal: 1,
        speakerAssetId: null,
        text: '它听见了什么？',
        emotion: null,
        speed: null,
        status: 'planned',
        activeTakeId: null,
      },
    ],
    assets: [
      {
        id: 'v1',
        kind: 'voice',
        name: '旁白 · 沉稳男声',
        locked: true,
        descriptor: '系统音色',
        blobSha: null,
        voiceId: 'male-qn-jingying',
        meta: {},
        createdAt: '',
      },
    ],
    takes: [take({})],
    events: [],
    ...over,
  }
}

describe('VoicePage (OCV5-593 FE-3)', () => {
  test('lines with voiced count, locked narrator, design / clone not wired', () => {
    render(
      <VoicePage
        auth={auth}
        view={view()}
        providers={prov('ready', 'unconfigured')}
        onOpenShot={() => {}}
      />,
    )
    expect(screen.getAllByTestId('studio-line')).toHaveLength(2)
    expect(screen.getByText('1 / 2 已配')).toBeInTheDocument()
    expect(screen.getAllByText('旁白 · 沉稳男声').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /一句话设计/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /上传克隆/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: '试听：它听见了什么？' })).toBeDisabled()
    expect(screen.queryByTestId('unconfigured-voice')).not.toBeInTheDocument()
  })

  test('voice without a ready provider shows "未配置", never an error', () => {
    render(
      <VoicePage
        auth={auth}
        view={view()}
        providers={prov('unconfigured', 'unconfigured')}
        onOpenShot={() => {}}
      />,
    )
    expect(screen.getByTestId('unconfigured-voice')).toHaveTextContent('配音未配置')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('MusicPage (OCV5-593 FE-3)', () => {
  test('default: music is not configured and nothing can be generated', () => {
    render(
      <MusicPage
        auth={auth}
        view={view()}
        providers={prov('ready', 'unconfigured')}
        onOpenShot={() => {}}
      />,
    )
    expect(screen.getByTestId('unconfigured-music')).toHaveTextContent('音乐生成未配置')
    expect(screen.getByRole('button', { name: /再来一版/ })).toBeDisabled()
    expect(screen.queryByTestId('music-candidate')).not.toBeInTheDocument()
  })

  test('with a ready provider, music takes show as candidates', () => {
    const v = view({
      takes: [
        take({ id: 'm1', ownerKind: 'music', ownerId: 'p', version: 1 }),
        take({ id: 'm2', ownerKind: 'music', ownerId: 'p', version: 2 }),
      ],
    })
    render(
      <MusicPage auth={auth} view={v} providers={prov('ready', 'ready')} onOpenShot={() => {}} />,
    )
    expect(screen.getAllByTestId('music-candidate')).toHaveLength(2)
    expect(screen.getByText('agent 已选')).toBeInTheDocument()
  })
})

describe('FinalPage (OCV5-593 FE-3)', () => {
  test('empty state before compose; download disabled', () => {
    render(<FinalPage auth={auth} view={view()} onOpenBoard={() => {}} />)
    expect(screen.getByText('还没有成片')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /下载 mp4/ })).toBeDisabled()
  })

  test('the composed file is downloadable; QA and the ledger total show', async () => {
    const v = view({
      takes: [
        take({}),
        take({
          id: 'f1',
          ownerKind: 'final',
          ownerId: 'p',
          version: 2,
          costCredits: '20',
          qa: {
            passed: true,
            character: 0.88,
            loudnessLufs: -16.1,
            glitches: 0,
            moderation: 'pass',
          },
        }),
      ],
    })
    render(<FinalPage auth={auth} view={v} onOpenBoard={() => {}} />)
    await waitFor(() =>
      expect(screen.getByRole('link', { name: /下载 mp4/ })).toHaveAttribute(
        'href',
        `/blob/${'a'.repeat(64)}`,
      ),
    )
    expect(screen.getByText('QA 全部通过')).toBeInTheDocument()
    expect(screen.getByText('-16.1 LUFS')).toBeInTheDocument()
    expect(screen.getByText('742 / 2,000')).toBeInTheDocument()
  })
})

describe('costBreakdown', () => {
  test('groups by kind and provider in pipeline order, skips unfinished and free takes', () => {
    const rows = costBreakdown([
      take({ ownerKind: 'shot_video', provider: 'Muse', costCredits: '50' }),
      take({ ownerKind: 'shot_video', provider: 'Muse', costCredits: '50' }),
      take({ ownerKind: 'bible', provider: 'GPT Image', costCredits: '50' }),
      take({ ownerKind: 'line', costCredits: '1' }),
      take({ ownerKind: 'shot_video', provider: 'Muse', costCredits: '50', status: 'running' }),
      take({ ownerKind: 'final', provider: '', costCredits: '0' }),
    ])
    expect(rows).toEqual([
      { label: '设定图 · GPT Image', count: 1, credits: 50 },
      { label: '视频 · Muse', count: 2, credits: 100 },
      { label: '配音 · minimax-speech', count: 1, credits: 1 },
    ])
  })
})

describe('FE-3 code r1 fixes', () => {
  test('final QA judges every item; failing ones are not ticked', () => {
    const v = view({
      takes: [
        take({
          id: 'f1',
          ownerKind: 'final',
          ownerId: 'p',
          version: 1,
          qa: { passed: false, character: 0.9, glitches: 3, moderation: 'fail' },
        }),
      ],
    })
    render(<FinalPage auth={auth} view={v} onOpenBoard={() => {}} />)
    expect(screen.queryByText('QA 全部通过')).not.toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: '通过' })).toHaveLength(1)
    expect(screen.getAllByRole('img', { name: '未达标' })).toHaveLength(2)
    expect(screen.getByText('3 处')).toBeInTheDocument()
    expect(screen.getByText('未通过')).toBeInTheDocument()
  })

  test('starting one music candidate pauses the others', async () => {
    const v = view({
      takes: [
        take({ id: 'm1', ownerKind: 'music', ownerId: 'p', version: 1 }),
        take({ id: 'm2', ownerKind: 'music', ownerId: 'p', version: 2, blobSha: 'b'.repeat(64) }),
      ],
    })
    const { container } = render(
      <MusicPage auth={auth} view={v} providers={prov('ready', 'ready')} onOpenShot={() => {}} />,
    )
    await waitFor(() => expect(container.querySelectorAll('audio')).toHaveLength(2))
    const [a, b] = [...container.querySelectorAll('audio')]
    const pauseA = vi.spyOn(a!, 'pause').mockImplementation(() => {})
    const pauseB = vi.spyOn(b!, 'pause').mockImplementation(() => {})
    b!.dispatchEvent(new Event('play'))
    expect(pauseA).toHaveBeenCalledTimes(1)
    expect(pauseB).not.toHaveBeenCalled()
  })
})
