/**
 * Commercial master → user-container proxy wiring for zero-turn Office preview:
 *   - GET / POST `/api/file/office-preview`
 *   - GET        `/api/file/office-preview/page?handle=<handle>&page=<index>`
 *
 * Delegates all request/response contract validation & per-uid opaque handle isolation
 * to `officePreviewRoutes.ts`, while executing preview rendering & page image reads inside
 * the authenticated caller's own isolated container via `/internal/office-preview*`.
 *
 * Security invariants:
 *   - Supports Bearer JWT or `oc_session` HttpOnly cookie (for native `<img>` page loads).
 *   - Verifies active account in DB when `v3Supervisor` is wired.
 *   - Never touches or exposes host filesystem paths; container returns opaque
 *     `cph:<containerHandle>:<pageIndex>` tokens mapped through master's per-uid handle registry.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  CONTAINER_PAGE_TOKEN_PREFIX,
  INTERNAL_OFFICE_PREVIEW_PAGE_PATH,
  INTERNAL_OFFICE_PREVIEW_PATH,
} from '@openclaude/gateway'
import { ContainerUnreadyError } from '../ws/userChatBridge.js'
import {
  authenticateActiveCommercialUser,
  authenticateCommercialUser,
} from './activeUserAuth.js'
import type { AuthedUser } from './auth.js'
import {
  ContainerInternalRequestError,
  requestUserContainerInternal,
  type ContainerInternalClientDeps,
} from './containerInternalClient.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import {
  handleOfficePreview,
  handleOfficePreviewPageImage,
  type OfficePreviewPayload,
  type OfficePreviewRouteDeps,
} from './officePreviewRoutes.js'
import { HttpError } from './util.js'

const CONTAINER_PAGE_TOKEN_RE = /^cph:([A-Za-z0-9_-]{16,96}):(\d+)$/

export { authenticateCommercialUser }

export interface CommercialOfficePreviewDeps extends Omit<OfficePreviewRouteDeps, 'jwtSecret'> {
  skipDbActiveCheck?: boolean
  containerClientOverrides?: Partial<ContainerInternalClientDeps>
}

/**
 * N2 (OCV5-832): Sanitize container-returned office preview error messages so raw
 * stderr, stack traces, or container filesystem paths can never reach external callers.
 */
function sanitizeExternalOfficeError(code: string, status: number): string {
  switch (code) {
    case 'INVALID_PATH':
    case 'INVALID_BODY':
      return 'valid file path is required'
    case 'FILE_NOT_FOUND':
    case 'NOT_FOUND':
      return 'preview file or page not found'
    case 'FILE_TOO_LARGE':
      return 'file exceeds maximum preview size'
    case 'UNSUPPORTED_TYPE':
      return 'unsupported file type for office preview'
    case 'PATH_ESCAPE':
    case 'FORBIDDEN':
      return 'access to file path denied'
    case 'SYMLINK_REJECTED':
      return 'symbolic links are not allowed'
    case 'RENDER_TIMEOUT':
      return 'office preview rendering timed out'
    case 'RENDER_FAILED':
      return 'office preview rendering failed'
    case 'RAW_PATH_FORBIDDEN':
      return 'raw filesystem path is not accepted; use preview handle'
    case 'INVALID_HANDLE':
      return 'valid preview handle is required'
    case 'INVALID_PAGE':
      return 'valid positive page index is required'
    default:
      return status === 404
        ? 'preview file not found'
        : status === 403
          ? 'access denied'
          : 'office preview failed'
  }
}

function parseContainerErrorPayload(body: Buffer, status: number): { code: string; message: string } {
  try {
    const parsed = JSON.parse(body.toString('utf8')) as {
      error?: { code?: unknown; message?: unknown }
      code?: unknown
      message?: unknown
    }
    const code =
      typeof parsed?.error?.code === 'string'
        ? parsed.error.code
        : typeof parsed?.code === 'string'
          ? parsed.code
          : status === 404
            ? 'FILE_NOT_FOUND'
            : status === 403
              ? 'FORBIDDEN'
              : 'OFFICE_PREVIEW_FAILED'
    return { code, message: sanitizeExternalOfficeError(code, status) }
  } catch {
    const code = status === 404 ? 'FILE_NOT_FOUND' : 'OFFICE_PREVIEW_FAILED'
    return {
      code,
      message: sanitizeExternalOfficeError(code, status),
    }
  }
}

async function ensureContainerReadyForHttp(
  uid: bigint,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.ensureContainerReady) return
  try {
    await deps.ensureContainerReady(uid)
  } catch (err) {
    if (err instanceof ContainerUnreadyError) {
      throw new HttpError(503, 'CONTAINER_UNREADY', `container not ready: ${err.reason}`, {
        extraHeaders: { 'Retry-After': err.retryAfterSec },
      })
    }
    throw err
  }
}

