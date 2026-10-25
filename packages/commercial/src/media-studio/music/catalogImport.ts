// OCV5-591 M1 — import hand-verified tracks into the curated music catalog (0329). The manifest is
// written by the verification run (music-catalog/CHECKLIST.md): every entry names its audio file
// and the snapshot of its source page together with their SHA-256, so a file that changed after it
// was verified is refused. Audio and snapshot become site-owned blobs (putSite); the row is inserted
// once per (source, sourceTrackId) — a rerun skips what is already there.

import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import type { Pool } from 'pg'
import { z } from 'zod'

import type { StudioBlobStore } from '../blobs.js'

const https = z
  .string()
  .max(2000)
  .regex(/^https:\/\//)
const sha = z.string().regex(/^[0-9a-f]{64}$/)
const relPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) => !p.startsWith('/') && !normalize(p).startsWith('..'),
    'must stay inside the manifest dir',
  )
const tags = z.array(z.string().trim().min(1).max(20)).max(12)

export const CatalogEntrySchema = z
  .object({
    source: z.enum(['openverse', 'pixabay', 'incompetech', 'other']),
    sourceTrackId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(200),
    artist: z.string().trim().min(1).max(200),
    landingUrl: https,
    license: z.enum(['CC0-1.0', 'CC-BY-3.0', 'CC-BY-4.0', 'PIXABAY-CL']),
    licenseUrl: https,
    attributionText: z.string().max(1000).default(''),
    durationMs: z.number().int().min(1000).max(1_800_000),
    bpm: z.number().min(20).max(300).nullable().default(null),
    moods: tags.default([]),
    genres: tags.default([]),
    vocals: z.boolean().default(false),
    mime: z.enum(['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/flac']),
    audioPath: relPath,
    audioSha: sha,
    evidencePath: relPath,
    evidenceSha: sha,
    evidence: z.record(z.string(), z.unknown()).default({}),
    verifiedAt: z.string().datetime(),
    verifiedBy: z.string().trim().min(1).max(100),
  })
  .superRefine((e, ctx) => {
    const by = e.license === 'CC-BY-3.0' || e.license === 'CC-BY-4.0'
    if (by && !e.attributionText.trim())
      ctx.addIssue({
        code: 'custom',
        path: ['attributionText'],
        message: 'CC BY needs its attribution text',
      })
  })
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>

/** Parses the whole manifest; any bad entry fails it with the entry's index in the message. */
export function parseCatalogManifest(json: unknown): CatalogEntry[] {
  const list = z.array(z.unknown()).max(1000).parse(json)
  return list.map((raw, i) => {
    const r = CatalogEntrySchema.safeParse(raw)
    if (!r.success) {
      const why = r.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')
      throw new Error(`manifest entry ${i}: ${why}`)
    }
    return r.data
  })
}

export interface ImportOutcome {
  inserted: string[]
  skipped: string[]
  failed: Array<{ sourceTrackId: string; reason: string }>
}

export async function importCatalogEntries(input: {
  pool: Pool
  blobs: StudioBlobStore
  dir: string
  entries: CatalogEntry[]
  dryRun?: boolean
}): Promise<ImportOutcome> {
  const out: ImportOutcome = { inserted: [], skipped: [], failed: [] }
  const digest = (b: Buffer) => createHash('sha256').update(b).digest('hex')
  // The schema keeps paths relative; the real path (symlinks resolved) must stay inside too.
  const base = await realpath(input.dir)
  const readInside = async (rel: string) => {
    const real = await realpath(join(input.dir, rel))
    if (!real.startsWith(base + sep)) throw new Error('file is outside the manifest dir')
    return readFile(real)
  }
  for (const e of input.entries) {
    const key = `${e.source}:${e.sourceTrackId}`
    try {
      const exists = await input.pool.query(
        'SELECT 1 FROM studio_music_catalog WHERE source = $1 AND source_track_id = $2',
        [e.source, e.sourceTrackId],
      )
      if (exists.rowCount) {
        out.skipped.push(key)
        continue
      }
      const audio = await readInside(e.audioPath)
      const shot = await readInside(e.evidencePath)
      if (digest(audio) !== e.audioSha) throw new Error('audio file changed since it was verified')
      if (digest(shot) !== e.evidenceSha)
        throw new Error('evidence file changed since it was verified')
      if (input.dryRun) {
        out.inserted.push(key)
        continue
      }
      const audioSha = await input.blobs.putSite(audio, e.mime)
      const evidenceSha = await input.blobs.putSite(shot, 'image/png')
      const ins = await input.pool.query(
        `INSERT INTO studio_music_catalog(id, title, artist, source, source_track_id, landing_url, license,
           license_url, attribution_required, attribution_text, duration_ms, bpm, moods, genres, vocals,
           blob_sha, mime, evidence_sha, evidence, verified_at, verified_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb, $20, $21)
         ON CONFLICT (source, source_track_id) DO NOTHING`,
        [
          randomUUID(),
          e.title,
          e.artist,
          e.source,
          e.sourceTrackId,
          e.landingUrl,
          e.license,
          e.licenseUrl,
          e.license === 'CC-BY-3.0' || e.license === 'CC-BY-4.0',
          e.attributionText,
          e.durationMs,
          e.bpm,
          e.moods,
          e.genres,
          e.vocals,
          audioSha,
          e.mime,
          evidenceSha,
          JSON.stringify(e.evidence),
          e.verifiedAt,
          e.verifiedBy,
        ],
      )
      if (ins.rowCount) out.inserted.push(key)
      else out.skipped.push(key)
    } catch (err) {
      out.failed.push({ sourceTrackId: key, reason: (err as Error).message.slice(0, 300) })
    }
  }
  return out
}
