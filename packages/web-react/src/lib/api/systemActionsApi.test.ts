import type { SystemActionDetail } from '@openclaude/protocol/browser'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAuthSession } from '../authSession'
import { createSystemActionsApi } from './systemActionsApi'
const id = 'b5be0795-e604-45ee-bd8b-a519324b5cf4'
const deviceId = 'a5be0795-e604-45ee-bd8b-a519324b5cf4'
const nonce = 'n'.repeat(43)
const hash = 'a'.repeat(64)
function prepared(): SystemActionDetail {
  return { id, operationId: 'preferences.update', title: '更改通知', state: 'prepared', executor: 'master',
    createdAt: Date.now(), updatedAt: Date.now(), expiresAt: Date.now() + 60000, result: null, previewHash: hash,
    preview: { title: '更改通知', description: '后续通知', scope: '当前账号', before: [], after: [], consequences: [],
      price: { kind: 'none', label: '无费用' }, destructive: false } }
}
function reply(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }) }
function setup() {
  const fetcher = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetcher)
  const auth = createMemoryAuthSession(() => {}, 'fixture-access-a')
  return { auth, fetcher, client: createSystemActionsApi({ auth, currentAuth: () => auth, deviceId }) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
describe('first party system approval transport', () => {
  it('fetches frozen details and sends one browser challenge and one explicit confirmation', async () => {
    const { client, fetcher } = setup()
    const d = prepared()
    fetcher.mockResolvedValueOnce(reply(d)).mockResolvedValueOnce(reply({ detail: d, nonce }))
      .mockResolvedValueOnce(reply({ ...d, state: 'succeeded', result: { summary: '已更新', completion: 'done' } }))
    const c = await client.getConfirmation(id)
    const result = await client.confirm(id, { nonce: c.nonce, previewHash: c.detail.previewHash })
    expect(result.state).toBe('succeeded')
    expect(fetcher.mock.calls.map(([url, opts]) => [url, opts?.method])).toEqual([
      [`/api/me/system-actions/${id}`, 'GET'], [`/api/auth/system-actions/${id}/challenge`, 'POST'], [`/api/auth/system-actions/${id}/confirm`, 'POST'],
    ])
    expect(JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body))).toEqual({ deviceId, nonce, previewHash: hash })
    for (const [, opts] of fetcher.mock.calls) {
      expect(opts?.credentials).toBe('include')
      expect(opts?.redirect).toBe('error')
    }
  })
  it.each(['401', 'lost-response'])('consumes the nonce on %s without refresh or automatic replay', async mode => {
    const { client, fetcher } = setup()
    const d = prepared()
    fetcher.mockResolvedValueOnce(reply(d)).mockResolvedValueOnce(reply({ detail: d, nonce }))
    await client.getConfirmation(id)
    if (mode === '401') fetcher.mockResolvedValueOnce(reply({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
    else fetcher.mockRejectedValueOnce(new Error('synthetic response loss'))
    await expect(client.confirm(id, { nonce, previewHash: hash })).rejects.toThrow()
    await expect(client.confirm(id, { nonce, previewHash: hash })).rejects.toThrow('请重新打开确认')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('refresh'))).toBe(false)
  })
  it('rejects a refresh at the same epoch before fetch and after late JSON parsing', async () => {
    const { auth, client, fetcher } = setup()
    let release!: (value: unknown) => void
    const decoded = new Promise<unknown>(resolve => { release = resolve })
    const response = reply(prepared())
    vi.spyOn(response, 'json').mockReturnValue(decoded)
    fetcher.mockResolvedValueOnce(response)
    const pending = client.getDetail(id)
    await vi.waitFor(() => expect(response.json).toHaveBeenCalled())
    auth.commitToken(0, 'fixture-access-b')
    expect(auth.snapshot().epoch).toBe(0)
    release(prepared())
    await expect(pending).rejects.toThrow()
    await expect(client.deny(id)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it('rejects another id or malformed preview rather than rendering unverified data', async () => {
    const { client, fetcher } = setup()
    fetcher.mockResolvedValueOnce(reply({ ...prepared(), id: deviceId }))
    await expect(client.getDetail(id)).rejects.toThrow('无法核验')
    fetcher.mockResolvedValueOnce(reply({ ...prepared(), preview: { ...prepared().preview, before: 'invalid' } }))
    await expect(client.getDetail(id)).rejects.toThrow('无法核验')
  })
  it('an optional display synchronization failure cannot change a successful receipt', async () => {
    const { auth, fetcher } = setup()
    const onReceiptError = vi.fn()
    const client = createSystemActionsApi({ auth, currentAuth: () => auth, deviceId,
      onReceipt: async () => { throw new Error('synthetic read failure') }, onReceiptError })
    fetcher.mockResolvedValueOnce(reply({ ...prepared(), state: 'succeeded', result: { summary: '已更新', completion: 'done' } }))
    expect((await client.getResult(id)).state).toBe('succeeded')
    await vi.waitFor(() => expect(onReceiptError).toHaveBeenCalledOnce())
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
it.each(['401', 'lost-response'])('reconcile is one captured request on %s and never reexecutes or refreshes', async mode => {
  const { client, fetcher } = setup()
  if (mode === '401') fetcher.mockResolvedValueOnce(reply({ error: { code: 'UNAUTHORIZED', message: 'expired' } }, 401))
  else fetcher.mockRejectedValueOnce(new Error('synthetic response loss'))
  await expect(client.reconcile(id)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]?.[0]).toBe(`/api/auth/system-actions/${id}/reconcile`)
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('POST')
  expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({})
})
