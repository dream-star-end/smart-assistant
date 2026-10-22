import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ApiError, api } from '../../../lib/api'
import { createMemoryAuthSession } from '../../../lib/authSession'
import type { LiteratureSetupView, RuntimePluginCatalogEntry } from '../../../lib/connectors'
import { LiteratureSetupDialog } from './LiteratureSetupDialog'
vi.mock('../../../lib/api', async (original) => {
  const base = await original<typeof import('../../../lib/api')>()
  return {
    ...base,
    api: {
      ...base.api,
      getLiteratureSetupCapability: vi.fn(),
      startLiteratureSetup: vi.fn(),
      getLiteratureSetup: vi.fn(),
      getLiteratureSetupImage: vi.fn(),
      answerLiteratureSetup: vi.fn(),
      cancelLiteratureSetup: vi.fn(),
    },
  }
})
const plugin = { slug: 'literature-db', versionId: '91' } as RuntimePluginCatalogEntry
const operation = (status: LiteratureSetupView['status'] = 'running'): LiteratureSetupView => ({
  operationId: 'op-fixture',
  status,
  automaticSubmissions: 4,
  agentReady: false,
})
const capability = {
  available: true,
  reasonCode: null,
  maxAutomaticSubmissions: 4,
  maxStartsPerHour: 6,
  operationTtlMs: 300000,
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.getLiteratureSetupCapability).mockResolvedValue(capability)
  vi.mocked(api.startLiteratureSetup).mockResolvedValue(operation())
  vi.mocked(api.getLiteratureSetup).mockResolvedValue(operation())
  vi.mocked(api.cancelLiteratureSetup).mockResolvedValue(operation('cancelled'))
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = vi.fn(() => 'blob:synthetic-captcha')
      static revokeObjectURL = vi.fn()
    },
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
function mount(relinkAccountId: string | null = null) {
  const auth = createMemoryAuthSession(() => {}, 'synthetic-access')
  const onClose = vi.fn()
  const onBound = vi.fn()
  const props = { auth, plugin, relinkAccountId, onClose, onBound }
  return { ...render(<LiteratureSetupDialog {...props} />), props, auth, onClose, onBound }
}
async function start() {
  fireEvent.change(await screen.findByLabelText('网站账号'), {
    target: { value: 'synthetic-user' },
  })
  fireEvent.change(screen.getByLabelText('网站密码'), { target: { value: 'synthetic-password' } })
  fireEvent.click(screen.getByRole('checkbox'))
  fireEvent.click(screen.getByRole('button', { name: '登录并保存' }))
  await waitFor(() => expect(api.startLiteratureSetup).toHaveBeenCalledTimes(1))
}
test('unavailable service does not collect or submit a password', async () => {
  vi.mocked(api.getLiteratureSetupCapability).mockResolvedValue({ ...capability, available: false })
  mount()
  expect(await screen.findByText('文献数据库登录暂未就绪。')).toBeInTheDocument()
  expect(screen.queryByLabelText('网站密码')).not.toBeInTheDocument()
  expect(api.startLiteratureSetup).not.toHaveBeenCalled()
})
test('relink submits a private form once with its exact target and clears the displayed password', async () => {
  let submitted: unknown
  vi.mocked(api.startLiteratureSetup).mockImplementation(async (_auth, input) => {
    submitted = structuredClone(input)
    return operation()
  })
  mount('7')
  await start()
  expect(submitted).toEqual({
    username: 'synthetic-user',
    password: 'synthetic-password',
    acceptTerms: true,
    accountId: '7',
  })
  await waitFor(() => expect(screen.queryByLabelText('网站密码')).not.toBeInTheDocument())
})
test('a manual answer with uncertain POST is never submitted again', async () => {
  vi.mocked(api.startLiteratureSetup).mockResolvedValue({
    ...operation('manual_required'),
    challengeId: 'challenge-fixture',
    challengeExpiresAt: Date.now() + 120000,
  })
  vi.mocked(api.getLiteratureSetup).mockResolvedValue({
    ...operation('manual_required'),
    challengeId: 'challenge-fixture',
  })
  vi.mocked(api.getLiteratureSetupImage).mockResolvedValue(
    new Blob(['fixture'], { type: 'image/png' }),
  )
  vi.mocked(api.answerLiteratureSetup).mockRejectedValue(new Error('synthetic uncertain response'))
  mount()
  await start()
  await screen.findByAltText('网站登录验证码')
  fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '1234' } })
  fireEvent.click(screen.getByRole('button', { name: '提交验证码' }))
  await screen.findByText('正在核对提交结果，请勿重复提交。')
  expect(screen.getByRole('button', { name: '提交验证码' })).toBeDisabled()
  expect(api.answerLiteratureSetup).toHaveBeenCalledTimes(1)
})
test('close waits for the actual authenticated cancellation result and reports saved account', async () => {
  vi.mocked(api.cancelLiteratureSetup).mockResolvedValue({
    ...operation('authenticated'),
    accountId: '7',
    agentReady: true,
  })
  const f = mount('7')
  await start()
  await screen.findByText('正在自动登录或安全保存，请稍候…')
  fireEvent.click(screen.getByText('关闭', { selector: 'button' }))
  await waitFor(() => expect(f.onBound).toHaveBeenCalledWith(true))
  expect(f.onClose).toHaveBeenCalledTimes(1)
})
test('identity change discards late captcha blobs without creating an image URL', async () => {
  let resolve!: (blob: Blob) => void
  vi.mocked(api.startLiteratureSetup).mockResolvedValue({
    ...operation('manual_required'),
    challengeId: 'challenge-fixture',
  })
  vi.mocked(api.getLiteratureSetupImage).mockReturnValue(
    new Promise((done) => {
      resolve = done
    }),
  )
  const f = mount()
  await start()
  await waitFor(() => expect(api.getLiteratureSetupImage).toHaveBeenCalledTimes(1))
  act(() => {
    f.auth.beginIdentity()
    f.rerender(<LiteratureSetupDialog {...f.props} />)
  })
  await act(async () => {
    resolve(new Blob(['old-private-captcha']))
    await Promise.resolve()
  })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(screen.queryByAltText('网站登录验证码')).not.toBeInTheDocument()
  expect(f.onBound).not.toHaveBeenCalled()
})

