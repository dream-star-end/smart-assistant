/** Encrypted account storage for managed-browser Plugins (connections table, strict v1 envelope). */

import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { computeAccountKey, connectionAad } from '../connectors/store.js'
import { decryptToBuffer, encrypt } from '../crypto/aead.js'
import { loadKmsKey, zeroBuffer } from '../crypto/keys.js'
import { getPool } from '../db/index.js'
import { type QueryRunner, tx } from '../db/queries.js'
import {
  lockMarketplaceListing,
  lockMarketplaceUserSlug,
  lockMarketplaceVersion,
} from '../marketplace/locking.js'
import type { ManagedBrowserPluginContractV1 } from './contracts.js'
import { type VerifiedRuntimePluginContract, loadVerifiedRuntimePluginContract } from './review.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SAME_SITE = new Set(['Strict', 'Lax', 'None'])
const STORAGE_STATE_MAX_BYTES = 256 * 1024
const COOKIE_MAX = 200
const ORIGIN_MAX = 20
const LOCAL_STORAGE_MAX_PER_ORIGIN = 200

export class PluginAccountError extends Error {
  readonly code:
    | 'INVALID_STATE'
    | 'NOT_INSTALLED'
    | 'ACCOUNT_NOT_FOUND'
    | 'ACCOUNT_STALE'
    | 'ACCOUNT_REVOKED'
    | 'SECRET_INVALID'

  constructor(code: PluginAccountError['code'], message: string = code) {
    super(message)
    this.name = 'PluginAccountError'
    this.code = code
  }
}

export interface BrowserCookieStateV1 {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: true
  sameSite: 'Strict' | 'Lax' | 'None'
}

export interface BrowserOriginStateV1 {
  origin: string
  localStorage: Array<{ name: string; value: string }>
}

export interface BrowserStorageStateV1 {
  cookies: BrowserCookieStateV1[]
  origins: BrowserOriginStateV1[]
}

export interface PluginAccountEnvelopeV1 {
  schemaVersion: 1
  pluginType: 'managed-browser'
  driverId: string
  driverVersion: string
  accountInstanceId: string
  storageState: BrowserStorageStateV1
}

function stateInvalid(message: string): never {
  throw new PluginAccountError('INVALID_STATE', message)
}

function dataObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    stateInvalid(`${label} must be an object`)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) stateInvalid(`${label} must be a plain object`)
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (POLLUTION_KEYS.has(key) || !Object.hasOwn(descriptor, 'value'))
      stateInvalid(`${label} contains forbidden property '${key}'`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allow.has(key) || POLLUTION_KEYS.has(key))
  if (unknown.length > 0) stateInvalid(`${label} has unknown fields: ${unknown.sort().join(', ')}`)
}

function stringField(value: unknown, max: number, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > max ||
    value.includes('\0') ||
    value.includes('\r') ||
    value.includes('\n')
  )
    stateInvalid(`${label} is invalid`)
  return value
}

function allowedOriginFacts(contract: ManagedBrowserPluginContractV1): {
  origins: Set<string>
  hostnames: Set<string>
} {
  const origins = new Set(contract.runtime.network.origins)
  const hostnames = new Set([...origins].map((origin) => new URL(origin).hostname))
  return { origins, hostnames }
}

function normalizeStateOrigin(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    stateInvalid('storageState origin is invalid')
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== ''
  )
    stateInvalid('storageState origin is not an exact HTTPS origin')
  return `https://${url.hostname.toLowerCase()}:${url.port || '443'}`
}

