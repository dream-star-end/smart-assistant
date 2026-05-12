/**
 * v3 commercial multi-tenant media routing.
 *
 * Plan B (2026-05-09) `/api/uploads` shipped a single-tenant assumption:
 * master writes to its own `paths.uploadsDir` (= `/root/.openclaude/uploads/`).
 * That breaks v3 commercial because dispatchInbound runs inside each user's
 * docker container and resolves media URLs against the container's local
 * `paths.uploadsDir` (= `/home/agent/.openclaude/uploads/`). Different
 * physical paths → `rejectFrame('媒体不存在或不可读')` regression.
 *
 * 2026-05-12 同型问题在 `generated/` 子目录复现:codex `image_gen` 在容器内
 * 写到 `paths.generatedDir` (= 容器视图 `/home/agent/.openclaude/generated/`,
 * 即 user volume `_data/generated/`),但 master gateway 的 `/api/media` 读
 * `paths.generatedDir` (= master 视图 `/root/.openclaude/generated/`),那里
 * 是空的 → 404。
 *
 * 本模块把存储权威源搬到用户 docker volume 的宿主路径,**两个子目录用同一次
 * 一致性检查**(DB active container + docker getVolume inspect)绑定:
 *
 *   master view  : /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/uploads/<file>
 *                  /var/lib/docker/volumes/oc-v3-data-u<uid>/_data/generated/<file>
 *   container view: /home/agent/.openclaude/uploads/<file>   (同 inode)
 *                   /home/agent/.openclaude/generated/<file>  (同 inode)
 *
 * 同一 docker volume,所以一次 inspect 就能确认两个 dir 都"可用",避免
 * `/api/media` 一次请求双查 DB+docker。
 *
 * 被 gateway 通过 `CommercialHook.resolveUserMediaDirs` 消费;它是 master
 * gateway 多租户路径路由的**唯一权威源**:
 *   - 写路径(handleUpload)用 `result.uploads`
 *   - 读路径(handleMediaGet)在 `[uploads, generated]` 两 dir 中查找
 *   - allowlist 用 closure 把 `(p) => p in uploads∪generated` 作为 user-scoped
 *     extraAllowedPredicate 传给 isFileAllowed(避免上一版 textual 全局谓词
 *     被 cross-tenant 滥用的 IDOR 风险)
 *
 * Fail-closed 分支(无 silent fallback):
 *   - invalid-uid    : userId not in `c:<digits>` shape (1-19 digit positive)
 *   - not-ready      : user has no active container yet (provisioning window)
 *   - remote-host    : container is on a non-self compute host (deferred to
 *                      node-agent push channel work; not implemented yet)
 *   - volume-missing : DB says active but docker volume doesn't exist
 *                      (data corruption / volume GC race)
 *   - ambiguous      : multiple active containers (data corruption)
 *   - daemon-error   : docker daemon unreachable / non-404 inspect error
 */

import type Docker from "dockerode";
import type { Pool } from "pg";
import { v3VolumeNameFor } from "./v3supervisor.js";

/** Per-user media dir prefix on master (docker volume host path). */
export const USER_VOLUME_MEDIA_HOST_PREFIX = "/var/lib/docker/volumes";

/** Subpath under `<volume-name>/` for uploads. */
export const USER_VOLUME_UPLOADS_SUBPATH = "_data/uploads";

/** Subpath under `<volume-name>/` for codex/agent generated output. */
export const USER_VOLUME_GENERATED_SUBPATH = "_data/generated";

/**
 * Discriminates the two media subdirs that live in the same user docker volume.
 * Keep this enum small — adding a third kind means adding a new subpath
 * constant + extending the regex below.
 */
export type MediaKind = "uploads" | "generated";

/**
 * Strict canonical regex for the master-side host path of a user's media
 * directory (either subdir). Public + exported so the gateway can reuse the
 * same source of truth when iterating user volumes for orphan sweeps.
 *
 *   /var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)
 *
 * No trailing slash, no trailing junk — callers should `realpathSync` first,
 * which strips trailing slashes. Digits = 1-19 positive (matches
 * v3VolumeNameFor's `Number.isInteger && >0` invariant, since 2^63 fits in
 * 19 digits).
 */
export const USER_VOLUME_MEDIA_DIR_REGEX =
  /^\/var\/lib\/docker\/volumes\/oc-v3-data-u([1-9][0-9]{0,18})\/_data\/(uploads|generated)$/;

/** Strict regex over the trailing component (uid + filename) under the dir. */
export const USER_VOLUME_MEDIA_FILE_REGEX =
  /^\/var\/lib\/docker\/volumes\/oc-v3-data-u([1-9][0-9]{0,18})\/_data\/(uploads|generated)\/[^/]+$/;

