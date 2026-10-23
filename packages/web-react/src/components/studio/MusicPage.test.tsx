import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const musicSearch = vi.fn()
const selectMusic = vi.fn()
const setMusicEdit = vi.fn()
const uploadTrack = vi.fn()
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
      musicSearch: (...a: unknown[]) => musicSearch(...a),
      selectMusic: (...a: unknown[]) => selectMusic(...a),
      setMusicEdit: (...a: unknown[]) => setMusicEdit(...a),
      uploadTrack: (...a: unknown[]) => uploadTrack(...a),
    },
  }
})

import { studioApi } from '../../lib/studio/api'
import type { MusicTrack } from '../../lib/studio/music'
import type { ProvidersView, StudioProjectView, StudioTake } from '../../lib/studio/types'
import { MusicPage } from './pages/Music'

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const played: string[] = []
beforeEach(() => {
  played.length = 0
  vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    played.push(this.src)
    return Promise.resolve()
  })
  vi.spyOn(window.HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  for (const f of [musicSearch, selectMusic, setMusicEdit, uploadTrack]) f.mockReset()
})

const music = (ready: boolean): ProvidersView => ({
  kinds: [
    {
      kind: 'music',
      state: ready ? 'ready' : 'unconfigured',
      providers: ['music-catalog', 'music-mine'].map((id) => ({
        id,
        label: id,
        state: ready ? ('ready' as const) : ('disabled' as const),
        models: [{ id: 'select', label: '选用曲目', ops: ['music.fetch'] }],
      })),
    },
  ],
})
const track = (id: string, over: Partial<MusicTrack> = {}): MusicTrack => ({
  id,
  title: `Track ${id}`,
  artist: 'Kevin MacLeod',
  durationMs: 90_000,
  bpm: 82,
  moods: ['宁静'],
  genres: [],
  vocals: false,
  license: 'CC-BY-4.0',
  licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
  attributionRequired: true,
  attributionText: `"Track ${id}" Kevin MacLeod (incompetech.com)`,
  landingUrl: 'https://incompetech.com/x',
  origin: 'incompetech',
  previewSha: id.repeat(64).slice(0, 64),
  metadata: { bpm: 'source', moods: 'source' },
  ...over,
})
const shot = (i: number, dur: number) => ({
  id: `s${i}`,
  ordinal: i,
  status: 'ready',
  activeTakeId: null,
  spec: { durationSec: dur, title: `#${i + 1}` },
})
const view = (
  over: Partial<StudioProjectView> = {},
  settings: Record<string, unknown> = {},
): StudioProjectView =>
  ({
    project: {
      id: 'p',
      title: '冬日来客',
      status: 'running',
      aspect: '16:9',
      settings,
      spentCredits: '0',
      budgetCredits: '2000',
    },
    shots: [shot(0, 5), shot(1, 5), shot(2, 6)],
    lines: [],
    assets: [],
    takes: [],
    events: [],
    ...over,
  }) as unknown as StudioProjectView

const musicTake = (over: Partial<StudioTake> = {}): StudioTake =>
  ({
    id: 'mt1',
    ownerKind: 'music',
    ownerId: 'p',
    version: 1,
    provider: 'music-catalog',
    model: 'select',
    op: 'music.fetch',
    status: 'succeeded',
    errorCode: null,
    costCredits: '0',
    qa: null,
    blobSha: 'f'.repeat(64),
    createdAt: '',
    finishedAt: '',
    music: {
      license: {
        source: 'curated-catalog',
        title: 'Easy Lemon',
        artist: 'Kevin MacLeod',
        license: 'CC-BY-4.0',
        attributionRequired: true,
        attributionText: '"Easy Lemon" Kevin MacLeod (incompetech.com)',
        landingUrl: 'https://incompetech.com/x',
        verifiedAt: '2026-10-23T06:56:16.472Z',
      },
      track: track('e', {
        title: 'Easy Lemon',
        durationMs: 126_000,
        previewSha: 'f'.repeat(64),
      }) as never,
    },
    ...over,
  }) as StudioTake