test('an identity change without a React render prevents old credentials from being sent with the new token', async () => {
  const f = mount()
  fireEvent.change(await screen.findByLabelText('网站账号'), {
    target: { value: 'old-private-user' },
  })
  fireEvent.change(screen.getByLabelText('网站密码'), { target: { value: 'old-private-password' } })
  fireEvent.click(screen.getByRole('checkbox'))
  const nextEpoch = f.auth.beginIdentity()
  f.auth.commitToken(nextEpoch, 'new-user-access')
  fireEvent.click(screen.getByRole('button', { name: '登录并保存' }))
  expect(api.startLiteratureSetup).not.toHaveBeenCalled()
})

test('a manual poll started before an answer cannot restore the consumed challenge', async () => {
  let resolveOld!: (view: LiteratureSetupView) => void
  const manual = { ...operation('manual_required'), challengeId: 'challenge-fixture' }
  vi.mocked(api.startLiteratureSetup).mockResolvedValue(manual)
  vi.mocked(api.getLiteratureSetup).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolveOld = done
      }),
  )
  vi.mocked(api.getLiteratureSetupImage).mockResolvedValue(new Blob(['fixture']))
  vi.mocked(api.answerLiteratureSetup).mockResolvedValue(operation('running'))
  mount()
  await start()
  await screen.findByAltText('网站登录验证码')
  await waitFor(() => expect(api.getLiteratureSetup).toHaveBeenCalledTimes(1), { timeout: 2000 })
  fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '1234' } })
  fireEvent.click(screen.getByRole('button', { name: '提交验证码' }))
  await screen.findByText('正在自动登录或安全保存，请稍候…')
  await act(async () => {
    resolveOld(manual)
    await Promise.resolve()
  })
  expect(screen.queryByRole('button', { name: '提交验证码' })).not.toBeInTheDocument()
  expect(api.getLiteratureSetupImage).toHaveBeenCalledTimes(1)
  expect(api.answerLiteratureSetup).toHaveBeenCalledTimes(1)
})

test('an operation lost after restart stops polling and can be closed', async () => {
  vi.mocked(api.getLiteratureSetup).mockRejectedValue(
    new ApiError({ status: 404, code: 'NOT_FOUND', message: 'fixture missing' }),
  )
  const f = mount()
  await start()
  await waitFor(() => expect(api.getLiteratureSetup).toHaveBeenCalledTimes(1), { timeout: 2000 })
  await screen.findByText('本次登录已结束。请关闭后重新发起。')
  fireEvent.click(screen.getByText('关闭', { selector: 'button' }))
  expect(f.onClose).toHaveBeenCalledTimes(1)
})

test('a missing operation during cancel allows close and leaves saved-account reconciliation to management', async () => {
  vi.mocked(api.cancelLiteratureSetup).mockRejectedValue(
    new ApiError({ status: 404, code: 'NOT_FOUND', message: 'fixture missing' }),
  )
  const f = mount()
  await start()
  await screen.findByText('正在自动登录或安全保存，请稍候…')
  fireEvent.click(screen.getByText('关闭', { selector: 'button' }))
  await waitFor(() => expect(f.onClose).toHaveBeenCalledTimes(1))
  expect(f.onBound).not.toHaveBeenCalled()
  expect(api.startLiteratureSetup).toHaveBeenCalledTimes(1)
})

test('manual captcha input renders visible mobile-safe control styling and submits on Enter', async () => {
  vi.mocked(api.startLiteratureSetup).mockResolvedValue({
    ...operation('manual_required'),
    automaticSubmissions: 0,
    challengeId: 'challenge-mobile',
  })
  vi.mocked(api.getLiteratureSetup).mockResolvedValue({
    ...operation('manual_required'),
    automaticSubmissions: 0,
    challengeId: 'challenge-mobile',
  })
  vi.mocked(api.getLiteratureSetupImage).mockResolvedValue(new Blob(['fixture-png']))
  vi.mocked(api.answerLiteratureSetup).mockResolvedValue({
    ...operation('authenticated'),
    accountId: '42',
    agentReady: true,
  })
  const f = mount()
  await start()
  expect(await screen.findByText('请输入下方图形验证码完成登录。')).toBeInTheDocument()
  await screen.findByAltText('网站登录验证码')
  const captchaInput = screen.getByLabelText('验证码') as HTMLInputElement
  expect(captchaInput).toHaveAttribute('placeholder', '请输入上方验证码')
  expect(captchaInput).toHaveAttribute('autocapitalize', 'off')
  expect(captchaInput).toHaveAttribute('autocorrect', 'off')
  expect(captchaInput).toHaveAttribute('enterkeyhint', 'done')
  expect(captchaInput.className).toContain('border-border-control')
  expect(captchaInput.className).toContain('bg-surface')
  expect(captchaInput.className).toContain('text-base')
  fireEvent.change(captchaInput, { target: { value: '8032' } })
  fireEvent.keyDown(captchaInput, { key: 'Enter' })
  await waitFor(() =>
    expect(api.answerLiteratureSetup).toHaveBeenCalledWith(f.auth, 'op-fixture', 'challenge-mobile', '8032'),
  )
})
