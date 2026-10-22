/** Private pre-login HTTP driver. Raw pages/cookies are never model-facing results. */
import { randomUUID } from 'node:crypto'
import { type DefaultTreeAdapterMap, Parser, type Token } from 'parse5'
import type { CookieJar } from 'tough-cookie'
import {
  type JieyouAccountState,
  acceptJieyouCookie,
  createJieyouCookieJar,
  exportJieyouAccountState,
  restoreJieyouCookieJar,
} from './accountState.js'
import { type CaptchaImage, captchaAnswer, normalizeCaptchaImage } from './captcha.js'
import { parseLiteratureCredentials } from './credentials.js'
import { LiteratureError, abortable } from './errors.js'
import { LITERATURE_SITE, literatureUrl } from './policy.js'
import { type LiteratureHttpResponse, LiteratureHttpTransport } from './transport.js'

type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']
interface Field {
  readonly name: string
  readonly value: string
}
export interface JieyouLoginForm {
  readonly action: string
  readonly captchaUrl: string
  readonly hidden: readonly Field[]
  readonly lifetimes: readonly {
    readonly value: string
    readonly checked: boolean
  }[]
  readonly submitValue: string
}
export interface JieyouPrivateResponse {
  url: string
  response: LiteratureHttpResponse
}
const LOGIN_URL = `${LITERATURE_SITE}/e/member/login/`
function invalid(): never {
  throw new LiteratureError('RESPONSE_INVALID')
}
function attr(e: Element, name: string): string | undefined {
  return e.attrs.find((a) => a.name === name)?.value
}
function value(e: Element): string {
  const result = attr(e, 'value')
  if (result === undefined || result.length > 2048 || /[\0\r\n]/.test(result)) invalid()
  return result
}
function elements(root: Node): Element[] {
  const stack = [root]
  const output: Element[] = []
  let visited = 0
  while (stack.length) {
    const node = stack.pop()!
    if (++visited > 20_000) invalid()
    if ('tagName' in node) output.push(node)
    if ('childNodes' in node) {
      if (stack.length + node.childNodes.length > 20_000) invalid()
      for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i])
    }
  }
  return output
}
/** parse5's pinned parser form pointer survives legacy <table><form> tree repair.
 * DOM ancestry alone loses these controls. Capture actual inserted nodes, not a
 * whole-page guess. This small internal-API adapter is guarded by layout tests.
 */
class JieyouFormParser extends Parser<DefaultTreeAdapterMap> {
  readonly owners = new WeakMap<Element, Element>()
  override _attachElementToTree(
    element: Element,
    location: Token.LocationWithAttributes | null,
  ): void {
    super._attachElementToTree(element, location)
    if (
      element.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      ['input', 'img'].includes(element.tagName) &&
      this.formElement &&
      this.openElements.tmplCount === 0
    )
      this.owners.set(element, this.formElement)
  }
}
/** Public HTML structure only; values must come from the current page, never CMS defaults. */
export function parseJieyouLoginForm(html: string, baseUrl = LOGIN_URL): JieyouLoginForm {
  if (typeof html !== 'string' || !html.length || Buffer.byteLength(html) > 1024 * 1024) invalid()
  const base = literatureUrl(baseUrl)
  const parser = new JieyouFormParser()
  parser.tokenizer.write(html, true)
  const tree = elements(parser.document)
  // This fixed site has no explicit form-owner overrides, including external controls.
  if (tree.some((e) => e.tagName === 'input' && attr(e, 'form') !== undefined)) invalid()
  const candidates = tree
    .filter((e) => e.tagName === 'form')
    .map((form) => {
      const scope = tree.filter((e) => parser.owners.get(e) === form)
      return {
        form,
        scope,
        inputs: scope.filter((e) => e.tagName === 'input'),
      }
    })
    .filter(({ inputs }) =>
      ['username', 'password', 'key'].every((name) => inputs.some((e) => attr(e, 'name') === name)),
    )
  if (candidates.length !== 1) invalid()
  const { form, inputs, scope } = candidates[0]
  if (
    attr(form, 'method')?.toLowerCase() !== 'post' ||
    (attr(form, 'enctype') && attr(form, 'enctype') !== 'application/x-www-form-urlencoded')
  )
    invalid()
  const action = literatureUrl(attr(form, 'action') ?? '', base.href)
  if (action.pathname !== '/e/member/doaction.php' || action.search) invalid()
  for (const [name, type] of [
    ['username', 'text'],
    ['password', 'password'],
    ['key', 'text'],
  ]) {
    const found = inputs.filter((e) => attr(e, 'name') === name)
    if (
      found.length !== 1 ||
      (attr(found[0], 'type') ?? 'text').toLowerCase() !== type ||
      attr(found[0], 'disabled') !== undefined
    )
      invalid()
  }
  const hidden: Field[] = []
  const seen = new Set<string>()
  for (const input of inputs) {
    const name = attr(input, 'name')
    if (!name) continue
    const type = (attr(input, 'type') ?? 'text').toLowerCase()
    if (type === 'hidden') {
      if (!['ecmsfrom', 'enews', 'tobind'].includes(name) || seen.has(name)) invalid()
      seen.add(name)
      hidden.push(Object.freeze({ name, value: value(input) }))
    } else if (!['username', 'password', 'key', 'lifetime', 'Submit'].includes(name)) invalid()
  }
  if (
    hidden.length !== 3 ||
    hidden.reduce((size, f) => size + Buffer.byteLength(f.value), 0) > 8192
  )
    invalid()
  const radios = inputs.filter((e) => attr(e, 'name') === 'lifetime')
  if (radios.length < 1 || radios.length > 8) invalid()
  const lifetimes = radios.map((e) => {
    if (attr(e, 'type')?.toLowerCase() !== 'radio' || attr(e, 'disabled') !== undefined) invalid()
    return Object.freeze({
      value: value(e),
      checked: attr(e, 'checked') !== undefined,
    })
  })
  if (
    new Set(lifetimes.map((e) => e.value)).size !== lifetimes.length ||
    lifetimes.filter((e) => e.checked).length > 1
  )
    invalid()
  const submits = inputs.filter((e) => attr(e, 'name') === 'Submit')
  if (
    submits.length !== 1 ||
    attr(submits[0], 'type')?.toLowerCase() !== 'submit' ||
    attr(submits[0], 'disabled') !== undefined
  )
    invalid()
  const images = scope
    .filter((e) => e.tagName === 'img')
    .flatMap((e) => {
      try {
        const url = literatureUrl(attr(e, 'src') ?? '', base.href)
        return url.pathname === '/e/ShowKey/' &&
          url.searchParams.size === 1 &&
          url.searchParams.get('v') === 'login'
          ? [url.href]
          : []
      } catch {
        return []
      }
    })
  if (images.length !== 1) invalid()
  return Object.freeze({
    action: action.href,
    captchaUrl: images[0],
    hidden: Object.freeze(hidden),
    lifetimes: Object.freeze(lifetimes),
    submitValue: value(submits[0]),
  })
}

