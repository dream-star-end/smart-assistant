/**
 * Remote chunk upload & CAS media fallback hooks for the gateway deps object.
 *
 * Kept out of index.ts so that file stays under the line ratchet.
 */
import { readFile } from "node:fs/promises";
import {
  assembleFiles,
  deleteFile,
  getFile,
  putFileFromPath,
  resolveServiceableHostTarget,
  statFile,
  streamFileTo,
  usageForDir,
} from "./nodeAgentClient.js";

const MAX_CAS_MIRROR_BYTES = 64 * 1024 * 1024;

export interface RemoteHostChunkHooks {
  pushRemoteHostUploadFromPath?: (args: {
    hostUuid: string;
    remotePath: string;
    localPath: string;
    length: number;
  }) => Promise<void>;
  sumRemoteUploadUsage?: (args: {
    hostUuid: string;
    remoteDir: string;
  }) => Promise<{
    usedBytes: number;
    truncated: boolean;
    files: { name: string; size: number; mtimeMs: number }[];
  }>;
  assembleRemoteHostUpload?: (args: {
    hostUuid: string;
    remoteDir: string;
    uploadId: string;
    count: number;
    ext: string;
    expectedSize: number;
  }) => Promise<{ sha256: string; size: number }>;
  deleteRemoteHostUpload?: (args: { hostUuid: string; remotePath: string }) => Promise<void>;
  openRemoteHostMedia?: (args: {
    hostUuid: string;
    remotePath: string;
    dest: NodeJS.WritableStream;
    onReady: (info: { size: number }) => boolean;
  }) => Promise<"ok" | "missing" | "rejected">;
  openCasMediaFallback?: (args: {
    userId: string;
    filename: string;
    dest: NodeJS.WritableStream;
    resolveRange?: (totalSize: number) => { start: number; end: number } | null;
    isHead?: boolean;
    onReady: (info: {
      totalSize: number;
      range: { start: number; end: number } | null;
      contentLength: number;
    }) => boolean;
  }) => Promise<"ok" | "missing" | "rejected">;
}

export interface CasMediaChunkMirrorCallbacks {
  readonly mirrorRemotePathBytes?: (remotePath: string, bytes: Uint8Array) => Promise<void>;
  readonly openCasMediaFallback?: RemoteHostChunkHooks["openCasMediaFallback"];
}

async function pushRemoteUploadFromPathWithCasMirror(
  mirrorRemotePathBytes: ((remotePath: string, bytes: Uint8Array) => Promise<void>) | undefined,
  args: { hostUuid: string; remotePath: string; localPath: string; length: number },
): Promise<void> {
  const target = await resolveServiceableHostTarget(args.hostUuid);
  try {
    await putFileFromPath(target, args.remotePath, args.localPath, args.length, 0o644, 1000, 1000);
  } finally {
    target.psk?.fill(0);
  }
  if (!mirrorRemotePathBytes || args.length > MAX_CAS_MIRROR_BYTES) return;
  try {
    const bytes = await readFile(args.localPath);
    await mirrorRemotePathBytes(args.remotePath, bytes);
  } catch (err) {
    void err;
  }
}

async function assembleRemoteUploadWithCasMirror(
  mirrorRemotePathBytes: ((remotePath: string, bytes: Uint8Array) => Promise<void>) | undefined,
  args: {
    hostUuid: string;
    remoteDir: string;
    uploadId: string;
    count: number;
    ext: string;
    expectedSize: number;
  },
): Promise<{ sha256: string; size: number }> {
  const target = await resolveServiceableHostTarget(args.hostUuid);
  let assembled: { sha256: string; size: number };
  let mirrorBytes: Buffer | null = null;
  try {
    assembled = await assembleFiles(target, {
      remoteDir: args.remoteDir,
      uploadId: args.uploadId,
      count: args.count,
      ext: args.ext,
      expectedSize: args.expectedSize,
    });
    if (mirrorRemotePathBytes && assembled.size <= MAX_CAS_MIRROR_BYTES) {
      mirrorBytes = await getFile(target, `${args.remoteDir}/${assembled.sha256}.${args.ext}`).catch(
        () => null,
      );
    }
  } finally {
    target.psk?.fill(0);
  }
  if (mirrorRemotePathBytes && mirrorBytes !== null) {
    try {
      await mirrorRemotePathBytes(`${args.remoteDir}/${assembled.sha256}.${args.ext}`, mirrorBytes);
    } catch (err) {
      void err;
    }
  }
  return assembled;
}

export function createRemoteHostChunkHooks(
  cas?: CasMediaChunkMirrorCallbacks,
): RemoteHostChunkHooks {
  return {
    pushRemoteHostUploadFromPath: (args) =>
      pushRemoteUploadFromPathWithCasMirror(cas?.mirrorRemotePathBytes, args),
    sumRemoteUploadUsage: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await usageForDir(target, args.remoteDir);
      } finally {
        target.psk?.fill(0);
      }
    },
    assembleRemoteHostUpload: (args) =>
      assembleRemoteUploadWithCasMirror(cas?.mirrorRemotePathBytes, args),
    deleteRemoteHostUpload: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        await deleteFile(target, args.remotePath);
      } finally {
        target.psk?.fill(0);
      }
    },
    openRemoteHostMedia: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        const st = await statFile(target, args.remotePath, { hash: false });
        if (!st.exists) return "missing";
        return await streamFileTo(target, args.remotePath, args.dest, () =>
          args.onReady({ size: st.size ?? 0 }),
        );
      } finally {
        target.psk?.fill(0);
      }
    },
    openCasMediaFallback: cas?.openCasMediaFallback,
  };
}
