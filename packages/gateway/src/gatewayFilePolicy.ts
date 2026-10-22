/**
 * Gateway file / upload / media access policy
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */
import type { fchmodSync, fchownSync, linkSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import {
  hasResolvedPrefix,
  isPathStrictlyUnder,
  isPathWithinRoot,
  openclaudeTempPrefix,
  trustedContainerHome,
} from './pathAcl.js'
import { paths } from '@openclaude/storage'
import { SAFE_UPLOAD_EXTENSION_RE } from './httpUploadStatic.js'

/**
 * Sensitive-file blocklist. Authoritative inventory for both:
 *   1. personal/legacy gateway `/api/file` blocklist
 *   2. **v3 trusted container** `/api/file` ACL (it IS the entire ACL there —
 *      see `isFileAllowed` trusted branch and its contract comment).
 *
 * Adding a new master-injected secret, container-persisted runtime state file,
 * or persistent credential location? It MUST land here in the same PR, with
 * a matching `security.test.ts` case. Cross-references:
 *   - v3supervisor.ts `provisionV3Container` env/mounts
 *   - entrypoint.ts (symlinks, codex-config dir, npmrc/pip.conf user volumes)
 *   - gateway state writers (sessions.db, msg-outbox, retry queues, webhooks)
 */
export const FILE_BLOCKED_PATTERNS = [
  // ── Personal/legacy (predates v3 trusted backend). Kept verbatim. ──
  /openclaude\.json$/, // gateway config with tokens
  /\.env($|\.)/, // .env, .env.local, .env.production, .env.development, etc.
  /credentials/, // credential directory (kept legacy-broad; trusted users accept rare false-positive name collisions)
  /\.ssh/, // SSH keys
  /\.key$/, // private keys
  /\.pem$/, // certificates
  /id_rsa/, // SSH private key
  /id_ed25519/, // SSH private key
  /\.gnupg/, // GPG keys
  /\.password/, // password files
  /shadow$/, // /etc/shadow
  /auth.*token/i, // token files
  /MEMORY\.md$/, // agent long-term memory
  /USER\.md$/, // user identity / core memory (legacy per-agent)
  /(^|\/)user\.md$/, // user-level shared identity / core memory (~/.openclaude/user.md)
  /CLAUDE\.md$/, // agent persona / system instructions
  /resume-map\.json$/, // session checkpoint data
  /\.npmrc$/, // npm registry tokens (top-level)
  /\.pypirc$/, // PyPI credentials
  /\.netrc$/, // FTP/HTTP credentials
  /\.aws\//, // AWS credentials & config directory
  /\.kube\//, // Kubernetes config directory
  /\.docker\/config\.json$/, // Docker registry credentials

  // ── v1.0.193 — trusted backend inventory (Codex review v4: closed-world for v3 container). ──

  // Codex auth + runtime state. `~/.codex/auth.json` is a symlink to
  // `/run/oc/codex-auth/auth.json` (master-injected RO). `~/.codex/` also
  // accumulates sessions/memories/sqlite state — all sensitive.
  /\/auth\.json$/i, // filename-bound (catches both symlink and target)
  /\/\.codex\/sessions\//, // turn-by-turn rollout transcripts
  /\/\.codex\/memories\//, // codex persistent memory
  /\/\.codex\/logs_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/state_[^/]*\.sqlite(-wal|-shm)?$/,
  /\/\.codex\/config\.toml$/, // model/profile + api keys

  // Gateway state files (SQLite + WAL/SHM, JSONL outbox, tasks store).
  /\/sessions\.db(-wal|-shm)?$/,
  /\/msg-outbox\.jsonl$/,
  // taskStore atomically writes `tasks.json` (with `.tmp` swap); fields include
  // prompt + lastOutput + execution output/error → same sensitivity class as
  // session JSONL and outbox.
  /\/tasks\.json(\.tmp)?$/,

  // Gateway YAML configs (agents/cron/webhooks). Webhook secrets are HMAC keys.
  /\/agents\.yaml$/,
  /\/cron\.yaml$/,
  /\/webhooks\.ya?ml$/,

  // Gateway retry queues — server-authored sink payloads (assistant text + tool args).
  /\/v3-master-retry\.d\//,
  /\/v3-wechat-retry\.d\//,

  // Cursor CLI cold-start diagnostics (oc-cursor.sh OPENCLAUDE_CURSOR_AGENT_DEBUG):
  // raw CLI stderr/debug logs may carry prompts, tool args and auth diagnostics.
  /\/logs\/cursor-cli\//,

  // Per-agent session JSONL subtree (thinking + tool args, may embed tokens).
  /\/\.openclaude\/agents\/[^/]+\/sessions\//,

  // Git credentials (git store helper at HOME root + dedicated subdir).
  /\/\.openclaude\/git-creds\//,
  /\/\.git-credentials$/,

  // ScanSci PDF persistent state. PDFs under `papers/` are user work products
  // and remain allowed in v3 trusted mode; config/cookies/browser state are
  // credential-bearing runtime state and must never be served as files.
  /\/\.local\/share\/scansci-pdf\/config\.json$/,
  /\/\.local\/share\/scansci-pdf\/cache\/browser_state\.json$/,
  /\/\.local\/share\/scansci-pdf\/(?:cache\/)?[^/]*(cookie|cookies|token|secret|key)[^/]*\.(json|txt|db|sqlite)$/i,

  // Persistent XDG user config volume (mounted by v3supervisor V3_USER_CONFIG_MOUNT).
  // Carries credential-bearing config for gh / git scoped / npm / pip /
  // vscode-server / arbitrary user dotfiles — see v3supervisor.ts comment on
  // `V3_USER_CONFIG_MOUNT`. **Deny the whole subtree** rather than chasing
  // per-tool XDG paths: false-positives here are config files (not work
  // products), and per-tool allowlist would force this blocklist to track the
  // entire CLI ecosystem forever.
  /\/\.config(\/|$)/,

  // Shell history (may include accidentally-pasted credentials).
  /\.bash_history$/,
  /\.zsh_history$/,

  // Kernel + runtime tmpfs. `/run/oc/*` (master-injected token/auth/sockets)
  // is the primary target; `/proc` + `/sys` + `/var/run` are kept for parity.
  /^\/(proc|sys|run|var\/run)\//,

  // System /etc — agent has no write access inside container; read is 99%
  // attack pattern (e.g. `/etc/shadow`, `/etc/sudoers`, `/etc/hostname`).
  // Note: the trusted branch already scopes to `/home/agent/**` + temp, so
  // this is **belt-and-suspenders** for personal/legacy + direct `/api/file`
  // misuse. Personal/legacy already denies `/etc/*` via missing allowlist;
  // this regex makes the intent explicit and survives any future allowlist
  // change.
  /^\/etc(\/|$)/,
]

/**
 * Returns true if the resolved absolute path falls within the allowlist.
 * Checked BEFORE the blocklist — if this returns false, the file is denied
 * regardless of blocklist status.
 *
 * `extraAllowedPredicate` is the multi-tenant escape hatch — in v3 commercial,
 * callers construct a **user-scoped** closure via `makeUserScopedMediaPredicate`
 * that restricts to the **current request's** `{uploads, generated}` dirs.
 * Critically NOT a global textual predicate that accepts any user's volume
 * paths — that would let user A read user B's docker volume media by
 * absolute path (cross-tenant IDOR).
 */
export function isFileAllowed(
  resolvedPath: string,
  agentCwds?: string[],
  extraAllowedPredicate?: (p: string) => boolean,
): boolean {
  // 0. **Cross-tenant IDOR hard gate**: paths that look like a v3 commercial
  //    per-user docker volume media path may ONLY be admitted by the
  //    request-scoped predicate. The static / temp / agent-cwd branches
  //    below are not uid-aware and would otherwise let user A read user B's
  //    media if any of those branches' allow-shapes overlap a volume path
  //    (e.g. a misconfigured agent cwd pointing at `/var/lib/docker/volumes/
  //    oc-v3-data-uX/_data`). The predicate captures the **current** user's
  //    resolved {uploads, generated} dirs; without it, deny.
  //
  //    Kept BEFORE the trusted-container branch: in trusted container mode
  //    the agent process never sees host-volume paths (it sees its own
  //    `/home/agent/.openclaude/...` mount), so this gate is a no-op there
  //    in practice. But keeping it ahead is fail-closed defense if anyone
  //    ever wires a host-volume path through trusted serve by misconfig.
  if (COMMERCIAL_USER_VOLUME_MEDIA_GATE.test(resolvedPath)) {
    // biome-ignore lint/complexity/useOptionalChain: moved verbatim from server.ts (OCV5-484); pre-existing there
    return Boolean(extraAllowedPredicate && extraAllowedPredicate(resolvedPath))
  }
  // 0b. **v3 trusted backend mode (per-user docker sandbox)** — closed-world.
  //     The container is master-controlled; every secret/credential/state file
  //     under the agent's home is master-injected via known volumes/symlinks
  //     and enumerable. Agent work products may land anywhere under
  //     `/home/agent/...` (cwd / `~/.openclaude/repos/<sess>/<ver>/output.pdf`
  //     / user-named `~/hello.txt` / etc.), so the legacy allowlist is too
  //     narrow and forces agent-prompt-dependent UX (the bug this fix targets).
  //
  //     Switch to **blocklist-only ACL, scoped to `/home/agent/**` + the
  //     openclaude temp prefix**. Anything outside those subtrees (`/etc/*`,
  //     `/opt/openclaude/*` runtime source, `/usr/local/lib/*`, etc.) stays
  //     denied — the trusted bit only loosens the user's own sandbox.
  //
  //     The blocklist is the **single authoritative inventory of download-
  //     sensitive container state** — see `FILE_BLOCKED_PATTERNS`. Any new
  //     master-injected secret or container-runtime persisted state file
  //     must add a matching pattern in the same PR (with a `security.test.ts`
  //     case). v3supervisor.ts and entrypoint.ts cite this contract.
  if (isTrustedContainerFileServeEnabled()) {
    const inHome = isPathWithinRoot(resolvedPath, TRUSTED_CONTAINER_HOME)
    const inTemp = hasResolvedPrefix(resolvedPath, TEMP_PREFIX)
    const inOptExport = OPT_OPENCLAUDE_EXPORT_RE.test(resolvedPath)
    if (!inHome && !inTemp && !inOptExport) return false
    return !isFileBlocked(resolvedPath)
  }
  // 1. Static allowed directories (OPENCLAUDE_HOME, generated/, uploads/)
  for (const dir of FILE_ALLOWED_DIRS) {
    if (isPathWithinRoot(resolvedPath, dir)) return true
  }
  // 2. Temp files matching /tmp/openclaude-*
  if (hasResolvedPrefix(resolvedPath, TEMP_PREFIX)) return true
  // 3. Dynamic agent cwds (if provided) — allow media files and generated/uploads subdirs
  if (agentCwds) {
    for (const raw of agentCwds) {
      if (!raw) continue
      const cwd = resolve(raw)
      if (isPathWithinRoot(resolvedPath, cwd)) {
        // Allow generated/ and uploads/ subdirs unconditionally
        const genSub = join(cwd, 'generated')
        const upSub = join(cwd, 'uploads')
        if (isPathStrictlyUnder(resolvedPath, genSub) || isPathStrictlyUnder(resolvedPath, upSub))
          return true
        // Allow non-executable media file extensions anywhere in CWD
        const ext = extname(resolvedPath).toLowerCase()
        if (MEDIA_EXTENSIONS.has(ext)) return true
      }
    }
  }
  // 4. Extra allowed predicate (user-scoped media dirs for v3 commercial).
  //    Called LAST so failure here doesn't shortcut earlier static-allowlist
  //    matches.
  // biome-ignore lint/complexity/useOptionalChain: moved verbatim from server.ts (OCV5-484); pre-existing there
  if (extraAllowedPredicate && extraAllowedPredicate(resolvedPath)) return true
  return false
}

// ── Exported security helpers (tested in security.test.ts) ──

/**
 * Allowlist of directory prefixes from which /api/file may serve files.
 * Static entries cover well-known locations; dynamic entries (agent cwds)
 * are checked separately via `isFileAllowed()`.
 */
export const FILE_ALLOWED_DIRS: string[] = [
  resolve(paths.generatedDir), // /root/.openclaude/generated/
  resolve(paths.uploadsDir), // /root/.openclaude/uploads/
]

export const MIME_MAP: Record<string, string> = {
  // web
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.wma': 'audio/x-ms-wma',
  // video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
}

/**
 * Resolve claimed MIME + optional original filename to a safe storage suffix.
 * Canonical MIME mappings win. Unknown formats retain a bounded final filename
 * extension when possible, then fall back to a bounded MIME subtype or `bin`.
 * `filenameHint` accepts either raw URL-encoded X-Filename or a plain legacy
 * filename; malformed encoding never rejects the upload.
 */
export function uploadExtForMime(mime: string, filenameHint?: string): string {
  const normalizedMime = mime.split(';')[0].trim().toLowerCase()
  const mapped = safeUploadExtension(UPLOAD_MIME_TO_EXT[normalizedMime])
  if (mapped) return mapped

  if (filenameHint) {
    let decoded = filenameHint
    try {
      decoded = decodeURIComponent(filenameHint)
    } catch {
      // A literal '%' or malformed escape is still safe to inspect because we
      // retain only a bounded alphanumeric suffix, never any path component.
    }
    const finalComponent = decoded.replace(/\\/g, '/').split('/').pop() ?? ''
    const suffix = finalComponent.match(/\.([^.]+)$/)?.[1]
    const fromFilename = safeUploadExtension(suffix)
    if (fromFilename) return fromFilename
  }

  const subtype = normalizedMime.includes('/')
    ? normalizedMime.slice(normalizedMime.indexOf('/') + 1).replace(/[^a-z0-9]/g, '')
    : ''
  return safeUploadExtension(subtype) ?? 'bin'
}

/** MIME → file extension. Used by dispatchInbound (legacy base64 path) and
 *  handleUpload (new streaming endpoint). Kept module-level so both paths
 *  agree on what `<digest>.<ext>` should be. */
export const UPLOAD_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

/**
 * Upload admission is intentionally format-agnostic. Browser MIME values are
 * client-controlled metadata (and `application/octet-stream` already made the
 * old allowlist bypassable), so they are not a security boundary. Safety comes
 * from byte limits, tenant-scoped storage, parser-specific gates, and forcing
 * executable web content to download rather than render inline.
 */
export function isUploadMimeAllowed(_mime: string): boolean {
  return true
}

/**
 * Build a **user-scoped** allowlist predicate restricted to a single user's
 * resolved media dirs. Used by handleApiFile / handleMediaGet to pass through
 * isFileAllowed + openFileHardened.
 *
 * Critical safety property: the closure captures the **current request's**
 * uploads/generated paths. Two simultaneous requests from different uids each
 * get their own predicate; no cross-tenant leakage by absolute path.
 *
 * `dir + '/'` boundary check avoids the `foo/uploads-evil/x` false positive
 * that a naive `startsWith(dir)` would admit. Equality match (`=== dir`) is
 * legitimate because the dir itself is a stat'able directory entry (not a
 * file to serve, but kept for parity with FILE_ALLOWED_DIRS logic).
 */
export function makeUserScopedMediaPredicate(
  uploadsDir: string,
  generatedDir: string,
): (p: string) => boolean {
  const u = resolve(uploadsDir)
  const g = resolve(generatedDir)
  return (p) => isPathWithinRoot(p, u) || isPathWithinRoot(p, g)
}

/**
 * V3 Phase 2 Task 2H: 商业化模块 hook 形状(只声明 gateway 需要的接口,
 * 不依赖 @openclaude/commercial 的具体实现)。
 *
 * - `handle(req, res) → Promise<boolean>`:返 true 表示已处理,gateway 不再继续路由
 * - `handleWsUpgrade(req, socket, head) → boolean`:同上,boolean 表示是否已 upgrade/destroy
 * - `shutdown()`:在 _doShutdown Stage 3.5 调用(channels 之后,sessions 之前)
 * - `internalProxyAddress`:供 /healthz 反映内部代理是否上线
 *
 * 故意不 import @openclaude/commercial — 保持 gateway 包对商业化模块零编译期依赖,
 * cli launcher 负责 dynamic import + 注入。
 */
/**
 * V3 multi-tenant media 路由结果(uploads + generated 双 dir,同一 docker volume)。
 *
 * 故意结构化(kind discriminator + logCtx),不抛错。gateway 自己决定 HTTP 状态码 +
 * 客户端可见 message。这里的字段命名与 commercial/userMedia.ts 的 `UserMediaLocation`
 * 完全一致 —— 类型在 gateway 端本地重复声明只是为了避免 gateway 反向 import commercial。
 *
 * ok 时同时返回 uploads 和 generated 两个子目录,因为它们属于同一 volume,一次
 * inspect 就能确认两者可用,避免 `/api/media` 一次请求里双查 DB+docker。
 */
export type UserMediaLocationLike =
  | { kind: 'ok'; uid: number; uploads: string; generated: string }
  | {
      kind: 'fail'
      reason: 'remote-host'
      /** 与 'ok' 分支同语义,gateway upload 推远端 host 时透传给 hook。 */
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
 * Textual shape of v3 commercial per-user docker volume media paths:
 *   /var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)/...
 *
 * Used as a **hard deny gate** in `isFileAllowed` — any path matching this
 * shape MUST be authorized by the user-scoped predicate (`extraAllowedPredicate`).
 * The static `FILE_ALLOWED_DIRS`, `TEMP_PREFIX`, and agent-CWD branches are NOT
 * allowed to authorize commercial multi-tenant media paths, because those
 * branches are not uid-aware and would re-introduce cross-tenant IDOR if an
 * agent CWD or static dir happened to overlap the volume path shape.
 *
 * Intentionally **broader** than `USER_VOLUME_MEDIA_FILE_REGEX` in
 * commercial/userMedia.ts — this is a fail-closed deny gate, so over-denying
 * the volume path shape is the safe direction:
 *   - matches both the directory itself and any nested file/subpath
 *   - accepts `u0` and leading-zero uids (commercial validates uid form
 *     elsewhere; the gate just refuses to delegate to non-uid-aware branches)
 * Duplicated here so gateway has no reverse import on commercial. If the
 * gate ever needs to match more shapes (e.g. additional subdirs alongside
 * uploads/generated), update both this regex and the commercial-side ones.
 */
// P1d:同时匹配 v3(oc-v3-data)与 v5(oc-v5-data)用户卷媒体路径。这是 fail-closed deny
// gate,over-match 是安全方向 —— 若 v5 路径不被本 gate 捕获,会落到非 uid-aware 的
// FILE_ALLOWED_DIRS/agent-CWD 分支 → v5 媒体跨租户 IDOR。匹配两 channel 前缀即堵死。
export const COMMERCIAL_USER_VOLUME_MEDIA_GATE =
  /^\/var\/lib\/docker\/volumes\/oc-v[35]-data-u\d+\/_data\/(uploads|generated)(\/|$)/

// ─── handleUpload TOCTOU hardening test seam (v3 commercial v1.0.155) ───────
//
// Production calls fchmod / fchown / link via `_uploadFsOps.*` so unit tests
// can simulate failure modes (EPERM on fchown, EXDEV on link, etc.) without
// spinning up real containers or root-side filesystem state. `null` restores
// defaults. Production code MUST NOT call __setUploadFsOpsForTests.
//
// Only operations whose TOCTOU semantics matter for the contract are wrapped
// — openSync / realpathSync / closeSync / fstatSync / unlinkSync remain
// direct because their failure-injection isn't needed by current tests.
//
// Pattern mirrors `__setCodexSpawnForTests` in codexRunner.ts.
export type UploadFsOps = {
  fchmodSync: typeof fchmodSync
  fchownSync: typeof fchownSync
  linkSync: typeof linkSync
}

/** Non-executable media extensions safe to serve from agent CWDs */
export const MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.aac',
  '.flac',
  '.mp4',
  '.webm',
  '.mov',
  '.pdf',
  '.txt',
  '.md',
  '.csv',
  '.json',
  '.log',
])

