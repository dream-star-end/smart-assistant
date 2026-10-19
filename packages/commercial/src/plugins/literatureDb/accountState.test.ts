import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
  parseJieyouAccountState,
  restoreJieyouCookieJar,
} from './accountState.js'
import { LiteratureError } from './errors.js'
import { LITERATURE_SITE } from './policy.js'

const HTTPS = 'https://www.jieyoutsg.com'
const validError = (error: unknown) => error instanceof LiteratureError
function state() {
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(
    jar,
    'sid=synthetic-cookie; Path=/e/; HttpOnly; SameSite=Lax',
    LITERATURE_SITE,
    Date.now(),
  )
  return exportJieyouAccountState(jar)
}

test('HTTP cookie codec preserves private flags and path while Secure cookies stay off HTTP', () => {
  const jar = restoreJieyouCookieJar(state())
  const now = Date.now()
  acceptJieyouCookie(jar, 'secure=synthetic-secure; Secure; Path=/; SameSite=Strict', HTTPS, now)
  acceptJieyouCookie(jar, 'parent=; Domain=jieyoutsg.com; Path=/', HTTPS, now)
  acceptJieyouCookie(jar, '__Host-host=synthetic-host; Secure; Path=/', HTTPS, now)
  const snapshot = exportJieyouAccountState(jar)
  const restored = restoreJieyouCookieJar(snapshot)
  assert.deepEqual(exportJieyouAccountState(restored), snapshot)
  const header = restored.getCookieStringSync(`${LITERATURE_SITE}/e/member/`, { http: true })
  assert(header.includes('sid=synthetic-cookie'))
  assert(header.includes('parent='))
  assert(!header.includes('secure='))
  assert(!header.includes('__Host-host='))
  assert(!restored.getCookieStringSync(`${LITERATURE_SITE}/other/`).includes('sid='))
  assert(restored.getCookieStringSync(`${HTTPS}/e/member/`).includes('secure='))
  assert(!restored.getCookieStringSync('https://other.jieyoutsg.com/e/').includes('sid='))
  assert.equal(snapshot.cookies.find((v) => v.name === 'sid')?.httpOnly, true)
  assert.equal(snapshot.cookies.find((v) => v.name === 'sid')?.sameSite, 'lax')
})

test('Max-Age is fixed at receipt and reading or restoring cannot extend the expiry', () => {
  const received = Date.now()
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, 'age=synthetic; Max-Age=60; Path=/', LITERATURE_SITE, received)
  jar.getCookieStringSync(`${LITERATURE_SITE}/`)
  jar.getCookieStringSync(`${LITERATURE_SITE}/`)
  const at55 = exportJieyouAccountState(jar, received + 55_000)
  assert.equal(at55.cookies[0].expiresAt, received + 60_000)
  const live = restoreJieyouCookieJar(at55, received + 55_000)
  assert.equal(
    exportJieyouAccountState(live, received + 59_000).cookies[0].expiresAt,
    received + 60_000,
  )
  const expired = restoreJieyouCookieJar(at55, received + 65_000)
  assert.equal(expired.getCookieStringSync(`${LITERATURE_SITE}/`), '')
  assert(!JSON.stringify(at55).includes('maxAge'))
})

test('new receipt overrides old creation and Max-Age takes precedence over Expires', () => {
  const now = Date.now()
  const jar = createJieyouCookieJar()
  acceptJieyouCookie(jar, 'age=old; Path=/', LITERATURE_SITE, now - 500_000)
  acceptJieyouCookie(
    jar,
    'age=new; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    LITERATURE_SITE,
    now,
  )
  assert.equal(exportJieyouAccountState(jar).cookies[0].expiresAt, now + 60_000)
  acceptJieyouCookie(
    jar,
    'age=delete; Path=/; Max-Age=0; Expires=Wed, 21 Oct 2037 07:28:00 GMT',
    LITERATURE_SITE,
    now,
  )
  assert.equal(exportJieyouAccountState(jar).cookies.length, 0)
  acceptJieyouCookie(jar, 'age=delete; Path=/; Max-Age=-1', LITERATURE_SITE, now)
  assert.equal(exportJieyouAccountState(jar).cookies.length, 0)
})

