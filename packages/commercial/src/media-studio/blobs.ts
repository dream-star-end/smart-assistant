/**
 * Content-addressed blob store with per-user and site quota (OCV5-591 A1; plan §6).
 *
 * Layout under OC_STUDIO_ROOT:
 *   blobs/<aa>/<bb>/<sha256>   0640, written to tmp/ first and renamed (atomic)
 *   tmp/<uuid>                 in-flight writes
 *
 * Physical files belong to nobody; studio_blob_refs says who may read them. Every read goes
 * through a ref of the reading user.
 *
 * Quota, per write:
 *   1. hold    — one transaction locks the 'site' and 'u:<id>' rows (in that order) and admits
 *                `maxBytes` only if used + live holds + maxBytes fits both limits and the disk keeps
 *                its 2 GB floor after every live hold lands. The hold row expires (default 30 min),
 *                so a writer that dies never leaks reservation.
 *   2. write   — streamed to tmp/ while hashing and counting; more than `maxBytes` aborts.
 *   3. settle  — under a per-sha advisory lock and the quota row locks: a hold that expired during
 *                the write is re-admitted against current usage (or refused); then the file is renamed
 *                into place if absent, the blob
 *                row inserted if new ('site' used += bytes only then), the ref inserted and, when
 *                this is the user's first ref to the sha, 'u:<id>' used += bytes (even if other
 *                users already hold the same content). The hold is deleted in the same transaction.
 *
 * Release: dropRefs() removes refs and, when the user no longer references a sha, gives its bytes
 * back. gc() deletes unreferenced blobs (row and file, under the same per-sha lock as settle, so a
 * concurrent put of the same content can never lose its file) and expired holds.
 *
 * Known gap: if the settle transaction rolls back after the rename, the file stays without a row.
 * The next put of the same content adopts it; otherwise it is a small leak outside the quota.
 */
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { access, mkdir, rename, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Pool, PoolClient } from 'pg'

import { removePreviews } from './preview.js'

export const STUDIO_USER_LIMIT_BYTES = 5n * 1024n ** 3n
export const STUDIO_SITE_LIMIT_BYTES = 15n * 1024n ** 3n
export const STUDIO_DISK_FLOOR_BYTES = 2n * 1024n ** 3n
const HOLD_TTL_SECONDS = 30 * 60
const UNREFERENCED_GRACE_SECONDS = 60 * 60

export type BlobRefKind = 'take' | 'asset' | 'annotation' | 'upload' | 'final'

export class StudioQuotaError extends Error {
  readonly code = 'STUDIO_QUOTA'
  constructor(readonly scope: 'user' | 'site' | 'disk') {
    super(`media studio storage quota exceeded (${scope})`)
    this.name = 'StudioQuotaError'
  }
}

export class StudioBlobTooLargeError extends Error {
  readonly code = 'STUDIO_BLOB_TOO_LARGE'
  constructor() {
    super('blob exceeds its declared size')
    this.name = 'StudioBlobTooLargeError'
  }
}

export interface StudioBlobStoreOptions {
  pool: Pool
  root: string
  userLimitBytes?: bigint
  siteLimitBytes?: bigint
  diskFloorBytes?: bigint
  holdTtlSeconds?: number
  /** Test seam; defaults to statfs(root). */
  freeBytes?: (root: string) => Promise<bigint>
}

export interface PutBlobArgs {
  userId: bigint
  mime: string
  /** Upper bound of the content size; the hold is taken for this many bytes. */
  maxBytes: number
  source: Buffer | AsyncIterable<Uint8Array>
  ref: { kind: BlobRefKind; id: string }
}

export interface StoredBlob {
  sha: string
  bytes: number
  mime: string
  /** true when this put made the user's first reference to the content. */
  newForUser: boolean
}

const SHA_RE = /^[0-9a-f]{64}$/
const MIME_RE = /^[a-z]+\/[a-z0-9.+-]{1,64}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function userScope(userId: bigint): string {
  return `u:${userId.toString()}`
}

