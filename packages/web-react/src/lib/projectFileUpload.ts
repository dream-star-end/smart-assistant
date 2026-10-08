import { AuthEpochStaleError, api } from "./api";
import type { AuthSession } from "./types";

/**
 * Upload files into a project for the identity that started the action.
 * Stops as soon as that identity changes (logout / account switch / token
 * epoch bump), so a file chosen as account A never lands in account B.
 */
export async function uploadFilesToProject(opts: {
  auth: AuthSession;
  projectId: string;
  files: readonly File[];
  identityChanged: () => boolean;
}): Promise<{ uploaded: number; failed: number; aborted: boolean }> {
  let uploaded = 0;
  let failed = 0;
  for (const file of opts.files) {
    if (opts.identityChanged()) return { uploaded, failed, aborted: true };
    try {
      const stored = await api.uploadFile(opts.auth, file);
      if (opts.identityChanged()) return { uploaded, failed, aborted: true };
      await api.createProjectAsset(opts.auth, {
        projectId: opts.projectId,
        source: "upload",
        name: file.name,
        url: stored.url,
        mime: stored.mimeType,
        size: stored.size ?? file.size,
        digest: stored.digest,
      });
      uploaded += 1;
    } catch (e) {
      if (e instanceof AuthEpochStaleError || opts.identityChanged()) return { uploaded, failed, aborted: true };
      failed += 1;
      console.warn("project file upload failed", e);
    }
  }
  return { uploaded, failed, aborted: false };
}
