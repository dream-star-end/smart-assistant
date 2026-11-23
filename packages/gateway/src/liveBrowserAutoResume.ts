/**
 * Zero-Token deterministic auto-resume watcher for Live Cloud Browser human takeover (OCV5-864).
 *
 * Runs strictly during `humanTakeover === true` using low-frequency (~1000ms) lightweight
 * `Runtime.evaluate` DOM probes (zero `Runtime.enable`, zero LLM calls) plus CDP download
 * lifecycle events (`Page.downloadWillBegin` / `Page.downloadProgress`).
 *
 * Four deterministic completion signals:
 *  (a) `login_completed`: left login/SSO path & login form gone / session changed;
 *  (b) `captcha_cleared`: visible captcha/slider/challenge element unmounted & page interactive;
 *  (c) `download_completed` / `pdf_opened`: file download captured or `application/pdf` opened;
 *  (d) `resume_when_matched`: explicit `BrowserHandoffResumeWhen` criteria satisfied.
 *
 * Hard Blocker Veto (runs FIRST before any signal):
 *  If the current page still has a visible `input[type="password"]`, visible OTP/2FA/captcha
 *  input, visible Turnstile/reCAPTCHA/GeeTest/hCaptcha iframe/widget, auth/SSO/IdP/OAuth/
 *  authorize/consent/captcha/verify URL blocker, or is still loading, `handoff_ready` is
 *  STRICTLY vetoed so multi-step SSO flows are never interrupted mid-flight.
 */
import type {
  BrowserHandoffResumeWhen,
  LiveBrowserHandoffReadyMessage,
  LiveBrowserHandoffVetoedMessage,
} from '@openclaude/protocol'

import type { LiveBrowserCdpTransport } from './liveBrowserCdpHelpers.js'

export const AUTO_RESUME_DEFAULT_POLL_MS = 1_000
const MAX_TRACKED_DOWNLOADS = 32
const MAX_URL_LEN = 2_048
const MAX_TITLE_LEN = 240
const MAX_FILENAME_LEN = 240

export type LiveBrowserAutoResumeEvent =
  | LiveBrowserHandoffReadyMessage
  | LiveBrowserHandoffVetoedMessage

const AUTH_HOST_PREFIX_RE =
  /^(?:login|log-in|signin|sign-in|sso|idp|auth|oauth|oauth2|accounts|passport|cas|verify|challenge)\./i

const KNOWN_IDP_HOST_RE =
  /(?:^|\.)(?:okta\.com|auth0\.com|login\.microsoftonline\.com|login\.live\.com|accounts\.google\.com|appleid\.apple\.com|challenges\.cloudflare\.com|duosecurity\.com|onelogin\.com|pingidentity\.com)$/i

const AUTH_PATH_SEGMENT_RE =
  /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|sso|idp|saml|saml2|oauth|oauth2|oidc|authorize|consent|authenticate|auth|two-factor|2fa|mfa|otp|captcha|verify|verification|checkpoint|challenge|qrconnect)(?:\/|$|\.|[-_](?:login|signin|sso|idp|oauth|authorize|consent|verify|challenge|captcha|mfa|2fa|otp|callback|step|form|page))/i

const AUTH_COMPOUND_PATH_RE =
  /(?:^|\/)(?:session\/new|sessions\/two-factor|sessions\/verified-device|cdn-cgi\/challenge-platform)(?:\/|$)/i

const AUTH_QUERY_PARAM_RE =
  /(?:^|[?&])(?:SAMLRequest|SAMLResponse|__cf_chl_|__cf_chl_rt_tk|oauth_token)=/i

const CAPTCHA_URL_RE =
  /(?:^|\/)(?:captcha|verify|verification|challenge|cdn-cgi\/challenge-platform)(?:\/|$|\.)|challenges\.cloudflare\.com/i

