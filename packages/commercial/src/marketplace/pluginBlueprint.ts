/**
 * Agent-facing compact authoring format for declarative HTTP Plugins.
 *
 * The blueprint deliberately omits security-sensitive ConnectorSpec boilerplate:
 * origin audiences, credential DAGs, slots and reviewer effects are derived here
 * deterministically, then the existing prepareConnectorPublish compiler remains
 * the final authority. Advanced authors can still submit the full raw draft.
 */

import { normalizeHttpsOrigin } from '../connectors/outboundPolicy.js'

const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const ACTION_RE = /^[a-z][a-z0-9_-]{0,63}$/
const FIELD_RE = /^[A-Za-z0-9_.-]{1,128}$/
const POINTER_RE = /^\/(?:[A-Za-z0-9_.-]|~[01]|\/)+$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'])
const EFFECTS = new Set(['read', 'write', 'send'])
const CATEGORIES = new Set([
  'office-docs',
  'data-analysis',
  'coding-dev',
  'research-academic',
  'design-creative',
  'finance-business',
  'daily-tools',
  'skill-pack',
])
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export class PluginBlueprintError extends Error {
  readonly code = 'BAD_BLUEPRINT'

  constructor(message: string) {
    super(message)
    this.name = 'PluginBlueprintError'
  }
}

function invalid(message: string): never {
  throw new PluginBlueprintError(message)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => POLLUTION_KEYS.has(key) || !allow.has(key))
  if (unknown.length > 0) invalid(`${label} has unknown fields: ${unknown.sort().join(', ')}`)
}

function string(value: unknown, label: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum)
    invalid(`${label} must be a string of length ${minimum}-${maximum}`)
  return value
}

function optionalString(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined) return undefined
  return string(value, label, 0, maximum)
}

function stringList(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  itemMaximum: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    invalid(`${label} must contain ${minimum}-${maximum} strings`)
  return value.map((item, index) => {
    const normalized = string(item, `${label}[${index}]`, 1, itemMaximum).trim()
    if (!normalized) invalid(`${label}[${index}] must not be blank`)
    return normalized
  })
}

function origin(value: unknown, label: string): string {
  const raw = string(value, label, 1, 300)
  try {
    return normalizeHttpsOrigin(raw)
  } catch {
    invalid(`${label} must be one exact lowercase https origin without path`)
  }
}

function endpointOrigin(value: unknown, label: string): { endpoint: string; origin: string } {
  const endpoint = string(value, label, 1, 1024)
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    invalid(`${label} must be an https URL`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  )
    invalid(`${label} must be an https URL without credentials, query or fragment`)
  return { endpoint, origin: origin(url.origin, `${label} origin`) }
}

function schema(value: unknown, label: string): Record<string, unknown> {
  return object(value, label)
}

function properties(schemaValue: Record<string, unknown>, label: string): Set<string> {
  const raw = schemaValue.properties
  if (raw === undefined) return new Set()
  const props = object(raw, `${label}.properties`)
  return new Set(Object.keys(props))
}

function paramPointer(field: unknown, fields: ReadonlySet<string>, label: string): string {
  const name = string(field, label, 1, 128)
  if (!FIELD_RE.test(name) || POLLUTION_KEYS.has(name) || !fields.has(name))
    invalid(`${label} must name a declared params property`)
  return `/params/${name.replaceAll('~', '~0').replaceAll('/', '~1')}`
}

function bodyTemplate(
  value: unknown,
  fields: ReadonlySet<string>,
  label: string,
  depth = 0,
): unknown {
  if (depth > 24) invalid(`${label} is nested too deeply`)
  if (typeof value === 'string') {
    const match = /^\$([A-Za-z0-9_.-]{1,128})$/.exec(value)
    return match ? { ref: paramPointer(match[1], fields, label) } : { lit: value }
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return { lit: value }
  if (Array.isArray(value)) {
    if (value.length > 64) invalid(`${label} has too many array items`)
    return {
      arr: value.map((item, index) => bodyTemplate(item, fields, `${label}[${index}]`, depth + 1)),
    }
  }
  const raw = object(value, label)
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(raw)) {
    if (!FIELD_RE.test(key) || POLLUTION_KEYS.has(key)) invalid(`${label} has an invalid field`)
    out[key] = bodyTemplate(item, fields, `${label}.${key}`, depth + 1)
  }
  return { obj: out }
}