function buildContainerOfficePreviewDeps(
  deps: CommercialHttpDeps,
  clientOverrides?: Partial<ContainerInternalClientDeps>,
): OfficePreviewRouteDeps {
  const authenticate = async (req: IncomingMessage): Promise<AuthedUser> =>
    authenticateActiveCommercialUser(req, deps.jwtSecret, {
      pool: deps.v3Supervisor?.pool,
      verifyActiveAccount: deps.verifyActiveAccount,
      skipDbActiveCheck: deps.officePreviewRouteDeps?.skipDbActiveCheck,
    })

  // Allow unit tests to inject direct route deps (previewImpl / readPageImageImpl / handleRegistry).
  if (deps.officePreviewRouteDeps?.previewImpl || deps.officePreviewRouteDeps?.readPageImageImpl) {
    return {
      jwtSecret: deps.jwtSecret,
      authenticate,
      ...deps.officePreviewRouteDeps,
    }
  }

  if (!deps.v3Supervisor || !deps.bridgeSecret) {
    return {
      jwtSecret: deps.jwtSecret,
      authenticate,
      handleRegistry: deps.officePreviewRouteDeps?.handleRegistry,
    }
  }

  const clientDeps: ContainerInternalClientDeps = {
    v3: deps.v3Supervisor,
    bridgeSecret: deps.bridgeSecret,
    selfHostId: deps.v3Supervisor.selfHostId,
    ...clientOverrides,
    ...deps.officePreviewRouteDeps?.containerClientOverrides,
  }

  return {
    jwtSecret: deps.jwtSecret,
    authenticate,
    handleRegistry: deps.officePreviewRouteDeps?.handleRegistry,
    previewImpl: async (userId, filePath, opts): Promise<OfficePreviewPayload> => {
      const uid = BigInt(userId)
      await ensureContainerReadyForHttp(uid, deps)
      const params = new URLSearchParams({ path: filePath })
      if (opts.maxRowsPerSheet !== undefined) {
        params.set('maxRowsPerSheet', String(opts.maxRowsPerSheet))
      }
      try {
        const resp = await requestUserContainerInternal(clientDeps, {
          uid,
          method: 'GET',
          pathAndQuery: `${INTERNAL_OFFICE_PREVIEW_PATH}?${params.toString()}`,
        })
        if (resp.status !== 200) {
          const errInfo = parseContainerErrorPayload(resp.body, resp.status)
          throw new HttpError(resp.status, errInfo.code, errInfo.message)
        }
        const parsed = JSON.parse(resp.body.toString('utf8')) as { preview?: OfficePreviewPayload }
        if (!parsed || !parsed.preview) {
          throw new HttpError(502, 'BAD_GATEWAY', 'invalid office preview payload from container')
        }
        return parsed.preview
      } catch (err) {
        if (err instanceof ContainerInternalRequestError) {
          throw new HttpError(err.httpStatus, err.code, err.message)
        }
        throw err
      }
    },
    readPageImageImpl: async (userId, imgPath) => {
      if (!imgPath.startsWith(CONTAINER_PAGE_TOKEN_PREFIX)) {
        throw new HttpError(400, 'INVALID_HANDLE', 'invalid container preview page token')
      }
      const m = CONTAINER_PAGE_TOKEN_RE.exec(imgPath)
      if (!m) {
        throw new HttpError(400, 'INVALID_HANDLE', 'malformed container preview page token')
      }
      const [, containerHandle, pageStr] = m
      const uid = BigInt(userId)
      await ensureContainerReadyForHttp(uid, deps)
      const params = new URLSearchParams({ handle: containerHandle!, page: pageStr! })
      try {
        const resp = await requestUserContainerInternal(clientDeps, {
          uid,
          method: 'GET',
          pathAndQuery: `${INTERNAL_OFFICE_PREVIEW_PAGE_PATH}?${params.toString()}`,
        })
        if (resp.status === 404) return null
        if (resp.status !== 200) {
          const errInfo = parseContainerErrorPayload(resp.body, resp.status)
          throw new HttpError(resp.status, errInfo.code, errInfo.message)
        }
        const rawCt = (resp.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
        const contentType =
          rawCt === 'image/jpeg' ? 'image/jpeg' : rawCt === 'image/png' ? 'image/png' : null
        if (!contentType) {
          throw new HttpError(502, 'BAD_GATEWAY', 'unexpected preview page content-type from container')
        }
        return { bytes: resp.body, contentType }
      } catch (err) {
        if (err instanceof ContainerInternalRequestError) {
          throw new HttpError(err.httpStatus, err.code, err.message)
        }
        throw err
      }
    },
  }
}

export async function handleCommercialOfficePreview(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const routeDeps = buildContainerOfficePreviewDeps(deps)
  await handleOfficePreview(req, res, ctx, routeDeps)
}

export async function handleCommercialOfficePreviewPage(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const routeDeps = buildContainerOfficePreviewDeps(deps)
  await handleOfficePreviewPageImage(req, res, ctx, routeDeps)
}