async function inTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/**
 * Site-owned content with no user ref (OCV5-591 M1, 0329): the curated music catalog's audio and
 * the snapshots that prove its licences. The GC never collects it while a catalog row points at it.
 */
const CATALOG_HOLDS =
  'SELECT 1 FROM studio_music_catalog c WHERE c.blob_sha=b.sha256 OR c.evidence_sha=b.sha256'

export class StudioBlobStore {
  private readonly userLimit: bigint
  private readonly siteLimit: bigint
  private readonly diskFloor: bigint
  private readonly holdTtl: number
  private readonly freeBytes: (root: string) => Promise<bigint>

  constructor(private readonly opts: StudioBlobStoreOptions) {
    this.userLimit = opts.userLimitBytes ?? STUDIO_USER_LIMIT_BYTES
    this.siteLimit = opts.siteLimitBytes ?? STUDIO_SITE_LIMIT_BYTES
    this.diskFloor = opts.diskFloorBytes ?? STUDIO_DISK_FLOOR_BYTES
    this.holdTtl = opts.holdTtlSeconds ?? HOLD_TTL_SECONDS
    this.freeBytes =
      opts.freeBytes ??
      (async (root) => {
        const st = await statfs(root)
        return BigInt(st.bavail) * BigInt(st.bsize)
      })
  }

  /** The store's directory (previews are kept under it, beside the blobs). */
  get root(): string {
    return this.opts.root
  }

  blobPath(sha: string): string {
    if (!SHA_RE.test(sha)) throw new Error('invalid blob sha')
    return join(this.opts.root, 'blobs', sha.slice(0, 2), sha.slice(2, 4), sha)
  }

  /** Admits `bytes` against both quotas and the disk floor; returns the hold id. */
  async hold(userId: bigint, bytes: number): Promise<string> {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('hold size must be positive')
    const need = BigInt(bytes)
    const id = randomUUID()
    await inTx(this.opts.pool, async (client) => {
      await client.query(
        `INSERT INTO studio_quota(scope, limit_bytes) VALUES ('site', $1), ($2, $3)
         ON CONFLICT (scope) DO NOTHING`,
        [this.siteLimit.toString(), userScope(userId), this.userLimit.toString()],
      )
      // Fixed lock order (site, then user) keeps concurrent writers deadlock-free.
      const site = await client.query<{ used: string; lim: string }>(
        `SELECT used_bytes::text AS used, limit_bytes::text AS lim FROM studio_quota
         WHERE scope='site' FOR UPDATE`,
      )
      const user = await client.query<{ used: string; lim: string }>(
        `SELECT used_bytes::text AS used, limit_bytes::text AS lim FROM studio_quota
         WHERE scope=$1 FOR UPDATE`,
        [userScope(userId)],
      )
      const held = await client.query<{ site: string; mine: string }>(
        `SELECT COALESCE(SUM(bytes),0)::text AS site,
                COALESCE(SUM(bytes) FILTER (WHERE user_id=$1),0)::text AS mine
         FROM studio_quota_holds WHERE expires_at > clock_timestamp()`,
        [userId.toString()],
      )
      // Sampled under the site lock (Codex Sol r1 P1): a sample taken earlier misses bytes another
      // writer settled (and whose hold it dropped) while we waited, so it could admit past the floor.
      const free = await this.freeBytes(this.opts.root)
      const siteHeld = BigInt(held.rows[0]!.site)
      const userHeld = BigInt(held.rows[0]!.mine)
      if (BigInt(user.rows[0]!.used) + userHeld + need > BigInt(user.rows[0]!.lim))
        throw new StudioQuotaError('user')
      if (BigInt(site.rows[0]!.used) + siteHeld + need > BigInt(site.rows[0]!.lim))
        throw new StudioQuotaError('site')
      if (free - siteHeld - need < this.diskFloor) throw new StudioQuotaError('disk')
      await client.query(
        `INSERT INTO studio_quota_holds(id, user_id, bytes, expires_at)
         VALUES ($1, $2, $3, clock_timestamp() + make_interval(secs => $4))`,
        [id, userId.toString(), need.toString(), this.holdTtl],
      )
    })
    return id
  }