/** Strict, bounded canonical storageState parser. Unknown fields and contract-external domains fail. */
export function validateBrowserStorageState(
  input: unknown,
  contract: ManagedBrowserPluginContractV1,
): BrowserStorageStateV1 {
  let serialized: string
  try {
    serialized = JSON.stringify(input)
  } catch {
    stateInvalid('storageState is not serializable')
  }
  if (typeof serialized !== 'string') stateInvalid('storageState is not serializable')
  if (Buffer.byteLength(serialized, 'utf8') > STORAGE_STATE_MAX_BYTES)
    stateInvalid('storageState exceeds byte limit')
  const root = dataObject(input, 'storageState')
  exactKeys(root, ['cookies', 'origins'], 'storageState')
  if (!Array.isArray(root.cookies) || root.cookies.length > COOKIE_MAX)
    stateInvalid(`storageState.cookies must contain at most ${COOKIE_MAX} items`)
  if (!Array.isArray(root.origins) || root.origins.length > ORIGIN_MAX)
    stateInvalid(`storageState.origins must contain at most ${ORIGIN_MAX} items`)
  const allowed = allowedOriginFacts(contract)

  const seenCookies = new Set<string>()
  const cookies = root.cookies.map((raw, index): BrowserCookieStateV1 => {
    const cookie = dataObject(raw, `storageState.cookies[${index}]`)
    exactKeys(
      cookie,
      ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'],
      `storageState.cookies[${index}]`,
    )
    const domain = stringField(cookie.domain, 253, `storageState.cookies[${index}].domain`)
    const canonicalDomain = domain.replace(/^\./, '').toLowerCase()
    if (domain !== domain.toLowerCase() || !allowed.hostnames.has(canonicalDomain))
      stateInvalid('storageState cookie domain is outside the signed Plugin contract')
    const path = stringField(cookie.path, 1024, `storageState.cookies[${index}].path`)
    if (!path.startsWith('/')) stateInvalid('storageState cookie path must start with /')
    if (
      typeof cookie.expires !== 'number' ||
      !Number.isFinite(cookie.expires) ||
      cookie.expires < -1 ||
      cookie.expires > 4_102_444_800
    )
      stateInvalid('storageState cookie expiry is invalid')
    if (typeof cookie.httpOnly !== 'boolean')
      stateInvalid('storageState cookie httpOnly is invalid')
    if (cookie.secure !== true) stateInvalid('storageState cookies must be secure')
    if (typeof cookie.sameSite !== 'string' || !SAME_SITE.has(cookie.sameSite))
      stateInvalid('storageState cookie sameSite is invalid')
    const name = stringField(cookie.name, 256, `storageState.cookies[${index}].name`)
    const identity = `${canonicalDomain}\0${path}\0${name}`
    if (seenCookies.has(identity)) stateInvalid('storageState cookies must be unique')
    seenCookies.add(identity)
    return {
      name,
      value: stringField(cookie.value, 16 * 1024, `storageState.cookies[${index}].value`, true),
      domain,
      path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: true,
      sameSite: cookie.sameSite as BrowserCookieStateV1['sameSite'],
    }
  })
  cookies.sort((a, b) =>
    `${a.domain}\0${a.path}\0${a.name}`.localeCompare(`${b.domain}\0${b.path}\0${b.name}`),
  )

  const seenOrigins = new Set<string>()
  const origins = root.origins.map((raw, index): BrowserOriginStateV1 => {
    const item = dataObject(raw, `storageState.origins[${index}]`)
    exactKeys(item, ['origin', 'localStorage'], `storageState.origins[${index}]`)
    const origin = normalizeStateOrigin(
      stringField(item.origin, 300, `storageState.origins[${index}].origin`),
    )
    if (!allowed.origins.has(origin) || seenOrigins.has(origin))
      stateInvalid('storageState origin is outside the signed Plugin contract or duplicate')
    seenOrigins.add(origin)
    if (
      !Array.isArray(item.localStorage) ||
      item.localStorage.length > LOCAL_STORAGE_MAX_PER_ORIGIN
    )
      stateInvalid('storageState localStorage exceeds item limit')
    const seenNames = new Set<string>()
    const localStorage = item.localStorage.map((rawEntry, entryIndex) => {
      const entry = dataObject(
        rawEntry,
        `storageState.origins[${index}].localStorage[${entryIndex}]`,
      )
      exactKeys(
        entry,
        ['name', 'value'],
        `storageState.origins[${index}].localStorage[${entryIndex}]`,
      )
      const name = stringField(entry.name, 1024, 'localStorage.name')
      if (seenNames.has(name)) stateInvalid('storageState localStorage names must be unique')
      seenNames.add(name)
      return { name, value: stringField(entry.value, 32 * 1024, 'localStorage.value', true) }
    })
    localStorage.sort((a, b) => a.name.localeCompare(b.name))
    return { origin, localStorage }
  })
  origins.sort((a, b) => a.origin.localeCompare(b.origin))
  const state = { cookies, origins }
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > STORAGE_STATE_MAX_BYTES)
    stateInvalid('canonical storageState exceeds byte limit')
  return state
}

