// R7.1 — barrel export for r7-backup module.
//
// 仅 re-export 公共 API,**不**触发 SDK 副作用(RealGcsClient 构造时才连 GCS)。

export {
  BackupBrokerError,
  type BackupBrokerErrorCode,
  type Manifest,
  type ManifestSlice,
  manifestSchema,
  manifestSliceSchema,
  OBJECT_NAME_TAIL_RE,
  assertSliceObjectPrefix,
  assertUid,
  assertContainerDbId,
  parseAndAssertManifest,
} from "./types.js";

export {
  type GcsClient,
  type SignedUrlReq,
  type ObjectGetResult,
  type ObjectPutOpts,
  type ObjectPutResult,
  type ListedObject,
  RealGcsClient,
  type RealGcsClientOpts,
} from "./gcsClient.js";

export {
  GcsBackupBroker,
  type BrokerOpts,
  type IssueUploadUrlsResult,
  type IssueDownloadUrlsResult,
  type ReadManifestResult,
  type CommitManifestResult,
} from "./gcsBackupBroker.js";
