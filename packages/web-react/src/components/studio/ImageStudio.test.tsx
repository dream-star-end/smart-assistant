import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'

const uploadAsset = vi.fn()
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
      uploadAsset: (...a: unknown[]) => uploadAsset(...a),
    },
  }
})
vi.mock('../../lib/api', () => ({
  callWithRefresh: vi.fn(),
  bearerHeaders: vi.fn(),
  assertAuthResponseCurrent: vi.fn(),
  AuthEpochStaleError: class extends Error {},
}))

import type { ProvidersView, StudioProjectView } from '../../lib/studio/types'
import { ImageStudioPage } from './pages/ImageStudio'

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  uploadAsset.mockReset()
})

const auth = { snapshot: () => ({ token: 't', epoch: 1 }) } as never
const providers: ProvidersView = {
  kinds: [
    {
      kind: 'image',
      state: 'ready',
      providers: [
        {
          id: 'gpt-image',
          label: 'GPT Image',
          state: 'ready',
          models: [{ id: 'gpt-image-2', label: 'gpt-image-2', ops: [], isDefault: true }],
        },
        {
          id: 'grok',
          label: 'Grok Imagine',
          state: 'unconfigured',
          reason: 'MISSING_KEY',
          models: [],
        },
      ],
    },
  ],
}
function view(): StudioProjectView {
  return {
    project: { id: 'p', aspect: '16:9' } as never,
    shots: [],
    lines: [],
    assets: [
      {
        id: 'a1',
        kind: 'character',
        name: '红狐「阿焰」',
        locked: true,
        descriptor: '成年赤狐，橙红毛',
        blobSha: null,
        voiceId: null,
        meta: {},
        createdAt: '',
      },
      {
        id: 'u1',
        kind: 'upload',
        name: 'ref.png',
        locked: false,
        descriptor: null,
        blobSha: 'b'.repeat(64),
        voiceId: null,
        meta: {},
        createdAt: '',
      },
    ],
    takes: [1, 2].map((v) => ({
      id: `t${v}`,
      ownerKind: 'bible' as const,
      ownerId: 'a1',
      version: v,
      provider: 'GPT Image',
      model: 'gpt-image-2',
      op: 'image.generate',
      status: 'succeeded' as const,
      errorCode: null,
      costCredits: '50',
      qa: { score: 0.8 + v / 100 },
      blobSha: `${v}`.repeat(64),
      createdAt: '',
      finishedAt: null,
    })),
    events: [],
  }
}

describe('ImageStudioPage (OCV5-593 FE-2c)', () => {
  test('bible card, fixed descriptor, versions and model plan from /providers; regenerate disabled', () => {
    render(<ImageStudioPage auth={auth} view={view()} providers={providers} onReload={() => {}} />)
    expect(screen.getAllByText('红狐「阿焰」').length).toBeGreaterThan(0)
    expect(screen.getAllByText('成年赤狐，橙红毛').length).toBeGreaterThan(0)
    expect(screen.getByText('2 个版本')).toBeInTheDocument()
    expect(screen.getByText('GPT Image').closest('.st-model-row')).toHaveClass('on')
    expect(screen.getByText('Grok Imagine').closest('.st-model-row')).toHaveAttribute(
      'data-state',
      'unconfigured',
    )
    expect(screen.getByRole('button', { name: /再生成/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /锁定为设定/ })).toBeDisabled()
  })

  test('uploading a reference calls the real endpoint and reloads', async () => {
    const onReload = vi.fn()
    uploadAsset.mockResolvedValue({ id: 'u2' })
    const { container } = render(
      <ImageStudioPage auth={auth} view={view()} providers={providers} onReload={onReload} />,
    )
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'fox.png', {
      type: 'image/png',
    })
    fireEvent.change(input, { target: { files: [png] } })
    await waitFor(() => expect(onReload).toHaveBeenCalled())
    expect(uploadAsset).toHaveBeenCalledWith(auth, 'p', png)
  })

  test('a batch where a later file fails still refreshes for the files already stored (code r1 P2)', async () => {
    const onReload = vi.fn()
    uploadAsset.mockResolvedValueOnce({ id: 'u2' }).mockRejectedValueOnce(new Error('net'))
    const { container } = render(
      <ImageStudioPage auth={auth} view={view()} providers={providers} onReload={onReload} />,
    )
    const input = container.querySelector('input[type=file]') as HTMLInputElement
    const a = new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })
    const b = new File([new Uint8Array([1])], 'b.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [a, b] } })
    await waitFor(() => expect(onReload).toHaveBeenCalledTimes(1))
    expect(uploadAsset).toHaveBeenCalledTimes(2)
  })

  test('comment mode drops a pin draft on the current version', async () => {
    render(<ImageStudioPage auth={auth} view={view()} providers={providers} onReload={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '评论' }))
    const canvas = screen.getByTestId('image-canvas')
    canvas.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 400,
      right: 600,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON() {},
    })
    fireEvent.pointerDown(canvas, { clientX: 300, clientY: 100 })
    expect(await screen.findByRole('dialog', { name: '批注 1' })).toBeInTheDocument()
    const saved = JSON.parse(sessionStorage.getItem('oc.studio.annotationDrafts.p')!)
    expect(saved[0]).toMatchObject({ takeId: 't2', kind: 'point', x: 0.5, y: 0.25 })
  })
})