export interface LiveBrowserPageProbe {
  readonly url: string
  readonly title: string
  readonly readyState: string
  readonly contentType: string
  readonly loading?: boolean
  readonly hasVisiblePasswordInput: boolean
  readonly hasVisibleOtpOrCaptchaInput: boolean
  readonly hasVisibleCaptchaFrame: boolean
  readonly hasLoginForm: boolean
  readonly authSessionFingerprint: string
  readonly selectorAppearMatched: boolean
  readonly selectorGoneStillPresent: boolean
  readonly isInteractive: boolean
}

export function isHttpUrl(rawUrl: string): boolean {
  if (!rawUrl) return false
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

export function isAuthOrChallengeUrl(rawUrl: string): boolean {
  if (!rawUrl) return false
  let u: URL
  try {
    u = new URL(rawUrl)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const host = u.hostname.toLowerCase()
  const pathname = u.pathname.toLowerCase()
  if (AUTH_HOST_PREFIX_RE.test(host) || KNOWN_IDP_HOST_RE.test(host)) {
    return true
  }
  if (AUTH_PATH_SEGMENT_RE.test(pathname) || AUTH_COMPOUND_PATH_RE.test(pathname)) {
    return true
  }
  if (u.search && AUTH_QUERY_PARAM_RE.test(u.search)) {
    return true
  }
  return false
}

export function isCaptchaChallengeUrl(rawUrl: string): boolean {
  if (!rawUrl) return false
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    return CAPTCHA_URL_RE.test(`${u.hostname}${u.pathname}`) || /(?:^|[?&])__cf_chl_/i.test(u.search)
  } catch {
    return false
  }
}

export function isPdfProbe(probe: Pick<LiveBrowserPageProbe, 'url' | 'contentType'>): boolean {
  // B5: require real PDF MIME type — never treat a text/plain or error page at a `.pdf` URL as a PDF.
  return probe.contentType.toLowerCase().includes('application/pdf')
}

function extractFilenameFromUrl(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl)
    const seg = decodeURIComponent(u.pathname.split('/').pop() ?? '').trim()
    if (!seg || !/\.[a-z0-9]{1,8}$/i.test(seg)) return undefined
    return sanitizeFilename(seg)
  } catch {
    return undefined
  }
}

function sanitizeFilename(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const base = raw.split(/[\\/]/).pop()?.replace(/[\x00-\x1f\x7f]/g, '').trim() ?? ''
  return base ? base.slice(0, MAX_FILENAME_LEN) : undefined
}

/**
 * Hard Blocker Veto check: returns a non-null veto reason if the page is still in an
 * authentication, SSO, 2FA/OTP, consent, captcha/challenge, or actively loading state.
 */
export function detectBlockerVeto(probe: LiveBrowserPageProbe): string | null {
  if (probe.loading || probe.readyState === 'loading') {
    return 'page_loading'
  }
  if (probe.hasVisiblePasswordInput) {
    return 'visible_password_input'
  }
  if (probe.hasVisibleOtpOrCaptchaInput) {
    return 'visible_otp_or_captcha_input'
  }
  if (probe.hasVisibleCaptchaFrame) {
    return 'visible_captcha_frame'
  }
  if (isAuthOrChallengeUrl(probe.url)) {
    return 'auth_or_challenge_url'
  }
  return null
}

function matchesAnyPattern(url: string, patterns: readonly string[]): boolean {
  const lower = url.toLowerCase()
  return patterns.some((p) => {
    const needle = p.trim().toLowerCase()
    return needle.length > 0 && lower.includes(needle)
  })
}

export function hasExplicitResumeConditions(resumeWhen?: BrowserHandoffResumeWhen): boolean {
  if (!resumeWhen) return false
  return Boolean(
    (resumeWhen.urlLeave && resumeWhen.urlLeave.length > 0) ||
      (resumeWhen.urlMatch && resumeWhen.urlMatch.length > 0) ||
      resumeWhen.selectorAppear ||
      resumeWhen.selectorGone ||
      resumeWhen.waitDownload === true,
  )
}

interface ProbeBaseline {
  readonly url: string
  readonly hadAuthUrl: boolean
  readonly hadCaptcha: boolean
  readonly hadLoginForm: boolean
  readonly hadPdf: boolean
  readonly authSessionFingerprint: string
}

