import type { Message, UserMessage } from '../types/message.js'
import { createUserMessage } from './messages.js'
import {
  prepareStrictReceiptInput,
  type ReceiptInputMarker,
} from './sessionStorage.js'
import type {
  NativeReceiptObservation,
  NativeReceiptProof,
} from './nativeReceiptTranscript.js'

export type ReceiptInputAdmission = Readonly<{
  marker: ReceiptInputMarker
  // Installed ONLY by the verified transport adapter. It must hold the shared
  // receipt writer barrier for owner CAS, write, oracle and confirmation.
  ingest: (
    proof: NativeReceiptProof,
    write: () => Promise<void>,
    oracle: () => Promise<NativeReceiptObservation>,
  ) => Promise<string>
}>

// No JSON/stdout/jobId sniffing: reconstructed/untrusted messages cannot opt in.
// No production transport enrollment until the complete C0 consumer handshake.
const admissions = new WeakMap<Message, ReceiptInputAdmission>()
export function bindReceiptInput(
  message: UserMessage,
  admission: ReceiptInputAdmission,
): void {
  if (admissions.has(message))
    throw new Error('receipt input binding is immutable')
  admissions.set(
    message,
    Object.freeze({
      marker: Object.freeze({ ...admission.marker }),
      ingest: admission.ingest,
    }),
  )
}

/** Actual query boundary: before both yield and normalization/API input. */
export async function admitReceiptInput<T extends Message>(
  message: T,
  history: readonly Message[],
): Promise<T | UserMessage> {
  const admission = admissions.get(message)
  if (!admission) return message
  if (message.type !== 'user')
    throw new Error('unsupported receipt input record')
  const prepared = await prepareStrictReceiptInput(
    message,
    history,
    admission.marker,
  )
  const outcome = await admission.ingest(
    prepared.proof,
    prepared.commit,
    prepared.observe,
  )
  if (outcome === 'ingested') return prepared.message

  // A different UUID is essential: a losing placeholder must not occupy the
  // prepared input's UUID/hash and poison crash recovery. Preserve tool pairing
  // but strip every original-result side channel (mcpMeta/toolUseResult/etc.).
  const neutral = '该子任务结果由持久任务回调交付；此处不重复提交结果。'
  const content = Array.isArray(message.message.content)
    ? message.message.content
        .filter(block => block.type === 'tool_result')
        .map(block => ({
          type: 'tool_result' as const,
          tool_use_id: block.tool_use_id,
          content: neutral,
        }))
    : []
  return createUserMessage({
    content: content.length ? content : neutral,
    sourceToolAssistantUUID: message.sourceToolAssistantUUID,
  })
}
