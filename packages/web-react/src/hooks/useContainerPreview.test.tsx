import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createMemoryAuthSession } from '../lib/authSession'
import { useContainerPreview } from './useContainerPreview'

const apiMock = vi.hoisted(() => ({
  createContainerPreviewTicket: vi.fn(),
  heartbeatContainerPreview: vi.fn(),
  revokeContainerPreview: vi.fn(),
}))

vi.mock('../lib/api', () => ({
  api: apiMock,
  apiErrorMessage: (error: unknown, fallback = 'failed') =>
    error instanceof Error ? error.message : fallback,
}))

const viewport = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  isMobile: false,
} as const
const auth = createMemoryAuthSession(() => {}, 'token')
const sessionId = 'a'.repeat(32)
const directUrl =
  'https://alpha-preview.trycloudflare.com/__oc_preview_bootstrap?ticket=abcdefghijklmnopqrstuvwxABCDEFGH'

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readonly url: string
  readonly protocols: string[]
  protocol = 'preview-v1'
  readyState = FakeWebSocket.CONNECTING
  binaryType = 'blob'
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly send = vi.fn()

  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = typeof protocols === 'string' ? [protocols] : (protocols ?? [])
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.()
  }
}

beforeEach(() => {
  FakeWebSocket.instances.length = 0
  vi.stubGlobal('WebSocket', FakeWebSocket)
  apiMock.createContainerPreviewTicket.mockReset()
  apiMock.heartbeatContainerPreview.mockReset().mockResolvedValue(undefined)
  apiMock.revokeContainerPreview.mockReset().mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useContainerPreview native transport', () => {
  test('accepts only the isolated frame bridge and mints a fresh legacy ticket on fallback', async () => {
    apiMock.createContainerPreviewTicket
      .mockResolvedValueOnce({
        ticket: 'initial-legacy-ticket',
        expiresAt: Date.now() + 30_000,
        url: 'http://127.0.0.1:3000/',
        viewport,
        protocol: 'preview-v1',
        direct: { sessionId, url: directUrl, expiresAt: Date.now() + 1_800_000 },
      })
      .mockResolvedValueOnce({
        ticket: 'fresh-legacy-ticket',
        expiresAt: Date.now() + 30_000,
        url: 'http://127.0.0.1:3000/',
        viewport,
        protocol: 'preview-v1',
      })

    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const iframeRef = { current: iframe }
    const { result } = renderHook(() =>
      useContainerPreview({
        auth,
        url: 'http://127.0.0.1:3000/',
        viewport,
        enabled: true,
        reconnectKey: 0,
        iframeRef,
        onFrame: vi.fn(),
      }),
    )

    await waitFor(() => expect(result.current.transport).toBe('direct'))
    expect(result.current.directUrl).toBe(directUrl)

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://alpha-preview.trycloudflare.com',
          source: iframe.contentWindow,
          data: {
            source: 'oc-direct-preview-v1',
            type: 'preview.ready',
            protocolVersion: 1,
            url: 'https://alpha-preview.trycloudflare.com/dashboard?q=1',
            title: 'Native app',
            viewport,
          },
        }),
      )
    })
    await waitFor(() => expect(result.current.phase).toBe('ready'))
    expect(result.current.ready?.url).toBe('http://127.0.0.1:3000/dashboard?q=1')

    apiMock.revokeContainerPreview.mockReturnValueOnce(new Promise(() => {}))
    act(() => result.current.useLegacyFallback())
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(apiMock.revokeContainerPreview).toHaveBeenCalledWith(auth, sessionId)
    expect(apiMock.createContainerPreviewTicket).toHaveBeenNthCalledWith(
      2,
      auth,
      'http://127.0.0.1:3000/',
      viewport,
      { direct: false },
    )
    expect(FakeWebSocket.instances[0]?.protocols).toContain('fresh-legacy-ticket')
    expect(result.current.transport).toBe('legacy')
  })

  test('revokes a direct session returned after the preview was already closed', async () => {
    let resolveTicket!: (value: Record<string, unknown>) => void
    apiMock.createContainerPreviewTicket.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveTicket = resolve
      }),
    )
    const iframe = document.createElement('iframe')
    const iframeRef = { current: iframe }
    const { unmount } = renderHook(() =>
      useContainerPreview({
        auth,
        url: 'http://127.0.0.1:3000/',
        viewport,
        enabled: true,
        reconnectKey: 0,
        iframeRef,
        onFrame: vi.fn(),
      }),
    )
    unmount()
    resolveTicket({
      ticket: 'unused',
      expiresAt: Date.now() + 30_000,
      url: 'http://127.0.0.1:3000/',
      viewport,
      protocol: 'preview-v1',
      direct: { sessionId, url: directUrl, expiresAt: Date.now() + 1_800_000 },
    })
    await waitFor(() =>
      expect(apiMock.revokeContainerPreview).toHaveBeenCalledWith(auth, sessionId),
    )
  })
})