interface TrackedDownload {
  readonly guid: string
  filename?: string
  state: 'began' | 'inProgress' | 'completed' | 'canceled'
  notified: boolean
  readonly startedAt: number
  updatedAt: number
}

/**
 * Pure, deterministic state machine that evaluates probe snapshots & download lifecycle
 * events to decide when to emit `handoff_ready`.
 */
export class LiveBrowserAutoResumeEvaluator {
  private resumeWhen: BrowserHandoffResumeWhen | undefined
  private baseline: ProbeBaseline | null = null
  private sawAuthBarrier = false
  private sawCaptchaBarrier = false
  private sawSelectorGoneTarget = false
  private sawUrlLeaveMatch = false
  private readyActive = false
  private lastEmittedKey: string | null = null
  private readonly downloads = new Map<string, TrackedDownload>()

  reset(resumeWhen?: BrowserHandoffResumeWhen): void {
    this.resumeWhen = resumeWhen
    this.baseline = null
    this.sawAuthBarrier = false
    this.sawCaptchaBarrier = false
    this.sawSelectorGoneTarget = false
    this.sawUrlLeaveMatch = false
    this.readyActive = false
    this.lastEmittedKey = null
    this.downloads.clear()
  }

  updateResumeWhen(resumeWhen?: BrowserHandoffResumeWhen): void {
    this.resumeWhen = resumeWhen
    this.readyActive = false
    this.lastEmittedKey = null
    this.sawSelectorGoneTarget = false
    this.sawUrlLeaveMatch = false
  }

  getResumeWhen(): BrowserHandoffResumeWhen | undefined {
    return this.resumeWhen
  }

  recordDownloadBegin(guid: string, suggestedFilename: string | undefined, now: number): void {
    if (!guid) return
    if (this.downloads.size >= MAX_TRACKED_DOWNLOADS) {
      const oldest = this.downloads.keys().next().value
      if (oldest !== undefined) this.downloads.delete(oldest)
    }
    this.downloads.set(guid, {
      guid,
      filename: sanitizeFilename(suggestedFilename),
      state: 'began',
      notified: false,
      startedAt: now,
      updatedAt: now,
    })
  }

  recordDownloadProgress(
    guid: string,
    state: 'inProgress' | 'completed' | 'canceled',
    now: number,
  ): void {
    if (!guid) return
    const existing = this.downloads.get(guid)
    if (!existing) {
      if (state === 'completed') {
        this.downloads.set(guid, {
          guid,
          state: 'completed',
          notified: false,
          startedAt: now,
          updatedAt: now,
        })
      }
      return
    }
    existing.state = state
    existing.updatedAt = now
    if (state === 'canceled') {
      this.downloads.delete(guid)
    }
  }

  /**
   * B5: Strictly require a real CDP `completed` download progress event.
   * Never infer completion from `downloadWillBegin` + elapsed time.
   */
  private findCompletedDownload(): TrackedDownload | null {
    let newestCompleted: TrackedDownload | null = null
    for (const dl of this.downloads.values()) {
      if (dl.notified) continue
      if (dl.state === 'completed') {
        if (!newestCompleted || dl.updatedAt >= newestCompleted.updatedAt) {
          newestCompleted = dl
        }
      }
    }
    return newestCompleted
  }

  private revokeReady(
    reason: string,
    url: string,
    now: number,
  ): LiveBrowserHandoffVetoedMessage | null {
    if (!this.readyActive) return null
    this.readyActive = false
    this.lastEmittedKey = null
    return {
      type: 'handoff_vetoed',
      reason,
      ...(url ? { url } : {}),
      detectedAt: now,
    }
  }

