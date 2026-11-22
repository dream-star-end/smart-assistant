import { useState } from 'react'
import type { ServiceTier } from '@openclaude/protocol/browser'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { api, ApiError } from '../lib/api'
import { createMemoryAuthSession } from '../lib/authSession'
import { readSessionServiceTier, writeSessionServiceTier } from '../lib/sessionServiceTier'
import { readSessionSwarmMode, writeSessionSwarmMode } from '../lib/sessionSwarmMode'
import { useSessionEngineOptions } from './useSessionEngineOptions'
import { EMPTY_COLLAB_UI, type CollaborationConfigDoc, type CollabMode, type CollabUiState } from '../lib/collaborationConfig'
import type { AuthorizeSwitch } from '../lib/modelSwitchCostTypes'
import type { PublicModel, Session } from '../lib/types'
import type { UseChatSocket } from './useChatSocket'
import { useComposerSend, type ComposerSendInput } from './useComposerSend'
import { useSessionList, type UseSessionListOptions } from './useSessionList'
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

test('send model A shares queueModelPatch single-flight queue and cannot overwrite subsequent explicit model B selection (#1278)', async () => {
  const SID = 'webu3race001'
  const A = 'deepseek-v4-flash'
  const B = 'glm-5.2'
  const C = 'MiniMax-M3'
  const models = [A, B, C].map((id) => ({ id, display_name: id }))
  const agent = { id: 'main', name: 'Main', description: '' }
  const noop = () => {}
  const auth = createMemoryAuthSession(noop, 'fixture')
  const authRef = { current: auth }

  let serverModel: string | undefined = A
  let serverVersion = 1000
  const patches: Array<{ modelId: string; finish: () => void }> = []
  vi.spyOn(api, 'patchSessionModel').mockImplementation((_auth, _id, modelId) =>
    new Promise((resolve) =>
      patches.push({
        modelId,
        finish() {
          serverModel = modelId
          resolve({ ok: true, updatedAt: ++serverVersion })
        },
      }),
    ),
  )
  vi.spyOn(api, 'patchSessionTitle').mockResolvedValue({ ok: true, updatedAt: 1000 })
  const socket = {
    getMessages: () => [],
    getSession: () => ({ id: SID }),
    ensureSession: vi.fn(),
    renameSession: vi.fn(),
    setSessionModel: vi.fn(),
    send: vi.fn(async () => true),
  }
  const sockRef = { current: socket } as unknown as ComposerSendInput['sockRef']
  const f = renderHook(() => {
    const list = useSessionList({
      demo: false,
      auth: null,
      authSession: auth,
      user: null,
      agentId: 'main',
      sockRef,
      confirmDialog: async () => false,
      promptText: async () => null,
      clearChatError: noop,
      onNewSessionReset: noop,
      onActiveSessionDeleted: noop,
    } as UseSessionListOptions)
    const [modelId, setModelId] = useState<string | undefined>(A)
    const collab = useSessionModelAndCollab({
      activeId: SID,
      modelId,
      setModelId,
      auth: null,
      agent,
      demo: false,
      models,
      modelPrefs: {},
      modelSwitchPreparing: false,
      sessions: list.sessions,
      confirmDialog: async () => true,
      handleNew: noop,
      queueModelPatch: list.queueModelPatch,
      resetSessionList: noop,
      sessionsResetRef: { current: noop },
      setModelSwitchPreparing: noop,
      setSessions: list.setSessions,
      sockRef,
      toast: noop,
    } as SessionModelAndCollabInput)
    const composer = useComposerSend({
      activeId: SID,
      agent,
      auth,
      authRef,
      demo: false,
      boardOpen: false,
      collabAsDefault: false,
      collabEpochRef: { current: 0 },
      collabUi: { ...EMPTY_COLLAB_UI },
      contextTier: '300k',
      draftProjectId: null,
      draftProjectRef: { current: null },
      draftSessionId: SID,
      modelId,
      models,
      newSessionInProject: noop,
      preferenceEffort: undefined,
      projectHome: null,
      promoteDraftCollab: noop,
      publicCfg: null,
      queueModelPatch: list.queueModelPatch,
      selectedSessionIdRef: { current: SID },
      sendImplicitRatingRef: { current: null },
      serviceTier: null,
      sessionEffort: undefined,
      sessions: list.sessions,
      setActiveId: noop,
      setBoardOpen: noop,
      setBusy: noop,
      setChatError: noop,
      applyCollabDoc: noop,
      setCollabSaveError: noop,
      setCollabUi: noop,
      setDraftProject: noop,
      setImageAnnotationSource: noop,
      setMessages: noop,
      setSessions: list.setSessions,
      setStreamText: noop,
      sockRef,
      stopPreparing: noop,
      stopRef: { current: false },
      toast: noop,
      user: { id: 'u', displayName: 'U', roles: ['user'] },
    } as ComposerSendInput)
    return { list, collab, composer, modelId }
  })

  act(() =>
    f.result.current.list.setSessions([
      {
        id: SID,
        title: 'Materialized Goal draft',
        ownerUserId: 'u',
        modelId: A,
        updatedAt: new Date(1000).toISOString(),
        messageCount: 0,
      },
    ]),
  )
  await act(async () => {
    expect(await f.result.current.composer.send('hello')).toBe(true)
  })
  expect(patches.map((p) => p.modelId)).toEqual([A])

  await act(async () => {
    await f.result.current.collab.selectModel(B)
  })
  expect(f.result.current.modelId).toBe(B)
  // Single-flight queue holds B in pending while A is still in-flight, preventing out-of-order DB commits.
  expect(patches.map((p) => p.modelId)).toEqual([A])

  await act(async () => {
    patches[0]!.finish()
  })
  await waitFor(() => expect(patches.map((p) => p.modelId)).toEqual([A, B]))

  await act(async () => {
    patches[1]!.finish()
  })
  expect(f.result.current.list.sessions.find((s) => s.id === SID)?.modelId).toBe(B)
  expect(serverModel).toBe(B)
})