describe('MusicPage (OCV5-593 FE-5)', () => {
  test('the curated catalog opens first; guessed metadata is labelled; choosing a track sets the soundtrack', async () => {
    musicSearch.mockResolvedValue({
      tracks: [
        track('a'),
        track('b', {
          bpm: null,
          moods: ['温暖'],
          metadata: { bpm: 'unknown', moods: 'guessed' },
          origin: 'openverse',
        }),
      ],
      next: null,
    })
    selectMusic.mockResolvedValue({ queued: true })
    const onReload = vi.fn()
    render(
      <MusicPage
        auth={auth}
        view={view()}
        providers={music(true)}
        onOpenShot={() => {}}
        onReload={onReload}
      />,
    )
    expect(screen.getByRole('tab', { name: /免版权曲库/ })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(screen.getAllByTestId('music-track')).toHaveLength(2))
    expect(musicSearch).toHaveBeenCalledWith(auth, 'music-catalog', { vocals: false })
    const b = screen.getAllByTestId('music-track')[1]!
    expect(within(b).getByText('情绪为推测')).toBeInTheDocument()
    expect(within(b).getByText('BPM 未知')).toBeInTheDocument()
    expect(screen.getByText(/只看可商用/)).toBeInTheDocument()
    fireEvent.click(
      within(screen.getAllByTestId('music-track')[0]!).getByRole('button', { name: '用在这支片' }),
    )
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    expect(selectMusic).toHaveBeenCalledWith(auth, 'p', 'music-catalog', 'a')
  })

  test('filters reach the search; "跟随镜头节奏" sets the BPM band from the shots', async () => {
    musicSearch.mockResolvedValue({ tracks: [], next: null })
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    await waitFor(() => expect(musicSearch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '温暖' }))
    fireEvent.click(
      screen.getByRole('button', { name: /跟随镜头节奏：平均镜头 5.3 秒 → 64–96 BPM/ }),
    )
    fireEvent.click(screen.getByRole('button', { name: '都可以' }))
    await waitFor(() =>
      expect(musicSearch).toHaveBeenLastCalledWith(auth, 'music-catalog', {
        moods: ['温暖'],
        bpmMin: 64,
        bpmMax: 96,
      }),
    )
    expect(screen.getByText('没有符合的曲目，放宽一点筛选条件试试。')).toBeInTheDocument()
  })

  test('one preview at a time: starting a track stops the other', async () => {
    musicSearch.mockResolvedValue({ tracks: [track('a'), track('b')], next: null })
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    await waitFor(() => expect(screen.getAllByTestId('music-track')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: '试听 Track a' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '暂停 Track a' })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    )
    fireEvent.click(screen.getByRole('button', { name: '试听 Track b' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '暂停 Track b' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: '试听 Track a' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
    expect(played.map((u) => u.split('/blob/')[1]?.slice(0, 1))).toEqual(['a', 'b'])
  })

  test('AI generation is a slot that says it is not configured', () => {
    musicSearch.mockResolvedValue({ tracks: [], next: null })
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /AI 生成/ }))
    expect(screen.getByText('AI 生成音乐还没有配置')).toBeInTheDocument()
  })

  test('My Music upload needs the rights statement', async () => {
    musicSearch.mockResolvedValue({ tracks: [], next: null })
    uploadTrack.mockResolvedValue({ id: 'u1', title: 'demo' })
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /我的音乐/ }))
    await waitFor(() => expect(musicSearch).toHaveBeenCalledWith(auth, 'music-mine', {}))
    fireEvent.click(screen.getByRole('button', { name: '上传音乐' }))
    const dialog = screen.getByRole('dialog', { name: '上传音乐' })
    const file = new File([new Uint8Array(16)], '片头曲.mp3', { type: 'audio/mpeg' })
    fireEvent.change(within(dialog).getByLabelText(/音乐文件/), { target: { files: [file] } })
    expect(within(dialog).getByLabelText('曲名')).toHaveValue('片头曲')
    const submit = within(dialog).getByRole('button', { name: '上传' })
    expect(submit).toBeDisabled()
    fireEvent.click(within(dialog).getByLabelText(/我拥有这段音乐/))
    fireEvent.change(within(dialog).getByLabelText(/授权说明/), { target: { value: '合同 A-12' } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    await waitFor(() => expect(uploadTrack).toHaveBeenCalledWith(auth, file, '片头曲', '合同 A-12'))
  })

  test('with a soundtrack the editor opens: licence card, trim, rules checked before saving, reset', async () => {
    setMusicEdit.mockImplementation(async (_a, _p, e) => e)
    const onReload = vi.fn()
    render(
      <MusicPage
        auth={auth}
        view={view({ takes: [musicTake()] }, { musicTakeId: 'mt1' })}
        providers={music(true)}
        onOpenShot={() => {}}
        onReload={onReload}
      />,
    )
    expect(screen.getByRole('button', { name: /剪辑配乐/ })).toHaveAttribute('aria-pressed', 'true')
    const card = screen.getByRole('region', { name: '授权' })
    expect(
      within(card).getByText('"Easy Lemon" Kevin MacLeod (incompetech.com)'),
    ).toBeInTheDocument()
    expect(within(card).getByText('必须保留')).toBeInTheDocument()

    const save = screen.getByRole('button', { name: /保存剪辑/ })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('入点'), { target: { value: '8' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    await waitFor(() => expect(setMusicEdit).toHaveBeenCalledWith(auth, 'p', { inSec: 8 }))

    // A loop whose crossfade is longer than half the part is refused before it is sent.
    fireEvent.change(screen.getByLabelText('出点'), { target: { value: '9' } })
    fireEvent.click(screen.getByLabelText(/不够长时循环/))
    expect(screen.getByText('交叉淡化要短于截取片段的一半')).toBeInTheDocument()
    expect(save).toBeDisabled()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /恢复默认/ }))
    })
    expect(setMusicEdit).toHaveBeenLastCalledWith(auth, 'p', {})
    // 换一首 goes back to the sources.
    fireEvent.click(screen.getByRole('button', { name: '换一首' }))
    expect(screen.getByRole('tab', { name: /免版权曲库/ })).toHaveAttribute('aria-selected', 'true')
  })

  test('a poll with the same saved edit keeps unsaved changes (code r1 P1)', () => {
    const props = { auth, providers: music(true), onOpenShot: () => {} }
    const { rerender } = render(
      <MusicPage
        {...props}
        view={view({ takes: [musicTake()] }, { musicTakeId: 'mt1', musicEdit: { inSec: 2 } })}
      />,
    )
    fireEvent.change(screen.getByLabelText('入点'), { target: { value: '8' } })
    // The next poll: a new object with the same content.
    rerender(
      <MusicPage
        {...props}
        view={view({ takes: [musicTake()] }, { musicTakeId: 'mt1', musicEdit: { inSec: 2 } })}
      />,
    )
    expect(screen.getByLabelText('入点')).toHaveValue('8')
    expect(screen.getByRole('button', { name: /保存剪辑/ })).toBeEnabled()
    // A changed saved edit does replace the draft.
    rerender(
      <MusicPage
        {...props}
        view={view({ takes: [musicTake()] }, { musicTakeId: 'mt1', musicEdit: { inSec: 5 } })}
      />,
    )
    expect(screen.getByLabelText('入点')).toHaveValue('5')
  })

  test('dragging an edge handle moves that edge only (code r1 P1)', () => {
    render(
      <MusicPage
        auth={auth}
        view={view({ takes: [musicTake()] }, { musicTakeId: 'mt1' })}
        providers={music(true)}
        onOpenShot={() => {}}
      />,
    )
    const handle = document.querySelector('.st-trim-handle.in') as HTMLElement
    const lane = document.querySelector('.st-trim') as HTMLElement
    fireEvent.pointerDown(handle, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(lane, { clientX: 5, pointerId: 1 })
    fireEvent.pointerUp(lane, { pointerId: 1 })
    // The in point moved (clamped 1 s before the out point); the out point stayed at the track end.
    expect(Number((screen.getByLabelText('入点') as HTMLInputElement).value)).toBeGreaterThan(100)
    expect(screen.getByLabelText('出点')).toHaveValue('126')
  })

  test('a track without a known length waits for it: no trim on the film length, no loop (code r1 P1)', () => {
    const t = musicTake()
    const noLength = {
      ...t,
      music: { ...t.music!, track: { ...(t.music!.track as object), durationMs: null } },
    } as StudioTake
    render(
      <MusicPage
        auth={auth}
        view={view({ takes: [noLength] }, { musicTakeId: 'mt1' })}
        providers={music(true)}
        onOpenShot={() => {}}
      />,
    )
    expect(screen.getByText('正在读取曲子时长…')).toBeInTheDocument()
    expect(screen.queryByLabelText('入点')).toBeNull()
    expect(screen.getByLabelText(/不够长时循环/)).toBeDisabled()
  })

  test('leaving the page before the preview ticket arrives plays nothing (code r1 P1)', async () => {
    musicSearch.mockResolvedValue({ tracks: [track('x')], next: null })
    let release: (v: { url: string; expiresInSeconds: number }) => void = () => {}
    vi.mocked(studioApi.blobTicket).mockImplementationOnce(() => new Promise((r) => (release = r)))
    const { unmount } = render(
      <MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />,
    )
    await waitFor(() => expect(screen.getAllByTestId('music-track')).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: '试听 Track x' }))
    unmount()
    await act(async () => {
      release({ url: '/blob/late', expiresInSeconds: 900 })
    })
    expect(played).toEqual([])
  })

  test('paging belongs to its query; one page at a time (code r1 P1)', async () => {
    let resolvePage: (v: unknown) => void = () => {}
    musicSearch.mockImplementation((_a: unknown, _p: unknown, q: { cursor?: string }) =>
      q.cursor
        ? new Promise((r) => (resolvePage = r))
        : Promise.resolve({ tracks: [track('a')], next: 'c1' }),
    )
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    const more = await screen.findByRole('button', { name: '再看 20 首' })
    fireEvent.click(more)
    fireEvent.click(more)
    expect(musicSearch.mock.calls.filter((c) => (c[2] as { cursor?: string }).cursor)).toHaveLength(
      1,
    )
    // A new query drops the old cursor at once; the late page of the old query is ignored.
    fireEvent.click(screen.getByRole('button', { name: '温暖' }))
    await act(async () => {
      resolvePage({ tracks: [track('z')], next: null })
    })
    expect(screen.queryByText('Track z')).toBeNull()
  })

  test('My Music pages past the first 20 tracks (code r1 P1)', async () => {
    musicSearch.mockImplementation((_a: unknown, _p: unknown, q: { cursor?: string }) =>
      Promise.resolve(
        q.cursor
          ? { tracks: [track('old', { title: '最早的曲子' })], next: null }
          : { tracks: [track('new')], next: 'm1' },
      ),
    )
    render(<MusicPage auth={auth} view={view()} providers={music(true)} onOpenShot={() => {}} />)
    fireEvent.click(screen.getByRole('tab', { name: /我的音乐/ }))
    fireEvent.click(await screen.findByRole('button', { name: '再看 20 首' }))
    expect(await screen.findByText('最早的曲子')).toBeInTheDocument()
    expect(musicSearch).toHaveBeenLastCalledWith(auth, 'music-mine', { cursor: 'm1' })
  })
})
