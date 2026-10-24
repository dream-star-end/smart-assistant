import { createServer } from 'node:http'
import { mkdtemp, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'undici'
import { pipeline } from 'node:stream/promises'
import { CCB_TRANSCRIPT_RESTORE_PATH, type CcbTranscriptRestoreBinding } from '@openclaude/protocol'
import { readV3MasterSinkConfig } from './v3MasterSink.js'

export interface CcbTranscriptRestoreSocket { socketPath: string; close(): Promise<void> }
/** One native SID per runner generation. This transport adds no credential
 * to the CLI environment, only a private, fixed-binding socket pathname. */
export async function createCcbTranscriptRestoreSocket(binding: CcbTranscriptRestoreBinding): Promise<CcbTranscriptRestoreSocket> {
  const cfg = readV3MasterSinkConfig(process.env)
  if (!cfg) throw new Error('CCB_TRANSCRIPT_RESTORE_CONFIG_UNAVAILABLE')
  const dir = await mkdtemp(join(tmpdir(), 'oc-ccb-restore-'))
  await chmod(dir, 0o700)
  const socketPath = join(dir, 'reader.sock')
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' || req.url !== '/restore') { res.writeHead(404).end(); return }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120000)
    res.once('close', () => { if (!res.writableFinished) controller.abort() })
    try {
      const query = new URLSearchParams({ ...binding })
      const upstream = await request(`${cfg.baseUrl}${CCB_TRANSCRIPT_RESTORE_PATH}?${query}`, {
        method: 'GET', headers: { authorization: `Bearer ${cfg.bearer}` }, signal: controller.signal,
      })
      res.writeHead(upstream.statusCode, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' })
      await pipeline(upstream.body, res)
    } catch { if (!res.headersSent) res.writeHead(503).end(); else res.destroy() }
    finally { clearTimeout(timer) }
  })
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(socketPath, accept) })
    await chmod(socketPath, 0o600)
  } catch (error) { server.close(); await rm(dir, { recursive: true, force: true }); throw error }
  let closed = false
  return { socketPath, async close() {
    if (closed) return; closed = true
    server.closeAllConnections()
    await new Promise<void>(accept => server.close(() => accept()))
    await rm(dir, { recursive: true, force: true })
  } }
}
