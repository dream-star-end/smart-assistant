/** Exact multi-axis runtime acceptance for a selfhost container. A release
 * label alone is never a success proof. Pure inputs allow no-I/O negatives. */
import { realpathSync } from "node:fs";
import { RUNTIME_IMAGE_ID_LABEL_KEY, RUNTIME_RELEASE_LABEL_KEY,
  RUNTIME_BUNDLE_REV_LABEL_KEY, RUNTIME_BOOT_HASH_LABEL_KEY } from
  "../../packages/commercial/src/agent-sandbox/platformBundle.js";

type Status = { state: string; imageId?: string | null } | null;
type Inspect = { Image?: string; Config?: { Labels?: Record<string, string> | null };
  Mounts?: Array<{ Type?: string; Destination?: string; Source?: string }> };
type Desired = { imageId?: string; bundleRev?: string; bootHash?: string;
  releaseResolvedPath?: string; platformRoot?: string };
export function runtimeMatches(status: Status, info: Inspect,
  desired: Desired, release: string,
  resolve: (path: string) => string = realpathSync): boolean {
  if (!status || status.state !== "running" || !desired.imageId
    || !desired.bundleRev || !desired.bootHash || !desired.releaseResolvedPath
    || !desired.platformRoot) return false;
  const labels = info.Config?.Labels ?? {};
  const mounts = info.Mounts ?? [];
  const runtime = mounts.find((m) => m.Type === "bind"
    && m.Destination === "/opt/openclaude");
  const platform = mounts.find((m) => m.Type === "bind"
    && m.Destination === "/run/oc/platform");
  try {
    return status.imageId === desired.imageId && info.Image === desired.imageId
      && labels[RUNTIME_IMAGE_ID_LABEL_KEY] === desired.imageId
      && labels[RUNTIME_RELEASE_LABEL_KEY] === release
      && labels[RUNTIME_BUNDLE_REV_LABEL_KEY] === desired.bundleRev
      && labels[RUNTIME_BOOT_HASH_LABEL_KEY] === desired.bootHash
      && !!runtime?.Source && !!platform?.Source
      && resolve(runtime.Source) === desired.releaseResolvedPath
      && resolve(platform.Source) === desired.platformRoot;
  } catch { return false; }
}