function validateEnvelope(
  input: unknown,
  contract: ManagedBrowserPluginContractV1,
): PluginAccountEnvelopeV1 {
  const value = dataObject(input, 'Plugin account envelope')
  exactKeys(
    value,
    [
      'schemaVersion',
      'pluginType',
      'driverId',
      'driverVersion',
      'accountInstanceId',
      'storageState',
    ],
    'Plugin account envelope',
  )
  if (
    value.schemaVersion !== 1 ||
    value.pluginType !== 'managed-browser' ||
    value.driverId !== contract.runtime.driverId ||
    value.driverVersion !== contract.runtime.driverVersion ||
    typeof value.accountInstanceId !== 'string' ||
    !UUID_RE.test(value.accountInstanceId)
  )
    throw new PluginAccountError('SECRET_INVALID', 'Plugin account envelope contract mismatch')
  return {
    schemaVersion: 1,
    pluginType: 'managed-browser',
    driverId: contract.runtime.driverId,
    driverVersion: contract.runtime.driverVersion,
    accountInstanceId: value.accountInstanceId,
    storageState: validateBrowserStorageState(value.storageState, contract),
  }
}

export interface PluginAccountRow {
  id: string
  user_id: number
  provider: string
  display_name: string
  account_key: string
  aad_seed: string
  secret_enc: Buffer | null
  secret_nonce: Buffer | null
  revision: number
  secret_generation: string
  connector_version_id: string
  spec_hash: Buffer
  exec_contract_hash: Buffer
  auth_contract_version: number
  status: 'active' | 'error'
  meta: Record<string, unknown>
  revoked_at: Date | null
}

const ACCOUNT_COLS = `id::text AS id, user_id::int AS user_id, provider, display_name,
  account_key, aad_seed::text AS aad_seed, secret_enc, secret_nonce, revision,
  secret_generation::text AS secret_generation,
  connector_version_id::text AS connector_version_id, spec_hash, exec_contract_hash,
  auth_contract_version, status, meta, revoked_at`

function encryptEnvelope(
  envelope: PluginAccountEnvelopeV1,
  userId: number,
  slug: string,
  aadSeed: string,
  env: NodeJS.ProcessEnv = process.env,
): { ciphertext: Buffer; nonce: Buffer } {
  const key = loadKmsKey(env)
  const plaintext = Buffer.from(JSON.stringify(envelope), 'utf8')
  try {
    return encrypt(plaintext, key, connectionAad(aadSeed, userId, slug))
  } finally {
    zeroBuffer(plaintext)
    zeroBuffer(key)
  }
}

export function decryptPluginAccountEnvelope(
  row: PluginAccountRow,
  contract: ManagedBrowserPluginContractV1,
  env: NodeJS.ProcessEnv = process.env,
): PluginAccountEnvelopeV1 {
  if (row.secret_enc === null || row.secret_nonce === null)
    throw new PluginAccountError('ACCOUNT_REVOKED', 'Plugin account has no secret')
  const key = loadKmsKey(env)
  let plaintext: Buffer | null = null
  try {
    plaintext = decryptToBuffer(
      row.secret_enc,
      row.secret_nonce,
      key,
      connectionAad(row.aad_seed, row.user_id, row.provider),
    )
    return validateEnvelope(JSON.parse(plaintext.toString('utf8')), contract)
  } catch (error) {
    if (error instanceof PluginAccountError) throw error
    throw new PluginAccountError('SECRET_INVALID', 'Plugin account secret failed validation')
  } finally {
    if (plaintext) zeroBuffer(plaintext)
    zeroBuffer(key)
  }
}

export async function assertRuntimePluginInstallEntitlement(
  userId: number,
  verified: VerifiedRuntimePluginContract,
  runner: QueryRunner,
  opts: { requireCurrent?: boolean } = {},
): Promise<void> {
  const installed = await runner.query(
    `SELECT 1
       FROM marketplace_installs i
       JOIN marketplace_skill_listings l ON l.slug = i.slug
      WHERE i.user_id = $1 AND i.slug = $2 AND i.version_id = $3
        AND i.artifact_hash = $4 AND i.uninstalled_at IS NULL
        AND l.state = 'active'
        AND ($5::boolean = FALSE OR l.current_approved_version_id = i.version_id)`,
    [
      userId,
      verified.slug,
      verified.versionId,
      verified.artifactHash,
      opts.requireCurrent === true,
    ],
  )
  if ((installed.rowCount ?? 0) !== 1)
    throw new PluginAccountError('NOT_INSTALLED', 'exact Plugin version is not installed')
}

