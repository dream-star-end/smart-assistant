/**
 * Gateway HTTP misc handlers: uploads, media, workspace file API, Claude OAuth, collaboration config, search
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-481. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. HttpMiscHandlersHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { createHash, randomBytes } from 'node:crypto'
import {
  constants as fsConstants,
  closeSync,
  createWriteStream,
  fchmodSync,
  fchownSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlink,
  unlinkSync,
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, join, resolve } from 'node:path'
import { shouldServeInline, uploadQuotaExceeded, uploadQuotaMessage } from '@openclaude/protocol'
import { resolveOpenedPath } from './openedPath.js'
import { localSessionDir, remoteReservationRemainder, remoteSessionDir, sumUploadReservationBytes } from './uploadChunkStore.js'
import { paths, readConfig, searchSessions, writeConfig } from '@openclaude/storage'
import {
  ADVISOR_CONSULT_PARENT_REASON,
  advisorConsultParentGate,
  advisorCanonicalModelId,
  assertAdvisorModelAllowed,
  listProvenAdvisorModels,
  openAdvisorEngines,
} from './advisorMode.js'
import { CollaborationConfigError, resolveSessionCollab } from './advisorConfigStore.js'
import { serveFileFdWithRange } from './httpRange.js'
import { isEngineLocalTurnExempt } from './modelAuthority.js'
import { getLocalCatalogView } from './modelCatalogClient.js'
import { CLAUDE_OAUTH_USER_AGENT, _uploadFsOps, isFileAllowed, makeUserScopedMediaPredicate, isFileBlocked, isUploadMimeAllowed, uploadExtForMime } from './server.js'
import { MAX_UPLOAD_SINGLE, mimeFor } from './httpUploadStatic.js'
import type { Gateway } from './server.js'

export interface HttpMiscHandlersHost {
  OAUTH_PROVIDERS: Gateway['OAUTH_PROVIDERS']
  _collaborationCapabilityFields: Gateway['_collaborationCapabilityFields']
  _parentEngineForCollabSession: Gateway['_parentEngineForCollabSession']
  _refreshClaudeOAuthImpl: Gateway['_refreshClaudeOAuthImpl']
  _refreshForced: Gateway['_refreshForced']
  _refreshPromise: Gateway['_refreshPromise']
  _resolveMediaDirs: Gateway['_resolveMediaDirs']
  _sendMediaResolveError: Gateway['_sendMediaResolveError']
  advisorConfigStore: Gateway['advisorConfigStore']
  deps: Gateway['deps']
  getUserId: Gateway['getUserId']
  log: Gateway['log']
  oauthPending: Gateway['oauthPending']
  openFileHardened: Gateway['openFileHardened']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendInternalError: Gateway['sendInternalError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

export type ResolveMediaDirsResult = | { kind: 'legacy'; uploads: string; generated: string }
  | { kind: 'ok'; uid: number; uploads: string; generated: string }
  | {
      kind: 'fail'
      reason: 'remote-host'
      uid: number
      hostUuid: string
      uploads: string
      generated: string
      logCtx: Record<string, unknown>
    }
  | {
      kind: 'fail'
      reason: 'invalid-uid' | 'not-ready' | 'volume-missing' | 'ambiguous' | 'daemon-error'
      logCtx: Record<string, unknown>
    }

/**
 * Resolve the media directories (uploads + generated) for an authenticated
 * user. Both subdirs live in the same docker volume, so a single resolve
 * call returns both — avoids double-DB / double-docker-inspect on read.
 *
 * Returns `{ kind: 'legacy' }` for personal-version flows (no commercial
 * hook, or commercial hook with no resolver — e.g. agentRuntime didn't
 * come up). Caller falls back to `paths.uploadsDir` / `paths.generatedDir`.
 *
 * Otherwise delegates to `commercial.resolveUserMediaDirs` which returns
 * the structured `{ kind: 'ok', uploads, generated }` / `{ kind: 'fail',
 * reason }`. Gateway never silently falls back from a `fail` to legacy
 * paths — that would re-introduce the same single-tenant split-brain that
 * this whole change exists to fix.
 *
 * Status mapping (caller-side):
 *   not-ready    → 503 + Retry-After (provisioning window)
 *   remote-host  → 503 (deferred remote-volume push, see TODO)
 *   volume-missing/ambiguous/daemon-error → 500 (data corruption / docker err)
 *   invalid-uid  → 401 (token has bad sub form; shouldn't happen post-getUserId)
 */
export async function _resolveMediaDirs(
  this: HttpMiscHandlersHost,
  userId: string,
): Promise<
  ResolveMediaDirsResult
> {
  // No commercial hook OR resolver not injected (agentRuntime not ready) →
  // legacy single-tenant write/read path. `default` always falls here
  // regardless of commercial hook presence (personal-version single-token
  // auth).
  const resolver = this.deps.commercial?.resolveUserMediaDirs
  if (!resolver || userId === 'default') {
    return { kind: 'legacy', uploads: paths.uploadsDir, generated: paths.generatedDir }
  }
  // Commercial JWT user → delegate. Any `c:` userId not parseable by the
  // resolver lands as `kind: 'fail', reason: 'invalid-uid'`.
  const loc = await resolver(userId)
  return loc
}

/**
 * Translate a `_resolveMediaDirs` failure into an HTTP response and log.
 * Returns true if the caller should stop (response already sent), false if
 * it can keep going (currently never returns false — branches always send).
 *
 * Centralized so handleUpload, /api/media, /api/file keep the same status
 * mapping.
 */
export function _sendMediaResolveError(
  this: HttpMiscHandlersHost,
  res: ServerResponse,
  fail: {
    reason:
      | 'invalid-uid'
      | 'not-ready'
      | 'remote-host'
      | 'volume-missing'
      | 'ambiguous'
      | 'daemon-error'
    logCtx: Record<string, unknown>
  },
  context: 'upload' | 'media' | 'file',
): void {
  switch (fail.reason) {
    case 'invalid-uid':
      // Reached only when a commercial JWT user has a bad sub; getUserId
      // already rejects unverifiable tokens. Treat as auth failure.
      this.log.warn(`${context}: invalid-uid`, fail.logCtx)
      this.sendError(res, 401, 'invalid auth')
      return
    case 'not-ready':
      // User has no active container yet (provisioning window). Frontend
      // re-tries on a backoff — surface 503 + Retry-After so UI/proxy
      // honors it.
      this.log.info(`${context}: container not ready`, fail.logCtx)
      res.setHeader('Retry-After', '5')
      this.sendError(res, 503, 'container not ready, please retry shortly')
      return
    case 'remote-host':
      // User is currently placed on a remote compute host. Plan B doesn't
      // yet push media to remote-host volumes; deferred. Surface 503
      // rather than guess.
      this.log.warn(`${context}: remote-host placement (deferred)`, fail.logCtx)
      this.sendError(res, 503, 'media on remote-host placement not supported yet')
      return
    case 'volume-missing':
      // DB says active but docker volume gone. Data corruption / GC race.
      this.log.error(`${context}: docker volume missing despite active state`, fail.logCtx)
      this.sendError(res, 500, 'storage layout inconsistent — admin investigating')
      return
    case 'ambiguous':
      // Multiple active rows for one user. Data corruption.
      this.log.error(`${context}: ambiguous active containers`, fail.logCtx)
      this.sendError(res, 500, 'storage layout inconsistent — admin investigating')
      return
    case 'daemon-error':
      // PG query error or docker daemon error (non-404).
      this.log.error(`${context}: resolver daemon error`, fail.logCtx)
      this.sendError(res, 500, 'storage layer unavailable')
      return
  }
}

