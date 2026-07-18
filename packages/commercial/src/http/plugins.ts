import type { IncomingMessage, ServerResponse } from 'node:http'

import { PluginAccountLeaseError } from '../plugins/accountLease.js'
import { PluginAccountError } from '../plugins/accounts.js'
import type { KnowledgePlanetAutomationService } from '../plugins/knowledgePlanetAutomation.js'
import { KnowledgePlanetAutomationError } from '../plugins/knowledgePlanetAutomation.js'
import type { KnowledgePlanetSetupManager } from '../plugins/knowledgePlanetSetup.js'
import { KnowledgePlanetSetupError } from '../plugins/knowledgePlanetSetup.js'
import type { PluginRuntimeFacade } from '../plugins/runtime.js'
import { PluginRuntimeFacadeError } from '../plugins/runtime.js'
import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

export interface PluginHttpDeps {
  pluginRuntime?: PluginRuntimeFacade
  knowledgePlanetSetup?: KnowledgePlanetSetupManager
  knowledgePlanetAutomation?: KnowledgePlanetAutomationService
}

function userIdFrom(value: string): number {
  if (!/^\d{1,16}$/.test(value)) throw new HttpError(401, 'UNAUTHORIZED', 'invalid user')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(401, 'UNAUTHORIZED', 'invalid user')
  return id
}

function setupManager(deps: CommercialHttpDeps & PluginHttpDeps): KnowledgePlanetSetupManager {
  if (!deps.knowledgePlanetSetup)
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  return deps.knowledgePlanetSetup
}

function runtime(deps: CommercialHttpDeps & PluginHttpDeps): PluginRuntimeFacade {
  if (!deps.pluginRuntime)
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  return deps.pluginRuntime
}

function automation(deps: CommercialHttpDeps & PluginHttpDeps): KnowledgePlanetAutomationService {
  if (!deps.knowledgePlanetAutomation)
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin automation unavailable')
  return deps.knowledgePlanetAutomation
}

function mapAutomationError(error: unknown): never {
  if (!(error instanceof KnowledgePlanetAutomationError)) throw error
  switch (error.code) {
    case 'BAD_REQUEST':
    case 'CONSENT_REQUIRED':
      throw new HttpError(400, error.code, 'Knowledge Planet automation request is invalid')
    case 'NOT_FOUND':
      throw new HttpError(404, error.code, 'Knowledge Planet automation target not found')
    case 'CONFLICT':
    case 'WRITE_DISABLED':
      throw new HttpError(409, error.code, 'Knowledge Planet automation state conflicts')
    default:
      throw new HttpError(503, error.code, 'Knowledge Planet automation unavailable')
  }
}

function exactBodyKeys(body: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed)
  return Object.keys(body).every((key) => allow.has(key))
}

function mapSetupError(error: unknown): never {
  if (!(error instanceof KnowledgePlanetSetupError)) throw error
  switch (error.code) {
    case 'NOT_INSTALLED':
      throw new HttpError(403, error.code, 'Knowledge Planet Plugin is not installed')
    case 'SETUP_ACTIVE':
    case 'ACCOUNT_ALREADY_EXISTS':
      throw new HttpError(409, error.code, 'Knowledge Planet account setup conflicts')
    case 'SETUP_NOT_FOUND':
    case 'QR_NOT_READY':
      throw new HttpError(404, error.code, 'Knowledge Planet setup not found')
    case 'TERMS_REQUIRED':
      throw new HttpError(400, error.code, 'terms acceptance is required')
    case 'CAPACITY_EXCEEDED':
      throw new HttpError(429, error.code, 'Plugin setup capacity is full')
    case 'CLOSING':
    case 'UNAVAILABLE':
      throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
    default:
      throw new HttpError(500, 'PLUGIN_SETUP_FAILED', 'Plugin setup failed')
  }
}

function mapRuntimeError(error: unknown): never {
  if (error instanceof PluginRuntimeFacadeError) {
    switch (error.code) {
      case 'BAD_REQUEST':
        throw new HttpError(400, error.code, 'invalid Plugin request')
      case 'TARGET_NOT_FOUND':
        throw new HttpError(404, error.code, 'Plugin account not found')
      case 'TARGET_STALE':
        throw new HttpError(409, error.code, 'Plugin account changed; retry')
      case 'WRITE_DISABLED':
      case 'WRITE_REQUIRES_CONFIRMATION':
        throw new HttpError(409, error.code, 'Plugin writes are not enabled')
      case 'RUNTIME_BUSY':
        throw new HttpError(429, error.code, 'Plugin runtime is busy')
      case 'RELINK_REQUIRED':
        throw new HttpError(401, error.code, 'Plugin account must be authorized again')
      default:
        throw new HttpError(503, error.code, 'Plugin runtime unavailable')
    }
  }
  if (error instanceof PluginAccountLeaseError) {
    if (error.code === 'LEASE_BUSY')
      throw new HttpError(409, error.code, 'Plugin account is currently in use')
    throw new HttpError(503, error.code, 'Plugin account lease unavailable')
  }
  if (error instanceof PluginAccountError) {
    if (error.code === 'ACCOUNT_NOT_FOUND' || error.code === 'ACCOUNT_REVOKED')
      throw new HttpError(404, 'TARGET_NOT_FOUND', 'Plugin account not found')
    if (error.code === 'ACCOUNT_STALE')
      throw new HttpError(409, 'TARGET_STALE', 'Plugin account changed; retry')
    throw new HttpError(503, 'PLUGIN_RUNTIME_UNAVAILABLE', 'Plugin runtime unavailable')
  }
  throw error
}

