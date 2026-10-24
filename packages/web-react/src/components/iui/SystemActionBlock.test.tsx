import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { SystemActionDetail, SystemActionSummary } from '@openclaude/protocol/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCardActionsContext, type SystemActionCardActions } from '../tool/context'
import { IuiBlock } from './IuiBlock'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const code = JSON.stringify({ type: 'system_action', proposalId: id })
function detail(): SystemActionDetail {
  return { id, operationId: 'preferences.patch', title: '更改通知', state: 'prepared', executor: 'master',
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000, result: null, previewHash: 'preview-frozen-hash',
    preview: { title: '更改通知', description: '只影响后续通知', scope: '当前账号', before: [{ label: '邮件通知', value: '开启' }],
      after: [{ label: '邮件通知', value: '关闭' }], consequences: ['不撤回已发送的通知'], price: { kind: 'none', label: '不产生模型请求' }, destructive: false } }
}
function actions(): SystemActionCardActions {
  return { identityKey: 'fixture-person', getDetail: vi.fn(async () => detail()),
    getConfirmation: vi.fn(async () => ({ detail: detail(), nonce: 'browser-only-confirmation-nonce' })),
    confirm: vi.fn(async (): Promise<SystemActionSummary> => ({ ...detail(), state: 'succeeded', result: { summary: '已关闭邮件通知', completion: 'done' } })),
    deny: vi.fn(async (): Promise<SystemActionSummary> => ({ ...detail(), state: 'denied' })), }
}
function view(a: SystemActionCardActions, raw = code, props: { live?: boolean; readOnly?: boolean } = {}) {
  return <ToolCardActionsContext.Provider value={{ systemActions: a }}><IuiBlock code={raw} {...props} /></ToolCardActionsContext.Provider>
}
afterEach(cleanup)

describe('verified system action sheet', () => {
  it('reads authority details; opening/cancelling the sheet does not execute, explicit confirmation does', async () => {
    const a = actions(); render(view(a))
    await screen.findByText('更改通知')
    expect(a.confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看并确认' }))
    let dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('当前账号')).toBeVisible()
    expect(within(dialog).getByText('不撤回已发送的通知')).toBeVisible()
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
    expect(a.confirm).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '查看并确认' }))
    dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }))
    await screen.findByText('已关闭邮件通知')
    expect(a.confirm).toHaveBeenCalledExactlyOnceWith(id, { nonce: 'browser-only-confirmation-nonce', previewHash: 'preview-frozen-hash' })
    expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
  })
  it('does not describe an accepted job or an unknown effect as completed', async () => {
    const a = actions()
    a.getDetail = vi.fn(async (): Promise<SystemActionDetail> => ({ ...detail(), state: 'succeeded', preview: null, result: { summary: '后台任务已提交', completion: 'accepted' } }))
    const r = render(view(a))
    await screen.findByText('已提交')
    expect(screen.queryByText('已完成')).not.toBeInTheDocument()
    a.getDetail = vi.fn(async (): Promise<SystemActionDetail> => ({ ...detail(), state: 'unknown', preview: null, result: { summary: '执行结果待核对', completion: 'accepted' } }))
    a.identityKey = 'next-fixture'
    r.rerender(view(a))
    await screen.findByText('结果待核对')
    expect(screen.queryByText('已提交')).not.toBeInTheDocument()
  })
  it('read-only history and streaming never fetch or enable an action', () => {
    const a = actions(); const r = render(view(a, code, { readOnly: true }))
    expect(a.getDetail).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
    r.rerender(view(a, code, { live: true }))
    expect(a.getDetail).not.toHaveBeenCalled()
  })
  it('repairable JSON, added arguments and nested references cannot create privileged controls', () => {
    for (const raw of [code.replace(/}$/, ',}'), JSON.stringify({ type: 'system_action', proposalId: id, args: { enabled: true } }),
      JSON.stringify({ type: 'tabs', tabs: [{ label: 'x', block: { type: 'system_action', proposalId: id } }] })]) {
      const a = actions(); const r = render(view(a, raw))
      expect(a.getDetail).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
      r.unmount()
    }
  })
  it('rejects details for another id and masks previous identity data immediately', async () => {
    const a = actions(); const r = render(view(a)); await screen.findByText('更改通知')
    const b = actions(); b.identityKey = 'another-fixture-identity'
    b.getDetail = vi.fn(async (): Promise<SystemActionDetail> => ({ ...detail(), id: 'a5be0795-e604-45ee-bd8b-a519324b5cf4' }))
    r.rerender(view(b))
    expect(screen.queryByText('更改通知')).not.toBeInTheDocument()
    await screen.findByText('这项操作无法核验。')
    expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
  })
  it('transport failure discards the nonce and refreshes an unknown result without resubmission', async () => {
    const a = actions(); let unknown = false
    a.confirm = vi.fn(async () => { unknown = true; throw new Error('lost response') })
    a.getDetail = vi.fn(async (): Promise<SystemActionDetail> => unknown ? { ...detail(), state: 'unknown', preview: null } : detail())
    render(view(a)); await screen.findByText('更改通知')
    fireEvent.click(screen.getByRole('button', { name: '查看并确认' }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }))
    await screen.findByText('结果待核对')
    expect(a.confirm).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }))
    await waitFor(() => expect(a.getDetail).toHaveBeenCalledTimes(3))
    expect(a.confirm).toHaveBeenCalledTimes(1)
  })
})