/**
 * GET /api/file?path=<absolute> — fetch a file by absolute path (allowlisted).
 *
 * Used by the UI when an agent tool output references a file by absolute
 * path (e.g. uploaded image saved at /var/lib/docker/volumes/...).
 *
 * v3 commercial multi-tenant: the user-scoped allowlist predicate is
 * derived from `_resolveMediaDirs(userId)`, NOT from a global textual
 * predicate. This is what prevents user A from reading user B's docker
 * volume media by guessing/leaking absolute paths.
 *
 * Failure modes from the resolver are translated by `_sendMediaResolveError`
 * (not-ready → 503+Retry, etc.). For users with no active container,
 * /api/file silently degrades: still serves OPENCLAUDE_HOME / tmp / agent
 * cwd paths (no docker-volume access), so legacy assets keep working.
 */
export async function handleApiFile(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    res.writeHead(400)
    res.end('missing ?path=')
    return
  }
  // Accept both POSIX (/path) and Windows (C:\path) absolute paths
  const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[\\\/]/.test(filePath)
  if (filePath.includes('..') || !isAbsolute) {
    res.writeHead(400)
    res.end('bad path')
    return
  }
  // v3 file proxy hardening: use realpath (not resolve) so symlinks in the
  // *path text* are resolved to their canonical target BEFORE allowlist
  // check. Without this, a symlink /root/.openclaude/generated/foo →
  // /root/openclaude.json would pass isFileAllowed (text startsWith check)
  // and leak the config.
  const resolved = resolve(filePath)
  const userId = this.getUserId(req)
  const mediaLoc = await this._resolveMediaDirs(userId)
  let realPath: string
  try {
    realPath = realpathSync(resolved)
  } catch {
    // 2026-05-16 Phase 2:本地 realpathSync 失败时,若该路径文本上属于 remote-host
    // 用户的 docker volume uploads/generated 子目录(master 本机物理上没这个
    // volume — 用户被调度到远端 compute host),走 node-agent /files GET 拉远端
    // 字节回服。否则维持原 404 行为。
    //
    // 安全:复用 makeUserScopedMediaPredicate 做边界安全前缀判定(`p === dir ||
    // p.startsWith(dir + '/')`),不裸 startsWith(防 `uploads-evil/x` 误中)。
    // 拉到字节后仍走 isFileBlocked + active MIME→attachment + inline/attachment
    // 双模,与本地分支完全对称(Codex review 2:remote 安全语义不能降级)。
    if (
      mediaLoc.kind === 'fail' &&
      mediaLoc.reason === 'remote-host' &&
      this.deps.commercial?.pullRemoteHostMedia
    ) {
      const remoteScoped = makeUserScopedMediaPredicate(mediaLoc.uploads, mediaLoc.generated)
      if (remoteScoped(resolved)) {
        let buf: Buffer | null = null
        try {
          buf = await this.deps.commercial.pullRemoteHostMedia({
            hostUuid: mediaLoc.hostUuid,
            remotePath: resolved,
          })
        } catch (err) {
          this.log.error(
            'api/file: remote-host pull failed',
            { hostUuid: mediaLoc.hostUuid, remotePath: resolved, ...mediaLoc.logCtx },
            err as Error,
          )
          this.sendError(res, 502, 'remote storage pull failed')
          return
        }
        if (buf === null) {
          // Codex review #1 (Phase 2): null 表示远端 404;空 Buffer(0 字节文件)
          // 是合法命中,不能被 falsy 吞掉。
          res.writeHead(404)
          res.end('not found')
          return
        }
        if (isFileBlocked(resolved)) {
          this.log.warn('api/file: remote hit blocked by sensitive deny-list', { path: resolved })
          res.writeHead(403)
          res.end('access denied')
          return
        }
        const remoteFileContentType = mimeFor(resolved)
        const remoteFileDispositionMode = shouldServeInline(remoteFileContentType)
          ? 'inline'
          : 'attachment'
        res.writeHead(200, {
          'Content-Type': remoteFileContentType,
          'Content-Length': buf.length,
          'Cache-Control': 'private, max-age=3600',
          'Content-Disposition': `${remoteFileDispositionMode}; filename="${encodeURIComponent(basename(resolved) || 'file')}"`,
        })
        res.end(buf)
        return
      }
    }
    res.writeHead(404)
    res.end('not found')
    return
  }
  const agentCwds = this.deps.agentsConfig.agents.map((a) => a.cwd).filter((c): c is string => !!c)
  // V3 multi-tenant: resolve the caller's docker-volume {uploads, generated}
  // dirs for a **user-scoped** allowlist predicate. Critical: this is what
  // closes the cross-tenant IDOR — a textual "any user volume" predicate
  // (the previous `isUserVolumeUploadsPath` approach) would let user A read
  // any user's media by absolute path.
  //
  // If resolve fails (not-ready / volume-missing / etc.), don't 5xx the
  // request: just fall through with no extraAllowed predicate. /api/file
  // can still serve static FILE_ALLOWED_DIRS / agent cwd paths — only
  // docker-volume media access is silently denied, which is the safest
  // degradation. (Returning 503 here would break personal-version flows
  // running side-by-side and confuse tool-output rendering for users
  // whose container is mid-provisioning.)
  const userScopedAllowed =
    mediaLoc.kind === 'fail'
      ? undefined
      : makeUserScopedMediaPredicate(mediaLoc.uploads, mediaLoc.generated)
  if (!isFileAllowed(realPath, agentCwds, userScopedAllowed)) {
    this.log.warn('api/file denied (not in allowlist)', { path: realPath })
    res.writeHead(403)
    res.end('access denied')
    return
  }
  if (isFileBlocked(realPath)) {
    this.log.warn('api/file blocked sensitive', { path: realPath })
    res.writeHead(403)
    res.end('access denied')
    return
  }
  // fd-based open (O_NOFOLLOW + /proc/self/fd realpath check) closes the
  // middle-directory swap race; see openFileHardened().
  const fd = this.openFileHardened(res, realPath, agentCwds, userScopedAllowed)
  if (fd === null) return
  let fileStat: ReturnType<typeof fstatSync>
  try {
    fileStat = fstatSync(fd)
  } catch {
    closeSync(fd)
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (!fileStat.isFile()) {
    closeSync(fd)
    res.writeHead(404)
    res.end('not found')
    return
  }
  const fileContentType = mimeFor(realPath)
  // Inline only previewable media; document/text artifacts must download.
  const fileDispositionMode = shouldServeInline(fileContentType) ? 'inline' : 'attachment'
  // D1:支持 HTTP Range —— 有合法 Range → 206 局部,无/非法 → 200 全量并宣告
  // Accept-Ranges。Content-Length 由 serveFileFdWithRange 按 200/206 补齐,fd 由
  // 流 autoClose 接管(与改造前一致,无泄漏)。
  serveFileFdWithRange(
    res,
    fd,
    fileStat.size,
    {
      'Content-Type': fileContentType,
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `${fileDispositionMode}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`,
    },
    { rangeHeader: req.headers.range, isHead: req.method === 'HEAD' },
  )
}

