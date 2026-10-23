/** Private, authenticated continuity material. Never exposed by browser routes. */
export interface CcbTranscriptRestoreBinding {
  peerId: string
  agentId: string
  nativeSessionId: string
}
export interface CcbNativeRestoreRecord {
  ordinal: number
  sha256: string
  payload: Record<string, unknown>
}
export interface CcbNativeRestoreTape {
  tapeId: string
  tapeSha256: string
  anchorSeq: number
  physicalRecordCount: number
  logicalRecordCount: number
  runtimeManifestSha256?: string
  canonicalInput: { id: string; modelText: string; sha256: string }
  records: CcbNativeRestoreRecord[]
}
export interface CcbNativeTranscriptArchive {
  version: 1
  binding: CcbTranscriptRestoreBinding
  tapes: CcbNativeRestoreTape[]
}
