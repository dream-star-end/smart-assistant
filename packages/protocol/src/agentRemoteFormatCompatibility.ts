/** Header comparison for integration planning, never a decoder or restore authorization.
 * Equal numbers do not prove that a format is supported or its contents/signature valid.
 * Different numbers require an explicit migration; no missing state is synthesized here.
 */
export interface AgentRemoteFormatVersions {
  checkpointSchemaVersion: number
  /** SQLite PRAGMA user_version, not the per-principal metadata row version. */
  controlStoreUserVersion: number
}

export interface AgentRemoteVersionComparison {
  sourceVersion: number
  targetVersion: number
  comparison: 'same-version' | 'explicit-migration-required'
  direction: 'unchanged' | 'upgrade' | 'downgrade'
}

export interface AgentRemoteFormatComparison {
  checkpoint: Readonly<AgentRemoteVersionComparison>
  controlStore: Readonly<AgentRemoteVersionComparison>
}

function readVersions(value: unknown): AgentRemoteFormatVersions {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'checkpointSchemaVersion,controlStoreUserVersion') {
    throw new Error('AGENT_REMOTE_FORMAT_HEADER_INVALID')
  }
  const header = value as Record<string, unknown>
  const checkpoint = header.checkpointSchemaVersion
  const control = header.controlStoreUserVersion
  if (typeof checkpoint !== 'number' || !Number.isSafeInteger(checkpoint) || checkpoint < 1 ||
    typeof control !== 'number' || !Number.isSafeInteger(control) || control < 1) {
    throw new Error('AGENT_REMOTE_FORMAT_HEADER_INVALID')
  }
  return { checkpointSchemaVersion: checkpoint, controlStoreUserVersion: control }
}

function compare(sourceVersion: number, targetVersion: number): Readonly<AgentRemoteVersionComparison> {
  return Object.freeze({
    sourceVersion,
    targetVersion,
    comparison: sourceVersion === targetVersion ? 'same-version' : 'explicit-migration-required',
    direction: sourceVersion === targetVersion ? 'unchanged' : sourceVersion < targetVersion ? 'upgrade' : 'downgrade',
  })
}

/** Inputs are already-extracted persisted version headers, not checkpoints or database handles.
 * A zero/uninitialized database is not a persisted format and must be handled by its own store.
 * Callers still need the real schema/hash checks and trusted recovery/Writer proofs.
 */
export function compareAgentRemoteFormatVersions(
  source: unknown,
  target: unknown,
): Readonly<AgentRemoteFormatComparison> {
  const from = readVersions(source)
  const to = readVersions(target)
  return Object.freeze({
    checkpoint: compare(from.checkpointSchemaVersion, to.checkpointSchemaVersion),
    controlStore: compare(from.controlStoreUserVersion, to.controlStoreUserVersion),
  })
}
