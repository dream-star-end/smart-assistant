/** Bound slow request bodies while retaining the real business promise during drain. */
import type { IncomingMessage } from 'node:http'
import { HttpError, readJsonBody } from '../http/util.js'
export async function readSystemActionBody(req: IncomingMessage, maxBytes: number, signal?: AbortSignal, deadlineMs = 5000): Promise<unknown> {
  const stop = () => req.destroy()
  if (signal?.aborted) { stop(); throw new HttpError(503, 'UNAVAILABLE', '系统操作正在重启。') }
  signal?.addEventListener('abort', stop, { once: true })
  const timer = setTimeout(stop, deadlineMs)
  timer.unref()
  try { return await readJsonBody(req, maxBytes) }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', stop) }
}
