/**
 * Remote chunk upload hooks for the gateway deps object.
 *
 * Kept out of index.ts so that file stays under the line ratchet.
 * WeChat and QQ keep their own Buffer push closures.
 */
import {
  assembleFiles,
  deleteFile,
  putFileFromPath,
  resolveServiceableHostTarget,
  statFile,
  streamFileTo,
  usageForDir,
} from "./nodeAgentClient.js";

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
}

export function createRemoteHostChunkHooks(): RemoteHostChunkHooks {
  return {
    pushRemoteHostUploadFromPath: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        await putFileFromPath(target, args.remotePath, args.localPath, args.length, 0o644, 1000, 1000);
      } finally {
        target.psk?.fill(0);
      }
    },
    sumRemoteUploadUsage: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await usageForDir(target, args.remoteDir);
      } finally {
        target.psk?.fill(0);
      }
    },
    assembleRemoteHostUpload: async (args) => {
      const target = await resolveServiceableHostTarget(args.hostUuid);
      try {
        return await assembleFiles(target, {
          remoteDir: args.remoteDir,
          uploadId: args.uploadId,
          count: args.count,
          ext: args.ext,
          expectedSize: args.expectedSize,
        });
      } finally {
        target.psk?.fill(0);
      }
    },
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
        return await streamFileTo(target, args.remotePath, args.dest, () => args.onReady({ size: st.size ?? 0 }));
      } finally {
        target.psk?.fill(0);
      }
    },
  };
}
