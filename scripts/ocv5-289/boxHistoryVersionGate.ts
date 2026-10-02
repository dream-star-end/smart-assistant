/** Only the verified Box Claude Code build may consume private session JSONL. */
export const PINNED_BOX_CLAUDE_VERSION = '2.1.280 (Claude Code)'

export async function withPinnedBoxHistoryVersion<T>(
  reportedVersion: unknown,
  stageAndInfer: () => Promise<T>,
): Promise<T> {
  if (reportedVersion !== PINNED_BOX_CLAUDE_VERSION) {
    throw new Error('BOX_HISTORY_CLI_VERSION_CHANGED')
  }
  return stageAndInfer()
}
