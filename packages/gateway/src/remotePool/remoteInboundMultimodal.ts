/**
 * Builds the `TurnParams['input']` payload for inbound user messages (OCV5-893 B1).
 *
 * - For `remote-driver-v4` turns (`remote_pool` — Antigravity, Codex, CC) that include
 *   saved image attachments (`kind === 'image'`), preserves structured content blocks
 *   `[{ type: 'text', text }, { type: 'image', path, mimeType? }, ...]` so
 *   `RemoteContainerLane` materializes the trusted container paths into inline base64
 *   image blocks before dispatching to the remote driver (and fails closed when
 *   `supportsVision === false`, never silently dropping images).
 * - For local container turns (non-`remote-driver-v4`) or turns without saved images,
 *   returns `finalText` unchanged as a plain string (zero regression).
 */
import {
  isRemoteDriverExecutionBackend,
  type RemoteExecutionBackend,
} from '@openclaude/protocol'

export interface InboundSavedMediaLike {
  readonly kind: string
  readonly path: string
  readonly mimeType?: string
  readonly name?: string
  readonly sizeHint?: string
}

export type RemoteInboundTurnBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; mimeType?: string }

export type InboundTurnSubmitPayload =
  | string
  | Array<{ type: string; [key: string]: unknown }>

export const DEFAULT_REMOTE_IMAGE_ONLY_TEXT = '请查看用户附带的图片并结合上下文回答。'

export function buildRemoteInboundTurnPayload(input: {
  readonly finalText: string
  readonly savedMedia?: readonly InboundSavedMediaLike[]
  readonly executionBackend?: RemoteExecutionBackend | null
}): InboundTurnSubmitPayload {
  if (!isRemoteDriverExecutionBackend(input.executionBackend)) {
    return input.finalText
  }
  const images = (input.savedMedia ?? []).filter(
    (m) => m.kind === 'image' && typeof m.path === 'string' && m.path.trim().length > 0,
  )
  if (images.length === 0) {
    return input.finalText
  }
  const textBody =
    input.finalText.trim().length > 0 ? input.finalText : DEFAULT_REMOTE_IMAGE_ONLY_TEXT
  const blocks: RemoteInboundTurnBlock[] = [{ type: 'text', text: textBody }]
  for (const img of images) {
    const cleanMime = typeof img.mimeType === 'string' ? img.mimeType.trim() : ''
    blocks.push({
      type: 'image',
      path: img.path.trim(),
      ...(cleanMime ? { mimeType: cleanMime } : {}),
    })
  }
  return blocks
}