test('explicit default preference change resets draft pick even when resolved default ID stays equal (#1278)', async () => {
  const SID = 'webu3race001'
  const A = 'deepseek-v4-flash'
  const B = 'glm-5.2'
  const C = 'MiniMax-M3'
  const models = [A, B, C].map((id) => ({ id, display_name: id }))
  const agent = { id: 'main', name: 'Main', description: '' }
  const noop = () => {}

  const modelPrefsBefore = { default_model: A, default_model_updated_at: 100 }
  const history = [
    {
      id: SID,
      title: 'Previous use',
      ownerUserId: 'u',
      updatedAt: new Date(200).toISOString(),
      lastAt: 200,
      messageCount: 2,
      modelId: B,
    },
  ]
  const setModelId = vi.fn()
  const input = {
    activeId: undefined,
    modelId: B,
    auth: null,
    agent,
    demo: false,
    models,
    modelPrefs: modelPrefsBefore,
    sessions: history,
    modelSwitchPreparing: false,
    confirmDialog: async () => true,
    handleNew: noop,
    queueModelPatch: noop,
    resetSessionList: noop,
    sessionsResetRef: { current: noop },
    setModelId,
    setModelSwitchPreparing: noop,
    setSessions: noop,
    sockRef: { current: null },
    toast: noop,
  } as SessionModelAndCollabInput
  const f = renderHook((props) => useSessionModelAndCollab(props), { initialProps: input })
  expect(setModelId).toHaveBeenLastCalledWith(B)

  await act(async () => {
    await f.result.current.selectModel(C)
  })
  expect(setModelId).toHaveBeenLastCalledWith(C)
  setModelId.mockClear()

  // Changing Settings > default model from A to B keeps resolved newSessionDefaultModel === B,
  // but must still re-run the empty-draft effect and reset the draft selection C -> B.
  f.rerender({
    ...input,
    modelId: C,
    modelPrefs: { default_model: B, default_model_updated_at: 300 },
  })
  await waitFor(() => expect(setModelId).toHaveBeenLastCalledWith(B))
})