/**
 * GET /api/media/<filename> — fetch a previously uploaded or generated file.
 *
 * V3 multi-tenant: both uploads/ AND generated/ lookup are scoped to the
 * **caller's** per-user docker volume host path. Personal/legacy mode falls
 * back to paths.uploadsDir + paths.generatedDir.
 *
 * Note: closes the pre-existing IDOR — previously any authed user could
 * fetch any digest known to them via /api/media/<digest>.<ext>. Per-user
 * dir routing + user-scoped extraAllowed predicate now restricts cross-user
 * access for both uploads and codex image_gen output.
 */
export async function handleMediaGet(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  rawFilename: string,
): Promise<void> {
  let filename: string
  try {
    filename = decodeURIComponent(rawFilename)
  } catch {
    res.writeHead(400)
    res.end('bad request')
    return
  }
  // Reject path traversal attempts (../ or absolute paths)
  if (filename.includes('..') || filename.startsWith('/') || filename.startsWith('\\')) {
    res.writeHead(400)
    res.end('bad request')
    return
  }
  const userIdForMedia = this.getUserId(req)
  const mediaLocation = await this._resolveMediaDirs(userIdForMedia)
  if (mediaLocation.kind === 'fail') {
    // 2026-05-16 Phase 2:remote-host 用户走 node-agent /files GET 拉远端 user
    // volume 文件回服。其余 fail 原因(not-ready / volume-missing / 等)继续
    // 走 _sendMediaResolveError 既有语义。
    //
    // 与本地分支的安全/响应头**完全对称**(Codex review 2:确保 isFileBlocked /
    // active MIME → attachment / Cache-Control / Content-Length 都跟本地一致,
    // 不能"远端走捷径"):
    //   - mimeFor 用 filename(无 realpath 可言,filename 经 traversal 校验)
    //   - 命中前查 isFileBlocked(防 `.env` 等 deny-list)
    //   - active content 强制 attachment + filename
    //   - Content-Length 取 buffer.length(node-agent 已校 MaxFileSize)
    if (mediaLocation.reason === 'remote-host' && (this.deps.commercial?.openRemoteHostMedia || this.deps.commercial?.pullRemoteHostMedia)) {
      const remoteCandidates = [
        `${mediaLocation.uploads}/${filename}`,
        `${mediaLocation.generated}/${filename}`,
      ]
      const openRemote = this.deps.commercial?.openRemoteHostMedia
      if (openRemote) {
        for (const remotePath of remoteCandidates) {
          try {
            const outcome = await openRemote({
              hostUuid: mediaLocation.hostUuid,
              remotePath,
              dest: res,
              onReady: (info) => {
                if (isFileBlocked(remotePath)) {
                  this.log.warn('media: remote hit blocked by sensitive deny-list', { remotePath })
                  res.writeHead(403)
                  res.end('access denied')
                  return false
                }
                const remoteContentType = mimeFor(remotePath)
                const remoteHeaders: Record<string, string | number> = {
                  'Content-Type': remoteContentType,
                  'Content-Length': info.size,
                  'Cache-Control': 'private, max-age=3600',
                }
                remoteHeaders['Content-Disposition'] =
                  `${shouldServeInline(remoteContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(remotePath) || 'file')}"`
                res.writeHead(200, remoteHeaders)
                return true
              },
            })
            if (outcome === 'missing') continue
            return
          } catch (err) {
            this.log.error(
              'media: remote-host pull failed',
              { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
              err as Error,
            )
            if (!res.headersSent) this.sendError(res, 502, 'remote storage pull failed')
            return
          }
        }
        if (!res.headersSent) {
          res.writeHead(404)
          res.end('not found')
        }
        return
      }
      const pullRemote = this.deps.commercial?.pullRemoteHostMedia
      if (!pullRemote) {
        if (!res.headersSent) {
          res.writeHead(404)
          res.end('not found')
        }
        return
      }
      let buf: Buffer | null = null
      let hitPath: string | null = null
      for (const remotePath of remoteCandidates) {
        try {
          const result = await pullRemote({
            hostUuid: mediaLocation.hostUuid,
            remotePath,
          })
          if (result !== null) {
            buf = result
            hitPath = remotePath
            break
          }
        } catch (err) {
          this.log.error(
            'media: remote-host pull failed',
            { hostUuid: mediaLocation.hostUuid, remotePath, ...mediaLocation.logCtx },
            err as Error,
          )
          this.sendError(res, 502, 'remote storage pull failed')
          return
        }
      }
      if (buf === null || hitPath === null) {
        // Codex review #1 (Phase 2):空 Buffer(0 字节文件)是合法命中,
        // 必须用严格 === null 判定,不能用 falsy。
        res.writeHead(404)
        res.end('not found')
        return
      }
      if (isFileBlocked(hitPath)) {
        this.log.warn('media: remote hit blocked by sensitive deny-list', { hitPath })
        res.writeHead(403)
        res.end('access denied')
        return
      }
      const remoteContentType = mimeFor(hitPath)
      const remoteHeaders: Record<string, string | number> = {
        'Content-Type': remoteContentType,
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=3600',
      }
      remoteHeaders['Content-Disposition'] =
        `${shouldServeInline(remoteContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(hitPath) || 'file')}"`
      res.writeHead(200, remoteHeaders)
      res.end(buf)
      return
    }
    this._sendMediaResolveError(res, mediaLocation, 'media')
    return
  }
  // Search in uploads first, then generated. Resolve via realpath so a
  // symlink inside uploads/ cannot escape the directory. baseReal also
  // goes through realpathSync — without that, the dir being a symlink
  // (rare but possible in some deployments) would fail the startsWith
  // check after the candidate's realpath resolves to the symlink target.
  const dirs = [mediaLocation.uploads, mediaLocation.generated]
  let realPath: string | null = null
  for (const dir of dirs) {
    let baseReal: string
    try {
      baseReal = realpathSync(dir)
    } catch {
      // Directory may not exist yet (e.g. fresh install with no uploads
      // OR no codex image_gen has run yet → generated dir not created).
      continue
    }
    const candidate = resolve(baseReal, filename)
    // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-481); pre-existing there
    if (!candidate.startsWith(baseReal + '/') && candidate !== baseReal) continue
    try {
      const r = realpathSync(candidate)
      // biome-ignore lint/style/useTemplate: moved verbatim from server.ts (OCV5-481); pre-existing there
      if (r.startsWith(baseReal + '/')) {
        realPath = r
        break
      }
    } catch {}
  }
  if (!realPath) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const agentCwds = this.deps.agentsConfig.agents.map((a) => a.cwd).filter((c): c is string => !!c)
  // User-scoped allowlist predicate: limit to **this request's** resolved
  // uploads + generated dirs. In legacy/personal mode these equal
  // paths.uploadsDir + paths.generatedDir (also in FILE_ALLOWED_DIRS, so
  // the predicate is a no-op there). In commercial mode this is what
  // prevents cross-tenant absolute-path leaks — without it, a textual
  // predicate would let user A read user B's docker volume files.
  const userScopedAllowed = makeUserScopedMediaPredicate(
    mediaLocation.uploads,
    mediaLocation.generated,
  )
  // Blocklist check — someone could drop a .env into uploads/.
  if (isFileBlocked(realPath)) {
    res.writeHead(403)
    res.end('access denied')
    return
  }
  const fd = this.openFileHardened(res, realPath, agentCwds, userScopedAllowed)
  if (fd === null) return
  let mediaStat: ReturnType<typeof fstatSync>
  try {
    mediaStat = fstatSync(fd)
  } catch {
    closeSync(fd)
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (!mediaStat.isFile()) {
    closeSync(fd)
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mediaContentType = mimeFor(realPath)
  const mediaHeaders: Record<string, string | number> = {
    'Content-Type': mediaContentType,
    'Cache-Control': 'private, max-age=3600',
  }
  mediaHeaders['Content-Disposition'] =
    `${shouldServeInline(mediaContentType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(basename(realPath) || 'file')}"`
  // D1:与 /api/file 同构 —— Range → 206,否则 200 全量 + Accept-Ranges。
  serveFileFdWithRange(res, fd, mediaStat.size, mediaHeaders, {
    rangeHeader: req.headers.range,
    isHead: req.method === 'HEAD',
  })
}

/**
 * POST /api/uploads — streaming single-file upload (Plan B 2026-05-09).
 * One HTTP body stays at 100MiB. A file up to 1GiB uses /api/uploads/init chunked upload.
 *
 * Body is the raw file bytes. Required headers:
 *   - Content-Type: claimed file MIME type (metadata only; all formats accepted)
 * Optional:
 *   - Content-Length: when present, used for early reject (saves bandwidth);
 *     when absent, streaming guard rejects mid-stream if bytes > MAX_UPLOAD_SINGLE.
 *   - X-Filename: URL-encoded original filename. Only its safe final extension may
 *     be used as a storage suffix when MIME has no canonical mapping.
 *
 * Response: 200 { url, digest, size, mimeType }
 * Errors: 400 / 413 (too large) / 500 (write failed)
 *
 * Storage: streams to `<uploadsDir>/.tmp-<random>` while computing sha256;
 * on success atomically renames to `<digest>.<ext>`. If a file with the
 * same digest already exists, dedups (tmp removed, existing path returned).
 */
export function publishOpenedUpload(opts: {
  tmpFd: number
  tmpPath: string
  finalPath: string
  isPerUser: boolean
  userId: string
  res: ServerResponse
  log: HttpMiscHandlersHost['log']
  sendError: HttpMiscHandlersHost['sendError']
}): boolean {
  const { tmpFd, tmpPath, finalPath, isPerUser, userId, res, log, sendError } = opts
    // 5a. fd-based mode/owner prep — TOCTOU-safe.
    //
    //   • fchmod 0o644 unconditionally: tmp was opened 0o600; published
    //     files need world-read (served via /api/media stream, but also
    //     read by per-user docker container's agent uid). Behavior delta
    //     vs old path-based code: personal mode previously inherited
    //     createWriteStream default 0o666 - umask (~0o644 with default
    //     umask 0o022); now explicit. Same end-state in 99% of cases.
    //   • fchown to agent uid (1000:1000) only for per-user docker volumes.
    //     Personal mode: same uid as master, chown would be no-op + risk
    //     EPERM on non-root local dev → skip.
    //
    // Routed through `_uploadFsOps.*` for failure-injection in unit tests
    // (see `__setUploadFsOpsForTests`). Failure here only affects our
    // private tmp fd (still pre-link, single dirent), so cleanup unlinks
    // the tmp and the finally closes the fd; no concurrent publisher's
    // file can be touched.
    try {
      _uploadFsOps.fchmodSync(tmpFd, 0o644)
      if (isPerUser) {
        _uploadFsOps.fchownSync(tmpFd, 1000, 1000)
      }
    } catch (err) {
      log.error(
        'handleUpload: pre-publish fchmod/fchown failed',
        {
          tmpPath,
          isPerUser,
          userId,
        },
        err,
      )
      try {
        unlinkSync(tmpPath)
      } catch {}
      sendError(res, 500, 'storage prep failed')
      return false
    }

    // 5b. Atomic publish via no-overwrite hardlink. linkSync is atomic +
    // fail-closed on EEXIST (race-free dedup signal). We verify post-link
    // that finalPath actually points to OUR tmp inode (not an attacker-
    // planted collision via parent-symlink swap on finalPath's side).
    let eexistDedup = false
    try {
      _uploadFsOps.linkSync(tmpPath, finalPath)
    } catch (err) {
      const code = (err as { code?: string })?.code
      if (code !== 'EEXIST') {
        log.error('handleUpload: link failed', undefined, err)
        try {
          unlinkSync(tmpPath)
        } catch {}
        sendError(res, 500, 'storage write failed')
        return false
      }
      // dedup hit: 既有 finalPath 是先前同 digest 上传 publish 出来的,owner 已
      // 是 agent uid(per-user 模式)或 master uid(personal 模式)。语义正确。
      eexistDedup = true
    }

    // 5c. Post-link verify: parent-symlink defense on finalPath's side,
    // applied to BOTH the just-linked and EEXIST-dedup cases.
    //
    //   (i)   openSync(finalPath, O_RDONLY|O_NOFOLLOW) — last-component
    //         symlink defense (matches openFileHardened).
    //   (ii)  realpathSync(/proc/self/fd/<finalFd>) === finalPath — parent-
    //         symlink race defense (parent swapped between our linkSync
    //         and the open here, or between a prior publish and now).
    //   (iii) fstat(tmpFd).dev/ino === fstat(finalFd).dev/ino — additional
    //         proof for **new** publishes that the link landed on OUR
    //         bytes. Skipped for dedup — by definition dedup means the
    //         inode at finalPath is from a prior request, not our tmpFd.
    //
    // Why dedup also needs (i)+(ii) (Codex 2026-05-16 review fix): without
    // them an attacker could parent-swap finalPath's dir to a controlled
    // location with a pre-placed `<digest>.<ext>` → our linkSync sees
    // EEXIST → we return 200 without ever validating the inode lives under
    // the legitimate upload root. Read-path openFileHardened would later
    // 404 the bogus URL, but we'd have lied to the client about success.
    //
    // Cleanup of finalPath on verify failure:
    //   • new-link path: we just created this inode at finalPath → safe to
    //     best-effort unlinkSync (residual race documented).
    //   • dedup path: we don't own the inode (could be prior legitimate
    //     publish OR attacker plant in attacker-controlled location). Do
    //     NOT unlink — leave the artifact alone, fail closed.
    let finalFd: number | null = null
    try {
      try {
        finalFd = openSync(finalPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      } catch (err) {
        log.error('handleUpload: post-link open failed', { finalPath, eexistDedup }, err)
        if (!eexistDedup) {
          try {
            unlinkSync(finalPath)
          } catch {}
        }
        try {
          unlinkSync(tmpPath)
        } catch {}
        sendError(res, 500, 'storage publish verify failed')
        return false
      }
      let finalReal: string
      try {
        finalReal = resolveOpenedPath(finalFd, finalPath)
      } catch (err) {
        log.error('handleUpload: post-link realpath failed', { finalPath, eexistDedup }, err)
        if (!eexistDedup) {
          try {
            unlinkSync(finalPath)
          } catch {}
        }
        try {
          unlinkSync(tmpPath)
        } catch {}
        sendError(res, 500, 'storage publish verify failed')
        return false
      }
      if (finalReal !== finalPath) {
        log.error('handleUpload: post-link parent swap detected', {
          finalPath,
          finalReal,
          eexistDedup,
        })
        if (!eexistDedup) {
          try {
            unlinkSync(finalPath)
          } catch {}
        }
        try {
          unlinkSync(tmpPath)
        } catch {}
        sendError(res, 500, 'storage publish diverged')
        return false
      }
      if (!eexistDedup) {
        const tmpStat = fstatSync(tmpFd)
        const finalStat = fstatSync(finalFd)
        if (tmpStat.dev !== finalStat.dev || tmpStat.ino !== finalStat.ino) {
          log.error('handleUpload: post-link inode mismatch', {
            finalPath,
            tmpDev: tmpStat.dev,
            tmpIno: tmpStat.ino,
            finalDev: finalStat.dev,
            finalIno: finalStat.ino,
          })
          try {
            unlinkSync(finalPath)
          } catch {}
          try {
            unlinkSync(tmpPath)
          } catch {}
          sendError(res, 500, 'storage publish diverged')
          return false
        }
      }
    } finally {
      if (finalFd !== null) {
        try {
          closeSync(finalFd)
        } catch {}
      }
    }

  try {
    unlinkSync(tmpPath)
  } catch {}
  return true
}

export async function handleUpload(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // ── 1. MIME metadata ──
  const ctype = (req.headers['content-type'] || '').toString().split(';')[0].trim().toLowerCase()
  if (!ctype) {
    this.sendError(res, 400, 'missing content-type')
    req.destroy()
    return
  }
  if (!isUploadMimeAllowed(ctype)) {
    this.sendError(res, 415, `unsupported mime: ${ctype}`)
    req.destroy()
    return
  }

  // ── 2. Content-Length early reject (when present) ──
  const declared = req.headers['content-length']
  if (declared !== undefined) {
    const n = Number(declared)
    if (!Number.isFinite(n) || n < 0 || !/^\d+$/.test(String(declared))) {
      this.sendError(res, 400, 'invalid content-length')
      req.destroy()
      return
    }
    if (n > MAX_UPLOAD_SINGLE) {
      this.sendError(res, 413, `file exceeds ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB`)
      req.destroy()
      return
    }
  }

  // ── 3a. Resolve per-user uploads directory ──
  // V3 multi-tenant: writes land in the user's docker volume host path so
  // the container side dispatchInbound (running inside oc-v3-u<uid>) reads
  // the same physical file via its `/home/agent/.openclaude/uploads/` mount.
  // Personal / legacy `default` users fall to paths.uploadsDir unchanged.
  // (generated dir is co-resolved but unused on the write path — we only
  // care that the volume exists, which the single resolve call confirms.)
  //
  // V3 remote-host (2026-05-16): when the user's container is on a non-self
  // compute host, master cannot write to a local docker volume — we stage
  // the upload under master's own paths.uploadsDir (just for hashing) and
  // then push the bytes via `pushRemoteHostUpload` (mTLS node-agent /files
  // PUT) to the **remote** volume host path. The final URL still resolves
  // through /api/media but read-back over the wire is Phase 2; this patch
  // unblocks the write path so the in-container agent can see the file.
  const userId = this.getUserId(req)
  // ── 3a-pre. Commercial cold-start guard (v1.0.192) ──
  // 在解析 user-scoped uploads dir 之前确保用户容器已 provision + volume 已挂载
  // + container running。否则会出现:`_resolveMediaDirs` 返回 ok(DB 行 active)
  // 但 docker container 没起来 → upload 写到 volume host path → 容器内 agent
  // 看不到文件 / 看到陈旧视图。
  //
  // 仅对 commercial userId(形如 `c:<digits>`,strict regex)启用,personal-version
  // 维持原行为。malformed `c:` 前缀(非纯数字)跳过 ensure,让 `_resolveMediaDirs`
  // 的 `invalid-uid` 路径继续判定(保住既有 401 语义)。
  //
  // 上界对齐 `parseCommercialUid`(userMedia.ts):commercial 的 uid 合同是
  // `<= Number.MAX_SAFE_INTEGER`(2^53 - 1,16-17 位)—— supervisor /
  // resolver / container proxy 全部沿用这个合同。所以这里也只在该合同内才
  // 触发 ensure;超过(理论 19 位 abuse 输入)跳过 ensure,继续让
  // `_resolveMediaDirs.parseCommercialUid` 把它判 invalid-uid → 401。否则
  // ensure 内部 `makeV3EnsureRunning` 会拒绝并抛 ContainerUnreadyError("invalid_uid"),
  // 把原本的 401 翻成 503,语义错位。
  //
  // 底层与 WS bridge / `/api/media-signed` / commercial router file proxy 共享
  // 同一 `sharedEnsureRunning`(per-uid singleflight),同时刻 reload 的 burst
  // 拉只触发一次 provision。
  const ensure = this.deps.commercial?.ensureContainerReady
  if (ensure && /^c:[1-9][0-9]{0,18}$/.test(userId)) {
    const uid = BigInt(userId.slice(2))
    if (uid <= BigInt(Number.MAX_SAFE_INTEGER)) {
      try {
        const r = await ensure(uid)
        if (!r.ok) {
          res.setHeader('Retry-After', String(r.retryAfterSec))
          this.sendError(res, 503, `container not ready: ${r.reason}`)
          req.destroy()
          return
        }
      } catch (err) {
        this.log.warn('handleUpload: ensureContainerReady threw', { userId }, err)
        res.setHeader('Retry-After', '5')
        this.sendError(res, 503, 'container not ready')
        req.destroy()
        return
      }
    }
    // uid > MAX_SAFE_INTEGER:跳过 ensure,让 _resolveMediaDirs 路径维持 invalid-uid 401。
  }
  const locationResult = await this._resolveMediaDirs(userId)
  let remoteUpload: {
    hostUuid: string
    remoteUploadsDir: string
  } | null = null
  let uploadsDir: string
  let isPerUser = false
  if (locationResult.kind === 'fail') {
    if (locationResult.reason === 'remote-host' && this.deps.commercial?.pushRemoteHostUpload) {
      // Stage locally; we push to remote after we have the final bytes + digest.
      // Use master's own paths.uploadsDir for the .tmp- staging file — it's
      // already mode 0755 root:root and the orphan sweep cleans .tmp-* there.
      remoteUpload = {
        hostUuid: locationResult.hostUuid,
        remoteUploadsDir: locationResult.uploads,
      }
      uploadsDir = paths.uploadsDir
      isPerUser = false
    } else {
      this._sendMediaResolveError(res, locationResult, 'upload')
      req.destroy()
      return
    }
  } else {
    uploadsDir = locationResult.uploads
    isPerUser = locationResult.kind === 'ok'
  }

  // ── 3b. Resolve uploadsDir realpath after ensuring it exists ──
  // Don't depend on startup sequence; create-then-realpath here.
  let baseReal: string
  try {
    mkdirSync(uploadsDir, { recursive: true })
    baseReal = realpathSync(uploadsDir)
  } catch (err) {
    this.log.error('handleUpload: uploadsDir setup failed', { uploadsDir }, err)
    this.sendError(res, 500, 'storage unavailable')
    req.destroy()
    return
  }

  const quotaSessionDir = remoteUpload
    ? remoteSessionDir(paths.uploadsDir)
    : localSessionDir(baseReal)
  let quotaUsed = 0
  if (remoteUpload) {
    const sumRemote = this.deps.commercial?.sumRemoteUploadUsage
    if (!sumRemote) {
      this.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
      req.destroy()
      return
    }
    try {
      const usage = await sumRemote({
        hostUuid: remoteUpload.hostUuid,
        remoteDir: remoteUpload.remoteUploadsDir,
      })
      quotaUsed = usage.usedBytes + remoteReservationRemainder(quotaSessionDir, {
        hostUuid: remoteUpload.hostUuid,
        remoteUploadsDir: remoteUpload.remoteUploadsDir,
      })
    } catch (err) {
      this.log.warn('handleUpload: remote quota unavailable', { userId }, err)
      this.sendError(res, 503, '暂时无法确认上传空间，请稍后重试')
      req.destroy()
      return
    }
  } else {
    quotaUsed = sumUploadReservationBytes(baseReal, quotaSessionDir)
  }
  if (declared !== undefined) {
    const declaredBytes = Number(declared)
    if (uploadQuotaExceeded(quotaUsed, declaredBytes)) {
      this.sendJson(res, 413, {
        error: uploadQuotaMessage(quotaUsed, declaredBytes),
        code: 'upload_quota_exceeded',
      })
      req.destroy()
      return
    }
  }

  // ── 4. Open .tmp fd-first + streaming write + sha256 ──
  //
  // TOCTOU hardening (v1.0.155):
  //   1. openSync(O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW, 0o600) — atomic create,
  //      fail-closed if last component is a symlink or already exists.
  //   2. realpathSync(/proc/self/fd/<n>) === tmpPath — parent-symlink race
  //      defense (mirrors openFileHardened on the read path). If parent dir
  //      was rename-swapped to a symlink in the window between baseReal
  //      resolve and openSync, our fd lives outside the upload root and we
  //      fail closed.
  //   3. createWriteStream(..., { fd, autoClose: false }) — we own fd
  //      lifetime via the outer try/finally; ws.destroy() does NOT close it.
  //   4. fchmod/fchown on the fd (not path) — immune to attacker rename
  //      between TOCTOU validate and chmod.
  //   5. Post-link verify (fd realpath + dev/ino fstat compare) — guarantees
  //      finalPath is the inode we just created, not an attacker-planted
  //      collision.
  //
  // Architecture (Codex B1 review fix v2):
  //   • Single state-machine variable `settled` resolves the await Promise
  //     exactly once. Every termination path calls `finish(ok)`.
  //   • We DO NOT listen for `req.close` — it fires on both normal completion
  //     and abnormal disconnect, and tends to fire BEFORE `ws.finish`. Using
  //     it for cleanup mis-deletes successful uploads. Instead we rely on
  //     `ws.finish` / `ws.error` / `req.error` / `req.aborted` only.
  //   • `cleanupTmp()` is the single place that destroys ws (with an Error
  //     to ensure ws.error fires) and unlinks the .tmp dirent. Idempotent
  //     via `cleaned` flag. fd is closed by the outer try/finally
  //     (`closeTmpFd`), not by cleanupTmp — keeps fd lifetime in one place.
  const tmpName = `.tmp-${randomBytes(16).toString('hex')}`
  const tmpPath = join(baseReal, tmpName)

  let tmpFd: number | null = null
  const closeTmpFd = (): void => {
    if (tmpFd === null) return
    try {
      closeSync(tmpFd)
    } catch {}
    tmpFd = null
  }

  try {
    try {
      tmpFd = openSync(
        tmpPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
    } catch (err) {
      this.log.error('handleUpload: tmp open failed', { tmpPath }, err)
      this.sendError(res, 500, 'storage open failed')
      req.destroy()
      return
    }
    // Verify the fd actually points to our intended path (parent-symlink
    // race defense). If divergent, the file was created somewhere outside
    // our upload root via a swapped parent symlink — best-effort unlink
    // the bogus dirent via its REAL path (not tmpPath, which now points
    // somewhere else entirely) and fail closed. Disk-leak DoS in the
    // worst case if the unlink races again; not a security boundary
    // violation. Documented in docs/audit-file-toctou.md.
    let tmpFdReal: string
    try {
      tmpFdReal = resolveOpenedPath(tmpFd, tmpPath)
    } catch (err) {
      this.log.error('handleUpload: tmp fd realpath failed', { tmpPath }, err)
      try {
        unlinkSync(tmpPath)
      } catch {}
      this.sendError(res, 500, 'storage verify failed')
      req.destroy()
      return
    }
    if (tmpFdReal !== tmpPath) {
      this.log.warn('handleUpload: tmp fd diverged from intended path', {
        tmpPath,
        tmpFdReal,
      })
      try {
        unlinkSync(tmpFdReal)
      } catch {}
      this.sendError(res, 500, 'storage path diverged')
      req.destroy()
      return
    }

    const ws = createWriteStream(null as unknown as string, { fd: tmpFd, autoClose: false })
    const hash = createHash('sha256')
    let received = 0
    let cleaned = false
    let settled = false
    let resolveWrite: (ok: boolean) => void = () => {}
    const writeDone = new Promise<boolean>((resolveP) => {
      resolveWrite = resolveP
    })
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      resolveWrite(ok)
    }

    const cleanupTmp = (cause?: Error) => {
      if (cleaned) return
      cleaned = true
      try {
        ws.destroy(cause ?? new Error('upload cleanup'))
      } catch {}
      unlink(tmpPath, () => {})
    }

    req.on('aborted', () => {
      cleanupTmp(new Error('client aborted'))
      finish(false)
    })
    req.on('error', (err) => {
      this.log.warn('handleUpload: req error', undefined, err)
      cleanupTmp(err)
      finish(false)
    })
    ws.on('error', (err) => {
      // Triggered either by upstream cleanupTmp() destroying us, or by a real
      // disk write failure. Either way, we're done.
      this.log.warn('handleUpload: write stream error', undefined, err)
      cleanupTmp(err)
      if (!res.headersSent) {
        this.sendError(res, 500, 'write failed')
      }
      finish(false)
    })
    ws.on('finish', () => {
      // Only "happy path" terminator. Note: ws emits 'finish' AFTER the file
      // is fully flushed, so it's safe to fchmod/link in the await-then block.
      finish(true)
    })

    let exceededLimit = false
    req.on('data', (chunk: Buffer) => {
      if (exceededLimit) return
      received += chunk.length
      if (received > MAX_UPLOAD_SINGLE) {
        exceededLimit = true
        if (!res.headersSent) {
          this.sendError(res, 413, `file exceeds ${MAX_UPLOAD_SINGLE / 1024 / 1024}MB`)
        }
        // Order matters: unpipe BEFORE destroying req, so any in-flight data
        // doesn't trigger a write on the destroyed ws (and the corresponding
        // ws.error path which is already handled by cleanupTmp).
        try {
          req.unpipe(ws)
        } catch {}
        cleanupTmp(new Error('upload exceeded MAX_UPLOAD_SINGLE'))
        try {
          req.destroy()
        } catch {}
        finish(false)
        return
      }
      if (declared === undefined && uploadQuotaExceeded(quotaUsed, received)) {
        exceededLimit = true
        if (!res.headersSent) {
          this.sendJson(res, 413, {
            error: uploadQuotaMessage(quotaUsed, received),
            code: 'upload_quota_exceeded',
          })
        }
        try {
          req.unpipe(ws)
        } catch {}
        cleanupTmp(new Error('upload exceeded quota'))
        try {
          req.destroy()
        } catch {}
        finish(false)
        return
      }
      hash.update(chunk)
    })

    // Pipe data into the write stream. ws.finish / ws.error / req.error /
    // req.aborted / size-limit overflow each call finish() exactly once.
    req.pipe(ws)
    const writeOk = await writeDone

    if (!writeOk || cleaned || exceededLimit) {
      // Some error path already responded (413, 500, or req-aborted with no
      // headers). If somehow none has, send a generic abort.
      cleanupTmp()
      if (!res.headersSent && !res.writableEnded) {
        this.sendError(res, 400, 'upload aborted')
      }
      return
    }

    // ── 5. Compute final name + per-user prep + atomic publish ──
    const digest = hash.digest('hex')
    const filenameHint =
      typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : undefined
    const ext = uploadExtForMime(ctype, filenameHint)
    const finalName = `${digest}.${ext}`
    const finalPath = join(baseReal, finalName)

    // 5-remote. Remote-host placement: bytes are still on master's local tmp;
    // ship them to the remote node-agent /files which writes into the user's
    // docker volume on that host. node-agent end does chown(1000:1000)+chmod
    // 0644 via owner_uid/owner_gid/mode query params (equivalent to the local
    // self-host branch below). On success we drop the local staging file.
    //
    // Path-based readFile here is safe: our tmpFd was verified to point at
    // tmpPath above, and remote write is to a root-owned destination that
    // re-validates with node-agent's own AllowedRoots. Worst case if attacker
    // races a parent swap right now: readFile fails or returns attacker
    // content (signed by digest we already computed — would diverge → push
    // succeeds but client sees mismatched bytes, no privilege escalation).
    //
    // Dedup is intentionally not optimized here (no preflight stat) — the
    // remote node-agent's PUT is tmp+fsync+rename, so re-pushing the same
    // digest is safe and the bandwidth cost is bounded by MAX_UPLOAD_SINGLE.
    if (remoteUpload) {
      const remotePath = `${remoteUpload.remoteUploadsDir}/${finalName}`
      const fromPath = this.deps.commercial?.pushRemoteHostUploadFromPath
      try {
        if (fromPath) {
          await fromPath({
            hostUuid: remoteUpload.hostUuid,
            remotePath,
            localPath: tmpPath,
            length: received,
          })
        } else {
          const content = await readFile(tmpPath)
          await this.deps.commercial!.pushRemoteHostUpload!({
            hostUuid: remoteUpload.hostUuid,
            remotePath,
            content,
          })
        }
      } catch (err) {
        this.log.error(
          'handleUpload: push to remote host failed',
          {
            hostUuid: remoteUpload.hostUuid,
            remotePath,
            userId,
          },
          err,
        )
        try {
          unlinkSync(tmpPath)
        } catch {}
        // 502 — upstream (node-agent) failure, distinct from master's own
        // storage failure (500). Frontend retry on this is reasonable.
        this.sendError(res, 502, 'remote storage push failed')
        return
      }
      try {
        unlinkSync(tmpPath)
      } catch {}
      this.sendJson(res, 200, {
        url: `/api/media/${finalName}`,
        digest,
        size: received,
        mimeType: ctype,
      })
      return
    }

    const published = publishOpenedUpload({
      tmpFd,
      tmpPath,
      finalPath,
      isPerUser,
      userId,
      res,
      log: this.log,
      sendError: (response, code, message) => this.sendError(response, code, message),
    })
    if (!published) return

    // Drop tmp dirent. The inode is kept alive by finalPath's hardlink (new
    // publish) or by the prior publisher's dirent (dedup). Our tmpFd stays
    // open until the outer finally; that's fine — unlinked-but-open is
    // standard Unix semantics.
    try {
      unlinkSync(tmpPath)
    } catch {}

    this.sendJson(res, 200, {
      url: `/api/media/${finalName}`,
      digest,
      size: received,
      mimeType: ctype,
    })
  } finally {
    closeTmpFd()
  }
}

export async function handleCollaborationConfig(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (!isEngineLocalTurnExempt()) {
    return this.sendError(res, 404, 'collaboration-config is selfhost only')
  }
  const userId = this.getUserId(req)
  // Selfhost ACCESS / container-proxy / static MCP resolve to 'default' after
  // outer checkHttpAuth (or a valid bridge nonce). That identity owns this
  // uid-volume config; do not remap it onto another uid or treat it as anonymous.
  if (!userId) return this.sendError(res, 401, 'unauthorized')
  const store = this.advisorConfigStore()
  const provenNow = () => {
    const doc = store.read()
    return {
      provenEngines: [...openAdvisorEngines(), ...doc.provenEngines],
      provenCcbModels: doc.provenCcbModels,
    }
  }
  const catalogOptions = async () => {
    try {
      const view = await getLocalCatalogView()
      const proven = provenNow()
      return listProvenAdvisorModels({
        catalog: view.models,
        provenEngines: proven.provenEngines,
        provenCcbModels: proven.provenCcbModels,
      })
    } catch (err) {
      return {
        advisorModels: [] as Array<{ id: string; label: string; engine: string }>,
        advisorUnavailableReason: `catalog unavailable: ${String((err as Error)?.message ?? err)}`,
      }
    }
  }
  if (req.method === 'GET') {
    try {
      const doc = store.read()
      const sessionId = url.searchParams.get('sessionId') ?? undefined
      let parentEngine: string | undefined
      if (sessionId) {
        const parent = await this._parentEngineForCollabSession({ sessionId, userId, req, url })
        if (parent.missing) return this.sendError(res, 404, 'session not found')
        if (parent.agentId !== 'main')
          return this.sendError(res, 400, 'collaboration config is main-only')
        parentEngine = parent.engine
      }
      const resolved = resolveSessionCollab(doc, sessionId)
      const listed = await catalogOptions()
      return this.sendJson(res, 200, {
        rev: doc.rev,
        defaultMode: doc.defaultMode,
        defaultAdvisorModel: doc.defaultAdvisorModel
          ? advisorCanonicalModelId(doc.defaultAdvisorModel)
          : doc.defaultAdvisorModel,
        session: {
          ...resolved,
          advisorModel: resolved.advisorModel
            ? advisorCanonicalModelId(resolved.advisorModel)
            : resolved.advisorModel,
        },
        advisorModels: listed.advisorModels,
        ...this._collaborationCapabilityFields({ sessionId, engine: parentEngine }),
        ...(listed.advisorUnavailableReason
          ? { advisorUnavailableReason: listed.advisorUnavailableReason }
          : {}),
      })
    } catch (err) {
      if (err instanceof CollaborationConfigError && err.code === 'CORRUPT') {
        return this.sendError(
          res,
          500,
          'collaboration config unreadable; original file left intact',
        )
      }
      throw err
    }
  }
  if (req.method !== 'PUT') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: {
    sessionId?: unknown
    mode?: unknown
    advisorModel?: unknown
    expectedRev?: unknown
    asDefault?: unknown
  }
  try {
    parsed = JSON.parse(body) as typeof parsed
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  if (parsed.mode !== 'solo' && parsed.mode !== 'advisor' && parsed.mode !== 'team') {
    return this.sendError(res, 400, 'mode must be solo|advisor|team')
  }
  if (
    parsed.mode === 'advisor' &&
    (typeof parsed.advisorModel !== 'string' || !parsed.advisorModel.trim())
  ) {
    return this.sendError(res, 400, 'advisorModel required')
  }
  let advisorModel =
    parsed.mode === 'advisor' && typeof parsed.advisorModel === 'string'
      ? parsed.advisorModel.trim()
      : null
  const sessionId = typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined
  let parentEngine: string | undefined
  if (sessionId) {
    const parent = await this._parentEngineForCollabSession({ sessionId, userId, req, url })
    if (parent.missing) return this.sendError(res, 404, 'session not found')
    if (parent.agentId !== 'main')
      return this.sendError(res, 400, 'collaboration config is main-only')
    parentEngine = parent.engine
    if (parsed.mode === 'advisor') {
      const gate = advisorConsultParentGate(parentEngine)
      if (!gate.allowed) {
        return this.sendError(res, 409, gate.reason || ADVISOR_CONSULT_PARENT_REASON)
      }
    }
  }
  if (parsed.mode === 'advisor') {
    const listed = await catalogOptions()
    const allowed = assertAdvisorModelAllowed({
      requested: advisorModel ?? '',
      advisorModels: listed.advisorModels,
      unavailableReason: listed.advisorUnavailableReason,
    })
    if (!allowed.ok) {
      const status = listed.advisorUnavailableReason?.startsWith('catalog unavailable') ? 503 : 400
      return this.sendError(res, status, allowed.error)
    }
    advisorModel = allowed.model
  }
  const expectedRev =
    typeof parsed.expectedRev === 'number' && Number.isInteger(parsed.expectedRev)
      ? parsed.expectedRev
      : undefined
  try {
    const next = await store.putIntent({
      sessionId,
      asDefault: parsed.asDefault === true,
      mode: parsed.mode,
      advisorModel,
      expectedRev,
    })
    const listed = await catalogOptions()
    const resolved = resolveSessionCollab(next, sessionId)
    return this.sendJson(res, 200, {
      rev: next.rev,
      defaultMode: next.defaultMode,
      defaultAdvisorModel: next.defaultAdvisorModel
        ? advisorCanonicalModelId(next.defaultAdvisorModel)
        : next.defaultAdvisorModel,
      session: {
        ...resolved,
        advisorModel: resolved.advisorModel
          ? advisorCanonicalModelId(resolved.advisorModel)
          : resolved.advisorModel,
      },
      ...this._collaborationCapabilityFields({ sessionId, engine: parentEngine }),
      advisorModels: listed.advisorModels,
      ...(listed.advisorUnavailableReason
        ? { advisorUnavailableReason: listed.advisorUnavailableReason }
        : {}),
    })
  } catch (err) {
    if (err instanceof CollaborationConfigError) {
      const status = err.code === 'CAS' ? 409 : err.code === 'VALIDATION' ? 400 : 500
      return this.sendError(res, status, err.message)
    }
    throw err
  }
}

export async function handleSearch(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  if (req.method !== 'GET') return this.sendError(res, 405, 'method not allowed')
  const q = url.searchParams.get('q') ?? ''
  const limit = Number(url.searchParams.get('limit') ?? '10')
  if (!q.trim()) {
    this.sendJson(res, 200, { hits: [] })
    return
  }
  try {
    const hits = await searchSessions(q, limit)
    this.sendJson(res, 200, { hits })
  } catch (err) {
    this.sendInternalError(res, err)
  }
}

export async function handleOAuthStart(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  const { provider: oauthProvider } = JSON.parse(body || '{}')
  const providerKey = oauthProvider || 'claude'
  const prov = this.OAUTH_PROVIDERS[providerKey]
  if (!prov) return this.sendError(res, 400, `unknown oauth provider: ${providerKey}`)

  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url')
  const state = randomBytes(16).toString('hex')

  // Limit pending states to prevent abuse
  if (this.oauthPending.size >= 50) {
    const oldest = this.oauthPending.keys().next().value
    if (oldest) this.oauthPending.delete(oldest)
  }
  this.oauthPending.set(state, { codeVerifier, createdAt: Date.now(), provider: providerKey })
  setTimeout(() => this.oauthPending.delete(state), 10 * 60_000)

  const params = new URLSearchParams({
    client_id: prov.clientId,
    redirect_uri: prov.redirect,
    response_type: 'code',
    scope: prov.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    ...(prov.extraParams ?? {}),
  })

  this.sendJson(res, 200, {
    authUrl: `${prov.authUrl}?${params}`,
    state,
    provider: providerKey,
  })
}

export async function handleOAuthCallback(
  this: HttpMiscHandlersHost,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  const { code, state } = parsed
  if (!code || !state) return this.sendError(res, 400, 'code and state required')
  const cleanCode = code.includes('#') ? code.split('#')[0] : code

  const pending = this.oauthPending.get(state)
  if (!pending) return this.sendError(res, 400, 'invalid or expired state')
  this.oauthPending.delete(state)
  const providerKey = (pending as any).provider || 'claude'
  const prov = this.OAUTH_PROVIDERS[providerKey]
  if (!prov) return this.sendError(res, 400, 'unknown provider')
  this.log.info('oauth exchanging code', { provider: providerKey, codeLen: cleanCode.length })

  try {
    const tokenRes = await fetch(prov.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(providerKey === 'claude' ? { 'User-Agent': CLAUDE_OAUTH_USER_AGENT } : {}),
      },
      // 出站硬超时:token 端点挂起时回调请求无限卡(与 commercial refresh.ts 同款收口)。
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: prov.clientId,
        code: cleanCode,
        code_verifier: pending.codeVerifier,
        redirect_uri: prov.redirect,
        ...(providerKey === 'claude' ? { state } : {}),
      }),
    })

    if (!tokenRes.ok) {
      // plan v3 §11(日志脱敏): 不入 log 原 body —— OAuth provider 错误响应
      // 可能含完整 access/refresh token 残片(provider 故障时)、内部 grant
      // 配置或客户的 email/account id。body 仅消费一次以释放 connection,
      // 不输入 logger;只 log status code + bodyLen(用于排查"空 body"等
      // 边界 case)。需要详细 body 时 boss 用 curl 重放 OAuth flow 现场抓。
      const _body = await tokenRes.text().catch(() => '')
      this.log.error('oauth token exchange failed', {
        provider: providerKey,
        status: tokenRes.status,
        bodyLen: _body.length,
      })
      return this.sendError(res, 502, `token exchange failed: ${tokenRes.status}`)
    }

    const tokens = (await tokenRes.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      token_type?: string
    }

    // Save to config (keyed by provider)
    const config = await readConfig()
    if (config) {
      const oauthData = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? '',
        expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        scope: tokens.scope ?? prov.scopes,
      }
      if (providerKey === 'claude') {
        config.auth.claudeOAuth = oauthData
        config.auth.mode = 'subscription'
      }
      await writeConfig(config)
      this.deps.config = config
      this.sessions.updateConfig(config)
      this.log.info('oauth tokens saved', { provider: providerKey })
    }

    this.sendJson(res, 200, {
      ok: true,
      expiresIn: tokens.expires_in,
      scope: tokens.scope,
    })
  } catch (err: any) {
    this.log.error('oauth exchange error', { provider: providerKey }, err)
    // E5 — err.message 可能携带上游 URL/响应片段,只回受控文案(原文已进上行日志)。
    this.sendError(res, 500, 'OAuth 令牌交换失败，请稍后重试')
  }
}

export function refreshClaudeOAuthIfNeeded(
  this: HttpMiscHandlersHost,
  force = false,
): Promise<void> {
  if (this._refreshPromise) {
    if (force && !this._refreshForced) {
      // Upgrade: chain a forced refresh after the in-flight non-forced one
      this._refreshForced = true
      this._refreshPromise = this._refreshPromise.then(() => this._refreshClaudeOAuthImpl(true))
    }
    return this._refreshPromise
  }
  this._refreshForced = force
  this._refreshPromise = this._refreshClaudeOAuthImpl(force).finally(() => {
    this._refreshPromise = null
    this._refreshForced = false
  })
  return this._refreshPromise
}