function setupMatch(path: string): { sessionId: string; qr: boolean } | null {
  const match = /^\/api\/plugins\/knowledge-planet\/setup\/([0-9a-f-]{36})(\/qr)?$/.exec(path)
  return match ? { sessionId: match[1]!, qr: match[2] === '/qr' } : null
}

export async function dispatchPluginsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps & PluginHttpDeps,
): Promise<void> {
  const user = await requireAuth(req, deps.jwtSecret)
  const userId = userIdFrom(user.id)
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x.invalid'}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (method === 'GET' && (path === '/api/plugins' || path === '/api/plugins/management')) {
    sendJson(res, 200, await runtime(deps).management(userId))
    return
  }

  if (method === 'POST' && path === '/api/plugins/knowledge-planet/setup') {
    const body = await readJsonBody(req, 1024)
    if (
      body === null ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== 'acceptTerms')
    )
      throw new HttpError(400, 'BAD_REQUEST', 'body must contain only acceptTerms')
    try {
      const setup = await setupManager(deps).start(
        userId,
        (body as Record<string, unknown>).acceptTerms === true,
      )
      sendJson(res, 201, setup)
      return
    } catch (error) {
      mapSetupError(error)
    }
  }

  const account = /^\/api\/plugins\/accounts\/(\d{1,16})$/.exec(path)
  if (account && method === 'DELETE') {
    try {
      sendJson(res, 200, {
        ...(await runtime(deps).revokeManagedAccount(userId, account[1]!)),
        status: 'revoked',
      })
      return
    } catch (error) {
      mapRuntimeError(error)
    }
  }

  const writeAccess = /^\/api\/plugins\/accounts\/(\d{1,16})\/write-access$/.exec(path)
  if (writeAccess && method === 'PATCH') {
    const body = await readJsonBody(req, 2048)
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'BAD_REQUEST', 'write access body must be an object')
    const value = body as Record<string, unknown>
    const keys = Object.keys(value).sort()
    const enabled = value.enabled
    const validDisable = enabled === false && keys.join('\0') === 'enabled'
    const validEnable =
      enabled === true &&
      value.accepted === true &&
      Number.isInteger(value.disclaimerVersion) &&
      keys.join('\0') === ['accepted', 'disclaimerVersion', 'enabled'].join('\0')
    if (!validDisable && !validEnable)
      throw new HttpError(400, 'BAD_REQUEST', 'write access body is invalid')
    try {
      const writeControl = await runtime(deps).setManagedAccountWriteAccess({
        userId,
        targetId: writeAccess[1]!,
        enabled: enabled as boolean,
        ...(validEnable
          ? {
              accepted: true as const,
              disclaimerVersion: Number(value.disclaimerVersion),
            }
          : {}),
      })
      sendJson(res, 200, { writeControl })
      return
    } catch (error) {
      mapRuntimeError(error)
    }
  }

  const writePreapproval =
    /^\/api\/plugins\/accounts\/(\d{1,16})\/write-preapproval$/.exec(path)
  if (writePreapproval && method === 'PATCH') {
    const body = await readJsonBody(req, 2048)
    if (body === null || typeof body !== 'object' || Array.isArray(body))
      throw new HttpError(400, 'BAD_REQUEST', 'write preapproval body must be an object')
    const value = body as Record<string, unknown>
    const keys = Object.keys(value).sort()
    const enabled = value.enabled
    const validDisable = enabled === false && keys.join('\0') === 'enabled'
    const validEnable =
      enabled === true &&
      value.accepted === true &&
      Number.isInteger(value.disclaimerVersion) &&
      keys.join('\0') === ['accepted', 'disclaimerVersion', 'enabled'].join('\0')
    if (!validDisable && !validEnable)
      throw new HttpError(400, 'BAD_REQUEST', 'write preapproval body is invalid')
    try {
      const writeControl = await runtime(deps).setManagedAccountWritePreapproval({
        userId,
        targetId: writePreapproval[1]!,
        enabled: enabled as boolean,
        ...(validEnable
          ? {
              accepted: true as const,
              disclaimerVersion: Number(value.disclaimerVersion),
            }
          : {}),
      })
      sendJson(res, 200, { writeControl })
      return
    } catch (error) {
      mapRuntimeError(error)
    }
  }

  const automationRoot = /^\/api\/plugins\/accounts\/(\d{1,16})\/automation$/.exec(path)
  if (automationRoot && method === 'GET') {
    try {
      sendJson(res, 200, await automation(deps).get(userId, automationRoot[1]!))
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }
  if (automationRoot && method === 'PATCH') {
    const raw = await readJsonBody(req, 4096)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new HttpError(400, 'BAD_REQUEST', 'automation body must be an object')
    const body = raw as Record<string, unknown>
    if (
      typeof body.enabled !== 'boolean' ||
      !exactBodyKeys(body, ['enabled', 'accepted', 'disclaimerVersion', 'accountDailyLimit']) ||
      (body.enabled === true &&
        (body.accepted !== true || !Number.isInteger(body.disclaimerVersion))) ||
      (body.enabled === false &&
        (body.accepted !== undefined || body.disclaimerVersion !== undefined)) ||
      (body.accountDailyLimit !== undefined && !Number.isInteger(body.accountDailyLimit))
    )
      throw new HttpError(400, 'BAD_REQUEST', 'automation body is invalid')
    try {
      const control = await automation(deps).setControl({
        userId,
        targetId: automationRoot[1]!,
        enabled: body.enabled,
        ...(body.accountDailyLimit !== undefined
          ? { accountDailyLimit: Number(body.accountDailyLimit) }
          : {}),
        ...(body.enabled === true
          ? {
              accepted: true,
              disclaimerVersion: Number(body.disclaimerVersion),
            }
          : {}),
      })
      sendJson(res, 200, { control })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }

  const automationGroups =
    /^\/api\/plugins\/accounts\/(\d{1,16})\/automation\/groups$/.exec(path)
  if (automationGroups && method === 'GET') {
    try {
      const groups = await automation(deps).listGroups(userId, automationGroups[1]!)
      sendJson(res, 200, { groups })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }

  const automationRulesBatch =
    /^\/api\/plugins\/accounts\/(\d{1,16})\/automation\/rules\/batch$/.exec(path)
  if (automationRulesBatch && method === 'POST') {
    const raw = await readJsonBody(req, 16 * 1024)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule batch body must be an object')
    const body = raw as Record<string, unknown>
    if (
      !Array.isArray(body.groupIds) ||
      body.groupIds.some((value) => typeof value !== 'string') ||
      typeof body.name !== 'string' ||
      typeof body.instructions !== 'string' ||
      (body.triggerKind !== undefined && typeof body.triggerKind !== 'string') ||
      (body.dailyLimit !== undefined && !Number.isInteger(body.dailyLimit)) ||
      (body.cooldownMinutes !== undefined && !Number.isInteger(body.cooldownMinutes)) ||
      (body.maxReplyChars !== undefined && !Number.isInteger(body.maxReplyChars)) ||
      !exactBodyKeys(body, [
        'groupIds',
        'name',
        'instructions',
        'triggerKind',
        'dailyLimit',
        'cooldownMinutes',
        'maxReplyChars',
      ])
    )
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule batch body is invalid')
    try {
      const rules = await automation(deps).createRulesBatch({
        userId,
        targetId: automationRulesBatch[1]!,
        groupIds: body.groupIds as string[],
        name: body.name,
        instructions: body.instructions,
        ...(body.triggerKind !== undefined
          ? { triggerKind: body.triggerKind as 'new_topic' | 'new_question' }
          : {}),
        ...(body.dailyLimit !== undefined ? { dailyLimit: Number(body.dailyLimit) } : {}),
        ...(body.cooldownMinutes !== undefined
          ? { cooldownMinutes: Number(body.cooldownMinutes) }
          : {}),
        ...(body.maxReplyChars !== undefined ? { maxReplyChars: Number(body.maxReplyChars) } : {}),
      })
      sendJson(res, 201, { rules })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }

  const automationRules = /^\/api\/plugins\/accounts\/(\d{1,16})\/automation\/rules$/.exec(path)
  if (automationRules && method === 'POST') {
    const raw = await readJsonBody(req, 16 * 1024)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule body must be an object')
    const body = raw as Record<string, unknown>
    if (
      typeof body.groupId !== 'string' ||
      typeof body.name !== 'string' ||
      typeof body.instructions !== 'string' ||
      (body.triggerKind !== undefined && typeof body.triggerKind !== 'string') ||
      (body.dailyLimit !== undefined && !Number.isInteger(body.dailyLimit)) ||
      (body.cooldownMinutes !== undefined && !Number.isInteger(body.cooldownMinutes)) ||
      (body.maxReplyChars !== undefined && !Number.isInteger(body.maxReplyChars)) ||
      !exactBodyKeys(body, [
        'groupId',
        'name',
        'instructions',
        'triggerKind',
        'dailyLimit',
        'cooldownMinutes',
        'maxReplyChars',
      ])
    )
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule body is invalid')
    try {
      const rule = await automation(deps).createRule({
        userId,
        targetId: automationRules[1]!,
        groupId: String(body.groupId ?? ''),
        name: body.name as string,
        instructions: body.instructions as string,
        ...(body.triggerKind !== undefined
          ? { triggerKind: body.triggerKind as 'new_topic' | 'new_question' }
          : {}),
        ...(body.dailyLimit !== undefined ? { dailyLimit: Number(body.dailyLimit) } : {}),
        ...(body.cooldownMinutes !== undefined
          ? { cooldownMinutes: Number(body.cooldownMinutes) }
          : {}),
        ...(body.maxReplyChars !== undefined ? { maxReplyChars: Number(body.maxReplyChars) } : {}),
      })
      sendJson(res, 201, { rule })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }

  const automationRule =
    /^\/api\/plugins\/accounts\/(\d{1,16})\/automation\/rules\/([0-9a-f-]{36})$/.exec(path)
  if (automationRule && method === 'PATCH') {
    const raw = await readJsonBody(req, 16 * 1024)
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule patch must be an object')
    const body = raw as Record<string, unknown>
    if (
      Object.keys(body).length === 0 ||
      (body.name !== undefined && typeof body.name !== 'string') ||
      (body.instructions !== undefined && typeof body.instructions !== 'string') ||
      (body.triggerKind !== undefined && typeof body.triggerKind !== 'string') ||
      (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
      (body.dailyLimit !== undefined && !Number.isInteger(body.dailyLimit)) ||
      (body.cooldownMinutes !== undefined && !Number.isInteger(body.cooldownMinutes)) ||
      (body.maxReplyChars !== undefined && !Number.isInteger(body.maxReplyChars)) ||
      !exactBodyKeys(body, [
        'name',
        'instructions',
        'triggerKind',
        'enabled',
        'dailyLimit',
        'cooldownMinutes',
        'maxReplyChars',
      ])
    )
      throw new HttpError(400, 'BAD_REQUEST', 'automation rule patch is invalid')
    try {
      const rule = await automation(deps).patchRule({
        userId,
        targetId: automationRule[1]!,
        ruleId: automationRule[2]!,
        patch: {
          ...(body.name !== undefined ? { name: body.name as string } : {}),
          ...(body.instructions !== undefined ? { instructions: body.instructions as string } : {}),
          ...(body.triggerKind !== undefined
            ? { triggerKind: body.triggerKind as 'new_topic' | 'new_question' }
            : {}),
          ...(body.enabled !== undefined ? { enabled: body.enabled as boolean } : {}),
          ...(body.dailyLimit !== undefined ? { dailyLimit: Number(body.dailyLimit) } : {}),
          ...(body.cooldownMinutes !== undefined
            ? { cooldownMinutes: Number(body.cooldownMinutes) }
            : {}),
          ...(body.maxReplyChars !== undefined
            ? { maxReplyChars: Number(body.maxReplyChars) }
            : {}),
        },
      })
      sendJson(res, 200, { rule })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }
  if (automationRule && method === 'DELETE') {
    try {
      await automation(deps).deleteRule(userId, automationRule[1]!, automationRule[2]!)
      sendJson(res, 200, { deleted: true })
      return
    } catch (error) {
      mapAutomationError(error)
    }
  }

  const match = setupMatch(path)
  if (match && method === 'GET' && match.qr) {
    try {
      const png = await setupManager(deps).qr(userId, match.sessionId)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', String(png.length))
      res.setHeader('Cache-Control', 'no-store, private')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.end(png)
      return
    } catch (error) {
      mapSetupError(error)
    }
  }
  if (match && method === 'GET' && !match.qr) {
    try {
      sendJson(res, 200, await setupManager(deps).status(userId, match.sessionId))
      return
    } catch (error) {
      mapSetupError(error)
    }
  }
  if (match && method === 'DELETE' && !match.qr) {
    try {
      sendJson(res, 200, await setupManager(deps).cancel(userId, match.sessionId))
      return
    } catch (error) {
      mapSetupError(error)
    }
  }

  throw new HttpError(404, 'NOT_FOUND', 'Plugin endpoint not found')
}
