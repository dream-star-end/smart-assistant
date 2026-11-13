/**
 * Upload request that reports request-body progress. fetch() exposes no upload
 * progress, so the body goes through XMLHttpRequest and the reply is rebuilt as
 * a real Response: callWithRefresh, the auth response fences and throwApi then
 * treat it exactly like a fetch reply. Like fetch, a network failure rejects
 * with TypeError and an abort rejects with AbortError.
 */

export type ProgressUploadRequest = {
  method: string;
  headers: Record<string, string>;
  body: Blob;
  signal?: AbortSignal;
};

const PROGRESS_MIN_INTERVAL_MS = 100;

export function canReportUploadProgress(): boolean {
  return typeof XMLHttpRequest !== "undefined";
}

export function sendWithUploadProgress(
  url: string,
  req: ProgressUploadRequest,
  onSent: (loaded: number) => void,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (req.signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const total = req.body.size;
    let lastAt = Number.NEGATIVE_INFINITY;
    let lastLoaded = -1;
    const emit = (loaded: number, force: boolean) => {
      const clamped = Math.max(0, Math.min(total, loaded));
      if (clamped === lastLoaded) return;
      const now = Date.now();
      if (!force && now - lastAt < PROGRESS_MIN_INTERVAL_MS) return;
      lastAt = now;
      lastLoaded = clamped;
      onSent(clamped);
    };

    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = () => req.signal?.removeEventListener("abort", onAbort);
    xhr.open(req.method, url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(req.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => emit(e.loaded, e.loaded >= total);
    xhr.upload.onload = () => emit(total, true);
    xhr.onload = () => {
      settle();
      if (xhr.status === 0) {
        reject(new TypeError("Failed to fetch"));
        return;
      }
      try {
        resolve(toResponse(xhr));
      } catch (err) {
        reject(err);
      }
    };
    xhr.onerror = () => {
      settle();
      reject(new TypeError("Failed to fetch"));
    };
    xhr.onabort = () => {
      settle();
      reject(new DOMException("aborted", "AbortError"));
    };
    req.signal?.addEventListener("abort", onAbort, { once: true });
    // Every attempt starts from zero, so a 503 backoff or 401 replay visibly restarts.
    emit(0, true);
    xhr.send(req.body);
  });
}

function toResponse(xhr: XMLHttpRequest): Response {
  const headers = new Headers();
  for (const line of xhr.getAllResponseHeaders().split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    try {
      headers.append(line.slice(0, at).trim(), line.slice(at + 1).trim());
    } catch {
      /* skip a header the Headers class rejects */
    }
  }
  const nullBody = xhr.status === 204 || xhr.status === 205 || xhr.status === 304;
  return new Response(nullBody ? null : xhr.responseText, {
    status: xhr.status,
    statusText: xhr.statusText,
    headers,
  });
}
