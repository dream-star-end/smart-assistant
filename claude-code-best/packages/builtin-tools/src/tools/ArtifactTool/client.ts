export type UploadResult = {
  id: string
  url: string
  expiresAt: string
}

export type UploadParams = {
  html: string
  token: string
  uploadUrl: string
  hash?: string
  ttl?: 7 | 30
  /** Hard wall-clock budget for the whole request (connect + upload + body). */
  timeoutMs?: number
}

/** Default upload deadline. The tool call runs inside the agent loop, so a
 * hung upload would otherwise freeze the entire turn. */
export const ARTIFACT_UPLOAD_TIMEOUT_MS = 60_000

/**
 * Bound a promise with a wall-clock deadline. Unlike AbortSignal alone, this
 * also covers the case where the runtime's response body stream never settles
 * (Node 22 undici hangs on `content-encoding` headers that do not match the
 * actual bytes, and abort() does not wake the pending read).
 */
async function withDeadline<T>(
  promise: Promise<T>,
  deadlineMs: number,
  onTimeout: () => void,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first so the race surfaces the timeout message rather than the
      // generic AbortError produced by cancelling the underlying request.
      reject(
        new Error(
          `Artifact upload timed out after ${Math.round(deadlineMs / 1000)}s (${label})`,
        ),
      )
      onTimeout()
    }, deadlineMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function uploadArtifact(
  params: UploadParams,
): Promise<UploadResult> {
  const url = new URL(params.uploadUrl)
  if (params.hash) url.searchParams.set('hash', params.hash)
  if (params.ttl) url.searchParams.set('ttl', String(params.ttl))

  const timeoutMs = params.timeoutMs ?? ARTIFACT_UPLOAD_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  const abort = (): void => controller.abort()

  const response = await withDeadline(
    fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'text/html',
        // The upload edge has been observed to advertise `content-encoding:
        // br|gzip` while sending an uncompressed JSON body. Node's fetch then
        // never finishes decoding and `response.text()` blocks forever.
        // Asking for identity keeps the body byte-for-byte parseable.
        'Accept-Encoding': 'identity',
      },
      body: params.html,
      signal: controller.signal,
    }),
    timeoutMs,
    abort,
    'waiting for response headers',
  )

  // Deno Deploy proxy flattens upstream status to 200; the Worker embeds the
  // real error in the body as `{ "error": "<code>" }`. Always parse body first.
  const text = await withDeadline(
    response.text(),
    Math.max(1, deadline - Date.now()),
    abort,
    'reading response body',
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `Artifact upload failed: HTTP ${response.status} (non-JSON body)`,
    )
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const code = (parsed as { error: unknown }).error
    throw new Error(`Artifact upload failed: ${String(code)}`)
  }

  const data = parsed as Partial<UploadResult>
  if (
    typeof data.id !== 'string' ||
    typeof data.url !== 'string' ||
    typeof data.expiresAt !== 'string'
  ) {
    throw new Error(
      `Artifact upload returned malformed body: ${text.slice(0, 200)}`,
    )
  }
  return { id: data.id, url: data.url, expiresAt: data.expiresAt }
}