function placement(value: unknown): Record<string, unknown> {
  if (value === undefined) return { source: 'access_token', placement: 'authorization-bearer' }
  const raw = object(value, 'auth.placement')
  exactKeys(raw, ['type', 'name', 'prefix'], 'auth.placement')
  const type = string(raw.type, 'auth.placement.type', 1, 16)
  if (type === 'bearer') {
    if (raw.name !== undefined || raw.prefix !== undefined)
      invalid('bearer placement must not include name or prefix')
    return { source: 'access_token', placement: 'authorization-bearer' }
  }
  const name = string(raw.name, 'auth.placement.name', 1, 64)
  if (type === 'header') {
    const prefix = optionalString(raw.prefix, 'auth.placement.prefix', 32)
    return {
      source: 'access_token',
      placement: 'header',
      name,
      ...(prefix !== undefined ? { valuePrefix: prefix } : {}),
    }
  }
  if (type === 'query') {
    if (raw.prefix !== undefined) invalid('query placement must not include prefix')
    return { source: 'access_token', placement: 'query', name }
  }
  invalid('auth.placement.type must be bearer, header or query')
}

function tokenOutputs(raw: Record<string, unknown>): Record<string, unknown> {
  const accessToken = string(
    raw.accessTokenPointer ?? '/access_token',
    'auth.accessTokenPointer',
    1,
    512,
  )
  const refreshToken = optionalString(raw.refreshTokenPointer, 'auth.refreshTokenPointer', 512)
  const expiresIn = optionalString(raw.expiresInPointer, 'auth.expiresInPointer', 512)
  for (const [label, pointer] of [
    ['auth.accessTokenPointer', accessToken],
    ['auth.refreshTokenPointer', refreshToken],
    ['auth.expiresInPointer', expiresIn],
  ] as const) {
    if (pointer !== undefined && !POINTER_RE.test(pointer))
      invalid(`${label} must be a JSON pointer`)
  }
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn ? { expiresIn } : {}),
  }
}