test('strict codec refuses jar options, raw jars, domains, flags, dates and duplicate cookies', () => {
  const good = state()
  for (const bad of [
    { ...good, jar: { looseMode: true } },
    { ...good, format: 'raw-tough-cookie' },
    { ...good, origin: 'http://jieyoutsg.com' },
    { ...good, schemaVersion: 2 },
    { ...good, cookies: [good.cookies[0], good.cookies[0]] },
    { ...good, cookies: Array(65).fill(good.cookies[0]) },
    ...[
      { domain: 'eviljieyoutsg.com' },
      { domain: '.jieyoutsg.com' },
      { domain: 'jieyoutsg.com', hostOnly: true },
      { path: 'relative' },
      { path: '/x;inject' },
      { path: '/x\r\n' },
      { name: 'bad;name' },
      { value: 'bad\r\n' },
      { secure: 'false' },
      { sameSite: 'unknown' },
      { expiresAt: Number.NaN },
      { expiresAt: Number.POSITIVE_INFINITY },
      { expiresAt: '2037-01-01' },
      { expiresAt: 8_640_000_000_000_001 },
      { maxAge: 60 },
      { store: {} },
      { name: '__Host-bad' },
    ].map((change) => ({ ...good, cookies: [{ ...good.cookies[0], ...change }] })),
  ])
    assert.throws(() => restoreJieyouCookieJar(bad), validError)
  const large = {
    ...good,
    cookies: Array.from({ length: 16 }, (_, i) => ({
      ...good.cookies[0],
      name: `large${i}`,
      value: 'x'.repeat(3000),
    })),
  }
  assert.throws(() => parseJieyouAccountState(large), validError)
})

test('accessors, inherited fields and sparse cookie arrays are rejected without evaluation', () => {
  const good = state()
  let reads = 0
  const accessor = { ...good }
  Object.defineProperty(accessor, 'cookies', {
    get() {
      reads++
      throw new Error('synthetic-sensitive-marker')
    },
  })
  const badCookie = { ...good.cookies[0] }
  Object.defineProperty(badCookie, 'value', {
    get() {
      reads++
      throw new Error('synthetic-sensitive-marker')
    },
  })
  const array = [good.cookies[0]]
  Object.defineProperty(array, '0', {
    get() {
      reads++
      throw new Error('synthetic-sensitive-marker')
    },
  })
  for (const bad of [
    accessor,
    Object.create(good),
    { ...good, cookies: [badCookie] },
    { ...good, cookies: array },
    { ...good, cookies: Array(1) },
  ]) {
    assert.throws(() => parseJieyouAccountState(bad), validError)
  }
  assert.equal(reads, 0)
})

test('invalid or overflowing relative lifetimes and cookie prefixes fail closed', () => {
  for (const header of [
    'age=x; Max-Age=1.5',
    'age=x; Max-Age=Infinity',
    'age=x; Max-Age=9007199254740991',
    'age=x; Max-Age=1; Max-Age=2',
    '__Secure-bad=x; Path=/',
    '__Host-bad=x; Secure; Path=/e/',
  ])
    assert.throws(
      () => acceptJieyouCookie(createJieyouCookieJar(), header, LITERATURE_SITE, Date.now()),
      validError,
    )
})

test('pre-epoch cookie deletion preserves unrelated valid session state', () => {
  const jar = restoreJieyouCookieJar(state())
  acceptJieyouCookie(
    jar,
    'obsolete=; Path=/; Expires=Wed, 31 Dec 1969 23:59:59 GMT',
    LITERATURE_SITE,
    Date.now(),
  )
  const snapshot = exportJieyouAccountState(jar)
  assert.deepEqual(
    snapshot.cookies.map((v) => v.name),
    ['sid'],
  )
  assert(jar.getCookieStringSync(`${LITERATURE_SITE}/e/member/`).includes('sid=synthetic-cookie'))
})
