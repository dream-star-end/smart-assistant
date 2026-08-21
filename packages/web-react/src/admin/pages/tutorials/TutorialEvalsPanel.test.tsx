import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../../lib/api'
import { TutorialEvalsPanel } from './TutorialEvalsPanel'

beforeEach(() => {
  vi.spyOn(api, 'listTutorialEvalSpecs').mockResolvedValue({ specs: [], nextCursor: null })
  vi.spyOn(api, 'listTutorialEvalJobs').mockResolvedValue({ jobs: [], nextCursor: null })
  vi.spyOn(api, 'listTutorialEvalCompass').mockResolvedValue({ items: [], nextCursor: null })
  vi.spyOn(api, 'createTutorialEvalSpec').mockResolvedValue({
    id: 'spec-1',
    publicId: 'ext-1',
    title: '外部案例登记标题足够长',
    sourcePlatform: 'Claude',
    sourceUrl: 'https://example.test/case',
    collectedAt: '2026-08-20T00:00:00.000Z',
    frozenPrompt: 'do the task with public materials only',
    authScope: 'synthetic_eval',
    rubric: { checks: [] },
    createdAt: '2026-08-20T00:00:00.000Z',
  })
  vi.spyOn(api, 'enqueueTutorialEvalJob').mockResolvedValue({
    id: 'job-1',
    specId: 'spec-1',
    status: 'queued',
    createdAt: '2026-08-20T00:00:00.000Z',
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TutorialEvalsPanel', () => {
  it('空队列时不声称自动评测已完成，并可登记后排队', async () => {
    render(<TutorialEvalsPanel />)
    expect(await screen.findByRole('heading', { name: '案例评测 / 改进罗盘' })).toBeInTheDocument()
    expect(screen.getByText(/不会声称自动评测已完成/)).toBeInTheDocument()
    expect(screen.getByText('尚未排队评测，不会显示已完成结果。')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/公开 ID/), { target: { value: 'ext-1' } })
    fireEvent.change(screen.getByLabelText(/^标题/), { target: { value: '外部案例登记标题足够长' } })
    fireEvent.change(screen.getByLabelText(/来源平台/), { target: { value: 'Claude' } })
    fireEvent.change(screen.getByLabelText(/来源 URL/), { target: { value: 'https://example.test/case' } })
    fireEvent.change(screen.getByLabelText(/采集时间/), { target: { value: '2026-08-20T00:00:00.000Z' } })
    fireEvent.change(screen.getByLabelText(/冻结 prompt/), { target: { value: 'do the task with public materials only' } })
    fireEvent.click(screen.getByRole('button', { name: '登记案例' }))

    await waitFor(() => expect(api.createTutorialEvalSpec).toHaveBeenCalledTimes(1))
    expect(api.createTutorialEvalSpec).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicId: 'ext-1',
        sourcePlatform: 'Claude',
        sourceUrl: 'https://example.test/case',
        frozenMaterials: { items: [] },
        rubric: expect.objectContaining({
          checks: [expect.objectContaining({ id: 'reproducible-output' })],
        }),
      }),
    )
  })
})
