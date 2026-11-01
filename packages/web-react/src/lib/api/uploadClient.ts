/** File upload transport, loaded when an upload begins. */
import type { AuthSession } from "../types";
import { MAX_UPLOAD_SINGLE_BYTES } from "@openclaude/protocol/browser";
import {
  AuthEpochStaleError,
  assertAuthResponseCurrent,
  callWithRefresh,
  jsonOrThrow,
  parseRetryAfter,
  sleep,
  throwApi,
} from "./http";

type UploadResult = { url: string; digest?: string; size?: number; mimeType?: string };
type UploadOpts = { maxRetries?: number; signal?: AbortSignal; onProgress?: (sent: number, total: number) => void };

async function uploadOnce(
  a: AuthSession,
  opts: UploadOpts | undefined,
  run: (token: string) => Promise<Response>,
): Promise<Response> {
  const maxRetries = opts?.maxRetries ?? 5;
  const startEpoch = a.snapshot().epoch;
  for (let attempt = 0; ; attempt++) {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (a.snapshot().epoch !== startEpoch) throw new AuthEpochStaleError();
    const res = await callWithRefresh(a, run);
    assertAuthResponseCurrent(res);
    if (res.ok) return res;
    if (res.status === 503 && attempt < maxRetries) {
      const retryAfterSec = Math.min(10, Math.max(1, parseRetryAfter(res) ?? 3));
      await sleep(retryAfterSec * 1000, opts?.signal);
      continue;
    }
    await throwApi(res);
  }
}

export async function uploadFile(
  a: AuthSession,
  file: File,
  opts?: UploadOpts,
): Promise<UploadResult> {
  const startEpoch = a.snapshot().epoch;
  if (file.size > MAX_UPLOAD_SINGLE_BYTES) {
    const { uploadChunkedFile } = await import("./uploadChunkClient");
    if (a.snapshot().epoch !== startEpoch) throw new AuthEpochStaleError();
    return uploadChunkedFile(a, file, opts, uploadOnce);
  }
  const maxRetries = opts?.maxRetries ?? 5;
  // The file belongs to the identity that started the upload. callWithRefresh
  // snapshots the epoch per call, so without this pin a 503 retry after a
  // logout/account switch would send the file with the next account's token.
  for (let attempt = 0; ; attempt++) {
    if (opts?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (a.snapshot().epoch !== startEpoch) throw new AuthEpochStaleError();
    const res = await callWithRefresh(a, (t) =>
      fetch("/api/uploads", {
        method: "POST",
        credentials: "include",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${t}`,
          "content-type": file.type || "application/octet-stream",
          "x-filename": encodeURIComponent(file.name || "file"),
        },
        body: file,
      }),
    );
    // 换号栅栏必须逐次检查:重试循环会跨越切账号边界,旧 epoch 的响应不能继续重放,
    // 否则退避期间换了号,文件会落进上一个账号的容器卷。
    assertAuthResponseCurrent(res);
    if (res.ok) return jsonOrThrow(res);
    // 容器冷启：handleUpload / _resolveMediaDirs 未就绪时 fail-closed 503 + Retry-After。
    // 只对 503 退避；其它状态码立即抛，避免把 4xx 拖成假成功。
    if (res.status === 503 && attempt < maxRetries) {
      const retryAfterSec = Math.min(10, Math.max(1, parseRetryAfter(res) ?? 3));
      await sleep(retryAfterSec * 1000, opts?.signal);
      continue;
    }
    await throwApi(res);
  }
}
