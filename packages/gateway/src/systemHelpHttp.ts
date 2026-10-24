/** Loopback-only model-facing surface. It accepts no approval or execution command. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SystemHelpRelayError, type SystemHelpRelay } from './systemHelpRelay.js'
function json(res: ServerResponse, code: number, body: unknown): void {
  if (res.destroyed) return
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}
export async function handleSystemHelpLocal(req: IncomingMessage, res: ServerResponse, relay: SystemHelpRelay | undefined): Promise<void> {
  const peer = req.socket.remoteAddress
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer ?? '') || req.headers.origin !== undefined) {
    json(res, 403, { error: { code: 'FORBIDDEN', message: '系统帮助仅供当前回合使用。' } }); return
  }
  if (!relay) { json(res, 503, { error: { code: 'UNAVAILABLE', message: '当前运行环境尚未支持系统操作。' } }); return }
  if (req.method !== 'POST' || req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    json(res, 400, { error: { code: 'INVALID_INPUT', message: '无效的系统帮助请求。' } }); return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const chunks: Buffer[] = []; let size = 0
    timer = setTimeout(() => req.destroy(), 5000); timer.unref()
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += bytes.byteLength
      if (size > 4 * 1024 * 1024) throw new SystemHelpRelayError('INVALID_INPUT')
      chunks.push(bytes)
    }
    clearTimeout(timer)
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new SystemHelpRelayError('INVALID_INPUT') }
    const result = await relay.request(body)
    json(res, 200, result)
  } catch (e) {
    const code = e instanceof SystemHelpRelayError ? e.code : 'UNAVAILABLE'
    json(res, code === 'INVALID_INPUT' ? 400 : code === 'INVALID_CONTEXT' ? 403 : 503,
      { error: { code, message: '系统帮助未完成；可重新读取状态或重新生成提议。' } })
  } finally { if (timer) clearTimeout(timer) }
}
