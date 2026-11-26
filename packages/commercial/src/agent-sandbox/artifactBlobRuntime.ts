/**
 * OCV5-907 Wave 2 (P1-2) — Master runtime assembly for `LocalCasArtifactBlobStore`.
 *
 * Binds `LocalCasArtifactBlobStore` to PostgreSQL metadata (`PgArtifactBlobMetaStore`)
 * and a domain-separated SHA-256 ticket signing secret derived from the master
 * bridge secret, and provides a safe helper bridging `UserMediaLocation` with
 * `resolveMediaOrBlobBridge`.
 *
 * Layer: app-container (L4). Zero `process.env` reads; zero forbidden R3-crypto
 * calls (`createHash` only).
 */
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import {
  LocalCasArtifactBlobStore,
  resolveMediaOrBlobBridge,
  type MediaOrBlobBridgeResolution,
} from './artifactBlobStore.js'
import type { UserMediaLocation } from './userMedia.js'
import { PgArtifactBlobMetaStore, type PgTransactionPool } from '../db/threeLayerStateStore.js'

const ARTIFACT_BLOB_TICKET_DOMAIN = 'openclaude:v5:artifact-blob-ticket:v1:'

export interface MasterArtifactBlobStoreOptions {
  /** Base OpenClaude home directory on master (e.g. `/root/.openclaude`). */
  readonly openClaudeHome: string
  /** Optional explicit override directory for the CAS store. */
  readonly casRootDir?: string
  /** PostgreSQL pool backing `artifact_blobs` and `artifact_blob_uploads`. */
  readonly pgPool: PgTransactionPool
  /** Master bridge secret used to derive a domain-separated signing key. */
  readonly bridgeSecret?: string
  /** Optional max blob bytes override. */
  readonly maxBlobBytes?: number
  /** Optional default chunk bytes override. */
  readonly defaultChunkBytes?: number
}

export function deriveArtifactBlobTicketKey(bridgeSecret: string): Uint8Array {
  const digest = createHash('sha256')
    .update(ARTIFACT_BLOB_TICKET_DOMAIN, 'utf8')
    .update(bridgeSecret, 'utf8')
    .digest()
  return new Uint8Array(digest)
}

export function resolveMasterArtifactCasDir(
  openClaudeHome: string,
  explicitCasRootDir?: string,
): string {
  const trimmed = explicitCasRootDir?.trim()
  if (trimmed) return path.resolve(trimmed)
  return path.join(openClaudeHome, 'artifact-cas')
}

export function createMasterArtifactBlobStore(
  opts: MasterArtifactBlobStoreOptions,
): {
  readonly store: LocalCasArtifactBlobStore
  readonly metaStore: PgArtifactBlobMetaStore
  readonly rootDir: string
} {
  const rootDir = resolveMasterArtifactCasDir(opts.openClaudeHome, opts.casRootDir)
  const metaStore = new PgArtifactBlobMetaStore(opts.pgPool)
  const signingSecret =
    opts.bridgeSecret && opts.bridgeSecret.length > 0
      ? deriveArtifactBlobTicketKey(opts.bridgeSecret)
      : undefined
  const store = new LocalCasArtifactBlobStore({
    rootDir,
    metaStore,
    ...(signingSecret ? { signingSecret } : {}),
    ...(opts.maxBlobBytes !== undefined ? { maxBlobBytes: opts.maxBlobBytes } : {}),
    ...(opts.defaultChunkBytes !== undefined ? { defaultChunkBytes: opts.defaultChunkBytes } : {}),
  })
  return { store, metaStore, rootDir }
}

/**
 * Resolve media location through `resolveMediaOrBlobBridge` bound to the
 * master CAS store so remote-host containers route through the blob bridge
 * instead of failing hard when the bridge is enabled.
 */
export function resolveMasterMediaWithBlobBridge(
  location: UserMediaLocation,
  blobStore?: LocalCasArtifactBlobStore,
  enableBlobBridge = true,
): MediaOrBlobBridgeResolution {
  return resolveMediaOrBlobBridge(location, {
    enableBlobBridge: enableBlobBridge && Boolean(blobStore),
    ...(blobStore ? { blobStore } : {}),
  })
}