test("new solo draft send dispatches immediately before ensureServerSession and putCollaborationConfig finish (OCV5-737)", async () => {
  const DRAFT = "webdraft737"
  const MODEL = "glm-5.2"
  const models: PublicModel[] = [{ id: MODEL, display_name: MODEL, engine: "ccb" }]
  const agent = { id: "main", name: "Main", description: "" }
  const noop = () => {}
  const auth = createMemoryAuthSession(() => {}, "test-token")
  let finishEnsure!: (ok: boolean) => void
  const ensureServerSession = vi.fn(
    () => new Promise<boolean>((resolve) => { finishEnsure = resolve }),
  )
  const send = vi.fn(async () => true)
  const putCollab = vi.spyOn(api, "putCollaborationConfig").mockResolvedValue({
    rev: 7,
    defaultMode: "solo",
    defaultAdvisorModel: "gpt-6-astra",
    session: { mode: "solo", advisorModel: null, configVersion: "v1:solo:", source: "session" },
    advisorModels: [],
    advisorConsultParents: ["ccb"],
    advisorConsultAllowed: true,
    parentEngine: "ccb",
  })
  const selectedSessionIdRef: { current: string | undefined } = { current: undefined }
  const setActiveId = vi.fn((next: React.SetStateAction<string | undefined>) => {
    selectedSessionIdRef.current = typeof next === "function" ? next(selectedSessionIdRef.current) : next
  })
  const sockRef = {
    current: {
      ensureSession: noop,
      ensureServerSession,
      getMessages: () => [],
      getSession: () => ({ id: DRAFT }),
      renameSession: noop,
      send,
      setSessionModel: noop,
    },
  } as unknown as React.RefObject<UseChatSocket | null>

  const f = renderHook(() => {
    const [activeId, setActiveState] = useState<string | undefined>(undefined)
    const [modelId, setModelId] = useState<string | undefined>(MODEL)
    const [sessions, setSessions] = useState<Session[]>([])
    const collab = useSessionModelAndCollab({
      activeId,
      agent,
      auth,
      confirmDialog: async () => true,
      demo: false,
      handleNew: noop,
      modelId,
      modelPrefs: {},
      modelSwitchPreparing: false,
      models,
      queueModelPatch: noop,
      resetSessionList: noop,
      sessions,
      sessionsResetRef: { current: noop },
      setModelId,
      setModelSwitchPreparing: noop,
      setSessions,
      sockRef,
      toast: noop,
    })
    const composer = useComposerSend({
      activeId,
      agent,
      applyCollabDoc: collab.applyCollabDoc,
      auth,
      authRef: { current: auth },
      boardOpen: false,
      collabAsDefault: collab.collabAsDefault,
      collabEpochRef: collab.collabEpochRef,
      collabUi: collab.collabUi,
      contextTier: "300k",
      demo: false,
      draftProjectId: null,
      draftProjectRef: { current: null },
      draftSessionId: DRAFT,
      modelId,
      models,
      newSessionInProject: noop,
      preferenceEffort: undefined,
      projectHome: null,
      promoteDraftCollab: collab.promoteDraftCollab,
      publicCfg: null,
      queueModelPatch: noop,
      selectedSessionIdRef,
      sendImplicitRatingRef: { current: null },
      serviceTier: null,
      sessionEffort: undefined,
      sessions,
      setActiveId: (next) => {
        setActiveId(next)
        setActiveState(next)
      },
      setBoardOpen: noop,
      setBusy: noop,
      setChatError: noop,
      setCollabSaveError: collab.setCollabSaveError,
      setCollabUi: collab.setCollabUi,
      setDraftProject: noop,
      setImageAnnotationSource: noop,
      setMessages: noop,
      setSessions,
      setStreamText: noop,
      sockRef,
      stopPreparing: noop,
      stopRef: { current: false },
      toast: noop,
      user: { id: "u", displayName: "U", roles: ["user"] },
    })
    return { collab, composer }
  })

  await act(async () => {
    expect(await f.result.current.composer.send("instant first turn")).toBe(true)
  })
  expect(send).toHaveBeenCalledTimes(1)
  expect(setActiveId).toHaveBeenCalledWith(DRAFT)
  expect(ensureServerSession).toHaveBeenCalledTimes(1)
  expect(putCollab).not.toHaveBeenCalled()

  await act(async () => {
    finishEnsure(true)
  })
  await waitFor(() => expect(putCollab).toHaveBeenCalledTimes(1))
  await waitFor(() => expect(f.result.current.collab.collabUi.rev).toBe(7))
})

