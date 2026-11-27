/**
 * Commercial fail-closed gate for Master Artifact CAS Blob Store and
 * container-side automatic EngineCapsuleRuntime (OCV5-913 T2 B2).
 *
 * Background:
 * - Master's `LocalCasArtifactBlobStore` enforces per-object and per-part size
 *   limits, but PG-mode GC does not yet reclaim physical objects or enforce
 *   atomic per-tenant/global disk quotas on multi-tenant commercial hosts.
 * - On commercial flavor (and fail-closed on `FlavorIdentityError`), Master
 *   leaves the CAS blob store uninitialized (`503 ARTIFACT_BLOB_STORE_UNAVAILABLE`
 *   on `/internal/v3/artifact-blobs/*`) and injects `OC_CAPSULE_RUNTIME_ENABLED=0`
 *   into newly provisioned containers unless operators explicitly opt in with
 *   `OC_ARTIFACT_CAS_ENABLED=1`.
 * - Selfhost and manifestless dev/test environments remain enabled by default.
 */

import {
  type FlavorIdentity,
  FlavorIdentityError,
  resolveFlavorIdentity,
} from "../flavor/assertFlavor.js";

export const ARTIFACT_CAS_ENABLED_ENV = "OC_ARTIFACT_CAS_ENABLED";
export const CAPSULE_RUNTIME_ENABLED_ENV = "OC_CAPSULE_RUNTIME_ENABLED";

export interface ArtifactCasEnvOpts {
  readonly env: NodeJS.ProcessEnv;
  /** Test seam; production uses real `resolveFlavorIdentity`. */
  readonly identity?: () => FlavorIdentity;
}

export function isMasterArtifactCasEnabled(opts: ArtifactCasEnvOpts): boolean {
  const explicit = opts.env[ARTIFACT_CAS_ENABLED_ENV]?.trim();
  if (explicit === "1") return true;
  if (explicit === "0") return false;

  let identity: FlavorIdentity;
  try {
    identity = (opts.identity ?? resolveFlavorIdentity)();
  } catch (err) {
    if (err instanceof FlavorIdentityError) return false;
    throw err;
  }
  if (identity.status === "ok" && identity.flavor === "commercial") {
    return false;
  }
  return true;
}

export function capsuleRuntimeContainerEnv(opts: ArtifactCasEnvOpts): string[] {
  return isMasterArtifactCasEnabled(opts) ? [] : [`${CAPSULE_RUNTIME_ENABLED_ENV}=0`];
}