  evaluate(probe: LiveBrowserPageProbe, now: number): LiveBrowserAutoResumeEvent | null {
    const url = (probe.url || '').slice(0, MAX_URL_LEN)
    const title = (probe.title || '').slice(0, MAX_TITLE_LEN)
    const authUrlNow = isAuthOrChallengeUrl(url)
    const captchaNow =
      probe.hasVisibleCaptchaFrame ||
      probe.hasVisibleOtpOrCaptchaInput ||
      isCaptchaChallengeUrl(url)
    const loginFormNow = probe.hasVisiblePasswordInput || probe.hasLoginForm
    const pdfNow = isPdfProbe(probe)

    if (!this.baseline) {
      this.baseline = {
        url,
        hadAuthUrl: authUrlNow,
        hadCaptcha: captchaNow,
        hadLoginForm: loginFormNow,
        hadPdf: pdfNow,
        authSessionFingerprint: probe.authSessionFingerprint,
      }
    }

    if (authUrlNow || loginFormNow) this.sawAuthBarrier = true
    if (captchaNow) this.sawCaptchaBarrier = true
    if (probe.selectorGoneStillPresent) this.sawSelectorGoneTarget = true
    if (this.resumeWhen?.urlLeave?.length && matchesAnyPattern(url, this.resumeWhen.urlLeave)) {
      this.sawUrlLeaveMatch = true
    }

    // Hard Blocker Veto ALWAYS executes first; if ready was previously emitted, revoke it (B3).
    const vetoReason = detectBlockerVeto(probe)
    if (vetoReason !== null) {
      return this.revokeReady(vetoReason, url, now)
    }

    const completedDownload = this.findCompletedDownload()
    const rw = this.resumeWhen

    if (hasExplicitResumeConditions(rw) && rw) {
      if (!probe.isInteractive && !completedDownload && !pdfNow) {
        return this.revokeReady('page_not_interactive', url, now)
      }

      // B6: `urlLeave` requires first observing a match on the target pattern, then leaving it.
      if (rw.urlLeave && rw.urlLeave.length > 0) {
        if (!isHttpUrl(url) || !this.sawUrlLeaveMatch || matchesAnyPattern(url, rw.urlLeave)) {
          return this.revokeReady('resume_condition_unmet', url, now)
        }
      }
      if (rw.urlMatch && rw.urlMatch.length > 0) {
        if (!matchesAnyPattern(url, rw.urlMatch)) {
          return this.revokeReady('resume_condition_unmet', url, now)
        }
      }
      if (rw.selectorAppear && !probe.selectorAppearMatched) {
        return this.revokeReady('resume_condition_unmet', url, now)
      }
      if (rw.selectorGone) {
        if (probe.selectorGoneStillPresent) {
          return this.revokeReady('resume_condition_unmet', url, now)
        }
        const onlySelectorGone =
          !rw.urlLeave?.length &&
          !rw.urlMatch?.length &&
          !rw.selectorAppear &&
          rw.waitDownload !== true
        if (onlySelectorGone && !this.sawSelectorGoneTarget && url === this.baseline.url) {
          return this.revokeReady('resume_condition_unmet', url, now)
        }
      }
      if (rw.waitDownload === true && !completedDownload && !pdfNow) {
        // Keep readyActive if an already-notified download was satisfied and no blocker appeared;
        // otherwise condition is not yet met.
        return this.readyActive ? null : null
      }

      const filename = completedDownload?.filename ?? (pdfNow ? extractFilenameFromUrl(url) : undefined)
      const emitted = this.emitOnce('resume_when_matched', url, title, filename, now)
      if (emitted && completedDownload) completedDownload.notified = true
      return emitted
    }

    // Generic signal (c): file download completed or browser opened application/pdf.
    if (completedDownload) {
      const emitted = this.emitOnce('download_completed', url, title, completedDownload.filename, now)
      if (emitted) completedDownload.notified = true
      return emitted
    }
    if (pdfNow && (!this.baseline.hadPdf || url !== this.baseline.url)) {
      return this.emitOnce('pdf_opened', url, title, extractFilenameFromUrl(url), now)
    }

    if (!probe.isInteractive) {
      return this.revokeReady('page_not_interactive', url, now)
    }

    // Generic signal (a): left login/SSO path & login form gone / session changed.
    // Checked before captcha_cleared so a multi-step SSO flow that included 2FA/OTP reports login_completed.
    if (this.sawAuthBarrier && isHttpUrl(url) && !authUrlNow && !loginFormNow) {
      const progressed =
        url !== this.baseline.url ||
        probe.authSessionFingerprint !== this.baseline.authSessionFingerprint ||
        this.baseline.hadAuthUrl ||
        this.baseline.hadLoginForm
      if (progressed) {
        return this.emitOnce('login_completed', url, title, undefined, now)
      }
    }

    // Generic signal (b): visible captcha/slider/verification barrier cleared & interactive.
    if (this.sawCaptchaBarrier && !captchaNow) {
      return this.emitOnce('captcha_cleared', url, title, undefined, now)
    }

    return null
  }