test('OCV5-798: Sol ultrafast -> Astra -> Sol clears stored serviceTier on commit (and keeps on cancel)', async () => {
  localStorage.clear()
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  let confirmReply = false
  const auth = createMemoryAuthSession(() => {}, 'fixture')
  const agent = { id: 'main', name: 'Main', description: '' }
  const models: PublicModel[] = [
    { id: 'gpt-6.2-sol', display_name: 'Sol', engine: 'codex' },
    { id: 'gpt-6.2-astra', display_name: 'Astra', engine: 'codex' },
  ]
  const modelPrefs = {}
  const noop = () => {}
  const sessionsResetRef = { current: noop }
  const sockRef = { current: { setSessionModel: vi.fn(), getMessages: () => [] } as unknown as UseChatSocket }
  const authorizeSwitch: AuthorizeSwitch = async (req) =>
    confirmReply ? { requestId: req.requestId, choice: true } : null
  const confirmDialog = vi.fn(async () => confirmReply)
  const f = renderHook(() => {
    const [modelId, setModelId] = useState<string | undefined>('gpt-6.2-sol')
    const [sessions, setSessions] = useState<Session[]>([
      { id: 'own', title: 'S', ownerUserId: 'u', updatedAt: '2026-11-18T00:00:00Z', messageCount: 1, modelId: 'gpt-6.2-sol' },
    ])
    const { serviceTier, setServiceTier } = useSessionEngineOptions('own')
    const collab = useSessionModelAndCollab({
      activeId: 'own',
      authorizeSwitch,
      modelId,
      auth,
      agent,
      demo: false,
      models,
      modelPrefs,
      modelSwitchPreparing: false,
      sessions,
      confirmDialog,
      handleNew: noop,
      queueModelPatch: noop,
      resetSessionList: noop,
      sessionsResetRef,
      serviceTier,
      setServiceTier,
      setModelId,
      setModelSwitchPreparing: noop,
      setSessions,
      sockRef,
      toast: noop,
    })
    return { modelId, serviceTier, setServiceTier, collab }
  })
  // Select Ultrafast AFTER mount (verifies selectModel does not capture stale Standard state).
  expect(f.result.current.serviceTier).toBeNull()
  act(() => {
    f.result.current.setServiceTier('ultrafast')
  })
  expect(f.result.current.serviceTier).toBe('ultrafast')
  expect(readSessionServiceTier('own')).toBe('ultrafast')
  // Cancelled switch must keep ultrafast.
  confirmReply = false
  await act(async () => {
    await f.result.current.collab.selectModel('gpt-6.2-astra')
  })
  expect(f.result.current.modelId).toBe('gpt-6.2-sol')
  expect(f.result.current.serviceTier).toBe('ultrafast')
  expect(readSessionServiceTier('own')).toBe('ultrafast')

  // Confirmed switch Sol -> Astra drops ultrafast in both state and storage; switching back stays Standard.
  confirmReply = true
  await act(async () => {
    await f.result.current.collab.selectModel('gpt-6.2-astra')
  })
  expect(f.result.current.modelId).toBe('gpt-6.2-astra')
  expect(f.result.current.serviceTier).toBeNull()
  expect(readSessionServiceTier('own')).toBeNull()

  await act(async () => {
    await f.result.current.collab.selectModel('gpt-6.2-sol')
  })
  expect(f.result.current.modelId).toBe('gpt-6.2-sol')
  expect(f.result.current.serviceTier).toBeNull()
  expect(readSessionServiceTier('own')).toBeNull()
  localStorage.clear()
})

