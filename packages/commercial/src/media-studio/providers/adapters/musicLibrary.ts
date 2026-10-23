// OCV5-591 M1 — music sources under the shared provider interface (user decision 2026-10-23 14:11,
// MUSIC-PLAN): the curated royalty-free catalog (0325, every track hand-verified) and the user's own
// tracks. Both answer search() and run `music.fetch`, which turns a chosen track into a music take:
// the audio becomes the user's blob (ref on the take) and the licence snapshot rides in the take's
// meta. Neither charges anything. AI generation stays an empty `music.generate` slot.

import type { Pool } from 'pg'

import type { AdapterFactory } from '../registry.js'
import {
  MediaProviderError,
  type ModelInfo,
  type MusicQuery,
  type MusicSearchResult,
  type MusicTrack,
} from '../types.js'
import type { BuiltinAdapterDeps } from './deps.js'

const PAGE_MAX = 50
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** LIKE pattern for a user's words: wildcards in the words match themselves. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

/** Offset cursors: catalog pages are small and ordered by (title, id), so this stays exact. */
function cursorOffset(cursor: string | undefined): number {
  if (!cursor) return 0
  const n = Number.parseInt(Buffer.from(cursor, 'base64url').toString('utf8'), 10)
  return Number.isSafeInteger(n) && n >= 0 && n <= 10_000 ? n : 0
}
const nextCursor = (offset: number, got: number, limit: number) =>
  got > limit ? Buffer.from(String(offset + limit), 'utf8').toString('base64url') : null

interface Filters {
  where: string[]
  args: unknown[]
}

/** The shared filter set (catalog columns and user-track columns use the same names). */
function filters(q: MusicQuery, f: Filters, tagged: boolean): void {
  const add = (sql: (n: number) => string, v: unknown) => {
    f.args.push(v)
    f.where.push(sql(f.args.length))
  }
  if (q.text?.trim()) {
    const words = q.text.trim().slice(0, 100)
    add(
      (n) =>
        tagged
          ? `(title ILIKE $${n} ESCAPE '\\' OR artist ILIKE $${n} ESCAPE '\\' OR EXISTS (SELECT 1 FROM unnest(moods || genres) t WHERE t ILIKE $${n} ESCAPE '\\'))`
          : `title ILIKE $${n} ESCAPE '\\'`,
      likePattern(words),
    )
  }
  if (tagged && q.moods?.length) add((n) => `moods && $${n}::text[]`, q.moods.slice(0, 12))
  if (tagged && q.genres?.length) add((n) => `genres && $${n}::text[]`, q.genres.slice(0, 12))
  if (q.bpmMin !== undefined) add((n) => `bpm >= $${n}`, q.bpmMin)
  if (q.bpmMax !== undefined) add((n) => `bpm <= $${n}`, q.bpmMax)
  if (q.minSec !== undefined) add((n) => `duration_ms >= $${n}`, Math.round(q.minSec * 1000))
  if (q.maxSec !== undefined) add((n) => `duration_ms <= $${n}`, Math.round(q.maxSec * 1000))
  if (tagged && q.vocals !== undefined) add((n) => `vocals = $${n}`, q.vocals)
}

interface CatalogRow {
  id: string
  title: string
  artist: string
  source: string
  landing_url: string
  license: MusicTrack['license']
  license_url: string
  attribution_required: boolean
  attribution_text: string
  duration_ms: number
  bpm: string | null
  moods: string[]
  genres: string[]
  vocals: boolean
  blob_sha: string
  mime: string
  evidence: { metadataConfidence?: { bpm?: string; moods?: string } }
  verified_at: Date
}

const CATALOG_COLUMNS = `id::text AS id, title, artist, source, landing_url, license, license_url,
  attribution_required, attribution_text, duration_ms, bpm::text AS bpm, moods, genres, vocals,
  blob_sha, mime, evidence, verified_at`

function catalogTrack(r: CatalogRow): MusicTrack {
  const conf = r.evidence?.metadataConfidence ?? {}
  return {
    id: r.id,
    title: r.title,
    artist: r.artist,
    durationMs: r.duration_ms,
    bpm: r.bpm === null ? null : Number(r.bpm),
    moods: r.moods,
    genres: r.genres,
    vocals: r.vocals,
    license: r.license,
    licenseUrl: r.license_url,
    attributionRequired: r.attribution_required,
    attributionText: r.attribution_text,
    landingUrl: r.landing_url,
    origin: r.source,
    previewSha: r.blob_sha,
    // Openverse-supplement tracks carry no measured BPM and moods we guessed without listening;
    // the UI says so instead of presenting them as facts (steward 2026-10-23).
    metadata: {
      bpm: conf.bpm === 'unknown' || r.bpm === null ? 'unknown' : 'source',
      moods: conf.moods === 'guessed' ? 'guessed' : 'source',
    },
  }
}

function licenseSnapshot(r: CatalogRow) {
  return {
    source: 'curated-catalog',
    catalogId: r.id,
    origin: r.source,
    title: r.title,
    artist: r.artist,
    license: r.license,
    licenseUrl: r.license_url,
    attributionRequired: r.attribution_required,
    attributionText: r.attribution_text,
    landingUrl: r.landing_url,
    verifiedAt: r.verified_at.toISOString(),
    verifiedBy: 'catalog',
    commercialOk: true,
  }
}

const FETCH_MODEL: ModelInfo[] = [
  { id: 'select', label: '选用曲目', ops: ['music.fetch'], isDefault: true },
]