  async releaseHold(holdId: string): Promise<void> {
    await this.opts.pool.query('DELETE FROM studio_quota_holds WHERE id=$1', [holdId])
  }

  async put(args: PutBlobArgs): Promise<StoredBlob> {
    if (!MIME_RE.test(args.mime)) throw new Error('invalid blob mime')
    if (!UUID_RE.test(args.ref.id)) throw new Error('invalid blob ref id')
    const holdId = await this.hold(args.userId, args.maxBytes)
    const tmpDir = join(this.opts.root, 'tmp')
    const tmp = join(tmpDir, randomUUID())
    try {
      await mkdir(tmpDir, { recursive: true, mode: 0o750 })
      const hash = createHash('sha256')
      let bytes = 0
      const limit = args.maxBytes
      const source = Buffer.isBuffer(args.source) ? [args.source] : args.source
      await pipeline(
        async function* () {
          for await (const chunk of source) {
            bytes += chunk.byteLength
            if (bytes > limit) throw new StudioBlobTooLargeError()
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(tmp, { mode: 0o640, flags: 'wx' }),
      )
      const sha = hash.digest('hex')
      const finalPath = this.blobPath(sha)
      const newForUser = await inTx(this.opts.pool, async (client) => {
        // Lock order everywhere: sha advisory lock, then 'site', then 'u:<id>'.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-blob:${sha}`])
        const quotaRows = await client.query<{ scope: string; used: string; lim: string }>(
          `SELECT scope, used_bytes::text AS used, limit_bytes::text AS lim FROM studio_quota
           WHERE scope IN ('site', $1) ORDER BY scope='site' DESC FOR UPDATE`,
          [userScope(args.userId)],
        )
        const physicalNew =
          (await client.query('SELECT 1 FROM studio_blobs WHERE sha256=$1', [sha])).rowCount === 0
        const first =
          (
            await client.query(
              'SELECT 1 FROM studio_blob_refs WHERE user_id=$1 AND sha256=$2 LIMIT 1',
              [args.userId.toString(), sha],
            )
          ).rowCount === 0
        // clock_timestamp(), not NOW(): NOW() is frozen at BEGIN, so a hold that lapsed while this
        // transaction waited on the locks above would still look live (Codex code r2 P1).
        const live = await client.query(
          'DELETE FROM studio_quota_holds WHERE id=$1 AND expires_at > clock_timestamp() RETURNING id',
          [holdId],
        )
        if (live.rowCount !== 1) {
          // The hold expired while we wrote (Codex code r1 P1): it no longer protects these bytes,
          // so admit them again against current usage and every other live hold.
          const held = await client.query<{ site: string; mine: string }>(
            `SELECT COALESCE(SUM(bytes),0)::text AS site,
                    COALESCE(SUM(bytes) FILTER (WHERE user_id=$1),0)::text AS mine
             FROM studio_quota_holds WHERE expires_at > clock_timestamp() AND id <> $2`,
            [args.userId.toString(), holdId],
          )
          const row = (scope: string) => quotaRows.rows.find((r) => r.scope === scope)!
          const fits = (scope: string, heldBytes: string, add: boolean) =>
            !add ||
            BigInt(row(scope).used) + BigInt(heldBytes) + BigInt(bytes) <= BigInt(row(scope).lim)
          if (!fits(userScope(args.userId), held.rows[0]!.mine, first))
            throw new StudioQuotaError('user')
          if (!fits('site', held.rows[0]!.site, physicalNew)) throw new StudioQuotaError('site')
          await client.query('DELETE FROM studio_quota_holds WHERE id=$1', [holdId])
        }
        if (!(await exists(finalPath))) {
          await mkdir(join(finalPath, '..'), { recursive: true, mode: 0o750 })
          await rename(tmp, finalPath)
        }
        if (physicalNew) {
          await client.query('INSERT INTO studio_blobs(sha256, bytes, mime) VALUES ($1, $2, $3)', [
            sha,
            bytes,
            args.mime,
          ])
          await client.query(
            `UPDATE studio_quota SET used_bytes = used_bytes + $1, updated_at = NOW() WHERE scope='site'`,
            [bytes],
          )
        }
        await client.query(
          `INSERT INTO studio_blob_refs(user_id, sha256, ref_kind, ref_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT DO NOTHING`,
          [args.userId.toString(), sha, args.ref.kind, args.ref.id],
        )
        if (first) {
          await client.query(
            'UPDATE studio_quota SET used_bytes = used_bytes + $1, updated_at = NOW() WHERE scope=$2',
            [bytes, userScope(args.userId)],
          )
        }
        return first
      })
      const mime = await this.opts.pool.query<{ mime: string }>(
        'SELECT mime FROM studio_blobs WHERE sha256=$1',
        [sha],
      )
      return { sha, bytes, mime: mime.rows[0]?.mime ?? args.mime, newForUser }
    } catch (err) {
      await this.releaseHold(holdId).catch(() => {})
      throw err
    } finally {
      // Gone already when it was renamed into place; otherwise a duplicate or a failed write.
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /**
   * Site-owned write for the curated music catalog (OCV5-591 M1): audio and licence snapshots that
   * belong to no user. Counted once on 'site' and checked against the disk floor; it carries no ref,
   * so the caller inserts the catalog row that holds it within UNREFERENCED_GRACE_SECONDS (an
   * offline import does both in one run). Returns the sha.
   */
  async putSite(content: Buffer, mime: string): Promise<string> {
    if (!MIME_RE.test(mime)) throw new Error('invalid blob mime')
    if (content.length === 0) throw new Error('empty blob')
    const sha = createHash('sha256').update(content).digest('hex')
    const finalPath = this.blobPath(sha)
    await inTx(this.opts.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-blob:${sha}`])
      await client.query(
        `INSERT INTO studio_quota(scope, limit_bytes) VALUES ('site', $1) ON CONFLICT (scope) DO NOTHING`,
        [this.siteLimit.toString()],
      )
      const site = await client.query<{ used: string; lim: string }>(
        `SELECT used_bytes::text AS used, limit_bytes::text AS lim FROM studio_quota
         WHERE scope='site' FOR UPDATE`,
      )
      const physicalNew =
        (await client.query('SELECT 1 FROM studio_blobs WHERE sha256=$1', [sha])).rowCount === 0
      if (!physicalNew) {
        // Re-imported content may be an orphan from an earlier run: restart its grace period under
        // the sha lock, so the GC (which re-checks the age under the same lock) cannot take it
        // before the caller's catalog row holds it.
        await client.query('UPDATE studio_blobs SET created_at = NOW() WHERE sha256=$1', [sha])
      }
      if (physicalNew) {
        const held = await client.query<{ n: string }>(
          'SELECT COALESCE(SUM(bytes),0)::text AS n FROM studio_quota_holds WHERE expires_at > clock_timestamp()',
        )
        const need = BigInt(content.length)
        if (BigInt(site.rows[0]!.used) + BigInt(held.rows[0]!.n) + need > BigInt(site.rows[0]!.lim))
          throw new StudioQuotaError('site')
        if (
          (await this.freeBytes(this.opts.root)) - BigInt(held.rows[0]!.n) - need <
          this.diskFloor
        )
          throw new StudioQuotaError('disk')
      }
      if (!(await exists(finalPath))) {
        const tmpDir = join(this.opts.root, 'tmp')
        const tmp = join(tmpDir, randomUUID())
        await mkdir(tmpDir, { recursive: true, mode: 0o750 })
        await writeFile(tmp, content, { mode: 0o640, flag: 'wx' })
        await mkdir(join(finalPath, '..'), { recursive: true, mode: 0o750 })
        await rename(tmp, finalPath)
      }
      if (physicalNew) {
        await client.query('INSERT INTO studio_blobs(sha256, bytes, mime) VALUES ($1, $2, $3)', [
          sha,
          content.length,
          mime,
        ])
        await client.query(
          `UPDATE studio_quota SET used_bytes = used_bytes + $1, updated_at = NOW() WHERE scope='site'`,
          [content.length],
        )
      }
    })
    return sha
  }

  /** Adds a ref to content the user already references (e.g. a take adopted as an asset). */
  async addRef(
    userId: bigint,
    sha: string,
    ref: { kind: BlobRefKind; id: string },
  ): Promise<boolean> {
    if (!SHA_RE.test(sha) || !UUID_RE.test(ref.id)) throw new Error('invalid blob ref')
    return inTx(this.opts.pool, async (client) => {
      // Same user-row lock as dropRefs: the existing ref cannot be released between the check and
      // the insert, so the user's usage never drops to 0 while a ref survives (Codex code r1 P1).
      await client.query('SELECT 1 FROM studio_quota WHERE scope=$1 FOR UPDATE', [
        userScope(userId),
      ])
      const r = await client.query(
        `INSERT INTO studio_blob_refs(user_id, sha256, ref_kind, ref_id)
         SELECT $1, $2, $3, $4
         WHERE EXISTS (SELECT 1 FROM studio_blob_refs WHERE user_id=$1 AND sha256=$2)
         ON CONFLICT DO NOTHING`,
        [userId.toString(), sha, ref.kind, ref.id],
      )
      return r.rowCount === 1
    })
  }

  /** The caller's transaction when given, else one of our own. */
  private inOwnOr<T>(
    db: PoolClient | undefined,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return db ? fn(db) : inTx(this.opts.pool, fn)
  }

  /** Like dropRefs, but keeps the refs to `keep` (a re-used take keeps only what it publishes). */
  async dropRefsExcept(
    userId: bigint,
    ref: { kind: BlobRefKind; id: string },
    keep: string[],
    /** Run inside this transaction (atomic with the caller's own writes, A2-1c code r2 P1). */
    db?: PoolClient,
  ): Promise<number> {
    return this.inOwnOr(db, async (client) => {
      await client.query('SELECT 1 FROM studio_quota WHERE scope=$1 FOR UPDATE', [
        userScope(userId),
      ])
      const dropped = await client.query<{ sha256: string }>(
        `DELETE FROM studio_blob_refs WHERE user_id=$1 AND ref_kind=$2 AND ref_id=$3 AND sha256 <> ALL($4::text[])
         RETURNING sha256`,
        [userId.toString(), ref.kind, ref.id, keep],
      )
      const shas = [...new Set(dropped.rows.map((row) => row.sha256))]
      if (shas.length === 0) return 0
      const released = await client.query<{ bytes: string }>(
        `SELECT COALESCE(SUM(b.bytes),0)::text AS bytes FROM studio_blobs b
         WHERE b.sha256 = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM studio_blob_refs r WHERE r.user_id=$1 AND r.sha256=b.sha256)`,
        [userId.toString(), shas],
      )
      await client.query(
        `UPDATE studio_quota SET used_bytes = GREATEST(0, used_bytes - $1), updated_at = NOW()
         WHERE scope=$2`,
        [released.rows[0]!.bytes, userScope(userId)],
      )
      return dropped.rowCount ?? 0
    })
  }

  /** Removes the user's refs held by one object; gives back bytes of shas the user no longer references. */
  async dropRefs(
    userId: bigint,
    ref: { kind: BlobRefKind; id: string },
    db?: PoolClient,
  ): Promise<number> {
    return this.inOwnOr(db, async (client) => {
      await client.query('SELECT 1 FROM studio_quota WHERE scope=$1 FOR UPDATE', [
        userScope(userId),
      ])
      const dropped = await client.query<{ sha256: string }>(
        `DELETE FROM studio_blob_refs WHERE user_id=$1 AND ref_kind=$2 AND ref_id=$3
         RETURNING sha256`,
        [userId.toString(), ref.kind, ref.id],
      )
      const shas = [...new Set(dropped.rows.map((row) => row.sha256))]
      if (shas.length === 0) return 0
      const released = await client.query<{ bytes: string }>(
        `SELECT COALESCE(SUM(b.bytes),0)::text AS bytes FROM studio_blobs b
         WHERE b.sha256 = ANY($2::text[])
           AND NOT EXISTS (SELECT 1 FROM studio_blob_refs r WHERE r.user_id=$1 AND r.sha256=b.sha256)`,
        [userId.toString(), shas],
      )
      await client.query(
        `UPDATE studio_quota SET used_bytes = GREATEST(0, used_bytes - $1), updated_at = NOW()
         WHERE scope=$2`,
        [released.rows[0]!.bytes, userScope(userId)],
      )
      return dropped.rowCount ?? 0
    })
  }

  /** Resolves a blob the user references; null when the user has no ref (or it does not exist). */
  async open(
    userId: bigint,
    sha: string,
  ): Promise<{ path: string; bytes: number; mime: string; sha: string } | null> {
    if (!SHA_RE.test(sha)) return null
    const r = await this.opts.pool.query<{ bytes: string; mime: string }>(
      `SELECT b.bytes::text AS bytes, b.mime FROM studio_blobs b
       WHERE b.sha256=$2 AND EXISTS (SELECT 1 FROM studio_blob_refs r WHERE r.user_id=$1 AND r.sha256=$2)`,
      [userId.toString(), sha],
    )
    const row = r.rows[0]
    if (!row) return null
    return { path: this.blobPath(sha), bytes: Number(row.bytes), mime: row.mime, sha }
  }

  /**
   * Catalog audio (site-owned, OCV5-591 M1): resolves only a sha an *active* catalog row plays, so
   * any studio user may preview it; retired tracks and licence snapshots are never served this way.
   */
  async openCatalog(
    sha: string,
  ): Promise<{ path: string; bytes: number; mime: string; sha: string } | null> {
    if (!SHA_RE.test(sha)) return null
    const r = await this.opts.pool.query<{ bytes: string; mime: string }>(
      `SELECT b.bytes::text AS bytes, b.mime FROM studio_blobs b
       WHERE b.sha256=$1 AND EXISTS (SELECT 1 FROM studio_music_catalog c WHERE c.blob_sha=$1 AND c.active)`,
      [sha],
    )
    const row = r.rows[0]
    if (!row) return null
    return { path: this.blobPath(sha), bytes: Number(row.bytes), mime: row.mime, sha }
  }

  /** Deletes unreferenced blobs (row + file) and expired holds. Returns blobs removed. */
  async gc(batch = 200): Promise<number> {
    await this.opts.pool.query('DELETE FROM studio_quota_holds WHERE expires_at <= NOW()')
    const candidates = await this.opts.pool.query<{ sha256: string }>(
      `SELECT b.sha256 FROM studio_blobs b
       WHERE b.created_at < NOW() - make_interval(secs => $1)
         AND NOT EXISTS (SELECT 1 FROM studio_blob_refs r WHERE r.sha256=b.sha256)
         AND NOT EXISTS (${CATALOG_HOLDS})
       LIMIT $2`,
      [UNREFERENCED_GRACE_SECONDS, Math.max(1, Math.min(5000, Math.trunc(batch)))],
    )
    let removed = 0
    for (const { sha256: sha } of candidates.rows) {
      const gone = await inTx(this.opts.pool, async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`studio-blob:${sha}`])
        const del = await client.query<{ bytes: string }>(
          `DELETE FROM studio_blobs b WHERE b.sha256=$1
             AND b.created_at < NOW() - make_interval(secs => $2)
             AND NOT EXISTS (SELECT 1 FROM studio_blob_refs r WHERE r.sha256=b.sha256)
             AND NOT EXISTS (${CATALOG_HOLDS})
           RETURNING bytes::text AS bytes`,
          [sha, UNREFERENCED_GRACE_SECONDS],
        )
        if (del.rowCount !== 1) return false
        await client.query(
          `UPDATE studio_quota SET used_bytes = GREATEST(0, used_bytes - $1), updated_at = NOW()
           WHERE scope='site'`,
          [del.rows[0]!.bytes],
        )
        // Unlinked while the sha lock is held: a concurrent put of the same content waits for it
        // and then finds the file missing, so it renames its own copy into place.
        await rm(this.blobPath(sha), { force: true })
        await removePreviews(this.opts.root, sha).catch(() => {})
        return true
      })
      if (gone) removed++
    }
    return removed
  }
}
