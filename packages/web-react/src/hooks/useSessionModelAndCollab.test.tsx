import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api, ApiError } from '../lib/api'
import { createMemoryAuthSession } from '../lib/authSession'
import type { CollaborationConfigDoc, CollabMode } from '../lib/collaborationConfig'
import type { AuthorizeSwitch } from '../lib/modelSwitchCostTypes'
import {
  useSessionModelAndCollab,
  type SessionModelAndCollabInput,
} from './useSessionModelAndCollab'

const doc = (mode: CollabMode, rev: number): CollaborationConfigDoc => ({
  rev,
  defaultMode: 'solo',
  defaultAdvisorModel: null,
  session: { mode, advisorModel: null, configVersion: `v${rev}:${mode}`, source: 'session' },
})
function setup() {
  const input = {
    activeId: 'own',
    modelId: undefined,
    auth: createMemoryAuthSession(() => {}, 'fixture'),
    agent: { id: 'main', name: 'Main', description: '' },
    demo: false,
    models: [],
    modelPrefs: {},
    modelSwitchPreparing: false,
    sessions: [],
    confirmDialog: vi.fn(),
    handleNew: vi.fn(),
    queueModelPatch: vi.fn(),
    resetSessionList: vi.fn(),
    sessionsResetRef: { current: vi.fn() },
    setModelId: vi.fn(),
    setModelSwitchPreparing: vi.fn(),
    setSessions: vi.fn(),
    sockRef: { current: null },
    toast: vi.fn(),
  } as SessionModelAndCollabInput
  const hook = renderHook((props) => useSessionModelAndCollab(props), { initialProps: input })
  return { ...hook, input }
}
afterEach(() => vi.restoreAllMocks())

test.each(['solo', 'team'] as const)(
  '409 retries the clicked %s once against the fresh revision',
  async (mode) => {
    vi.spyOn(api, 'getCollaborationConfig')
      .mockResolvedValueOnce(doc('team', 1))
      .mockResolvedValueOnce(doc(mode === 'solo' ? 'team' : 'solo', 2))
    const put = vi
      .spyOn(api, 'putCollaborationConfig')
      .mockRejectedValueOnce(new ApiError({ status: 409, message: 'conflict' }))
      .mockResolvedValueOnce(doc(mode, 3))
    const f = setup()
    await waitFor(() => expect(f.result.current.collabUi.rev).toBe(1))
    await act(() => f.result.current.persistCollab(mode, { asDefault: true }))
    expect(put).toHaveBeenCalledTimes(2)
    expect(put.mock.calls.map((call) => call[1])).toEqual([
      { sessionId: 'own', mode, advisorModel: null, expectedRev: 1, asDefault: true },
      { sessionId: 'own', mode, advisorModel: null, expectedRev: 2, asDefault: true },
    ])
    expect(f.result.current.collabUi.configVersion).toBe(`v3:${mode}`)
    expect(f.result.current.collabSaveError).toBeNull()
    expect(f.input.toast).not.toHaveBeenCalled()
  },
)

test('a second conflict is bounded and keeps the clicked solo choice', async () => {
  vi.spyOn(api, 'getCollaborationConfig')
    .mockResolvedValueOnce(doc('team', 1))
    .mockResolvedValueOnce(doc('team', 2))
  const put = vi
    .spyOn(api, 'putCollaborationConfig')
    .mockRejectedValue(new ApiError({ status: 409, message: '配置冲突' }))
  const f = setup()
  await waitFor(() => expect(f.result.current.collabUi.rev).toBe(1))
  await act(() => f.result.current.persistCollab('solo'))
  expect(put).toHaveBeenCalledTimes(2)
  expect(f.result.current.collabMode).toBe('solo')
  expect(f.result.current.collabSaveError).toBeTruthy()
})

test('a newer click fences the old conflict reread before it can retry', async () => {
  let resolve!: (value: CollaborationConfigDoc) => void
  const get = vi
    .spyOn(api, 'getCollaborationConfig')
    .mockResolvedValueOnce(doc('team', 1))
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
  const put = vi
    .spyOn(api, 'putCollaborationConfig')
    .mockRejectedValueOnce(new ApiError({ status: 409, message: 'conflict' }))
    .mockResolvedValueOnce(doc('team', 3))
  const f = setup()
  await waitFor(() => expect(f.result.current.collabUi.rev).toBe(1))
  let pending!: Promise<void>
  act(() => {
    pending = f.result.current.persistCollab('solo')
  })
  await waitFor(() => expect(get).toHaveBeenCalledTimes(2))
  await act(() => f.result.current.persistCollab('team'))
  await act(async () => {
    resolve(doc('solo', 2))
    await pending
  })
  expect(put).toHaveBeenCalledTimes(2)
  expect(f.result.current.collabUi.configVersion).toBe('v3:team')
})


