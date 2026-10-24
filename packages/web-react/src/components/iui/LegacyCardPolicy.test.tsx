import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../lib/chat/model'
import { __resetIntelligentUiForTests } from '../../lib/intelligentUi'
import { loadBeforeAll } from '../../test/moduleLoad'
import { prefetchMarkdownImpl } from '../Markdown'
import { MessageList, MessageRenderer } from '../MessageRenderer'
import { ProcessDisclosure, processSections } from '../chat/ProcessDisclosure'
import { ToolCardActionsContext, type ToolCardActions } from '../tool/context'
import { ConnectorConfirmCard } from '../tool/connectorCards'
import { TaskApprovalCard } from '../tool/taskApprovalCard'
import { preloadToolBody } from '../tool/lazyToolBody'
import { IuiBlock } from './IuiBlock'
import { LegacyCardPolicyProvider } from './LegacyCardPolicy'
import { ReadOnlySystemActionsBoundary } from './ReadOnlySystemActionsBoundary'
import { __resetBlogChatForTests } from './blogChat'

loadBeforeAll(() => Promise.all([prefetchMarkdownImpl(), preloadToolBody()]))
beforeEach(() => { __resetIntelligentUiForTests({ pref: true }); __resetBlogChatForTests() })
afterEach(() => { cleanup(); __resetIntelligentUiForTests(); __resetBlogChatForTests() })
const draft = JSON.stringify({ type: 'blog_draft', draft_id: 'policy-test', version: 1, title: '分享经验', summary: '流程说明', category: '编程', body: '这是分享经验的正文。' })
const fence = '```ui\n' + draft + '\n```'
const row = (id: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id, role, text, ts: 1700000000000, ...extra })
function fixture() {
  const read = vi.fn(() => new Promise<never>(() => {}))
  const write = vi.fn(async () => ({ id: '12', sha256: 'a'.repeat(64) }))
  const precheck = vi.fn(async () => ({ issues: [], quota: { pendingLeft: 3, dailyLeft: 5 } }))
  const actions: ToolCardActions = {
    connectorConfirm: { getDetail: read, decide: read },
    taskApproval: { getTicket: read, approve: read, reject: read },
    communityBlog: { precheck, readContainerImage: read, uploadImage: write, submit: write, getMine: read,
      postUrl: id => `https://example.test/${id}`, openPost: vi.fn(), openMine: vi.fn(), openEditor: vi.fn() },
  }
  return { actions, read, write, precheck }
}
function cards() {
  return <><IuiBlock code={draft} /><ConnectorConfirmCard trigger={{ type: 'confirmation_required', id: 'abcd1234-ef56-7890-aaaa-bbbbccccdddd' }} /><TaskApprovalCard id="OCV5-42" /></>
}
it.each(['boundary', 'inherited', 'live'] as const)('%s blocks all three legacy business groups before private reads', async kind => {
  const f = fixture()
  render(<ToolCardActionsContext.Provider value={f.actions}>
    {kind === 'boundary' ? <ReadOnlySystemActionsBoundary readOnly>{cards()}</ReadOnlySystemActionsBoundary>
      : <LegacyCardPolicyProvider readOnly={kind === 'inherited'} live={kind === 'live'}>
        <ReadOnlySystemActionsBoundary readOnly={false}>
          <ToolCardActionsContext.Provider value={f.actions}>{cards()}</ToolCardActionsContext.Provider>
        </ReadOnlySystemActionsBoundary>
      </LegacyCardPolicyProvider>}
  </ToolCardActionsContext.Provider>)
  await act(async () => {})
  expect(f.read).not.toHaveBeenCalled()
  expect(f.precheck).not.toHaveBeenCalled()
  expect(f.write).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '确认执行' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '通过' })).not.toBeInTheDocument()
})
it('complete live blog JSON stays passive and becomes available after completion', async () => {
  const f = fixture()
  const view = render(<ToolCardActionsContext.Provider value={f.actions}><IuiBlock code={draft} live /></ToolCardActionsContext.Provider>)
  await act(async () => {})
  expect(f.precheck).not.toHaveBeenCalled()
  view.rerender(<ToolCardActionsContext.Provider value={f.actions}><IuiBlock code={draft} live={false} /></ToolCardActionsContext.Provider>)
  await waitFor(() => expect(f.precheck).toHaveBeenCalledTimes(1))
  expect(f.write).not.toHaveBeenCalled()
})
it('ordinary completed cards retain their existing authenticated reads', async () => {
  const f = fixture()
  render(<ToolCardActionsContext.Provider value={f.actions}>{cards()}</ToolCardActionsContext.Provider>)
  await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
  expect(f.precheck).toHaveBeenCalledTimes(1)
  expect(f.write).not.toHaveBeenCalled()
})
it('real readonly MessageRenderer renders the draft without inheriting business authority', async () => {
  const f = fixture()
  render(<ToolCardActionsContext.Provider value={f.actions}><MessageRenderer m={row('draft', 'assistant', fence)} sig="readonly-draft" cb={{}} onRespondPermission={() => {}} readOnly /></ToolCardActionsContext.Provider>)
  await screen.findByText('分享经验')
  expect(f.precheck).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
})
it('ProcessDisclosure passes readonly to its actual narrative Markdown without an outer boundary', async () => {
  const f = fixture()
  const message = row('stage', 'assistant', fence)
  const sections = processSections([message], m => [m], m => m.id)
  render(<ToolCardActionsContext.Provider value={f.actions}><ProcessDisclosure sections={sections} active={false} open readOnly setOpen={() => {}} detailOpen={() => true} setDetailOpen={() => {}} renderItem={() => null} keyOf={m => m.id} messagesOf={m => [m]} eagerDeferred={false} /></ToolCardActionsContext.Provider>)
  await screen.findByText('分享经验')
  expect(f.precheck).not.toHaveBeenCalled()
})
it('real readonly MessageList keeps business draft narration passive inside expanded process', async () => {
  const f = fixture()
  const messages = [row('u', 'user', '整理一下'), row('stage', 'assistant', fence), row('tool', 'tool', '终端', { toolName: 'Bash', inputJson: { command: 'echo fixture' }, output: 'ok', _completed: true }), row('final', 'assistant', '整理完毕')]
  render(<ToolCardActionsContext.Provider value={f.actions}><MessageList messages={messages} sending={false} sessionId="policy-session" cb={{}} onRespondPermission={() => {}} processDisclosure readOnly /></ToolCardActionsContext.Provider>)
  fireEvent.click(await screen.findByTestId('process-toggle'))
  await screen.findByText('分享经验')
  expect(f.precheck).not.toHaveBeenCalled()
  expect(f.read).not.toHaveBeenCalled()
})
