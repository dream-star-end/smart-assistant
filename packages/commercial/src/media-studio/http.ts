/**
 * Browser API for the media studio (OCV5-591 A1 skeleton; A2 adds brief/approve/annotations/takes).
 *
 *   GET    /api/studio/projects[?before=&limit=]
 *   POST   /api/studio/projects
 *   GET    /api/studio/projects/:id                  aggregate view
 *   PATCH  /api/studio/projects/:id                  {expectedRev, ...fields}
 *   DELETE /api/studio/projects/:id
 *   POST   /api/studio/projects/:id/pause|resume|cancel
 *   POST   /api/studio/projects/:id/uploads          raw body, Content-Type + Content-Length
 *   GET    /api/studio/music/search?provider=&text=&moods=&genres=&bpmMin=&bpmMax=&minSec=&maxSec=&vocals=&cursor=
 *   POST   /api/studio/music/tracks?title=&rights=own_or_licensed[&note=]   raw audio body (My Music)
 *   POST   /api/studio/projects/:id/music            {providerId, trackId} → a free music take
 *   PUT    /api/studio/projects/:id/music/edit       trim / place / loop / fades / ducking
 *   POST   /api/studio/projects/:id/export           {resolution, subtitles} → free re-compose (A2-1c)
 *   POST   /api/studio/projects/:id/annotations      {takeId, kind, tStartMs?, tEndMs?, geom?, text} → draft (A2-1b-2)
 *   PATCH  /api/studio/annotations/:id               a draft's fields;  DELETE a draft
 *   POST   /api/studio/annotations/:id/send|apply|reject
 *   POST   /api/studio/blobs/:sha/ticket             → {url, expiresInSeconds}
 *   GET    /api/studio/blobs/:sha?ticket=            Range-capable
 *
 * Everything is 404 unless OC_STUDIO_ENABLED=1 and the user is an admin or allow-listed (D13):
 * the surface does not reveal itself to anyone else.
 */
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { requireAuth } from '../http/auth.js'
import type { RequestContext } from '../http/handlers.js'
import { HttpError, readJsonBody, sendJson } from '../http/util.js'
import {
  BLOB_TICKET_TTL_SECONDS,
  type StudioAccess,
  createBlobTicket,
  sendBlobFile,
  verifyBlobTicket,
} from './access.js'
import { type StudioBlobStore, StudioBlobTooLargeError, StudioQuotaError } from './blobs.js'
import { audioDurationMs } from './music/audioLength.js'
import type { ComposeRunnerLike } from './orchestrator/compose.js'
import type { OrchestratorApi } from './orchestrator/service.js'
import type { ProviderRegistry } from './providers/registry.js'
import { MEDIA_KINDS, type MusicQuery } from './providers/types.js'
import type { StudioStore } from './store.js'

export const STUDIO_BROWSER_PREFIX = '/api/studio'
export const STUDIO_UPLOAD_MAX_BYTES = 25 * 1024 * 1024

export interface StudioHttpDeps {
  access: StudioAccess
  store: StudioStore
  blobs: StudioBlobStore
  /** OCV5-591 A2-0; absent → every media kind reads as not configured. */
  providers?: ProviderRegistry
  /** OCV5-591 A2-1; absent → start / approve / take selection answer 503. */
  orchestrator?: OrchestratorApi
  /** OCV5-591 A2-1c: the compose sandbox (OCV5-588), when OC_STUDIO_FFMPEG_IMAGE_ID is set. */
  compose?: ComposeRunnerLike
}

const UPLOAD_TYPES: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.length >= 8 && b.readUInt32BE(0) === 0x89504e47,
  'image/jpeg': (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) =>
    b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP',
  'audio/mpeg': (b) =>
    b.length >= 3 &&
    (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)),
  'audio/wav': (b) =>
    b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE',
}

const notFound = () => new HttpError(404, 'NOT_FOUND', 'not found')
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PROJECT_RE = new RegExp(
  `^/projects/(${UUID})(?:/(pause|resume|cancel|uploads|start|approve|voices|export|annotations))?$`,
)
const TAKE_SELECT_RE = new RegExp(`^/takes/(${UUID})/select$`)
const VOICE_NARRATION_RE = new RegExp(`^/assets/(${UUID})/narration$`)
const BLOB_RE = /^\/blobs\/([0-9a-f]{64})(\/ticket)?$/
const PROJECT_MUSIC_RE = new RegExp(`^/projects/(${UUID})/music(/edit)?$`)
const ANNOTATION_RE = new RegExp(`^/annotations/(${UUID})(?:/(send|apply|reject))?$`)
const MUSIC_AUDIO_TYPES = new Set(['audio/mpeg', 'audio/wav'])

