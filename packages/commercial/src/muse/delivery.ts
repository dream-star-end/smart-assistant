// Retryable terminal outbox. A deterministic message id makes a lost append ACK harmless.
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Pool } from 'pg'
import type { UserMediaLocation } from '../agent-sandbox/userMedia.js'
import type { MuseDurableState } from './durable.js'
import { MIME_EXT } from './protocol.js'

export interface MuseDeliveryDeps {
  originActive(sessionId: string, userId: string): Promise<boolean>
  append: typeof import('@openclaude/storage').appendServerAuthoredMessage
  resolveMedia(userId: string): Promise<UserMediaLocation>
  pushRemote?(args: { hostUuid: string; remotePath: string; content: Buffer }): Promise<void>
  broadcast?(userId: bigint, frame: Record<string, unknown>): void
}

export function createMuseDelivery(
  pool: Pool,
  root: string,
  deps: MuseDeliveryDeps,
): () => Promise<void> {
  return async () => {
    // Claim a short retry window, not execution ownership. Concurrent drains may repeat filesystem
    // publication, but appendServerAuthoredMessage dedupes both hot and archived message ids.
    const r = await pool.query<{
      id: string
      user_id: string
      status: string
      error_code: string | null
      durable: MuseDurableState
      finished_at: Date
      files: Array<{ mime: string; bytes: number; sha256: string }> | null
    }>(`WITH due AS (
      SELECT id FROM muse_media_jobs WHERE durable IS NOT NULL AND delivered_at IS NULL
        AND status IN ('succeeded','failed','cancelled') AND delivery_next_at<=NOW()
      ORDER BY delivery_next_at FOR UPDATE SKIP LOCKED LIMIT 10
    ) UPDATE muse_media_jobs j SET delivery_next_at=NOW()+INTERVAL '40 seconds',
        delivery_attempts=delivery_attempts+1 FROM due WHERE j.id=due.id
      RETURNING j.id,j.user_id::text,j.status,j.error_code,j.durable,j.finished_at,j.files`)
    for (const row of r.rows) {
      try {
        const owner = `c:${row.user_id}`
        if (!(await deps.originActive(row.durable.sessionId, owner))) {
          // Never redirect a deleted origin to another conversation.
          await pool.query('UPDATE muse_media_jobs SET delivered_at=NOW() WHERE id=$1', [row.id])
          continue
        }
        let text: string
        if (row.status === 'succeeded') {
          const location = await deps.resolveMedia(owner)
          const paths: string[] = []
          if (location.kind === 'fail' && location.reason === 'remote-host') {
            if (!deps.pushRemote) throw new Error('MUSE_REMOTE_DELIVERY_PENDING')
            for (const [i, file] of (row.files ?? []).entries()) {
              const ext = MIME_EXT[file.mime]
              if (!ext) throw new Error('MUSE_BAD_STORED_MIME')
              const content = await readFile(join(root, row.id, row.durable.nonce, `${i}.bin`))
              if (
                content.length !== file.bytes ||
                createHash('sha256').update(content).digest('hex') !== file.sha256
              )
                throw new Error('MUSE_RESULT_CORRUPT')
              const name = `muse-${row.id}-${i}.${ext}`
              await deps.pushRemote({
                hostUuid: location.hostUuid,
                remotePath: join(location.generated, name),
                content,
              })
              paths.push(`/home/agent/.openclaude/generated/${name}`)
            }
          } else {
            if (location.kind !== 'ok') throw new Error('MUSE_MEDIA_LOCATION_PENDING')
            await mkdir(location.generated, { recursive: true })
            // The parent is user writable; reject a symlink out of the resolved user's volume.
            const dir = await open(
              location.generated,
              constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
            )
            const anchored = `/proc/self/fd/${dir.fd}`
            try {
              for (const [i, file] of (row.files ?? []).entries()) {
                const ext = MIME_EXT[file.mime]
                if (!ext) throw new Error('MUSE_BAD_STORED_MIME')
                const name = `muse-${row.id}-${i}.${ext}`
                const target = join(anchored, name)
                const tmp = join(anchored, `.muse-${randomUUID()}.tmp`)
                try {
                  const handle = await open(
                    tmp,
                    constants.O_WRONLY |
                      constants.O_CREAT |
                      constants.O_EXCL |
                      constants.O_NOFOLLOW,
                    0o644,
                  )
                  try {
                    const hash = createHash('sha256')
                    let bytes = 0
                    for await (const chunk of createReadStream(
                      join(root, row.id, row.durable.nonce, `${i}.bin`),
                    )) {
                      hash.update(chunk)
                      bytes += chunk.length
                      await handle.writeFile(chunk)
                    }
                    if (hash.digest('hex') !== file.sha256 || bytes !== file.bytes)
                      throw new Error('MUSE_RESULT_CORRUPT')
                    await handle.sync()
                  } finally {
                    await handle.close()
                  }
                  await rename(tmp, target) // replaces a leaf symlink; never writes through it
                } finally {
                  await rm(tmp, { force: true }).catch(() => {})
                }
                paths.push(`/home/agent/.openclaude/generated/${name}`)
              }
            } finally {
              await dir.close()
            }
          }
          if (!paths.length) throw new Error('MUSE_RESULT_MISSING')
          text = `Muse 视频已生成。\n\n${paths.join('\n\n')}`
        } else {
          text = `Muse 视频生成未完成（${row.error_code ?? row.status}），未扣取本次生成积分。`
        }
        const id = `muse-result:${row.id}`
        const message = { id, role: 'assistant' as const, text, ts: row.finished_at.getTime() }
        const appended = await deps.append(row.durable.sessionId, owner, message)
        if (
          !appended.applied &&
          !['already_exists', 'session_deleted', 'session_not_found'].includes(
            appended.reason ?? '',
          )
        ) {
          throw new Error('MUSE_MESSAGE_APPEND_PENDING')
        }
        await pool.query('UPDATE muse_media_jobs SET delivered_at=NOW() WHERE id=$1', [row.id])
        // The durable message is authoritative on reconnect; this is only the live projection.
        if (appended.applied || appended.reason === 'already_exists') {
          deps.broadcast?.(BigInt(row.user_id), {
            type: 'sys.muse_result',
            sessionId: row.durable.sessionId,
            jobId: row.id,
            ts: Date.now(),
          })
        }
      } catch {
        // Leave outbox pending. Execution/settlement are never repeated for a delivery failure.
      }
    }
  }
}
