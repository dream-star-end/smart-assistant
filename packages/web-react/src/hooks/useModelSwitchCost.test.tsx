import { expect, test, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { createMemoryAuthSession } from '../lib/authSession'
import { useModelSwitchCost } from './useModelSwitchCost'
const loader = vi.hoisted(() => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return { gate, release: () => release() }
})
vi.mock('../lib/modelSwitchCostClient', async () => {
  await loader.gate
  throw new TypeError('fixture chunk unavailable')
})
test('failed lazy load cannot grant an obsolete selection or lose valid offline work', async () => {
  const auth = createMemoryAuthSession(() => {}, 'fixture')
  const { result } = renderHook(() =>
    useModelSwitchCost({ authRef: { current: auth }, confirmDialog: vi.fn(), toast: vi.fn() }),
  )
  const input = {
    sessionId: 'own',
    requestId: 'm-lazy-cost-1',
    targetModel: 'gpt-6-astra',
    agentId: 'main',
  }
  let selected = true
  const pending = result.current(input, { allowOfflineQueue: true, isCurrent: () => selected })
  selected = false
  loader.release()
  expect(await pending).toBeNull()
  expect(
    await result.current({ ...input, requestId: 'm-lazy-cost-2' }, { allowOfflineQueue: true }),
  ).toEqual({ requestId: 'm-lazy-cost-2', choice: true })
  await expect(
    result.current({ ...input, requestId: 'm-lazy-cost-3' }, { interactive: false }),
  ).rejects.toMatchObject({ cause: { message: 'fixture chunk unavailable' } })
})