/**
 * Build the master-side host path for a user's media subdirectory.
 * Synchronous + pure (no I/O); validates uid format. Throws on invalid uid.
 *
 *   buildUserMediaHostDir(42, 'uploads')   === "/var/lib/docker/volumes/oc-v3-data-u42/_data/uploads"
 *   buildUserMediaHostDir(42, 'generated') === "/var/lib/docker/volumes/oc-v3-data-u42/_data/generated"
 *
 * NOTE: This does NOT verify the docker volume exists. Callers that need
 * the volume to exist (= active container path) should use the full
 * `createUserMediaResolver` resolver which adds docker volume inspect.
 */
export function buildUserMediaHostDir(uid: number, kind: MediaKind): string {
  const volume = v3VolumeNameFor(uid); // validates uid > 0, integer
  const subpath =
    kind === "uploads"
      ? USER_VOLUME_UPLOADS_SUBPATH
      : USER_VOLUME_GENERATED_SUBPATH;
  return `${USER_VOLUME_MEDIA_HOST_PREFIX}/${volume}/${subpath}`;
}

/**
 * Parse a userId of the form `c:<sub>` produced by Gateway.getUserId() for
 * commercial users. Returns the numeric uid on success, null on any of:
 *   - userId === 'default' (legacy single-token auth)
 *   - userId not starting with 'c:'
 *   - sub doesn't match strict positive-integer regex (1-19 digits, no
 *     leading zeros, no signs, no whitespace, no path traversal chars)
 *
 * Reject reasons (deliberately strict):
 *   - 'c:0'        → null (zero invalid for v3VolumeNameFor)
 *   - 'c:001'      → null (leading-zero canonicalization ambiguity)
 *   - 'c:-1'       → null (sign char)
 *   - 'c:42/../x'  → null (path traversal attempt)
 *   - 'c:42\n'     → null (control char)
 *   - 'c:'         → null (empty sub)
 *   - sub > Number.MAX_SAFE_INTEGER (2^53 - 1) → null (lossy Number parse
 *     would break identity round-trip)
 *   - 'c:1' .. 'c:<MAX_SAFE_INTEGER>' → uid integer
 *
 * MUST be exported so handleUpload tests can verify reject behavior without
 * spinning up the full resolver.
 */