  private emitOnce(
    signal: string,
    url: string,
    title: string,
    filename: string | undefined,
    now: number,
  ): LiveBrowserHandoffReadyMessage | null {
    const key = `${signal}\0${url}\0${filename ?? ''}`
    if (this.lastEmittedKey === key) return null
    this.lastEmittedKey = key
    this.readyActive = true
    return {
      type: 'handoff_ready',
      signal,
      url,
      ...(title ? { title } : {}),
      ...(filename ? { filename } : {}),
      detectedAt: now,
    }
  }
}

/**
 * Build a side-effect-free, self-contained JS expression for CDP `Runtime.evaluate`
 * (zero `Runtime.enable`, never reads cookie/storage values — counts only).
 */
export function buildAutoResumeProbeExpression(resumeWhen?: BrowserHandoffResumeWhen): string {
  const escapeJsString = (s: string) =>
    JSON.stringify(s).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  const appearSel = escapeJsString(resumeWhen?.selectorAppear ?? '')
  const goneSel = escapeJsString(resumeWhen?.selectorGone ?? '')
  return `(() => {
    const isVis = (el) => {
      if (!el || el.nodeType !== 1) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    };
    const safeQuery = (sel) => {
      if (!sel) return null;
      try { return document.querySelector(sel); } catch { return null; }
    };
    const otpRe = /\\b(?:otp|totp|2fa|mfa|passcode|sms[_-]?code|verify[_-]?code|auth[_-]?code|captcha|vcode|yzm|seccode)\\b|验证码|动态码|安全码|两步验证|双重验证/i;
    const captchaSrcRe = /turnstile|challenges\\.cloudflare\\.com|recaptcha|hcaptcha|geetest|arkoselabs|funcaptcha|tcaptcha|aliyuncaptcha|captcha/i;
    let hasVisiblePasswordInput = false;
    let hasVisibleOtpOrCaptchaInput = false;
    let hasLoginForm = false;
    const inputs = document.querySelectorAll('input');
    for (let i = 0; i < inputs.length; i++) {
      const inp = inputs[i];
      if (!isVis(inp)) continue;
      const type = String(inp.getAttribute('type') || inp.type || 'text').toLowerCase();
      if (type === 'password') {
        hasVisiblePasswordInput = true;
        hasLoginForm = true;
        continue;
      }
      const ac = String(inp.getAttribute('autocomplete') || '').toLowerCase();
      const meta = [inp.name, inp.id, inp.placeholder, inp.getAttribute('aria-label'), inp.className].filter(Boolean).join(' ');
      if (ac === 'one-time-code' || otpRe.test(meta)) {
        hasVisibleOtpOrCaptchaInput = true;
      }
    }
    if (!hasLoginForm) {
      const forms = document.querySelectorAll('form');
      for (let i = 0; i < forms.length; i++) {
        const f = forms[i];
        if (!isVis(f)) continue;
        const action = String(f.getAttribute('action') || '') + ' ' + String(f.id || '') + ' ' + String(f.className || '');
        if (/\\b(?:login|signin|sign-in|log-in|auth|sso)\\b/i.test(action)) {
          hasLoginForm = true;
          break;
        }
      }
    }
    let hasVisibleCaptchaFrame = false;
    const frames = document.querySelectorAll('iframe');
    for (let i = 0; i < frames.length; i++) {
      const fr = frames[i];
      if (!isVis(fr)) continue;
      const sig = [fr.src, fr.title, fr.id, fr.name, fr.className].filter(Boolean).join(' ');
      if (captchaSrcRe.test(sig)) {
        hasVisibleCaptchaFrame = true;
        break;
      }
    }
    if (!hasVisibleCaptchaFrame) {
      const widgets = document.querySelectorAll('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey],[class*="geetest"],[id*="captcha" i],[class*="captcha" i],#nc_1_wrapper');
      for (let i = 0; i < widgets.length; i++) {
        if (isVis(widgets[i])) {
          hasVisibleCaptchaFrame = true;
          break;
        }
      }
    }
    let cookieCount = 0;
    try {
      const c = document.cookie || '';
      cookieCount = c ? c.split(';').filter(Boolean).length : 0;
    } catch {}
    let lsCount = 0;
    try { lsCount = window.localStorage ? window.localStorage.length : 0; } catch {}
    const appearEl = safeQuery(${appearSel});
    const goneEl = safeQuery(${goneSel});
    const rs = String(document.readyState || '');
    const body = document.body;
    const isInteractive = (rs === 'interactive' || rs === 'complete') && Boolean(body);
    return {
      url: String(location.href || ''),
      title: String(document.title || ''),
      readyState: rs,
      contentType: String(document.contentType || ''),
      hasVisiblePasswordInput,
      hasVisibleOtpOrCaptchaInput,
      hasVisibleCaptchaFrame,
      hasLoginForm,
      authSessionFingerprint: 'c:' + cookieCount + ':ls:' + lsCount,
      selectorAppearMatched: Boolean(appearEl && isVis(appearEl)),
      selectorGoneStillPresent: Boolean(goneEl && isVis(goneEl)),
      isInteractive,
    };
  })()`
}