test('OCV5-798: draft Astra session with stale ultrafast normalizes persisted tier to null and clamps advisor no-write on send', async () => {
  localStorage.clear()
  const DRAFT = '11111111-1111-4111-8111-111111111112'
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  vi.spyOn(api, 'putCollaborationConfig').mockResolvedValue({
    rev: 1,
    defaultMode: 'solo',
    defaultAdvisorModel: null,
    session: { mode: 'advisor', advisorModel: 'gpt-6.2-astra', configVersion: 'v1:advisor', source: 'session' },
  })
  const send = vi.fn().mockResolvedValue(true)
  const ensureServerSession = vi.fn().mockResolvedValue(true)
  const auth = createMemoryAuthSession(() => {}, 'fixture')
  const authRef = { current: auth }
  const agent = { id: 'main', name: 'Main', description: '' }
  const models: PublicModel[] = [{ id: 'gpt-6.2-astra', display_name: 'Astra', engine: 'codex' }]
  const modelPrefs = {}
  const noop = () => {}
  const sessionsResetRef = { current: noop }
  const draftProjectRef = { current: null }
  const selectedSessionIdRef = { current: undefined }
  const sendImplicitRatingRef = { current: null }
  const sendScrollRef = { current: null }
  const stopRef = { current: false }
  const publicCfg = { auth: true } as never
  const user = { id: 'u', displayName: 'U', roles: ['user'] }
  const advisorCollabUi: CollabUiState = {
    ...EMPTY_COLLAB_UI,
    mode: 'advisor',
    advisorModel: 'gpt-6.2-astra',
    configVersion: 'v1',
    rev: 1,
    source: 'session',
  }
  const sockRef = {
    current: {
      send,
      ensureSession: noop,
      setSessionModel: noop,
      ensureServerSession,
      getMessages: () => [],
    } as unknown as UseChatSocket,
  }
  const confirmDialog = async () => true
  const runDraftSend = async (tier: ServiceTier | null, prompt: string) => {
    localStorage.clear()
    send.mockClear()
    const f = renderHook(() => {
      const [activeId, setActiveId] = useState<string | undefined>(undefined)
      const [sessions, setSessions] = useState<Session[]>([])
      const collab = useSessionModelAndCollab({
        activeId,
        modelId: 'gpt-6.2-astra',
        auth,
        agent,
        demo: false,
        models,
        modelPrefs,
        modelSwitchPreparing: false,
        sessions,
        confirmDialog,
        handleNew: noop,
        queueModelPatch: noop,
        resetSessionList: noop,
        sessionsResetRef,
        setModelId: noop,
        setModelSwitchPreparing: noop,
        setSessions,
        sockRef,
        toast: noop,
      })
      const composer = useComposerSend({
        activeId,
        agent,
        applyCollabDoc: collab.applyCollabDoc,
        auth,
        authRef,
        boardOpen: false,
        collabAsDefault: collab.collabAsDefault,
        collabEpochRef: collab.collabEpochRef,
        collabUi: advisorCollabUi,
        promoteDraftCollab: collab.promoteDraftCollab,
        contextTier: '300k',
        demo: false,
        draftProjectId: null,
        draftProjectRef,
        draftSessionId: DRAFT,
        modelId: 'gpt-6.2-astra',
        models,
        newSessionInProject: noop,
        preferenceEffort: undefined,
        projectHome: null,
        publicCfg,
        queueModelPatch: noop,
        selectedSessionIdRef,
        sendImplicitRatingRef,
        sendScrollRef,
        serviceTier: tier,
        sessionEffort: undefined,
        sessions,
        setActiveId,
        setBoardOpen: noop,
        setBusy: noop,
        setChatError: noop,
        setCollabSaveError: collab.setCollabSaveError,
        setCollabUi: collab.setCollabUi,
        setDraftProject: noop,
        setImageAnnotationSource: noop,
        setMessages: noop,
        setSessions,
        setStreamText: noop,
        sockRef,
        stopPreparing: noop,
        stopRef,
        toast: noop,
        user,
      })
      return { composer }
    })
    await act(async () => {
      expect(await f.result.current.composer.send(prompt)).toBe(true)
    })
    expect(send).toHaveBeenCalledTimes(1)
    return send.mock.calls[0]?.[0]
  }
  const staleCall = await runDraftSend('ultrafast', '不要修改任何文件')
  expect(readSessionServiceTier(DRAFT)).toBeNull()
  expect(staleCall?.serviceTier).toBeUndefined()

  const clampedFastCall = await runDraftSend('fast', '不要修改任何文件')
  expect(clampedFastCall?.serviceTier).toBeUndefined()

  const editFastCall = await runDraftSend('fast', '帮我直接修改 README.md')
  expect(editFastCall?.serviceTier).toBe('fast')
  localStorage.clear()
})

