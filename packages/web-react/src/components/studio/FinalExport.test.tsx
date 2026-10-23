import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const requestExport = vi.fn()
vi.mock('../../lib/studio/api', () => ({
  studioApi: {
    blobTicket: vi.fn(async (_a: unknown, sha: string) => ({
      url: `/blob/${sha}`,
      expiresInSeconds: 900,
    })),
    requestExport: (...args: unknown[]) => requestExport(...args),
  },
  studioErrorText: () => '出错了',
  StudioApiError: class StudioApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message)
    }
  },
}))

import { StudioApiError } from '../../lib/studio/api'
import type { FilmCredit, StudioProjectView, StudioTake } from '../../lib/studio/types'
import { FinalPage } from './pages/Final'

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never

const film = (over: Partial<StudioTake> & { key?: string; srtSha?: string }): StudioTake => {
  const { key = '1080p-burn', srtSha, ...rest } = over
  const [resolution, subtitles] = key.split('-') as ['1080p', 'burn']
  return {
    id: `f-${key}`,
    ownerKind: 'final',
    ownerId: 'p',
    version: 1,
    provider: 'compose',
    model: 'ffmpeg',
    op: 'compose',
    status: 'succeeded',
    errorCode: null,
    costCredits: '0',
    qa: null,
    blobSha: `${key.length}`.padEnd(64, 'b'),
    createdAt: '',
    finishedAt: null,
    final: {
      variant: { resolution, subtitles },
      variantKey: key,
      credits: [],
      srtSha: srtSha ?? null,
    },
    ...rest,
  }
}

function view(takes: StudioTake[], status = 'done'): StudioProjectView {
  return {
    project: {
      id: 'p',
      title: '冬日来客',
      status,
      aspect: '16:9',
      fps: 24,
      budgetCredits: '2000',
      spentCredits: '742',
      reservedCredits: '0',
    } as never,
    shots: [],
    lines: [],
    assets: [],
    takes,
    events: [],
  }
}

beforeEach(() => requestExport.mockReset())
afterEach(cleanup)

describe('final page export (OCV5-593 FE-6)', () => {
  test('the newest film downloads as its own format; the picker starts on it', async () => {
    render(
      <FinalPage
        auth={auth}
        view={view([film({ key: 'vertical-srt', srtSha: 'c'.repeat(64) })])}
        onOpenBoard={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: '竖屏 9:16' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(screen.getByRole('button', { name: '.srt' })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(screen.getByTestId('final-download')).toBeInTheDocument())
    expect(screen.getByTestId('final-download').getAttribute('download')).toBe(
      '冬日来客-v1-vertical-srt.mp4',
    )
    await waitFor(() =>
      expect(screen.getByTestId('final-srt')).toHaveAttribute('href', `/blob/${'c'.repeat(64)}`),
    )
    expect(screen.queryByTestId('final-export')).toBeNull()
  })

  test('another format asks the server; a reused film downloads at once', async () => {
    const other = film({ id: 'old720', key: '720p-burn', version: 1 })
    const latest = film({ id: 'new', key: '1080p-burn', version: 2 })
    requestExport.mockResolvedValue({ reused: true, takeId: 'old720' })
    const onReload = vi.fn()
    render(
      <FinalPage
        auth={auth}
        view={view([latest, other])}
        onOpenBoard={() => {}}
        onReload={onReload}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '720p' }))
    // Not known current until the server says so (the old 720p may predate a music change).
    expect(screen.queryByTestId('final-download')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('final-export'))
    })
    expect(requestExport).toHaveBeenCalledWith(auth, 'p', {
      resolution: '720p',
      subtitles: 'burn',
    })
    expect(onReload).toHaveBeenCalled()
    await waitFor(() =>
      expect(screen.getByTestId('final-download').getAttribute('download')).toBe(
        '冬日来客-v1-720p-burn.mp4',
      ),
    )
  })

  test('a queued re-compose waits, then hands out the new film when it lands', async () => {
    requestExport.mockResolvedValue({ queued: true })
    const first = film({ id: 'f1', key: '1080p-burn', version: 1 })
    const { rerender } = render(
      <FinalPage auth={auth} view={view([first])} onOpenBoard={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '无字幕' }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('final-export'))
    })
    expect(screen.getByTestId('export-format-note')).toHaveTextContent(
      '正在按这个规格重新合成（免费）',
    )
    expect(screen.queryByTestId('final-export')).toBeNull()
    rerender(
      <FinalPage
        auth={auth}
        view={view([film({ id: 'f2', key: '1080p-none', version: 2 }), first])}
        onOpenBoard={() => {}}
      />,
    )
    await waitFor(() =>
      expect(screen.getByTestId('final-download').getAttribute('download')).toBe(
        '冬日来客-v2-1080p-none.mp4',
      ),
    )
  })

  test('a film being composed for the format shows as in progress', () => {
    const running = film({ id: 'r', key: 'vertical-burn', version: 2, status: 'running' })
    if (running.final) running.final = { ...running.final, variantKey: null }
    render(
      <FinalPage
        auth={auth}
        view={view([running, film({ id: 'f1', version: 1 })])}
        onOpenBoard={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: '竖屏 9:16' }))
    expect(screen.getByText('正在按这个规格合成…')).toBeInTheDocument()
    expect(screen.queryByTestId('final-export')).toBeNull()
  })

  test('no other format before the film is done', () => {
    render(<FinalPage auth={auth} view={view([film({})], 'composing')} onOpenBoard={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '720p' }))
    expect(screen.queryByTestId('final-export')).toBeNull()
    expect(screen.getByTestId('export-format-note')).toHaveTextContent('成片完成后')
  })

  test('a failed export request is reported and can be retried', async () => {
    requestExport.mockRejectedValueOnce(new StudioApiError(409, 'STUDIO_NOT_DONE', 'not done'))
    render(<FinalPage auth={auth} view={view([film({})])} onOpenBoard={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '720p' }))
    fireEvent.click(screen.getByTestId('final-export'))
    await waitFor(() => expect(requestExport).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('final-export')).not.toBeDisabled())
  })
})