export interface LiveBrowserAutoResumeWatcherDeps {
  getCdp: () => { cdp: LiveBrowserCdpTransport; sessionId: string } | null
  isActive: () => boolean
  isLoading: () => boolean
  getFallbackUrl: () => string
  getFallbackTitle: () => string
  now: () => number
  pollIntervalMs?: number
  onReady: (msg: LiveBrowserHandoffReadyMessage) => void
  onVetoed?: (msg: LiveBrowserHandoffVetoedMessage) => void
}

const AUTO_RESUME_ARMED_POLL_MS = 200

/**
 * Interval-driven CDP watcher bound to a single `LiveBrowserStreamSession`.
 * Guarantees zero timer leaks and zero overlapping probes.
 * While `armed` (handoff_ready emitted and frontend countdown active), polls faster
 * (200ms) so async OTP/blocker reappearance is detected and vetoed before countdown ends.
 */
export class LiveBrowserAutoResumeWatcher {
  private readonly evaluator = new LiveBrowserAutoResumeEvaluator()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private probing = false
  private armed = false
  private watchId: string | undefined = undefined
  private gen = 0

  constructor(private readonly deps: LiveBrowserAutoResumeWatcherDeps) {}

  private scheduleNext(expectedGen: number): void {
    if (!this.running || this.gen !== expectedGen) return
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const baseInterval = Math.max(20, this.deps.pollIntervalMs ?? AUTO_RESUME_DEFAULT_POLL_MS)
    const interval = this.armed ? Math.min(baseInterval, AUTO_RESUME_ARMED_POLL_MS) : baseInterval
    this.timer = setTimeout(() => {
      this.timer = null
      void this.probeOnce(expectedGen)
    }, interval)
    this.timer.unref?.()
  }

  start(resumeWhen?: BrowserHandoffResumeWhen, watchId?: string): void {
    this.stop()
    this.gen += 1
    this.running = true
    this.armed = false
    this.watchId = typeof watchId === 'string' && watchId.trim() ? watchId.trim().slice(0, 128) : undefined
    this.evaluator.reset(resumeWhen)
    void this.probeOnce(this.gen)
  }