test('OCV5-843: switching from Antigravity to non-Antigravity auto-disables swarm with merged toast (and keeps on cancel or AG->AG)', async () => {
  localStorage.clear()
  vi.spyOn(api, 'getCollaborationConfig').mockResolvedValue(doc('solo', 1))
  const auth = createMemoryAuthSession(() => {}, 'fixture')
  const agent = { id: 'main', name: 'Main', description: '' }
  const models: PublicModel[] = [
    { id: 'antigravity-gemini-4-neon', display_name: 'Gemini 4 Neon', engine: 'antigravity' },
    { id: 'antigravity-claude-opus-5.5', display_name: 'Claude Opus 5.5', engine: 'antigravity' },
    { id: 'gpt-6.2-astra', display_name: 'Astra', engine: 'codex' },
  ]
  const toast = vi.fn()
  const onAutoDisableSwarm = vi.fn()
  const noop = () => {}
  const sockRef = { current: { setSessionModel: vi.fn(), getMessages: () => [] } as unknown as UseChatSocket }
  let confirmReply = false
  const authorizeSwitch: AuthorizeSwitch = async (req) =>
    confirmReply ? { requestId: req.requestId, choice: true } : null

  const f = renderHook(
    ({ modelId, swarmMode, swarmRunning }: { modelId: string; swarmMode: boolean; swarmRunning: boolean }) =>
      useSessionModelAndCollab({
        activeId: 'own',
        authorizeSwitch,
        modelId,
        auth,
        agent,
        demo: false,
        models,
        modelPrefs: {},
        modelSwitchPreparing: false,
        sessions: [{ id: 'own', title: 'S', ownerUserId: 'u', updatedAt: '', messageCount: 1, modelId }],
        confirmDialog: vi.fn(async () => confirmReply),
        handleNew: noop,
        queueModelPatch: noop,
        resetSessionList: noop,
        sessionsResetRef: { current: noop },
        swarmMode,
        swarmRunning,
        onAutoDisableSwarm,
        setModelId: noop,
        setModelSwitchPreparing: noop,
        setSessions: noop,
        sockRef,
        toast,
      }),
    { initialProps: { modelId: 'antigravity-gemini-4-neon', swarmMode: true, swarmRunning: false } },
  )

  // Cancelled switch must NOT disable swarm
  confirmReply = false
  await act(async () => {
    await f.result.current.selectModel('gpt-6.2-astra')
  })
  expect(onAutoDisableSwarm).not.toHaveBeenCalled()
  expect(toast).not.toHaveBeenCalled()

  // Antigravity -> Antigravity keeps swarm enabled
  confirmReply = true
  await act(async () => {
    await f.result.current.selectModel('antigravity-claude-opus-5.5')
  })
  expect(onAutoDisableSwarm).not.toHaveBeenCalled()
  expect(toast).toHaveBeenLastCalledWith('已切换到 Claude Opus 5.5', 'success')

  // Antigravity -> non-Antigravity auto-disables swarm with merged toast
  await act(async () => {
    await f.result.current.selectModel('gpt-6.2-astra')
  })
  expect(onAutoDisableSwarm).toHaveBeenCalledTimes(1)
  expect(toast).toHaveBeenLastCalledWith('已切换到 Astra（已自动关闭蜂群模式）', 'success')

  // When a swarm is actively running, toast notes background continuation
  onAutoDisableSwarm.mockClear()
  f.rerender({ modelId: 'antigravity-gemini-4-neon', swarmMode: true, swarmRunning: true })
  await act(async () => {
    await f.result.current.selectModel('gpt-6.2-astra')
  })
  expect(onAutoDisableSwarm).toHaveBeenCalledTimes(1)
  expect(toast).toHaveBeenLastCalledWith(
    '已切换到 Astra（当前蜂群仍在后台运行，新消息将以单兵模式发送）',
    'success',
  )

  // Fallback without onAutoDisableSwarm writes false directly to sessionSwarmMode
  writeSessionSwarmMode('own', true)
  const fallback = renderHook(() =>
    useSessionModelAndCollab({
      activeId: 'own',
      modelId: 'antigravity-gemini-4-neon',
      auth,
      agent,
      demo: false,
      models,
      modelPrefs: {},
      modelSwitchPreparing: false,
      sessions: [{ id: 'own', title: 'S', ownerUserId: 'u', updatedAt: '', messageCount: 0, modelId: 'antigravity-gemini-4-neon' }],
      confirmDialog: vi.fn(async () => true),
      handleNew: noop,
      queueModelPatch: noop,
      resetSessionList: noop,
      sessionsResetRef: { current: noop },
      swarmMode: true,
      setModelId: noop,
      setModelSwitchPreparing: noop,
      setSessions: noop,
      sockRef,
      toast: noop,
    }),
  )
  await act(async () => {
    await fallback.result.current.selectModel('gpt-6.2-astra')
  })
  expect(readSessionSwarmMode('own')).toBe(false)
  localStorage.clear()
})
