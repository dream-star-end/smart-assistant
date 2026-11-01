/**
 * Chunked upload client.
 *
 * Loaded only after a file exceeds the 100MiB single-shot cap, so the first
 * screen does not carry this module.
 */
import type { AuthSession } from "../types";
import { ApiError } from "./http";
import {
  MAX_UPLOAD_FILE_BYTES,
  UPLOAD_CHUNK_BYTES,
  uploadChunkCount,
  uploadChunkLength,
  uploadFileLimitMessage,
} from "@openclaude/protocol/browser";

type UploadResult = { url: string; digest?: string; size?: number; mimeType?: string };
type UploadOpts = { maxRetries?: number; signal?: AbortSignal; onProgress?: (sent: number, total: number) => void };
type UploadOnce = (
  a: AuthSession,
  opts: UploadOpts | undefined,
  run: (token: string) => Promise<Response>,
) => Promise<Response>;

export async function uploadChunkedFile(
  a: AuthSession,
  file: File,
  opts: UploadOpts | undefined,
  uploadOnce: UploadOnce,
): Promise<UploadResult> {
  if (file.size > MAX_UPLOAD_FILE_BYTES) throw new Error(uploadFileLimitMessage(file.size));
  const storageKey = `oc-upload:${file.name}:${file.size}:${file.lastModified}`;
  const remember = (id: string) => {
    if (typeof sessionStorage === "undefined") return;
    try {
      sessionStorage.setItem(storageKey, id);
    } catch {
      /* private mode */
    }
  };
  const recall = (): string | null => {
    if (typeof sessionStorage === "undefined") return null;
    try {
      return sessionStorage.getItem(storageKey);
    } catch {
      return null;
    }
  };
  let uploadId = recall();
  let chunkBytes = UPLOAD_CHUNK_BYTES;
  let chunkCount = uploadChunkCount(file.size, chunkBytes);
  let received = new Set<number>();
  if (uploadId) {
    const resumeId = uploadId;
    try {
      const res = await uploadOnce(a, opts, (t) =>
        fetch(`/api/uploads/${resumeId}`, {
          method: "GET",
          credentials: "include",
          headers: { Accept: "application/json", Authorization: `Bearer ${t}` },
          signal: opts?.signal,
        }),
      );
      const st = (await res.json()) as { size?: number; chunkBytes?: number; chunkCount?: number; received?: number[] };
      if (st.size === file.size && Array.isArray(st.received) && st.chunkCount) {
        chunkBytes = st.chunkBytes || chunkBytes;
        chunkCount = st.chunkCount;
        received = new Set(st.received);
      } else {
        uploadId = null;
      }
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 404) uploadId = null;
      else throw err;
    }
  }
  if (!uploadId) {
    const res = await uploadOnce(a, opts, (t) =>
      fetch("/api/uploads/init", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${t}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          filename: file.name || "file",
          size: file.size,
          mimeType: file.type || "application/octet-stream",
        }),
        signal: opts?.signal,
      }),
    );
    const init = (await res.json()) as { uploadId: string; chunkBytes?: number; chunkCount?: number };
    uploadId = init.uploadId;
    chunkBytes = init.chunkBytes || chunkBytes;
    chunkCount = init.chunkCount || chunkCount;
    remember(uploadId);
  }
  const activeId = uploadId;
  if (!activeId) throw new Error("upload init failed");
  let sent = 0;
  for (let index = 0; index < chunkCount; index++) {
    const length = uploadChunkLength(file.size, index, chunkBytes);
    if (received.has(index)) {
      sent += length;
      opts?.onProgress?.(sent, file.size);
      continue;
    }
    const start = index * chunkBytes;
    const body = file.slice(start, start + length);
    await uploadOnce(a, opts, (t) =>
      fetch(`/api/uploads/${activeId}/chunks/${index}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          Authorization: `Bearer ${t}`,
          "content-type": "application/octet-stream",
        },
        body,
        signal: opts?.signal,
      }),
    );
    sent += length;
    opts?.onProgress?.(sent, file.size);
  }
  const done = await uploadOnce(a, opts, (t) =>
    fetch(`/api/uploads/${activeId}/complete`, {
      method: "POST",
      credentials: "include",
      headers: { Accept: "application/json", Authorization: `Bearer ${t}` },
      signal: opts?.signal,
    }),
  );
  if (typeof sessionStorage !== "undefined") {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  }
  return (await done.json()) as UploadResult;
}