it('checks unknown receipts without submitting the business operation again', async () => {
  const a = actions()
  const unknown = { ...detail(), state: 'unknown' as const, preview: null, result: { summary: '等待核对', completion: 'accepted' as const } }
  a.getDetail = vi.fn(async () => unknown)
  a.reconcile = vi.fn().mockResolvedValueOnce(unknown).mockResolvedValueOnce({ ...unknown, state: 'succeeded', result: { summary: '已核对完成', completion: 'done' } })
  render(view(a))
  fireEvent.click(await screen.findByRole('button', { name: '核对结果' }))
  await waitFor(() => expect(a.reconcile).toHaveBeenCalledTimes(1))
  expect(screen.getByText('结果待核对')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: '核对结果' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: '核对结果' }))
  await screen.findByText('已核对完成')
  expect(a.reconcile).toHaveBeenCalledTimes(2)
  expect(a.getConfirmation).not.toHaveBeenCalled()
  expect(a.confirm).not.toHaveBeenCalled()
  expect(a.deny).not.toHaveBeenCalled()
})
it.each([true, false])('receipt controls remain unavailable when readOnly=%s or no adapter exists', async readOnly => {
  const a = actions()
  a.getDetail = vi.fn(async () => ({ ...detail(), state: 'unknown' as const, preview: null }))
  if (readOnly) a.reconcile = vi.fn()
  render(view(a, code, { readOnly }))
  await screen.findByText(readOnly ? '只读记录' : '结果待核对')
  expect(screen.queryByRole('button', { name: '核对结果' })).not.toBeInTheDocument()
})
it('a receipt arriving after an identity change cannot update the replacement card', async () => {
  const a = actions()
  a.getDetail = vi.fn(async () => ({ ...detail(), state: 'unknown' as const, preview: null }))
  let release!: (value: SystemActionSummary) => void
  const pending = new Promise<SystemActionSummary>(resolve => { release = resolve })
  a.reconcile = vi.fn(async () => pending)
  const r = render(view(a))
  fireEvent.click(await screen.findByRole('button', { name: '核对结果' }))
  expect(screen.getByRole('button', { name: '核对结果' })).toBeDisabled()
  a.identityKey = 'different-receipt-owner'
  r.rerender(view(a))
  await act(async () => { release({ ...detail(), state: 'succeeded', result: { summary: '旧身份回执不应显示', completion: 'done' } }); await pending })
  expect(screen.queryByText('旧身份回执不应显示')).not.toBeInTheDocument()
})
