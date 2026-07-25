import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { MarketplaceInstalled } from '../../lib/types'
import { TooltipProvider } from '../ui'

const mocks = vi.hoisted(() => ({
  listMarketplaceInstalled: vi.fn(),
  listMyAgents: vi.fn(),
  uninstallMarketplace: vi.fn(),
}))
vi.mock('../../lib/api', () => ({
  api: {
    listMarketplaceInstalled: (...args: unknown[]) => mocks.listMarketplaceInstalled(...args),
    listMyAgents: (...args: unknown[]) => mocks.listMyAgents(...args),
    uninstallMarketplace: (...args: unknown[]) => mocks.uninstallMarketplace(...args),
  },
  apiErrorMessage: (_cause: unknown, fallback: string) => fallback,
}))

import { InstalledPanel } from './InstalledPanel'

const auth = createMemoryAuthSession(() => {}, 'tok')
const installed: MarketplaceInstalled = {
  slug: 'research-helper',
  kind: 'skill',
  version: '1.0.0',
  versionId: 'v1',
  name: '研究助手',
  artifactHash: 'hash',
  agentIds: ['main'],
  installedAt: '2026-07-25T00:00:00.000Z',
  listingState: 'active',
}

beforeEach(() => {
  mocks.listMarketplaceInstalled.mockReset().mockResolvedValue([installed])
  mocks.listMyAgents.mockReset().mockResolvedValue([])
  mocks.uninstallMarketplace.mockReset().mockResolvedValue({ ok: true })
})
afterEach(cleanup)

test('卸载前可选原因并随请求提交', async () => {
  render(
    <TooltipProvider>
      <InstalledPanel auth={auth} onGoBrowse={() => {}} />
    </TooltipProvider>,
  )
  await screen.findByText('研究助手')
  fireEvent.click(screen.getByRole('button', { name: '卸载' }))

  const dialog = await screen.findByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('原因（可不说明）'), {
    target: { value: 'missing_capability' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: '卸载' }))

  await waitFor(() =>
    expect(mocks.uninstallMarketplace).toHaveBeenCalledWith(
      auth,
      'research-helper',
      'missing_capability',
    ),
  )
})