function authAndDecision(
  value: unknown,
  apiOrigin: string,
): {
  authMode: 'static-token' | 'token-exchange' | 'oauth2-auth-code'
  auth: Record<string, unknown>
  pipeline: Record<string, unknown>
  slot: string
  authorizationOrigins: string[]
  tokenOrigins: string[]
} {
  const raw = object(value, 'auth')
  const mode = string(raw.mode, 'auth.mode', 1, 32)
  const apiPlacement = placement(raw.placement)
  if (mode === 'static-token') {
    exactKeys(raw, ['mode', 'placement'], 'auth')
    return {
      authMode: mode,
      auth: { apiCredentialPlacements: [apiPlacement] },
      pipeline: {
        nodes: [{ id: 'api-token', authMode: mode, subject: 'user', audience: 'api' }],
      },
      slot: 'api-token',
      authorizationOrigins: [],
      tokenOrigins: [],
    }
  }
  if (mode === 'token-exchange') {
    exactKeys(
      raw,
      [
        'mode',
        'placement',
        'tokenOrigin',
        'exchangePath',
        'encoding',
        'credentialFields',
        'staticFields',
        'grantValue',
        'successPointer',
        'errorCodePointer',
        'accessTokenPointer',
        'refreshTokenPointer',
        'expiresInPointer',
      ],
      'auth',
    )
    const tokenOrigin = origin(raw.tokenOrigin ?? apiOrigin, 'auth.tokenOrigin')
    const exchangePath = string(raw.exchangePath, 'auth.exchangePath', 1, 1024)
    const encoding = string(raw.encoding ?? 'json', 'auth.encoding', 1, 16)
    if (!['query', 'json', 'form', 'basic-auth'].includes(encoding))
      invalid('auth.encoding is unsupported')
    const credentialFields = object(raw.credentialFields, 'auth.credentialFields')
    if (Object.keys(credentialFields).length < 1 || Object.keys(credentialFields).length > 8)
      invalid('auth.credentialFields must contain 1-8 entries')
    for (const [name, source] of Object.entries(credentialFields)) {
      if (
        !FIELD_RE.test(name) ||
        !['client_id', 'client_secret', 'refresh_token'].includes(String(source))
      )
        invalid('auth.credentialFields contains an invalid field or credential source')
    }
    const staticFields =
      raw.staticFields === undefined ? undefined : object(raw.staticFields, 'auth.staticFields')
    const outputs = tokenOutputs(raw)
    const successPredicate = optionalString(raw.successPointer, 'auth.successPointer', 512)
    const providerErrorCodePointer = optionalString(
      raw.errorCodePointer,
      'auth.errorCodePointer',
      512,
    )
    return {
      authMode: mode,
      auth: {
        exchangeRequest: {
          method: 'POST',
          path: exchangePath,
          encoding,
          credentialFieldNames: credentialFields,
          ...(staticFields ? { staticFields } : {}),
          ...(raw.grantValue !== undefined
            ? { grantValue: string(raw.grantValue, 'auth.grantValue', 1, 128) }
            : {}),
        },
        tokenResponse: {
          ...(successPredicate ? { successPredicate } : {}),
          ...(providerErrorCodePointer ? { providerErrorCodePointer } : {}),
        },
        tokenOutputs: outputs,
        apiCredentialPlacements: [apiPlacement],
      },
      pipeline: {
        nodes: [
          { id: 'exchange', authMode: mode, subject: 'app', audience: 'token' },
          {
            id: 'api-token',
            authMode: mode,
            subject: 'app',
            audience: 'api',
            dependsOn: ['exchange'],
          },
        ],
      },
      slot: 'api-token',
      authorizationOrigins: [],
      tokenOrigins: [tokenOrigin],
    }
  }
  if (mode === 'oauth2-auth-code') {
    exactKeys(
      raw,
      [
        'mode',
        'placement',
        'authorizeEndpoint',
        'tokenEndpoint',
        'refreshEndpoint',
        'revokeEndpoint',
        'clientAuth',
        'scopeSeparator',
        'scopes',
        'fixedExtraParams',
        'errorCodePointer',
        'refreshRotation',
        'refreshEncoding',
        'refreshFields',
        'pkce',
        'accessTokenPointer',
        'refreshTokenPointer',
        'expiresInPointer',
      ],
      'auth',
    )
    const authorize = endpointOrigin(raw.authorizeEndpoint, 'auth.authorizeEndpoint')
    const token = endpointOrigin(raw.tokenEndpoint, 'auth.tokenEndpoint')
    const refresh =
      raw.refreshEndpoint !== undefined
        ? endpointOrigin(raw.refreshEndpoint, 'auth.refreshEndpoint')
        : null
    const revoke =
      raw.revokeEndpoint !== undefined
        ? endpointOrigin(raw.revokeEndpoint, 'auth.revokeEndpoint')
        : null
    const clientAuth = string(raw.clientAuth ?? 'form', 'auth.clientAuth', 1, 16)
    if (!['basic', 'form', 'json'].includes(clientAuth)) invalid('auth.clientAuth is unsupported')
    const refreshEncoding = string(raw.refreshEncoding ?? 'form', 'auth.refreshEncoding', 1, 16)
    if (!['form', 'json'].includes(refreshEncoding)) invalid('auth.refreshEncoding is unsupported')
    const pkce = string(raw.pkce ?? 'required', 'auth.pkce', 1, 16)
    if (!['required', 'optional'].includes(pkce)) invalid('auth.pkce is unsupported')
    const scopes =
      raw.scopes === undefined ? undefined : stringList(raw.scopes, 'auth.scopes', 0, 64, 128)
    const fixedExtraParams =
      raw.fixedExtraParams === undefined
        ? undefined
        : object(raw.fixedExtraParams, 'auth.fixedExtraParams')
    const refreshFields =
      raw.refreshFields === undefined ? undefined : object(raw.refreshFields, 'auth.refreshFields')
    const providerErrorCodePointer = optionalString(
      raw.errorCodePointer,
      'auth.errorCodePointer',
      512,
    )
    const outputs = tokenOutputs({
      ...raw,
      refreshTokenPointer: raw.refreshTokenPointer ?? '/refresh_token',
      expiresInPointer: raw.expiresInPointer ?? '/expires_in',
    })
    if (raw.refreshRotation !== undefined && typeof raw.refreshRotation !== 'boolean')
      invalid('auth.refreshRotation must be boolean')
    return {
      authMode: mode,
      auth: {
        authorizeEndpoint: authorize.endpoint,
        tokenEndpoint: token.endpoint,
        ...(refresh ? { refreshEndpoint: refresh.endpoint } : {}),
        ...(revoke ? { revokeEndpoint: revoke.endpoint } : {}),
        clientProvisioning: 'byoa',
        clientAuth,
        scopeSeparator: string(raw.scopeSeparator ?? ' ', 'auth.scopeSeparator', 1, 4),
        ...(scopes ? { scopes } : {}),
        ...(fixedExtraParams ? { fixedExtraParams } : {}),
        ...(providerErrorCodePointer ? { providerErrorCodePointer } : {}),
        refreshRotation: raw.refreshRotation ?? true,
        refreshEncoding,
        ...(refreshFields ? { refreshFieldNames: refreshFields } : {}),
        pkce,
        tokenOutputs: outputs,
        apiCredentialPlacements: [apiPlacement],
      },
      pipeline: {
        nodes: [{ id: 'api-token', authMode: mode, subject: 'user', audience: 'api' }],
      },
      slot: 'api-token',
      authorizationOrigins: [authorize.origin],
      tokenOrigins: [
        ...new Set([token.origin, refresh?.origin, revoke?.origin].filter(Boolean)),
      ] as string[],
    }
  }
  invalid('auth.mode must be static-token, token-exchange or oauth2-auth-code')
}

