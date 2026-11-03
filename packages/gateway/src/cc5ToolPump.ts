/** Serialized real tools in the execution container, correlated with original host stdout. */
import { request } from 'node:http'
import {
  type AuthorityKeyring,
  assertLeaseMatchesAuthority,
  verifyAuthority,
  verifyTurnLease,
} from '@openclaude/protocol'
import { CC5_RELAY_SOCKET, type Cc5BridgeBinding } from './cc5BridgePort.js'
import type { Cc5ToolRequest } from './cc5FixedTool.js'
import { Cc5NativeToolExecutor } from './cc5NativeToolExecutor.js'
import type { Cc5ToolResult } from './cc5NativeTool.js'
import type { Cc5ToolObservation } from './cc5ToolObservation.js'

export interface Cc5ToolDelivery {
  request: Cc5ToolRequest
  admission: {
    turnKey: string
    authorityTurnId: string
    connectionChallenge: string
    securityEpoch: number
  }
}

/** Fixed Unix paths only. A poll may be repeated; an effect/result delivery never is. */
export function cc5ToolRequest(
  path: '/tool/next' | '/tool/result',
  body: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  socketPath = CC5_RELAY_SOCKET,
): Promise<Record<string, unknown>> {
  if (signal.aborted) return Promise.reject(new Error('CC5_TOOL_CHANNEL_CLOSED'))
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        agent: false,
        path,
        method: 'POST',
        signal,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 131072) req.destroy(new Error('CC5_TOOL_RESPONSE_LIMIT'))
          else chunks.push(chunk)
        })
        res.once('error', reject)
        res.once('aborted', () => reject(new Error('CC5_TOOL_RESPONSE_UNKNOWN')))
        res.once('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
              string,
              unknown
            >
            if (res.statusCode !== 200 || !value || value.ok !== true)
              throw new Error('CC5_TOOL_REJECTED')
            resolve(value)
          } catch {
            reject(new Error('CC5_TOOL_RESPONSE_INVALID'))
          }
        })
      },
    )
    const timer = setTimeout(() => req.destroy(new Error('CC5_TOOL_DELIVERY_UNKNOWN')), 45000)
    req.once('close', () => clearTimeout(timer))
    req.once('error', reject)
    req.end(payload)
  })
}

export async function runCc5ToolPump(input: {
  binding: Readonly<Cc5BridgeBinding>
  sessionKey: string
  keyring: AuthorityKeyring
  observation: Cc5ToolObservation
  signal: AbortSignal
  socketPath?: string
  executeTool: (request: Cc5ToolRequest) => Promise<Cc5ToolResult>
  /** Only fixtures override the persistent production root. */
  executionRoot?: string
}): Promise<void> {
  if (input.keyring.size === 0) throw new Error('CC5_TOOL_KEYRING_MISSING')
  if (input.sessionKey !== input.binding.sessionKey) throw new Error('CC5_TOOL_SCOPE_MISMATCH')
  const scope = {
    capability: input.binding.capability,
    uid: input.binding.uid,
    containerDbId: input.binding.containerDbId,
    dockerId: input.binding.dockerId,
    operationId: input.binding.operationId,
    sessionKey: input.sessionKey,
  }
  while (!input.signal.aborted) {
    const value = await cc5ToolRequest('/tool/next', scope, input.signal, input.socketPath)
    if (value.delivery === null) continue // bounded long-poll; no effect has been attempted.
    const delivery = structuredClone(value.delivery) as Cc5ToolDelivery
    if (!delivery || input.signal.aborted) throw new Error('CC5_TOOL_CHANNEL_CLOSED')
  const { request: tool, admission } = delivery
  const now = Date.now()
  const authority = verifyAuthority(tool.authority, input.keyring, now, { allowExpired: true })
  const lease = verifyTurnLease(tool.lease, input.keyring, now)
  assertLeaseMatchesAuthority(lease, authority)
  if (
    !admission ||
    typeof admission.turnKey !== 'string' ||
    !admission.turnKey ||
    admission.turnKey !== tool.turnKey ||
    admission.authorityTurnId !== authority.authorityTurnId ||
    admission.connectionChallenge !== authority.connectionChallenge ||
    admission.securityEpoch !== authority.securityEpoch
  )
    throw new Error('CC5_TOOL_ADMISSION_MISMATCH')
  const actual = await input.observation.waitFor(tool, input.signal)
  if (input.signal.aborted) throw new Error('CC5_TOOL_CHANNEL_CLOSED')
  const executor = new Cc5NativeToolExecutor(
    input.binding,
    input.keyring,
    input.executeTool,
    input.executionRoot ?? '/home/agent/.openclaude/.cc5-native-tools',
  )
  // execute verifies all signatures, expiry and binding again after observation's await.
  const receipt = await executor.execute(tool, actual, admission)
  const ack = await cc5ToolRequest(
    '/tool/result',
    { ...scope, receipt },
    input.signal,
    input.socketPath,
  )
  if (ack.commandId !== receipt.commandId) throw new Error('CC5_TOOL_RESULT_ACK_UNKNOWN')
  }
}
