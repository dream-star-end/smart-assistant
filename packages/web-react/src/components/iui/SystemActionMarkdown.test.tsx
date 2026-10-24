import { captureIdentityAttempt, resolveIdentity } from '../../lib/resolvedIdentity'
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Markdown from '../MarkdownImpl'
import { ToolCardActionsContext } from '../tool/context'
import { createMemoryAuthSession } from '../../lib/authSession'
import { __resetIntelligentUiForTests } from '../../lib/intelligentUi'
import { useSystemActionCardActions } from '../../hooks/useSystemActionCardActions'
import { uiFencesToMarkdown } from './toMarkdown'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const ref = JSON.stringify({ type: 'system_action', proposalId: id })
const fence = (code: string, language = 'ui') => `\`\`\`${language}\n${code}\n\`\`\``
const prepared = () => ({ id, operationId: 'preferences.update', title: '更改通知', state: 'prepared', executor: 'master',
  createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000, result: null, previewHash: 'a'.repeat(64),
  preview: { title: '更改通知', description: '后续通知', scope: '当前账号', before: [], after: [], consequences: [], price: { kind: 'none', label: '无费用' }, destructive: false } })
const succeeded = () => ({ ...prepared(), state: 'succeeded', preview: null, result: { summary: '已更新', completion: 'done' } })
const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
function view(source: string, options: { readOnly?: boolean; live?: boolean; provider?: boolean } = {}) {
  const auth = createMemoryAuthSession(() => {}, 'fixture-access')
  const input = { authRef: { current: auth }, userId: '765', identity: resolveIdentity(captureIdentityAttempt(auth, auth.snapshot().token), '765'), demo: false, applyPreferences: vi.fn(), setTheme: vi.fn(), onSyncError: vi.fn() }
  function Harness() {
    const { systemActions } = useSystemActionCardActions(input)
    return <ToolCardActionsContext.Provider value={{ systemActions: options.provider === false ? undefined : systemActions }}>
      <Markdown readOnly={options.readOnly} live={options.live}>{source}</Markdown>
    </ToolCardActionsContext.Provider>
  }
  return render(<Harness />)
}
beforeEach(() => { __resetIntelligentUiForTests({ pref: false }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); __resetIntelligentUiForTests() })
it('UI-off real Markdown keeps native approval and sheet, downgrades ordinary UI and confirms exactly once', async () => {
  let committed = false
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    const path = String(url)
    if (path.endsWith('/challenge')) return reply({ detail: prepared(), nonce: 'A'.repeat(43) })
    if (path.endsWith('/confirm')) { committed = true; return reply(succeeded()) }
    if (path === '/api/me/preferences') return reply({ prefs: { intelligent_ui: false, theme: 'auto' } })
    if ((options?.method ?? 'GET') === 'GET' && path === `/api/me/system-actions/${id}`) return reply(committed ? succeeded() : prepared())
    throw new Error('Unexpected fixture request')
  })
  vi.stubGlobal('fetch', fetcher)
  const table = fence(JSON.stringify({ type: 'table', columns: ['项目', '状态'], rows: [['可选组件', '普通表格']] }))
  const { container } = view(`${fence(ref)}\n\n${table}`)
  expect(await screen.findByRole('table')).toHaveTextContent('普通表格')
  expect(container.querySelectorAll('.oc-iui')).toHaveLength(1)
  fireEvent.click(await screen.findByRole('button', { name: '查看并确认' }))
  const dialog = await screen.findByRole('dialog')
  expect(fetcher.mock.calls.filter(([url]) => /\/(confirm|deny|reconcile)$/.test(String(url)))).toHaveLength(0)
  expect(committed).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '确认执行' }))
  await screen.findByText('已更新')
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/confirm'))).toHaveLength(1)
  expect(fetcher.mock.calls.some(([, options]) => options?.method === 'PATCH')).toBe(false)
})
it.each([
  ['extra field', fence(JSON.stringify({ type: 'system_action', proposalId: id, args: {} }))],
  ['wrong uuid', fence(JSON.stringify({ type: 'system_action', proposalId: 'wrong' }))],
  ['repairable JSON', fence(`{type:'system_action',proposalId:'${id}'}`)],
  ['unclosed fence', `\`\`\`ui\n${ref}`],
  ['partial JSON', `\`\`\`ui\n{"type":"system_action","proposalId":"${id}`],
  ['quoted original fence', fence(ref).split('\n').map(line => `> ${line}`).join('\n')],
])('does not promote %s to an approval or fetch details', async (_name, source) => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  view(source)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})
it.each(['tabs', 'callout'])('downgraded %s body cannot manufacture a nested approval fence', async type => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const embedded = fence(ref, 'UI')
  const block = type === 'tabs' ? { type, tabs: [{ label: '说明', body: embedded }] } : { type, tone: 'info', body: embedded }
  view(fence(JSON.stringify(block)))
  await act(async () => {})
  expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})
it.each([{ readOnly: true }, { live: true }, { provider: false }])('readOnly/streaming/unavailable provider makes no approval request: %j', async options => {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  view(fence(ref), options)
  await act(async () => {})
  expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
  expect(fetcher).not.toHaveBeenCalled()
})
it.each(['UI', ' ui'])('complete original %s reference follows the same native strict path', async language => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => reply(prepared())))
  view(fence(ref, language))
  await screen.findByRole('button', { name: '查看并确认' })
})
it('default copy/export conversion remains plain JSON; render mode is explicit', () => {
  const source = fence(ref)
  expect(uiFencesToMarkdown(source)).toBe(fence(ref, 'json'))
  expect(uiFencesToMarkdown(source, false, { systemActionReferences: 'preserve' })).toBe(source)
  expect(uiFencesToMarkdown(source, false, { systemActionReferences: 'plain' })).toBe(fence(ref, 'json'))
})
it('enabled ordinary UI and approval still use the existing renderer', async () => {
  __resetIntelligentUiForTests({ pref: true })
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => reply(prepared())))
  view(`${fence(ref)}\n\n${fence(JSON.stringify({ type: 'callout', tone: 'info', body: '原有组件' }))}`)
  await screen.findByRole('button', { name: '查看并确认' })
  expect(screen.getByText('原有组件')).toBeInTheDocument()
})
it.each(['tabs', 'callout'])('entity-encoded %s downgrade cannot manufacture an approval', async type => {
  await import('../../lib/api/systemActionsApi')
  const fetcher = vi.fn<typeof fetch>(async () => reply(prepared()))
  vi.stubGlobal('fetch', fetcher)
  const embedded = `~~~&#117;i\n${ref}\n~~~`
  const block = type === 'tabs' ? { type, tabs: [{ label: '说明', body: embedded }] } : { type, tone: 'info', body: embedded }
  view(fence(JSON.stringify(block), 'UI'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
})

it.each([
  ['numeric character reference', `~~~&#117;i\n${ref}\n~~~`],
  ['hex character reference', fence(ref, 'u&#x69;')],
  ['quoted character reference', `> ~~~&#x75;&#105;\n> ${ref}\n> ~~~`],
])('an encoded original language stays noninteractive: %s', async (_name, source) => {
  await import('../../lib/api/systemActionsApi')
  const fetcher = vi.fn<typeof fetch>(async () => reply(prepared()))
  vi.stubGlobal('fetch', fetcher)
  view(source)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(fetcher).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: '查看并确认' })).not.toBeInTheDocument()
})