/** Compile a compact agent-authored blueprint into the existing full publish body. */
export function compilePluginBlueprint(input: unknown): Record<string, unknown> {
  const raw = object(input, 'blueprint')
  exactKeys(
    raw,
    [
      'format',
      'slug',
      'name',
      'description',
      'version',
      'category',
      'useCases',
      'outcomeExamples',
      'humanMd',
      'tags',
      'visibility',
      'apiOrigin',
      'auth',
      'identity',
      'actions',
    ],
    'blueprint',
  )
  if (raw.format !== 'plugin-blueprint-v1')
    invalid("blueprint.format must be 'plugin-blueprint-v1'")
  const slug = string(raw.slug, 'blueprint.slug', 2, 64)
  if (!SLUG_RE.test(slug)) invalid('blueprint.slug is invalid')
  const name = string(raw.name, 'blueprint.name', 1, 120)
  const description = string(raw.description, 'blueprint.description', 0, 2_000)
  const version = string(raw.version ?? '1.0.0', 'blueprint.version', 1, 32)
  if (!VERSION_RE.test(version)) invalid('blueprint.version must be x.y.z')
  const category = string(raw.category, 'blueprint.category', 1, 64)
  if (!CATEGORIES.has(category)) invalid('blueprint.category is invalid')
  const useCases = stringList(raw.useCases, 'blueprint.useCases', 1, 4, 200)
  const outcomeExamples =
    raw.outcomeExamples === undefined
      ? []
      : stringList(raw.outcomeExamples, 'blueprint.outcomeExamples', 0, 4, 240)
  const tags =
    raw.tags === undefined ? ['API插件'] : stringList(raw.tags, 'blueprint.tags', 1, 20, 64)
  const visibility = raw.visibility ?? 'public'
  if (visibility !== 'public' && visibility !== 'org') invalid('blueprint.visibility is invalid')
  const apiOrigin = origin(raw.apiOrigin, 'blueprint.apiOrigin')
  const auth = authAndDecision(raw.auth, apiOrigin)

  if (!Array.isArray(raw.actions) || raw.actions.length < 1 || raw.actions.length > 64)
    invalid('blueprint.actions must contain 1-64 actions')
  const actions: Record<string, unknown>[] = []
  const decisions: Record<string, unknown> = {}
  const seen = new Set<string>()
  for (let index = 0; index < raw.actions.length; index++) {
    const item = object(raw.actions[index], `blueprint.actions[${index}]`)
    exactKeys(
      item,
      [
        'id',
        'description',
        'method',
        'path',
        'query',
        'body',
        'headers',
        'params',
        'result',
        'effect',
      ],
      `blueprint.actions[${index}]`,
    )
    const id = string(item.id, `blueprint.actions[${index}].id`, 1, 64)
    if (!ACTION_RE.test(id) || seen.has(id))
      invalid(`blueprint action id '${id}' is invalid or duplicate`)
    seen.add(id)
    const method = string(item.method, `blueprint.actions[${index}].method`, 3, 6).toUpperCase()
    if (!METHODS.has(method)) invalid(`blueprint action '${id}' method is unsupported`)
    const params = schema(item.params, `blueprint.actions[${index}].params`)
    const result = schema(item.result, `blueprint.actions[${index}].result`)
    const fields = properties(params, `blueprint.actions[${index}].params`)
    let path = string(item.path, `blueprint.actions[${index}].path`, 1, 1024)
    path = path.replace(
      /\{([A-Za-z0-9_.-]{1,128})\}/g,
      (_whole, field: string) =>
        `{${paramPointer(field, fields, `blueprint action '${id}' path`)}}`,
    )
    const request: Record<string, unknown> = { method, pathTemplate: path }
    if (item.query !== undefined) {
      const query = object(item.query, `blueprint action '${id}' query`)
      const mapped: Record<string, string> = {}
      for (const [name, field] of Object.entries(query)) {
        if (!FIELD_RE.test(name) || POLLUTION_KEYS.has(name))
          invalid(`blueprint action '${id}' query name is invalid`)
        mapped[name] = paramPointer(field, fields, `blueprint action '${id}' query.${name}`)
      }
      request.query = mapped
    }
    if (item.body !== undefined)
      request.bodyTemplate = bodyTemplate(item.body, fields, `blueprint action '${id}' body`)
    if (item.headers !== undefined)
      request.staticHeaders = object(item.headers, `blueprint action '${id}' headers`)
    const effect = item.effect ?? (method === 'GET' || method === 'HEAD' ? 'read' : 'write')
    if (typeof effect !== 'string' || !EFFECTS.has(effect))
      invalid(`blueprint action '${id}' effect is invalid`)
    decisions[id] =
      effect === 'read' && method !== 'GET' && method !== 'HEAD'
        ? { effect: 'read', safeReadNonGet: true }
        : { effect }
    actions.push({
      id,
      description: string(item.description, `blueprint.actions[${index}].description`, 1, 2_000),
      request,
      params,
      result,
      usesSlot: auth.slot,
    })
  }

  const identity = object(raw.identity, 'blueprint.identity')
  exactKeys(identity, ['actionId', 'accountKeyPointer', 'accountHintPointer'], 'blueprint.identity')
  const identityAction = string(identity.actionId, 'blueprint.identity.actionId', 1, 64)
  if (!seen.has(identityAction)) invalid('blueprint.identity.actionId must name an action')
  const accountKeyPointer = string(
    identity.accountKeyPointer,
    'blueprint.identity.accountKeyPointer',
    1,
    256,
  )
  const accountHintPointer = optionalString(
    identity.accountHintPointer,
    'blueprint.identity.accountHintPointer',
    256,
  )
  if (
    !POINTER_RE.test(accountKeyPointer) ||
    (accountHintPointer && !POINTER_RE.test(accountHintPointer))
  )
    invalid('blueprint identity pointers must be JSON pointers')

  return {
    kind: 'connector',
    version,
    spec: {
      id: slug,
      label: name,
      description,
      authMode: auth.authMode,
      auth: auth.auth,
      originMode: 'fixed-reviewed',
      credentialPipeline: auth.pipeline,
      identity: {
        probeActionId: identityAction,
        accountKeyPointer,
        ...(accountHintPointer ? { accountHintPointer } : {}),
      },
      actions,
    },
    securityDecision: {
      audience: {
        authorizationOrigins: auth.authorizationOrigins,
        tokenOrigins: auth.tokenOrigins,
        apiOrigins: [apiOrigin],
        unauthenticatedUploadOrigins: [],
      },
      actions: decisions,
    },
    category,
    useCases,
    outcomeExamples,
    ...(raw.humanMd !== undefined
      ? { humanMd: string(raw.humanMd, 'blueprint.humanMd', 0, 32_000) }
      : {}),
    tags,
    ...(visibility === 'org' ? { visibility: 'org' } : {}),
  }
}