test('leaving team skips model-switch consent so「关闭团队模式」cannot abort to Astra (OCV5-623)', async () => {
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('team', 1))
  const put = vi.spyOn(api, 'putCollaborationConfig').mockResolvedValue(doc('solo', 2))
  const authorizeSwitch = vi.fn(async (_input: Parameters<AuthorizeSwitch>[0], _opts?: Parameters<AuthorizeSwitch>[1]) => null)
  const f = setup()
  f.rerender({
    ...f.input,
    modelId: 'gpt-6.1-sol',
    authorizeSwitch,
    sessions: [{ id: 'own', title: 't', ownerUserId: 'u', updatedAt: '', messageCount: 1 }],
  } as SessionModelAndCollabInput)
  await waitFor(() => expect(f.result.current.collabUi.rev).toBe(1))
  expect(f.result.current.collabMode).toBe('team')
  await act(() => f.result.current.setTeamMode(false))
  expect(authorizeSwitch).not.toHaveBeenCalled()
  expect(put).toHaveBeenCalledTimes(1)
  expect(put.mock.calls[0][1]).toMatchObject({ sessionId: 'own', mode: 'solo' })
  expect(f.result.current.collabMode).toBe('solo')
  expect(f.result.current.teamMode).toBe(false)
})

test('entering team still asks model-switch consent (OCV5-623)', async () => {
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  const put = vi.spyOn(api, 'putCollaborationConfig').mockResolvedValue(doc('team', 2))
  const authorizeSwitch = vi.fn(async (_input: Parameters<AuthorizeSwitch>[0], _opts?: Parameters<AuthorizeSwitch>[1]) => null)
  const f = setup()
  f.rerender({
    ...f.input,
    modelId: 'gpt-6.1-sol',
    authorizeSwitch,
    sessions: [{ id: 'own', title: 't', ownerUserId: 'u', updatedAt: '', messageCount: 1 }],
  } as SessionModelAndCollabInput)
  await waitFor(() => expect(f.result.current.collabUi.rev).toBe(1))
  await act(() => f.result.current.setTeamMode(true))
  expect(authorizeSwitch).toHaveBeenCalledTimes(1)
  expect(authorizeSwitch.mock.calls[0][0]).toMatchObject({ teamMode: true, targetModel: 'gpt-6.1-sol' })
  expect(put).not.toHaveBeenCalled()
  expect(f.result.current.collabMode).toBe('solo')
})

test('new session (activeId=undefined) defaults to the last actually used session model (U3)', async () => {
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  const setModelId = vi.fn()
  const models = [
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
    { id: 'MiniMax-M3', display_name: 'MiniMax M3' },
  ]
  const sessions = [
    { id: 's-used', title: 'Used', ownerUserId: 'u', updatedAt: '2026-10-30T01:00:00Z', lastAt: 2_000, messageCount: 3, modelId: 'gpt-5.6-sol' },
    { id: 's-old', title: 'Old', ownerUserId: 'u', updatedAt: '2026-10-29T01:00:00Z', lastAt: 1_000, messageCount: 2, modelId: 'deepseek-v4-flash' },
  ]
  const f = setup()
  f.rerender({
    ...f.input,
    activeId: 's-used',
    models,
    sessions,
    setModelId,
  } as SessionModelAndCollabInput)
  expect(setModelId).toHaveBeenLastCalledWith('gpt-5.6-sol')

  setModelId.mockClear()
  f.rerender({
    ...f.input,
    activeId: undefined,
    models,
    sessions,
    setModelId,
  } as SessionModelAndCollabInput)
  expect(setModelId).toHaveBeenLastCalledWith('gpt-5.6-sol')
})

test('explicit draft model pick is preserved across late session list refreshes until new draft or explicit default_model change (U3)', async () => {
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  const setModelId = vi.fn()
  const models = [
    { id: 'deepseek-v4-flash', display_name: 'DeepSeek V4 Flash' },
    { id: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol' },
    { id: 'MiniMax-M3', display_name: 'MiniMax M3' },
  ]
  const f = setup()
  f.rerender({
    ...f.input,
    activeId: undefined,
    models,
    sessions: [],
    setModelId,
  } as SessionModelAndCollabInput)
  expect(setModelId).toHaveBeenLastCalledWith('deepseek-v4-flash')

  await act(() => f.result.current.selectModel('MiniMax-M3'))
  expect(setModelId).toHaveBeenLastCalledWith('MiniMax-M3')

  setModelId.mockClear()
  // 迟到的 listSessions 带回上次会话模型时,不覆盖用户在当前空白草稿的显式选择
  f.rerender({
    ...f.input,
    activeId: undefined,
    models,
    modelId: 'MiniMax-M3',
    sessions: [
      { id: 's-used', title: 'Used', ownerUserId: 'u', updatedAt: '2026-10-30T01:00:00Z', lastAt: 2_000, messageCount: 2, modelId: 'gpt-5.6-sol' },
    ],
    setModelId,
  } as SessionModelAndCollabInput)
  expect(setModelId).not.toHaveBeenCalled()

  // 用户在设置里显式修改默认模型(带 default_model_updated_at)则更新当前草稿
  f.rerender({
    ...f.input,
    activeId: undefined,
    models,
    modelId: 'MiniMax-M3',
    modelPrefs: { default_model: 'deepseek-v4-flash', default_model_updated_at: 5_000 },
    sessions: [
      { id: 's-used', title: 'Used', ownerUserId: 'u', updatedAt: '2026-10-30T01:00:00Z', lastAt: 2_000, messageCount: 2, modelId: 'gpt-5.6-sol' },
    ],
    setModelId,
  } as SessionModelAndCollabInput)
  expect(setModelId).toHaveBeenLastCalledWith('deepseek-v4-flash')
})