export async function createManagedBrowserPluginAccount(input: {
  userId: number
  versionId: number
  displayName?: string
  accountHint?: string
  storageState: unknown
  env?: NodeJS.ProcessEnv
  pool?: Pool
}): Promise<{ id: string; accountInstanceId: string }> {
  const pool = input.pool ?? getPool()
  return tx(async (client: PoolClient) => {
    const initial = await loadVerifiedRuntimePluginContract(input.versionId, client, {
      env: input.env,
    })
    if (initial.pluginType !== 'managed-browser')
      throw new PluginAccountError('INVALID_STATE', 'Plugin does not use a browser account')
    await lockMarketplaceUserSlug(client, input.userId, initial.slug)
    const version = await lockMarketplaceVersion(client, input.versionId)
    if (!version || version.slug !== initial.slug)
      throw new PluginAccountError('ACCOUNT_STALE', 'Plugin version changed before account bind')
    const listing = await lockMarketplaceListing(client, initial.slug)
    if (!listing || listing.pluginType !== 'managed-browser')
      throw new PluginAccountError('ACCOUNT_STALE', 'Plugin listing changed before account bind')
    const verified = await loadVerifiedRuntimePluginContract(input.versionId, client, {
      env: input.env,
    })
    if (verified.pluginType !== 'managed-browser')
      throw new PluginAccountError('ACCOUNT_STALE', 'Plugin subtype changed before account bind')
    await assertRuntimePluginInstallEntitlement(input.userId, verified, client, {
      requireCurrent: true,
    })
    const accountInstanceId = randomUUID()
    const accountKey = computeAccountKey(
      `plugin-account-v1:${verified.slug}:${accountInstanceId}`,
      input.env ?? process.env,
    )
    const aadSeed = randomUUID()
    const envelope: PluginAccountEnvelopeV1 = {
      schemaVersion: 1,
      pluginType: 'managed-browser',
      driverId: verified.contract.runtime.driverId,
      driverVersion: verified.contract.runtime.driverVersion,
      accountInstanceId,
      storageState: validateBrowserStorageState(input.storageState, verified.contract),
    }
    const encrypted = encryptEnvelope(envelope, input.userId, verified.slug, aadSeed, input.env)
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO connections
         (user_id, provider, display_name, account_key, aad_seed, secret_enc, secret_nonce,
          meta, connector_version_id, spec_hash, exec_contract_hash, auth_contract_version)
       VALUES ($1,$2,$3,$4,$5::uuid,$6,$7,$8::jsonb,$9,$10,$11,$12)
       RETURNING id::text AS id`,
      [
        input.userId,
        verified.slug,
        (input.displayName ?? '').slice(0, 64),
        accountKey,
        aadSeed,
        encrypted.ciphertext,
        encrypted.nonce,
        JSON.stringify({
          plugin_type: 'managed-browser',
          account_hint: (input.accountHint ?? '').slice(0, 128),
        }),
        verified.versionId,
        Buffer.from(verified.artifactHash, 'hex'),
        Buffer.from(verified.execContractHash, 'hex'),
        verified.contract.account.contractVersion,
      ],
    )
    return { id: inserted.rows[0]!.id, accountInstanceId }
  }, pool)
}

/** Call-time entitlement + persistent generation fence. Invoke only while holding Redis lease. */
export async function fencePluginAccountInvocation(input: {
  connectionId: string
  userId: number
  expectedRevision: number
  verified: VerifiedRuntimePluginContract
  runner: QueryRunner
}): Promise<PluginAccountRow> {
  if (input.verified.pluginType !== 'managed-browser')
    throw new PluginAccountError('INVALID_STATE', 'runtime Plugin is not accountful')
  await assertRuntimePluginInstallEntitlement(input.userId, input.verified, input.runner, {
    requireCurrent: true,
  })
  const row = await input.runner.query<PluginAccountRow>(
    `UPDATE connections
        SET secret_generation = secret_generation + 1
      WHERE id = $1::bigint AND user_id = $2 AND provider = $3
        AND connector_version_id = $4 AND revision = $5
        AND spec_hash = $6 AND exec_contract_hash = $7 AND auth_contract_version = $8
        AND status = 'active' AND revoked_at IS NULL
      RETURNING ${ACCOUNT_COLS}`,
    [
      input.connectionId,
      input.userId,
      input.verified.slug,
      input.verified.versionId,
      input.expectedRevision,
      Buffer.from(input.verified.artifactHash, 'hex'),
      Buffer.from(input.verified.execContractHash, 'hex'),
      input.verified.contract.account.contractVersion,
    ],
  )
  if (row.rowCount !== 1)
    throw new PluginAccountError('ACCOUNT_STALE', 'Plugin account fence acquisition failed')
  return row.rows[0]!
}

/** Final invocation commit. This must be the last fallible operation before returning a result. */
export async function commitPluginAccountState(input: {
  row: PluginAccountRow
  verified: VerifiedRuntimePluginContract
  envelope: PluginAccountEnvelopeV1
  runner: QueryRunner
  env?: NodeJS.ProcessEnv
}): Promise<string> {
  if (input.verified.pluginType !== 'managed-browser')
    throw new PluginAccountError('INVALID_STATE', 'runtime Plugin is not accountful')
  const envelope = validateEnvelope(input.envelope, input.verified.contract)
  const aadSeed = randomUUID()
  const encrypted = encryptEnvelope(
    envelope,
    input.row.user_id,
    input.row.provider,
    aadSeed,
    input.env,
  )
  const updated = await input.runner.query<{ secret_generation: string }>(
    `UPDATE connections
        SET secret_enc = $9, secret_nonce = $10, aad_seed = $11::uuid,
            secret_generation = secret_generation + 1, updated_at = NOW()
      WHERE id = $1::bigint AND user_id = $2 AND provider = $3
        AND connector_version_id = $4 AND revision = $5 AND secret_generation = $6
        AND spec_hash = $7 AND exec_contract_hash = $8
        AND auth_contract_version = $12 AND status = 'active' AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1
            FROM marketplace_installs i
            JOIN marketplace_skill_versions v
              ON v.id = i.version_id AND v.slug = i.slug
            JOIN marketplace_skill_listings l ON l.slug = i.slug
           WHERE i.user_id = $2 AND i.slug = $3 AND i.version_id = $4
             AND i.artifact_hash = $13 AND i.uninstalled_at IS NULL
             AND v.artifact_hash = $13 AND v.exec_contract_hash = $8
             AND v.status = 'approved'
             AND v.security_review_state = 'security_approved'
             AND v.functional_verify_state = 'verified'
             AND v.exec_revoked_at IS NULL
             AND l.kind = 'connector' AND l.plugin_type = 'managed-browser'
             AND l.state = 'active' AND l.current_approved_version_id = v.id
        )
      RETURNING secret_generation::text AS secret_generation`,
    [
      input.row.id,
      input.row.user_id,
      input.verified.slug,
      input.verified.versionId,
      input.row.revision,
      input.row.secret_generation,
      Buffer.from(input.verified.artifactHash, 'hex'),
      Buffer.from(input.verified.execContractHash, 'hex'),
      encrypted.ciphertext,
      encrypted.nonce,
      aadSeed,
      input.verified.contract.account.contractVersion,
      input.verified.artifactHash,
    ],
  )
  if (updated.rowCount !== 1)
    throw new PluginAccountError('ACCOUNT_STALE', 'Plugin account state CAS failed')
  return updated.rows[0]!.secret_generation
}

export async function getPluginAccount(
  connectionId: string,
  userId: number,
  runner: QueryRunner,
): Promise<PluginAccountRow | null> {
  const row = await runner.query<PluginAccountRow>(
    `SELECT c.id::text AS id, c.user_id::int AS user_id, c.provider, c.display_name,
            c.account_key, c.aad_seed::text AS aad_seed, c.secret_enc, c.secret_nonce,
            c.revision, c.secret_generation::text AS secret_generation,
            c.connector_version_id::text AS connector_version_id, c.spec_hash,
            c.exec_contract_hash, c.auth_contract_version, c.status, c.meta, c.revoked_at
       FROM connections c
      JOIN marketplace_skill_versions v ON v.id = c.connector_version_id
      JOIN marketplace_skill_listings l ON l.slug = v.slug
      WHERE c.id = $1::bigint AND c.user_id = $2 AND c.revoked_at IS NULL
        AND c.status = 'active' AND l.kind = 'connector'
        AND l.plugin_type = 'managed-browser'`,
    [connectionId, userId],
  )
  return row.rows[0] ?? null
}

/** Requires the same Redis account lease used by invoke/rotate. */
export async function revokePluginAccountFenced(input: {
  row: PluginAccountRow
  runner: QueryRunner
}): Promise<void> {
  const revoked = await input.runner.query(
    `UPDATE connections
        SET secret_enc = NULL, secret_nonce = NULL, revoked_at = NOW(),
            secret_generation = secret_generation + 1, updated_at = NOW()
      WHERE id = $1::bigint AND user_id = $2 AND revision = $3
        AND secret_generation = $4 AND status = 'active' AND revoked_at IS NULL`,
    [input.row.id, input.row.user_id, input.row.revision, input.row.secret_generation],
  )
  if (revoked.rowCount !== 1)
    throw new PluginAccountError('ACCOUNT_STALE', 'Plugin account revoke fence failed')
}
