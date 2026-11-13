import type { Pool } from 'pg'
import type { CcbTranscriptRestoreBinding } from '@openclaude/protocol'
import { readCcbNativeRestoreArchive } from './pgSessionsBackend.js'

/** Keep one read-only snapshot for the complete native continuity archive. */
export function makeCcbTranscriptRestoreReader(pool: Pool) {
  return async (owner: string, binding: CcbTranscriptRestoreBinding) => {
    const client = await pool.connect()
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
      const archive = await readCcbNativeRestoreArchive(client, owner, binding)
      await client.query('COMMIT')
      return archive
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}
