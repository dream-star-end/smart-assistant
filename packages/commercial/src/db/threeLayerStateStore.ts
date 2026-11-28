/**
 * OCV5-890 Wave 1B / OCV5-928 — Layer 1 PostgreSQL Authoritative State Stores Facade.
 *
 * Named re-export facade preserving 100% public contract compatibility across:
 * - `PgSessionAuthorityStateStore` (`./threeLayer/sessionAuthorityStateStore.ts`)
 * - `PgLogicalModelBindingStore` (`./threeLayer/logicalModelBindingStore.ts`)
 * - `PgArtifactBlobMetaStore` (`./threeLayer/artifactBlobMetaStore.ts`)
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 */
export {
  PENDING_INSTALL_MIGRATION_KEY,
  extractPendingInstallMigration,
  type PendingInstallMigration,
} from './threeLayerPendingInstall.js'

export type {
  AbortPlacementMigrationCas,
  AbortPlacementMigrationResult,
  AckRollingCheckpointCas,
  ArtifactBlobUploadPartMeta,
  ArtifactBlobUploadRecord,
  BeginPlacementMigrationCas,
  BeginPlacementMigrationResult,
  CompleteBlobRowInput,
  CommitPlacementMigrationCas,
  CommitPlacementMigrationResult,
  GcUnreferencedBlobsOptions,
  GcUnreferencedBlobsResult,
  InitiateBlobUploadMetaInput,
  InspectedModelPoolBindings,
  MarkPlacementMigrationInstalledOptions,
  MarkPlacementMigrationInstalledResult,
  PgQueryable,
  PgQueryResult,
  PgTransactionClient,
  PgTransactionPool,
  RecordBlobPartResult,
  ResolvedModelPoolBindings,
  SaveRollingCheckpointInput,
  SaveRollingCheckpointResult,
  UpsertEnginePointerInput,
} from './threeLayer/types.js'

export { PgSessionAuthorityStateStore } from './threeLayer/sessionAuthorityStateStore.js'
export { PgLogicalModelBindingStore } from './threeLayer/logicalModelBindingStore.js'
export { PgArtifactBlobMetaStore } from './threeLayer/artifactBlobMetaStore.js'