  setResumeWhen(resumeWhen?: BrowserHandoffResumeWhen, watchId?: string): void {
    this.armed = false
    if (watchId !== undefined) {
      this.watchId = typeof watchId === 'string' && watchId.trim() ? watchId.trim().slice(0, 128) : undefined
    }
    this.evaluator.updateResumeWhen(resumeWhen)
    if (this.running) {
      void this.probeOnce(this.gen)
    }
  }

  stop(): void {
    this.gen += 1
    this.running = false
    this.probing = false
    this.armed = false
    this.watchId = undefined
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.evaluator.reset(undefined)
  }

  isRunning(): boolean {
    return this.running
  }

  onDownloadBegin(guid: string, suggestedFilename?: string): void {
    if (!this.running) return
    this.evaluator.recordDownloadBegin(guid, suggestedFilename, this.deps.now())
  }

  onDownloadProgress(guid: string, state: string): void {
    if (!this.running) return
    if (state !== 'inProgress' && state !== 'completed' && state !== 'canceled') return
    this.evaluator.recordDownloadProgress(guid, state, this.deps.now())
    if (state === 'completed') {
      void this.probeOnce(this.gen)
    }
  }

  onNavigation(): void {
    if (!this.running) return
    void this.probeOnce(this.gen)
  }

  private async probeOnce(expectedGen: number): Promise<void> {
    if (!this.running || this.probing || this.gen !== expectedGen) return
    if (!this.deps.isActive()) {
      this.stop()
      return
    }
    const target = this.deps.getCdp()
    if (!target) return
    this.probing = true
    try {
      const expr = buildAutoResumeProbeExpression(this.evaluator.getResumeWhen())
      const res = (await target.cdp.send(
        'Runtime.evaluate',
        {
          expression: expr,
          returnByValue: true,
          awaitPromise: false,
          silent: true,
        },
        target.sessionId,
      )) as { result?: { value?: unknown } } | null

      if (!this.running || this.gen !== expectedGen || !this.deps.isActive()) return

      const val = res?.result?.value
      if (!val || typeof val !== 'object' || Array.isArray(val)) return
      const raw = val as Record<string, unknown>
      const probe: LiveBrowserPageProbe = {
        url: typeof raw.url === 'string' && raw.url ? raw.url : this.deps.getFallbackUrl(),
        title: typeof raw.title === 'string' ? raw.title : this.deps.getFallbackTitle(),
        readyState: typeof raw.readyState === 'string' ? raw.readyState : '',
        contentType: typeof raw.contentType === 'string' ? raw.contentType : '',
        loading: this.deps.isLoading(),
        hasVisiblePasswordInput: raw.hasVisiblePasswordInput === true,
        hasVisibleOtpOrCaptchaInput: raw.hasVisibleOtpOrCaptchaInput === true,
        hasVisibleCaptchaFrame: raw.hasVisibleCaptchaFrame === true,
        hasLoginForm: raw.hasLoginForm === true,
        authSessionFingerprint:
          typeof raw.authSessionFingerprint === 'string' ? raw.authSessionFingerprint : '',
        selectorAppearMatched: raw.selectorAppearMatched === true,
        selectorGoneStillPresent: raw.selectorGoneStillPresent === true,
        isInteractive: raw.isInteractive === true,
      }

      const evt = this.evaluator.evaluate(probe, this.deps.now())
      if (evt && this.running && this.gen === expectedGen && this.deps.isActive()) {
        const tagged = this.watchId ? { ...evt, watchId: this.watchId } : evt
        if (tagged.type === 'handoff_ready') {
          this.armed = true
          this.deps.onReady(tagged)
        } else {
          this.armed = false
          this.deps.onVetoed?.(tagged)
        }
      }
    } catch {
      // Best-effort zero-token probe: transient navigation/context errors are silently skipped.
    } finally {
      this.probing = false
      if (this.running && this.gen === expectedGen) {
        this.scheduleNext(expectedGen)
      }
    }
  }
}