export const curatedCatalogAdapter: AdapterFactory<BuiltinAdapterDeps> = {
  adapter: 'curated-catalog',
  kind: 'music',
  label: '免版权曲库',
  models: () => FETCH_MODEL,
  defaultKey: () => undefined,
  create({ deps }) {
    const music = deps.music
    const pool = (): Pool => {
      if (!music) throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'catalog is off')
      return music.pool
    }
    return {
      status: () => (music ? null : { state: 'disabled', reason: 'FEATURE_OFF' }),
      estimateMaxCost: () => 0n,
      chargedFor: async () => 0n,
      async search(_user, q): Promise<MusicSearchResult> {
        const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit ?? 20)))
        const offset = cursorOffset(q.cursor)
        const f: Filters = { where: ['active'], args: [] }
        filters(q, f, true)
        f.args.push(limit + 1, offset)
        const r = await pool().query<CatalogRow>(
          `SELECT ${CATALOG_COLUMNS} FROM studio_music_catalog WHERE ${f.where.join(' AND ')}
            ORDER BY title, id LIMIT $${f.args.length - 1} OFFSET $${f.args.length}`,
          f.args,
        )
        return {
          tracks: r.rows.slice(0, limit).map(catalogTrack),
          next: nextCursor(offset, r.rows.length, limit),
        }
      },
      async run(_ctx, req) {
        if (!req.trackId || !UUID_RE.test(req.trackId))
          throw new MediaProviderError('BAD_REQUEST', false, 'trackId is required')
        const r = await pool().query<CatalogRow>(
          `SELECT ${CATALOG_COLUMNS} FROM studio_music_catalog WHERE id = $1 AND active`,
          [req.trackId],
        )
        const row = r.rows[0]
        if (!row)
          throw new MediaProviderError('TRACK_UNAVAILABLE', false, 'track is not in the catalog')
        const bytes = await music!.readCatalog(row.blob_sha)
        if (!bytes)
          throw new MediaProviderError('TRACK_UNAVAILABLE', false, 'track audio is missing')
        return {
          outputs: [{ bytes, mime: row.mime, durationMs: row.duration_ms }],
          model: 'select',
          costCredits: 0n,
          charged: false,
          providerRef: { table: 'studio_music_catalog', id: row.id },
          meta: { license: licenseSnapshot(row), track: catalogTrack(row) },
        }
      },
    }
  },
}

interface TrackRow {
  id: string
  title: string
  blob_sha: string
  mime: string
  duration_ms: number | null
  bpm: string | null
  rights_statement: Record<string, unknown>
}

function userTrack(r: TrackRow): MusicTrack {
  return {
    id: r.id,
    title: r.title,
    artist: '',
    durationMs: r.duration_ms,
    bpm: r.bpm === null ? null : Number(r.bpm),
    moods: [],
    genres: [],
    vocals: false,
    license: 'USER-STATEMENT',
    licenseUrl: null,
    attributionRequired: false,
    attributionText: '',
    landingUrl: null,
    origin: 'user-upload',
    previewSha: r.blob_sha,
    metadata: { bpm: r.bpm === null ? 'unknown' : 'measured', moods: 'unknown' },
  }
}

export const userLibraryAdapter: AdapterFactory<BuiltinAdapterDeps> = {
  adapter: 'user-library',
  kind: 'music',
  label: '我的音乐',
  models: () => FETCH_MODEL,
  defaultKey: () => undefined,
  create({ deps }) {
    const music = deps.music
    const pool = (): Pool => {
      if (!music)
        throw new MediaProviderError('PROVIDER_UNAVAILABLE', false, 'music library is off')
      return music.pool
    }
    const COLS =
      'id::text AS id, title, blob_sha, mime, duration_ms, bpm::text AS bpm, rights_statement'
    return {
      status: () => (music ? null : { state: 'disabled', reason: 'FEATURE_OFF' }),
      estimateMaxCost: () => 0n,
      chargedFor: async () => 0n,
      async search(user, q): Promise<MusicSearchResult> {
        const limit = Math.max(1, Math.min(PAGE_MAX, Math.trunc(q.limit ?? 20)))
        const offset = cursorOffset(q.cursor)
        const f: Filters = { where: ['user_id = $1', 'deleted_at IS NULL'], args: [user.id] }
        filters(q, f, false)
        f.args.push(limit + 1, offset)
        const r = await pool().query<TrackRow>(
          `SELECT ${COLS} FROM studio_user_tracks WHERE ${f.where.join(' AND ')}
            ORDER BY created_at DESC, id LIMIT $${f.args.length - 1} OFFSET $${f.args.length}`,
          f.args,
        )
        return {
          tracks: r.rows.slice(0, limit).map(userTrack),
          next: nextCursor(offset, r.rows.length, limit),
        }
      },
      async run(ctx, req) {
        if (!req.trackId || !UUID_RE.test(req.trackId))
          throw new MediaProviderError('BAD_REQUEST', false, 'trackId is required')
        const r = await pool().query<TrackRow>(
          `SELECT ${COLS} FROM studio_user_tracks WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`,
          [req.trackId, ctx.userId.toString()],
        )
        const row = r.rows[0]
        if (!row)
          throw new MediaProviderError('TRACK_UNAVAILABLE', false, 'track is not in your library')
        // The user's own blob: readInput refuses content the user holds no ref to.
        const bytes = await ctx.readInput(row.blob_sha)
        return {
          outputs: [
            { bytes, mime: row.mime, ...(row.duration_ms ? { durationMs: row.duration_ms } : {}) },
          ],
          model: 'select',
          costCredits: 0n,
          charged: false,
          providerRef: { table: 'studio_user_tracks', id: row.id },
          meta: {
            license: {
              source: 'user-upload',
              trackId: row.id,
              title: row.title,
              rightsStatement: row.rights_statement,
              verifiedBy: 'user-upload',
              attributionRequired: false,
            },
            track: userTrack(row),
          },
        }
      },
    }
  },
}