export function parseCommercialUid(userId: string): number | null {
  if (!userId.startsWith("c:")) return null;
  const sub = userId.slice(2);
  if (!/^[1-9][0-9]{0,18}$/.test(sub)) return null;
  // Fail-closed on lossy Number parse: a 19-digit BIGINT > 2^53 - 1 would
  // round through Number() and produce a uid that no longer matches the JWT
  // sub → agent_containers.user_id → docker volume name. The identity chain
  // must round-trip exactly. Reject anything > MAX_SAFE_INTEGER.
  // (Postgres BIGSERIAL grows monotonically from 1, so in practice this gate
  // never fires for real users — it's defense against malformed/abusive sub
  // claims, not a realistic capacity ceiling.)
  const uidBig = BigInt(sub);
  if (uidBig > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const uid = Number(uidBig);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return uid;
}

export type UserMediaLocation =
  | { kind: "ok"; uid: number; uploads: string; generated: string }
  | {
      kind: "fail";
      reason:
        | "invalid-uid"
        | "not-ready"
        | "remote-host"
        | "volume-missing"
        | "ambiguous"
        | "daemon-error";
      logCtx: Record<string, unknown>;
    };

interface ActiveContainerRow {
  /** compute_hosts.name — `'self'` only allowed; anything else → remote-host. */
  hostName: string;
  containerId: string | number;
}

/**
 * Pool query helper interface — declared narrow so tests can inject a stub
 * without pulling in the full pg.Pool surface area.
 */
export interface PoolLike {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
}

/**
 * Docker client interface — narrowed to just what we need from dockerode.
 * Tests inject a stub; production passes the same `Docker` instance the
 * commercial bootstrap created.
 */
export interface DockerLike {
  getVolume(name: string): {
    inspect(): Promise<unknown>;
  };
}

/**
 * Build a resolver function that gateway can call without knowing anything
 * about pg.Pool or dockerode. Returns a closure capturing the deps so we can
 * inject test stubs cleanly.
 *
 *   const resolve = createUserMediaResolver({ pool, docker });
 *   const loc = await resolve('c:42');
 *   // loc.kind === 'ok' → loc.uploads, loc.generated 都可用(同一 volume)
 *
 * 单次 DB + docker inspect 解决两个子目录的一致性检查 —— 避免 /api/media
 * 一次请求双查。如果 uploads 通过那 generated 也必然通过(同一 volume)。
 */
export function createUserMediaResolver(deps: {
  pool: PoolLike;
  docker: DockerLike;
}): (userId: string) => Promise<UserMediaLocation> {
  return async function resolveUserMediaDirs(
    userId: string,
  ): Promise<UserMediaLocation> {
    const uid = parseCommercialUid(userId);
    if (uid === null) {
      // Note: 'default' (legacy single-token) is NOT routed here — the gateway
      // checks the userId upstream and falls back to paths.uploadsDir. So
      // anything reaching this resolver but not parsing is genuinely invalid.
      return {
        kind: "fail",
        reason: "invalid-uid",
        logCtx: { userId: redactUserId(userId) },
      };
    }

    // ── DB: enumerate active containers for this user ──
    // JOIN compute_hosts to surface the host name (the only authoritative
    // self/remote discriminator — never trust c.host_id presence alone).
    // state='active' is the same filter v3supervisor uses for "user-owned
    // live container". Multiple active rows = data corruption; fail-closed
    // because picking one arbitrarily would let split-brain hide.
    let rows: { host_name: string; container_id: string }[];
    try {
      const res = await deps.pool.query<{
        host_name: string;
        container_id: string;
      }>(
        `SELECT h.name AS host_name, c.id::text AS container_id
           FROM agent_containers c
           JOIN compute_hosts h ON c.host_uuid = h.id
          WHERE c.user_id = $1 AND c.state = 'active'`,
        [uid],
      );
      rows = res.rows;
    } catch (err) {
      return {
        kind: "fail",
        reason: "daemon-error",
        logCtx: { uid, stage: "pg-query", err: stringifyErr(err) },
      };
    }

    if (rows.length === 0) {
      return { kind: "fail", reason: "not-ready", logCtx: { uid } };
    }
    if (rows.length > 1) {
      return {
        kind: "fail",
        reason: "ambiguous",
        logCtx: {
          uid,
          activeCount: rows.length,
          containerIds: rows.map((r) => r.container_id),
        },
      };
    }

    const row: ActiveContainerRow = {
      hostName: rows[0].host_name,
      containerId: rows[0].container_id,
    };
    if (row.hostName !== "self") {
      return {
        kind: "fail",
        reason: "remote-host",
        logCtx: { uid, host: row.hostName, containerId: row.containerId },
      };
    }

    // ── Docker: verify volume exists ──
    // active-on-self ⇒ supervisor should have created the volume. If it
    // doesn't exist, either GC ran ahead of state transition or DB has
    // stale state. Either way fail-closed; admin investigates.
    const volumeName = v3VolumeNameFor(uid);
    try {
      await deps.docker.getVolume(volumeName).inspect();
    } catch (err) {
      if (isDockerNotFound(err)) {
        return {
          kind: "fail",
          reason: "volume-missing",
          logCtx: { uid, volume: volumeName },
        };
      }
      return {
        kind: "fail",
        reason: "daemon-error",
        logCtx: {
          uid,
          stage: "docker-inspect",
          volume: volumeName,
          err: stringifyErr(err),
        },
      };
    }

    return {
      kind: "ok",
      uid,
      uploads: buildUserMediaHostDir(uid, "uploads"),
      generated: buildUserMediaHostDir(uid, "generated"),
    };
  };
}

/**
 * Predicate: does this resolved path belong to ANY user's media volume?
 *
 * **Caveat — not user-scoped**: 只判定路径形态,不判定 uid 是否等于调用方。
 * 当前唯一合法用途是启动时 `.tmp-*` orphan sweep(那里无 userId 上下文,只想
 * 匹配目录壳子)。gateway HTTP handler **不要**用它做 allowlist,会引入
 * cross-tenant IDOR(用户 A 拿到用户 B 的绝对路径就能读) —— 那里应该用
 * resolver 拿到的当前用户 `{uploads, generated}` 两 dir 自己 closure。
 *
 * Strict — only matches paths of the exact shape
 * `/var/lib/docker/volumes/oc-v3-data-u<digits>/_data/(uploads|generated)[/<file>]`.
 * Callers are still responsible for verifying the path via realpathSync
 * before opening; this is a textual gate, not a TOCTOU defense.
 */
export function isUserVolumeMediaPath(resolvedPath: string): boolean {
  return (
    USER_VOLUME_MEDIA_DIR_REGEX.test(resolvedPath) ||
    USER_VOLUME_MEDIA_FILE_REGEX.test(resolvedPath)
  );
}

// ─── internal helpers ───────────────────────────────────────────────────

function isDockerNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "statusCode" in err &&
    (err as { statusCode: number }).statusCode === 404
  );
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Truncate possibly-attacker-controlled userId before logging. Avoids log
 * injection if userId carries newlines / control bytes — the gateway already
 * derives userId from a verified JWT, but defense in depth.
 */
function redactUserId(userId: string): string {
  // eslint-disable-next-line no-control-regex
  return userId.replace(/[\x00-\x1f\x7f]/g, "?").slice(0, 64);
}
