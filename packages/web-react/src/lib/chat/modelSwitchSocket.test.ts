import { afterEach, describe, expect, test, vi } from 'vitest'

import { ChatSocket } from './socket'

class FakeWS {
  static instances: FakeWS[] = []
  static OPEN = 1
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeWS.instances.push(this)
  }

  send(data: string) {
    this.sent.push(data)
  }

  open() {
    this.readyState = FakeWS.OPEN
    this.onopen?.()
    this.onmessage?.({ data: JSON.stringify({ type: 'sys.relay_ready' }) })
  }

  close(code = 1000, reason = '') {
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function makeSocket() {
  return new ChatSocket({
    getToken: () => 'token',
    getAuthEpoch: () => 0,
    silentRefresh: async (epoch) => ({ kind: 'transient', epoch, retryAfterMs: 500 }),
    onAuthExpired: () => {},
    defaultAgentId: 'main',
  })
}

afterEach(() => {
  FakeWS.instances = []
  vi.unstubAllGlobals()
})

describe('native model switch socket transaction', () => {
  test('binds the prepared generation to the first target turn and consumes it on admission', async () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)
    const socket = makeSocket()
    socket.setGateReady(true)
    const ws = FakeWS.instances.at(-1)!
    ws.open()
    socket.ensureSession('s1', 'main')

    const prepared = socket.prepareModelSwitch('s1', 'glm-5.3', 'gpt-5.6-sol')
    const control = ws.sent
      .map((raw) => JSON.parse(raw))
      .find((frame) => frame.type === 'control.session.prepare_model_switch')
    expect(control).toMatchObject({
      sessionKey: 'agent:main:webchat:dm:s1',
      sourceModel: 'glm-5.3',
      targetModel: 'gpt-5.6-sol',
    })
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'outbound.model_switch.prepared',
        requestId: control.requestId,
        sessionKey: control.sessionKey,
        sourceModel: 'glm-5.3',
        targetModel: control.targetModel,
        status: 'completed',
      }),
    })
    await expect(prepared).resolves.toBe(control.requestId)

    socket.setSessionModel('s1', 'gpt-5.6-sol', control.requestId)
    socket.sendMessage({ sessId: 's1', agentId: 'main', model: 'gpt-5.6-sol', text: 'continue' })
    await vi.waitFor(() => {
      expect(
        ws.sent
          .map((raw) => JSON.parse(raw))
          .some(
            (frame) =>
              frame.type === 'inbound.message' && frame.modelSwitchId === control.requestId,
          ),
      ).toBe(true)
    })
    const inbound = ws.sent
      .map((raw) => JSON.parse(raw))
      .find(
        (frame) => frame.type === 'inbound.message' && frame.modelSwitchId === control.requestId,
      )
    ws.onmessage?.({
      data: JSON.stringify({
        type: 'outbound.ack',
        admitted: true,
        peer: { id: 's1', kind: 'dm' },
        clientMessageId: inbound.clientMessageId,
      }),
    })
    expect(socket.sessions.get('s1')?._preparedModelSwitch).toBeUndefined()
    socket.stop()
  })

  test('rejects a pending preparation immediately when its transport closes', async () => {
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket)
    const socket = makeSocket()
    socket.setGateReady(true)
    const ws = FakeWS.instances.at(-1)!
    ws.open()
    socket.ensureSession('s1', 'main')

    const prepared = socket.prepareModelSwitch('s1', 'glm-5.3', 'gpt-5.6-sol')
    ws.close(1012, 'restart')
    await expect(prepared).rejects.toThrow('连接已断开，未切换模型')
    expect(socket.retryConnectNow()).toBe(true)
    const reconnected = FakeWS.instances.at(-1)!
    reconnected.open()
    expect(reconnected.sent.map((raw) => JSON.parse(raw))).toContainEqual(
      expect.objectContaining({
        type: 'control.session.cancel_model_switch',
        sessionKey: 'agent:main:webchat:dm:s1',
      }),
    )
    socket.stop()
  })
})