describe('final page export review r1', () => {
  test('a confirmed film stops counting once a newer film lands (it may carry new music)', async () => {
    requestExport.mockResolvedValueOnce({ reused: true, takeId: 'old720' })
    const other = film({ id: 'old720', key: '720p-burn', version: 1 })
    const latest = film({ id: 'new', key: '1080p-burn', version: 2 })
    const { rerender } = render(
      <FinalPage auth={auth} view={view([latest, other])} onOpenBoard={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '720p' }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('final-export'))
    })
    await waitFor(() => expect(screen.getByTestId('final-download')).toBeInTheDocument())
    // Reconnected straight into done: a newer film exists (another client changed the music).
    rerender(
      <FinalPage
        auth={auth}
        view={view([film({ id: 'newer', key: '1080p-burn', version: 3 }), latest, other])}
        onOpenBoard={() => {}}
      />,
    )
    expect(screen.queryByTestId('final-download')).toBeNull()
    expect(screen.getByTestId('final-export')).toBeInTheDocument()
  })

  test('a re-compose that failed ends the wait and can be asked again', async () => {
    requestExport.mockResolvedValueOnce({ queued: true })
    const first = film({ id: 'f1', version: 1 })
    const { rerender } = render(
      <FinalPage auth={auth} view={view([first])} onOpenBoard={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: '720p' }))
    await act(async () => {
      fireEvent.click(screen.getByTestId('final-export'))
    })
    expect(screen.queryByTestId('final-export')).toBeNull()
    rerender(
      <FinalPage
        auth={auth}
        view={view([
          film({ id: 'f2', key: '720p-burn', version: 2, status: 'failed', blobSha: null }),
          first,
        ])}
        onOpenBoard={() => {}}
      />,
    )
    expect(screen.getByTestId('final-export')).toBeInTheDocument()
    expect(screen.getByTestId('export-format-note')).toHaveTextContent('可以再试一次（免费）')
  })

  test('while a re-compose is only queued the page keeps reloading', async () => {
    vi.useFakeTimers()
    try {
      requestExport.mockResolvedValueOnce({ queued: true })
      const onReload = vi.fn()
      render(
        <FinalPage
          auth={auth}
          view={view([film({})])}
          onOpenBoard={() => {}}
          onReload={onReload}
        />,
      )
      fireEvent.click(screen.getByRole('button', { name: '720p' }))
      await act(async () => {
        fireEvent.click(screen.getByTestId('final-export'))
      })
      expect(onReload).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3100)
      })
      expect(onReload).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('final page credits (OCV5-593 FE-6, d14)', () => {
  const credit: FilmCredit = {
    kind: 'music',
    title: 'Wallpaper',
    attributionText:
      '"Wallpaper" Kevin MacLeod (incompetech.com)\nLicensed under Creative Commons: By Attribution 4.0 License',
    license: 'CC BY 4.0',
  }

  test('each CC BY item with its licence, the exact attribution and a credits.txt', async () => {
    const created: Blob[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b)
      return 'blob:credits'
    }) as never
    URL.revokeObjectURL = vi.fn()
    try {
      const f = film({})
      if (f.final) f.final = { ...f.final, credits: [credit] }
      render(<FinalPage auth={auth} view={view([f])} onOpenBoard={() => {}} />)
      const box = screen.getByTestId('final-credits')
      expect(box).toHaveTextContent('Wallpaper')
      expect(box).toHaveTextContent('CC BY 4.0')
      expect(box).toHaveTextContent('必须署名')
      expect(box).toHaveTextContent('"Wallpaper" Kevin MacLeod (incompetech.com)')
      expect(screen.getByTestId('final-credits-txt')).toHaveAttribute(
        'download',
        '冬日来客-credits.txt',
      )
      const text = await created[0]!.text()
      expect(text).toContain(credit.attributionText)
      expect(text).toContain('协议：CC BY 4.0')
    } finally {
      URL.createObjectURL = origCreate
      URL.revokeObjectURL = origRevoke
    }
  })

  test('a film without CC BY material says so', () => {
    render(<FinalPage auth={auth} view={view([film({})])} onOpenBoard={() => {}} />)
    expect(screen.getByTestId('final-credits')).toHaveTextContent('这支片没有需要署名的素材')
  })
})
