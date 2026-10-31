import type { UUID } from 'crypto'
import type { Message, SystemCompactBoundaryMessage } from '../../types/message.js'
import type { CompactionResult } from './compact.js'

/**
 * Build the base post-compact messages array from a CompactionResult.
 * This ensures consistent ordering across all compaction paths.
 * Order: boundaryMarker, summaryMessages, messagesToKeep, attachments, hookResults
 */
export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return ([result.boundaryMarker] as Message[]).concat(
    result.summaryMessages,
    stripToolUseResults(result.messagesToKeep),
    result.attachments,
    result.hookResults,
  )
}

/** Release large tool result payloads from kept messages after compaction.
 *  toolUseResult is only used for UI rendering, not API calls. */
function stripToolUseResults(messages: Message[] | undefined): Message[] {
  if (!messages) return []
  return messages.map(msg => {
    if (
      msg.type === 'user' &&
      'toolUseResult' in msg &&
      msg.toolUseResult !== undefined
    ) {
      const { toolUseResult, ...rest } = msg as Message & {
        toolUseResult: unknown
      }
      return rest as Message
    }
    return msg
  })
}

/**
 * Annotate a compact boundary with relink metadata for messagesToKeep.
 * Preserved messages keep their original parentUuids on disk (dedup-skipped);
 * the loader uses this to patch head→anchor and anchor's-other-children→tail.
 *
 * `anchorUuid` = what sits immediately before keep[0] in the desired chain:
 *   - suffix-preserving (reactive/session-memory): last summary message
 *   - prefix-preserving (partial compact): the boundary itself
 */
export function annotateBoundaryWithPreservedSegment(
  boundary: SystemCompactBoundaryMessage,
  anchorUuid: UUID,
  messagesToKeep: readonly Message[] | undefined,
): SystemCompactBoundaryMessage {
  const keep = messagesToKeep ?? []
  if (keep.length === 0) return boundary
  return {
    ...boundary,
    compactMetadata: {
      ...boundary.compactMetadata,
      preservedSegment: {
        headUuid: keep[0]!.uuid,
        anchorUuid,
        tailUuid: keep.at(-1)!.uuid,
      },
    },
  }
}

