/** Private HTTP cookie state. Never deserialize untrusted tough-cookie store/options. */
import { Cookie, CookieJar, canonicalDomain } from 'tough-cookie'
import { LiteratureError } from './errors.js'
import { LITERATURE_SITE, literatureUrl } from './policy.js'

const HOST = 'www.jieyoutsg.com'
const FORMAT = 'jieyou-http-cookies-v1'
const LIMIT = 32 * 1024
interface HttpCookie {
  name: string
  value: string
  domain: string
  path: string
  hostOnly: boolean
  secure: boolean
  httpOnly: boolean
  sameSite: 'strict' | 'lax' | 'none' | null
  expiresAt: number | null
}
export interface JieyouAccountState {
  schemaVersion: 1
  format: typeof FORMAT
  origin: typeof LITERATURE_SITE
  cookies: HttpCookie[]
}
function invalid(): never {
  throw new LiteratureError('RESPONSE_INVALID')
}
/** Read only own data properties; neither getters nor inherited fields are evaluated. */
function record(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid()
  if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(input)
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid()
  const result: Record<string, unknown> = Object.create(null)
  for (const key of keys) {
    const descriptor = descriptors[key]
    if (!descriptor || !('value' in descriptor)) invalid()
    result[key] = descriptor.value
  }
  return result
}
function time(value: number, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > 8_640_000_000_000_000) invalid()
  return value
}
function cookie(input: unknown): HttpCookie {
  const v = record(input, [
    'name',
    'value',
    'domain',
    'path',
    'hostOnly',
    'secure',
    'httpOnly',
    'sameSite',
    'expiresAt',
  ])
  if (
    typeof v.name !== 'string' ||
    v.name.length < 1 ||
    v.name.length > 256 ||
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(v.name) ||
    typeof v.value !== 'string' ||
    /[^\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]/.test(v.value) ||
    v.name.length + v.value.length > 4096 ||
    ![HOST, 'jieyoutsg.com'].includes(v.domain as string) ||
    typeof v.path !== 'string' ||
    !v.path.startsWith('/') ||
    v.path.length > 2048 ||
    Array.from(v.path).some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127 || c === ';') ||
    typeof v.hostOnly !== 'boolean' ||
    (v.hostOnly && v.domain !== HOST) ||
    typeof v.secure !== 'boolean' ||
    typeof v.httpOnly !== 'boolean' ||
    ![null, 'strict', 'lax', 'none'].includes(v.sameSite as string | null) ||
    (v.expiresAt !== null && typeof v.expiresAt !== 'number')
  )
    invalid()
  if (v.expiresAt !== null) time(v.expiresAt as number, -8_640_000_000_000_000)
  if (v.name.startsWith('__Secure-') && !v.secure) invalid()
  if (v.name.startsWith('__Host-') && (!v.secure || !v.hostOnly || v.path !== '/')) invalid()
  return v as unknown as HttpCookie
}
export function parseJieyouAccountState(input: unknown): JieyouAccountState {
  const v = record(input, ['schemaVersion', 'format', 'origin', 'cookies'])
  if (v.schemaVersion !== 1 || v.format !== FORMAT || v.origin !== LITERATURE_SITE) invalid()
  if (!Array.isArray(v.cookies)) invalid()
  if (v.cookies.length > 64) throw new LiteratureError('RESPONSE_TOO_LARGE')
  // Reject sparse arrays, custom properties and accessor elements before iteration.
  const descriptors = Object.getOwnPropertyDescriptors(v.cookies)
  if (Reflect.ownKeys(descriptors).length !== v.cookies.length + 1) invalid()
  const cookies: HttpCookie[] = []
  const seen = new Set<string>()
  for (let index = 0; index < v.cookies.length; index++) {
    const descriptor = descriptors[String(index)]
    if (!descriptor || !('value' in descriptor)) invalid()
    const entry = cookie(descriptor.value)
    const key = JSON.stringify([entry.domain, entry.path, entry.name])
    if (seen.has(key)) invalid()
    seen.add(key)
    cookies.push(entry)
  }
  const result: JieyouAccountState = {
    schemaVersion: 1,
    format: FORMAT,
    origin: LITERATURE_SITE,
    cookies,
  }
  if (Buffer.byteLength(JSON.stringify(result)) > LIMIT)
    throw new LiteratureError('RESPONSE_TOO_LARGE')
  return result
}
export function createJieyouCookieJar(): CookieJar {
  return new CookieJar(undefined, {
    rejectPublicSuffixes: true,
    looseMode: false,
    allowSpecialUseDomain: false,
    allowSecureOnLocal: false,
    prefixSecurity: 'strict',
  })
}
/** Normalize Max-Age at receipt, before a read can move tough-cookie's lastAccessed. */
export function acceptJieyouCookie(
  jar: CookieJar,
  header: string,
  url: string,
  receivedAt: number,
): void {
  time(receivedAt)
  const target = literatureUrl(url)
  if (typeof header !== 'string' || Buffer.byteLength(header) > 4096 || /[\0\r\n]/.test(header))
    invalid()
  const ages = header
    .split(';')
    .slice(1)
    .filter((part) => /^\s*max-age(?:\s*=|\s*$)/i.test(part))
  if (ages.length > 1 || (ages.length === 1 && !/^\s*max-age\s*=\s*-?[0-9]+\s*$/i.test(ages[0])))
    invalid()
  const value = Cookie.parse(header)
  if (!value) invalid()
  if (value.maxAge !== null) {
    if (typeof value.maxAge !== 'number' || !Number.isSafeInteger(value.maxAge)) invalid()
    const expiry = value.maxAge <= 0 ? 0 : time(receivedAt + value.maxAge * 1000)
    value.expires = new Date(expiry)
    value.maxAge = null
  }
  // This site's CMS also emits cookies for an unrelated domain (an expired
  // deletion on the public page, a live copy of the captcha key on ShowKey).
  // RFC 6265 5.3 step 6: a Domain that does not domain-match the request host
  // makes the user agent ignore the cookie entirely. It is never stored or sent.
  const domain = value.domain ? canonicalDomain(value.domain) : null
  if (domain && domain !== HOST && domain !== 'jieyoutsg.com') {
    exportJieyouAccountState(jar, receivedAt)
    return
  }
  try {
    jar.setCookieSync(value, target.href, {
      http: true,
      ignoreError: false,
      now: new Date(receivedAt),
    })
    // Garbage-collect expired cookies at every path before applying the live-state budget.
    jar.getCookiesSync('https://www.jieyoutsg.com/', { http: true, allPaths: true })
    // Validate the complete result, including cookies that do not match the current path.
    exportJieyouAccountState(jar, receivedAt)
  } catch (error) {
    if (error instanceof LiteratureError) throw error
    invalid()
  }
}
export function exportJieyouAccountState(jar: CookieJar, now = Date.now()): JieyouAccountState {
  time(now)
  const serialized = jar.serializeSync()
  if (!serialized) invalid()
  const cookies = serialized.cookies.map((v) => {
    if (v.maxAge !== undefined && v.maxAge !== null) invalid()
    const expiresAt =
      v.expires === undefined || v.expires === 'Infinity'
        ? null
        : typeof v.expires === 'string'
          ? Date.parse(v.expires)
          : invalid()
    return {
      name: v.key ?? '',
      value: v.value ?? '',
      domain: v.domain,
      path: v.path,
      hostOnly: v.hostOnly,
      secure: v.secure ?? false,
      httpOnly: v.httpOnly ?? false,
      sameSite: v.sameSite ?? null,
      expiresAt,
    }
  })
  // Validate before dropping expired entries so malformed data cannot be hidden by expiry.
  const state = parseJieyouAccountState({
    schemaVersion: 1,
    format: FORMAT,
    origin: LITERATURE_SITE,
    cookies,
  })
  state.cookies = state.cookies.filter((v) => v.expiresAt === null || v.expiresAt > now)
  return state
}
export function restoreJieyouCookieJar(input: unknown, now = Date.now()): CookieJar {
  time(now)
  const state = parseJieyouAccountState(input)
  const jar = createJieyouCookieJar()
  try {
    for (const v of state.cookies) {
      if (v.expiresAt !== null && v.expiresAt <= now) continue
      const value = new Cookie({
        key: v.name,
        value: v.value,
        domain: v.domain,
        path: v.path,
        hostOnly: v.hostOnly,
        secure: v.secure,
        httpOnly: v.httpOnly,
        sameSite: v.sameSite ?? undefined,
        expires: v.expiresAt === null ? 'Infinity' : new Date(v.expiresAt),
      })
      // HTTPS can store Secure cookies; future HTTP reads still exclude them.
      jar.setCookieSync(value, `https://${HOST}${v.path}`, {
        http: true,
        ignoreError: false,
        now: new Date(now),
      })
    }
    return jar
  } catch {
    jar.removeAllCookiesSync()
    invalid()
  }
}
