import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api } from '../../lib/api'
import { createMemoryAuthSession } from '../../lib/authSession'
import { LibraryPanel } from './LibraryPanel'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

test('文献库首次加载失败不显示假空态，可原地重试后显示真实空态', async () => {
  const auth = createMemoryAuthSession(() => {}, 'tok')
  const listLibrary = vi
    .spyOn(api, 'listResearchLibrary')
    .mockRejectedValueOnce(new Error('backend unavailable'))
    .mockResolvedValueOnce([])

  render(<LibraryPanel auth={auth} />)

  expect(await screen.findByText('加载文献库失败')).toBeInTheDocument()
  expect(screen.queryByText('文献库为空')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  expect(await screen.findByText('文献库为空')).toBeInTheDocument()
  await waitFor(() => expect(listLibrary).toHaveBeenCalledTimes(2))
})