/**
 * v3 trusted backend mode — agent OS user home root inside the per-user docker
 * container. Hardcoded by container image contract (entrypoint creates this
 * user; v3supervisor mounts the user volume to `/home/agent/.openclaude/`).
 * Used only by the trusted branch of `isFileAllowed`; legacy/personal-version
 * code never references this constant.
 */
export const TRUSTED_CONTAINER_HOME = trustedContainerHome()

/**
 * Call-time check (NOT a module-load const) — tests can flip the env between
 * cases via `process.env.OC_V3_TRUSTED_FILE_SERVE = '1' / delete`.
 * Cost is one string compare per `/api/file` request; negligible.
 */
export function isTrustedContainerFileServeEnabled(): boolean {
  return process.env.OC_V3_TRUSTED_FILE_SERVE === '1'
}

/**
 * v3 Codex sometimes writes a user-requested artifact into its cwd
 * (/opt/openclaude) before reading platform-capabilities. Do not expose the
 * source tree; allow only top-level, non-executable document artifacts.
 */
export const OPT_OPENCLAUDE_EXPORT_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: moved verbatim from server.ts (OCV5-484); pre-existing there
  /^\/opt\/openclaude\/[^/\x00-\x1F\x7F]+\.(?:txt|md|csv|pdf|docx?|xlsx?|pptx?|zip|tar|gz)$/i

/** Temp-file prefix pattern: /tmp/openclaude-* (win32: os.tmpdir()/openclaude-) */
export const TEMP_PREFIX = openclaudeTempPrefix()

/** Returns true if the resolved path matches any sensitive-file pattern. */
export function isFileBlocked(resolvedPath: string): boolean {
  return FILE_BLOCKED_PATTERNS.some((p) => p.test(resolvedPath))
}

export function safeUploadExtension(candidate: string | undefined): string | null {
  if (!candidate) return null
  const normalized = candidate.toLowerCase()
  return SAFE_UPLOAD_EXTENSION_RE.test(normalized) ? normalized : null
}