/** Music search query from the URL (OCV5-591 M1); bad numbers are refused, not ignored. */
function musicQuery(params: URLSearchParams): MusicQuery {
  const n = (k: string, lo: number, hi: number) => {
    const v = params.get(k)
    if (v === null || v === '') return undefined
    const x = Number(v)
    if (!Number.isFinite(x) || x < lo || x > hi)
      throw new HttpError(400, 'BAD_REQUEST', `${k} must be ${lo}..${hi}`)
    return x
  }
  const list = (k: string) => {
    const v = params.get(k)
    return v
      ? v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s && s.length <= 20)
          .slice(0, 12)
      : undefined
  }
  const vocals = params.get('vocals')
  const text = params.get('text')?.slice(0, 100) || undefined
  const moods = list('moods')
  const genres = list('genres')
  const bpmMin = n('bpmMin', 20, 300)
  const bpmMax = n('bpmMax', 20, 300)
  const minSec = n('minSec', 0, 1800)
  const maxSec = n('maxSec', 0, 1800)
  const limit = n('limit', 1, 50)
  const cursor = params.get('cursor')?.slice(0, 32) || undefined
  return {
    ...(text ? { text } : {}),
    ...(moods ? { moods } : {}),
    ...(genres ? { genres } : {}),
    ...(bpmMin !== undefined ? { bpmMin } : {}),
    ...(bpmMax !== undefined ? { bpmMax } : {}),
    ...(minSec !== undefined ? { minSec } : {}),
    ...(maxSec !== undefined ? { maxSec } : {}),
    ...(vocals === 'true' || vocals === 'false' ? { vocals: vocals === 'true' } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  }
}

function bodyRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, 'BAD_REQUEST', 'expected a JSON object')
  return value as Record<string, unknown>
}

async function readUpload(req: IncomingMessage): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (!Number.isSafeInteger(declared) || declared <= 0)
    throw new HttpError(411, 'LENGTH_REQUIRED', 'Content-Length is required')
  if (declared > STUDIO_UPLOAD_MAX_BYTES)
    throw new HttpError(413, 'STUDIO_UPLOAD_TOO_LARGE', 'upload exceeds 25 MB')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > declared) throw new HttpError(400, 'BAD_REQUEST', 'body longer than Content-Length')
    chunks.push(buf)
  }
  if (total !== declared)
    throw new HttpError(400, 'BAD_REQUEST', 'body shorter than Content-Length')
  return Buffer.concat(chunks)
}

function mapStoreError(err: unknown): never {
  if (err instanceof StudioQuotaError)
    throw new HttpError(413, 'STUDIO_QUOTA', 'media studio storage is full')
  if (err instanceof StudioBlobTooLargeError)
    throw new HttpError(413, 'STUDIO_UPLOAD_TOO_LARGE', err.message)
  throw err
}

