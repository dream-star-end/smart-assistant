import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { createMemoryAuthSession } from '../../lib/authSession'
import type { PrefsView } from '../../lib/modelPreferences'
import { AssistantPrivacyPreferences } from './AssistantPrivacyPreferences'
afterEach(cleanup)
test('default off; editing, opening and cancelling never write; explicit consent saves scoped data', async () => {
  const auth = createMemoryAuthSession(() => {})
  const writes = vi.fn(async (_patch: Record<string, unknown>) => {})
  function Harness() {
    const [profile, setProfile] = useState<PrefsView['system_assistant_profile']>()
    return <AssistantPrivacyPreferences auth={auth} sessionId="scope-a" profile={profile} onPatch={async p => { await writes(p); setProfile(p.system_assistant_profile as PrefsView['system_assistant_profile']) }} />
  }
  render(<Harness />)
  const toggle = screen.getByRole('switch', { name: '本会话使用称呼' })
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  fireEvent.change(screen.getByRole('textbox', { name: '助手称呼' }), { target: { value: '小林' } })
  fireEvent.click(toggle)
  let dialog = await screen.findByRole('dialog')
  expect(writes).not.toHaveBeenCalled()
  expect(within(dialog).getByText('称呼：小林')).toBeVisible()
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(writes).not.toHaveBeenCalled()
  fireEvent.click(toggle)
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  expect(writes).toHaveBeenCalledExactlyOnceWith({ system_assistant_profile: { enabled: true, nickname: '小林', sessionId: 'scope-a' } })
})
test('failed withdrawal retains the controlled preference and reports failure', async () => {
  const auth = createMemoryAuthSession(() => {})
  const writes = vi.fn(async () => { throw new Error('保存失败，请重试') })
  render(<AssistantPrivacyPreferences auth={auth} sessionId="scope-a" profile={{ enabled: true, nickname: '小林', sessionId: 'scope-a' }} onPatch={writes} />)
  fireEvent.click(screen.getByRole('switch', { name: '本会话使用称呼' }))
  const dialog = await screen.findByRole('dialog')
  expect(writes).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
  await screen.findByText('保存失败，请重试')
  expect(screen.getByRole('switch', { name: '本会话使用称呼', hidden: true })).toHaveAttribute('aria-checked', 'true')
  expect(writes).toHaveBeenCalledExactlyOnceWith({ system_assistant_profile: null })
})
test('a new identity cannot confirm a sheet prepared by the previous identity', async () => {
  const auth = createMemoryAuthSession(() => {})
  const writes = vi.fn(async (_patch: Record<string, unknown>) => {})
  render(<AssistantPrivacyPreferences auth={auth} sessionId="scope-a" profile={{ enabled: true, nickname: '小林', sessionId: 'scope-a' }} onPatch={writes} />)
  fireEvent.click(screen.getByRole('switch', { name: '本会话使用称呼' }))
  const dialog = await screen.findByRole('dialog')
  auth.beginIdentity()
  fireEvent.click(within(dialog).getByRole('button', { name: '确认保存' }))
  expect(writes).not.toHaveBeenCalled()
})