/** One caller/owner per instance. Installation, lease and persistence remain control-plane duties. */
export class JieyouHttpClient {
  private readonly jar: CookieJar
  private form?: JieyouLoginForm
  private challenge?: string
  private busy = false
  private closed = false
  private active?: AbortController
  private draining?: Promise<void>
  private closing?: Promise<void>
  constructor(
    private readonly transport = new LiteratureHttpTransport(),
    options: { initialState?: unknown } = {},
  ) {
    this.jar =
      options.initialState === undefined
        ? createJieyouCookieJar()
        : restoreJieyouCookieJar(options.initialState)
  }
  private check(signal: AbortSignal): void {
    if (this.closed || signal.aborted) throw new LiteratureError('CANCELLED')
  }
  private async run<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(signal)
    if (this.busy) throw new LiteratureError('ACCOUNT_BUSY')
    this.busy = true
    const controller = new AbortController()
    this.active = controller
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const underlying = Promise.resolve().then(() => {
      this.check(controller.signal)
      return work(controller.signal)
    })
    // Consume the operation's result here only for cleanup; its error is still returned below.
    const drained = underlying.then(
      () => undefined,
      () => undefined,
    )
    this.draining = drained
    try {
      return await abortable(underlying, controller.signal)
    } catch (error) {
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    } finally {
      await drained
      signal.removeEventListener('abort', abort)
      this.draining = undefined
      this.active = undefined
      this.busy = false
    }
  }
  private acceptCookies(response: LiteratureHttpResponse, url: string): void {
    const headers = response.headers['set-cookie'] ?? []
    try {
      if (!Array.isArray(headers) || headers.length > 64)
        throw new LiteratureError('RESPONSE_TOO_LARGE')
      for (const cookie of headers) {
        if (typeof cookie !== 'string' || Buffer.byteLength(cookie) > 4096)
          throw new LiteratureError('RESPONSE_TOO_LARGE')
        acceptJieyouCookie(this.jar, cookie, url, Date.now())
      }
      exportJieyouAccountState(this.jar)
    } catch (error) {
      this.jar.removeAllCookiesSync()
      this.form = undefined
      this.challenge = undefined
      if (error instanceof LiteratureError) throw error
      throw new LiteratureError('RESPONSE_INVALID')
    }
  }
  private async hop(
    urlInput: string,
    signal: AbortSignal,
    body?: Buffer,
  ): Promise<JieyouPrivateResponse> {
    this.check(signal)
    const url = literatureUrl(urlInput).href
    const cookie = this.jar.getCookieStringSync(url, { http: true })
    if (Buffer.byteLength(cookie) > 16 * 1024) throw new LiteratureError('RESPONSE_TOO_LARGE')
    const response = await this.transport.request({
      url,
      signal,
      cookie: cookie || undefined,
      ...(body ? { method: 'POST', body } : { method: 'GET' }),
    })
    this.check(signal)
    if (response.status === 403 || response.status === 429)
      throw new LiteratureError('UPSTREAM_BLOCKED')
    this.acceptCookies(response, url)
    return { url, response }
  }
  private async get(url: string, signal: AbortSignal): Promise<JieyouPrivateResponse> {
    const seen = new Set<string>()
    for (let redirects = 0; redirects <= 3; redirects++) {
      const current = literatureUrl(url).href
      if (seen.has(current)) throw new LiteratureError('OUTBOUND_BLOCKED')
      seen.add(current)
      const result = await this.hop(current, signal)
      if (![301, 302, 303, 307, 308].includes(result.response.status)) return result
      if (!result.response.redirect || redirects === 3)
        throw new LiteratureError('OUTBOUND_BLOCKED')
      url = result.response.redirect
    }
    throw new LiteratureError('OUTBOUND_BLOCKED')
  }
  private async page(signal: AbortSignal): Promise<JieyouLoginForm> {
    this.form = undefined
    this.challenge = undefined
    const { response, url } = await this.get(LOGIN_URL, signal)
    if (
      response.status !== 200 ||
      !/^text\/html(?:\s*;|$)/i.test(response.headers['content-type'] ?? '')
    )
      invalid()
    const html = new TextDecoder('utf-8', { fatal: true }).decode(response.body)
    const form = parseJieyouLoginForm(html, url)
    this.check(signal)
    this.form = form
    return form
  }
  loadLoginPage(signal: AbortSignal): Promise<JieyouLoginForm> {
    return this.run(signal, (s) => this.page(s))
  }
  getChallenge(signal: AbortSignal): Promise<{ challengeId: string; image: CaptchaImage }> {
    return this.run(signal, async (s) => {
      this.challenge = undefined
      const form = this.form ?? (await this.page(s))
      const url = new URL(form.captchaUrl)
      url.searchParams.set('_aurora_challenge', randomUUID())
      const { response } = await this.get(url.href, s)
      if (response.status !== 200) invalid()
      const mediaType = response.headers['content-type']?.split(';')[0].trim().toLowerCase()
      if (mediaType !== 'image/png' && mediaType !== 'image/jpeg') invalid()
      const image = await abortable(normalizeCaptchaImage({ data: response.body, mediaType }), s)
      this.check(s)
      const challengeId = randomUUID()
      this.challenge = challengeId
      return { challengeId, image }
    })
  }
  /** Exactly one POST; returns private evidence, NOT an authenticated verdict. */
  submit(
    input: {
      challengeId: string
      credentials: unknown
      answer: string
      lifetime: string
    },
    signal: AbortSignal,
  ): Promise<JieyouPrivateResponse> {
    return this.run(signal, async (s) => {
      const form = this.form
      if (!form || !this.challenge || input.challengeId !== this.challenge)
        throw new LiteratureError('CHALLENGE_STALE')
      const credentials = parseLiteratureCredentials(input.credentials)
      const answer = captchaAnswer(input.answer)
      if (!form.lifetimes.some((item) => item.value === input.lifetime))
        throw new LiteratureError('INVALID_INPUT')
      const fields = new URLSearchParams(form.hidden.map(({ name, value }) => [name, value]))
      fields.set('username', credentials.username)
      fields.set('password', credentials.password)
      fields.set('key', answer)
      fields.set('lifetime', input.lifetime)
      fields.set('Submit', form.submitValue)
      const body = Buffer.from(fields.toString())
      // Consume before dispatch. Even a lost response cannot make this challenge reusable.
      this.challenge = undefined
      try {
        if (body.length > 16 * 1024) throw new LiteratureError('INVALID_INPUT')
        return await this.hop(form.action, s, body)
      } finally {
        body.fill(0)
      }
    })
  }
  /** Bounded GET on the fixed site using this client's private cookie jar. */
  getMemberPage(pathOrUrl: string, signal: AbortSignal): Promise<JieyouPrivateResponse> {
    return this.run(signal, (s) => this.get(literatureUrl(pathOrUrl, LITERATURE_SITE).href, s))
  }
  /** Private cookie evidence only; it proves neither login success nor account ownership. */
  exportPrivateCookies(): JieyouAccountState {
    if (this.closed) throw new LiteratureError('CANCELLED')
    if (this.busy) throw new LiteratureError('ACCOUNT_BUSY')
    return exportJieyouAccountState(this.jar)
  }
  /** Synchronously seals state; completion proves all active HTTP connections have closed. */
  close(): Promise<void> {
    this.closed = true
    this.active?.abort()
    this.jar.removeAllCookiesSync()
    this.form = undefined
    this.challenge = undefined
    return (this.closing ??= this.draining ?? Promise.resolve())
  }
}