export async function dispatchStudioRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: { jwtSecret: string | Uint8Array; studio?: StudioHttpDeps },
): Promise<void> {
  const studio = deps.studio
  if (!studio?.access.enabled) throw notFound()
  const url = new URL(req.url ?? '/', 'http://studio.invalid')
  if (
    url.pathname !== STUDIO_BROWSER_PREFIX &&
    !url.pathname.startsWith(`${STUDIO_BROWSER_PREFIX}/`)
  )
    throw notFound()
  const path = url.pathname.slice(STUDIO_BROWSER_PREFIX.length) || '/'
  const method = req.method ?? 'GET'

  // Ticketed blob read: an <img>/<video> element sends no Authorization header.
  const blob = BLOB_RE.exec(path)
  if (blob && !blob[2] && method === 'GET') {
    const ticket = url.searchParams.get('ticket')
    if (!ticket) throw new HttpError(401, 'UNAUTHORIZED', 'blob ticket required')
    const userId = verifyBlobTicket(deps.jwtSecret, ticket, blob[1]!)
    const file =
      (await studio.blobs.open(BigInt(userId), blob[1]!)) ??
      (await studio.blobs.openCatalog(blob[1]!))
    if (!file) throw notFound()
    await sendBlobFile(req, res, file)
    return
  }

  const user = await requireAuth(req, deps.jwtSecret)
  if (!studio.access.allows(user)) throw notFound()
  const uid = user.id

  if (blob?.[2] && method === 'POST') {
    // The user's own content, or an active curated-catalog track (a preview; OCV5-591 M1).
    if (
      !(await studio.blobs.open(BigInt(uid), blob[1]!)) &&
      !(await studio.blobs.openCatalog(blob[1]!))
    )
      throw notFound()
    const ticket = createBlobTicket(deps.jwtSecret, uid, blob[1]!)
    sendJson(res, 200, {
      url: `${STUDIO_BROWSER_PREFIX}/blobs/${blob[1]}?ticket=${encodeURIComponent(ticket)}`,
      expiresInSeconds: BLOB_TICKET_TTL_SECONDS,
    })
    return
  }

  if (path === '/providers' && method === 'GET') {
    sendJson(
      res,
      200,
      studio.providers?.describe(user) ?? {
        kinds: MEDIA_KINDS.map((kind) => ({
          kind,
          state: 'unconfigured',
          reason: 'NO_PROVIDER',
          providers: [],
        })),
      },
    )
    return
  }

  if (path === '/projects' && method === 'GET') {
    const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined
    sendJson(
      res,
      200,
      await studio.store.listProjects(uid, {
        before: url.searchParams.get('before') ?? undefined,
        limit,
      }),
    )
    return
  }
  if (path === '/projects' && method === 'POST') {
    sendJson(res, 201, {
      project: await studio.store.createProject(uid, bodyRecord(await readJsonBody(req))),
    })
    return
  }

  if (path === '/music/search' && method === 'GET') {
    const id = url.searchParams.get('provider') ?? ''
    const source = studio.providers?.get(id)
    if (!source || source.kind !== 'music' || !source.search)
      throw new HttpError(400, 'BAD_REQUEST', 'provider is not a music source')
    if (source.status(user).state !== 'ready')
      throw new HttpError(409, 'STUDIO_MUSIC_UNAVAILABLE', 'this music source is not available')
    sendJson(res, 200, await source.search(user, musicQuery(url.searchParams)))
    return
  }
  if (path === '/music/tracks' && method === 'POST') {
    // My Music (0325): the uploader states they own the music or are licensed to use it.
    if (url.searchParams.get('rights') !== 'own_or_licensed')
      throw new HttpError(
        400,
        'MUSIC_RIGHTS_REQUIRED',
        'confirm you own this music or are licensed to use it',
      )
    const title = (url.searchParams.get('title') ?? '').trim()
    if (!title || title.length > 200)
      throw new HttpError(400, 'BAD_REQUEST', 'title must be 1..200 chars')
    const note = (url.searchParams.get('note') ?? '').trim().slice(0, 300)
    const mime = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase()
    if (!MUSIC_AUDIO_TYPES.has(mime) || !UPLOAD_TYPES[mime])
      throw new HttpError(415, 'STUDIO_UNSUPPORTED_MEDIA', 'upload an MP3 or WAV file')
    const body = await readUpload(req)
    if (!UPLOAD_TYPES[mime]!(body))
      throw new HttpError(
        415,
        'STUDIO_UNSUPPORTED_MEDIA',
        'the file is not the audio type it claims',
      )
    const trackId = randomUUID()
    const stored = await studio.blobs
      .put({
        userId: BigInt(uid),
        mime,
        maxBytes: body.length,
        source: body,
        ref: { kind: 'upload', id: trackId },
      })
      .catch(mapStoreError)
    const track = await studio.store
      .addUserTrack(uid, {
        id: trackId,
        title,
        blobSha: stored.sha,
        mime,
        rights: {
          statement: 'own_or_licensed',
          acceptedAt: new Date().toISOString(),
          ...(note ? { note } : {}),
        },
        // M1 follow-up: the real length, so length filters, the editor and compose can use it.
        durationMs: audioDurationMs(mime, body),
      })
      .catch(async (err) => {
        // No row holds the audio then: give the bytes back instead of leaving an orphan ref.
        await studio.blobs.dropRefs(BigInt(uid), { kind: 'upload', id: trackId }).catch(() => {})
        throw err
      })
    sendJson(res, 201, { track })
    return
  }
  const projectMusic = PROJECT_MUSIC_RE.exec(path)
  if (
    projectMusic &&
    ((!projectMusic[2] && method === 'POST') || (projectMusic[2] && method === 'PUT'))
  ) {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    const body = bodyRecord(await readJsonBody(req))
    if (projectMusic[2]) {
      sendJson(res, 200, {
        musicEdit: await studio.orchestrator.setMusicEdit(uid, projectMusic[1]!, body),
      })
    } else {
      sendJson(res, 202, await studio.orchestrator.selectMusic(uid, projectMusic[1]!, body))
    }
    return
  }

  const narration = VOICE_NARRATION_RE.exec(path)
  if (narration && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    sendJson(res, 200, await studio.orchestrator.useVoiceForNarration(uid, narration[1]!))
    return
  }
  // OCV5-591 A2-1b-2: annotations.
  const annotation = ANNOTATION_RE.exec(path)
  if (annotation) {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    const api = studio.orchestrator.annotations
    const id = annotation[1]!
    const act = annotation[2]
    if (!act && method === 'PATCH') {
      await api.update(uid, id, bodyRecord(await readJsonBody(req)))
    } else if (!act && method === 'DELETE') {
      await api.remove(uid, id)
    } else if (act === 'send' && method === 'POST') {
      await api.send(uid, id)
    } else if (act === 'apply' && method === 'POST') {
      await api.apply(uid, id)
    } else if (act === 'reject' && method === 'POST') {
      await api.reject(uid, id)
    } else {
      throw notFound()
    }
    sendJson(res, 200, { ok: true })
    return
  }
  const takeSelect = TAKE_SELECT_RE.exec(path)
  if (takeSelect && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    sendJson(res, 200, await studio.orchestrator.selectTake(uid, takeSelect[1]!))
    return
  }

  const project = PROJECT_RE.exec(path)
  if (!project) throw notFound()
  const projectId = project[1]!
  const action = project[2]
  if (!action && method === 'GET') {
    const view = await studio.store.projectView(uid, projectId)
    if (!view) throw notFound()
    sendJson(res, 200, view)
    return
  }
  if (!action && method === 'PATCH') {
    const body = bodyRecord(await readJsonBody(req))
    const { expectedRev, ...fields } = body
    sendJson(res, 200, {
      project: await studio.store.updateProject(uid, projectId, Number(expectedRev), fields),
    })
    return
  }
  if (!action && method === 'DELETE') {
    await studio.store.deleteProject(uid, projectId)
    sendJson(res, 200, { ok: true })
    return
  }
  if ((action === 'pause' || action === 'resume' || action === 'cancel') && method === 'POST') {
    const updated = await studio.store.transition(uid, projectId, action)
    if (action === 'resume') studio.orchestrator?.kick(projectId)
    sendJson(res, 200, { project: updated })
    return
  }
  if (action === 'voices' && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    sendJson(
      res,
      201,
      await studio.orchestrator.createVoice(uid, projectId, bodyRecord(await readJsonBody(req))),
    )
    return
  }
  if (action === 'annotations' && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    sendJson(
      res,
      201,
      await studio.orchestrator.annotations.create(
        uid,
        projectId,
        bodyRecord(await readJsonBody(req)),
      ),
    )
    return
  }
  if (action === 'export' && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    const out = await studio.orchestrator.requestExport(
      uid,
      projectId,
      bodyRecord(await readJsonBody(req)),
    )
    sendJson(res, 'reused' in out ? 200 : 202, out)
    return
  }
  if ((action === 'start' || action === 'approve') && method === 'POST') {
    if (!studio.orchestrator)
      throw new HttpError(503, 'STUDIO_ORCHESTRATOR_OFF', 'the director agent is not running')
    if (action === 'start') await studio.orchestrator.start(uid, projectId)
    else await studio.orchestrator.approve(uid, projectId)
    const view = await studio.store.projectView(uid, projectId)
    if (!view) throw notFound()
    sendJson(res, 200, view)
    return
  }
  if (action === 'uploads' && method === 'POST') {
    const mime = String(req.headers['content-type'] ?? '')
      .split(';', 1)[0]!
      .trim()
      .toLowerCase()
    const sniff = UPLOAD_TYPES[mime]
    if (!sniff) throw new HttpError(415, 'STUDIO_UNSUPPORTED_MEDIA', 'unsupported upload type')
    if (!(await studio.store.projectOwned(uid, projectId))) throw notFound()
    const data = await readUpload(req)
    if (!sniff(data))
      throw new HttpError(415, 'STUDIO_UNSUPPORTED_MEDIA', 'content does not match its type')
    const rawName = String(req.headers['x-filename'] ?? '')
    let name = 'upload'
    try {
      name =
        decodeURIComponent(rawName)
          .replace(/\p{Cc}/gu, '')
          .slice(0, 200) || 'upload'
    } catch {
      /* keep default */
    }
    const assetId = randomUUID()
    const stored = await studio.blobs
      .put({
        userId: BigInt(uid),
        mime,
        maxBytes: data.length,
        source: data,
        ref: { kind: 'upload', id: assetId },
      })
      .catch(mapStoreError)
    try {
      const asset = await studio.store.addUploadAsset(uid, projectId, {
        assetId,
        name,
        blobSha: stored.sha,
        mime,
        bytes: stored.bytes,
      })
      sendJson(res, 201, { asset })
    } catch (err) {
      await studio.blobs.dropRefs(BigInt(uid), { kind: 'upload', id: assetId }).catch(() => {})
      throw err
    }
    return
  }
  throw notFound()
}
