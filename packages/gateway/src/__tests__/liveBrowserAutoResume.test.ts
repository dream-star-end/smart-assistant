import * as assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import {
  LIVE_BROWSER_ASSERTION_HEADER,
  LIVE_BROWSER_INTERNAL_WS_PATH,
  LIVE_BROWSER_PROTOCOL_VERSION,
  encodeAuthorityKeyring,
  type LiveBrowserHandoffReadyMessage,
} from '@openclaude/protocol'
import { signLiveBrowserAssertion } from '@openclaude/protocol/containerPreviewAuth'
import { WebSocket } from 'ws'

import {
  LiveBrowserAutoResumeEvaluator,
  LiveBrowserAutoResumeWatcher,
  detectBlockerVeto,
  isAuthOrChallengeUrl,
  type LiveBrowserPageProbe,
} from '../liveBrowserAutoResume.js'
import type { LiveBrowserCdpTransport } from '../liveBrowserCdpHelpers.js'
import { LiveBrowserStreamManager } from '../liveBrowserStream.js'

function makeProbe(overrides: Partial<LiveBrowserPageProbe> = {}): LiveBrowserPageProbe {
  return {
    url: 'https://app.example.com/dashboard',
    title: 'Dashboard',
    readyState: 'complete',
    contentType: 'text/html',
    loading: false,
    hasVisiblePasswordInput: false,
    hasVisibleOtpOrCaptchaInput: false,
    hasVisibleCaptchaFrame: false,
    hasLoginForm: false,
    authSessionFingerprint: 'c:2:ls:1',
    selectorAppearMatched: false,
    selectorGoneStillPresent: false,
    isInteractive: true,
    ...overrides,
  }
}

describe('LiveBrowserAutoResumeEvaluator — zero-token deterministic completion & Blocker Veto', () => {
  it('triggers login_completed after leaving login page and clearing login form, deduplicating same URL+signal', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset(undefined)

    // Initial login page -> vetoed
    const p1 = ev.evaluate(
      makeProbe({
        url: 'https://github.com/login',
        title: 'Sign in to GitHub',
        hasVisiblePasswordInput: true,
        hasLoginForm: true,
        authSessionFingerprint: 'c:1:ls:0',
      }),
      1_000,
    )
    assert.equal(p1, null)

    // After successful login -> business page, no blockers
    const p2 = ev.evaluate(
      makeProbe({
        url: 'https://github.com/org/repo',
        title: 'org/repo',
        authSessionFingerprint: 'c:4:ls:2',
      }),
      2_000,
    )
    assert.ok(p2)
    assert.equal(p2.type, 'handoff_ready')
    assert.equal(p2.signal, 'login_completed')
    assert.equal(p2.url, 'https://github.com/org/repo')
    assert.equal(p2.title, 'org/repo')
    assert.equal(p2.detectedAt, 2_000)

    // Same URL + signal must NOT spam duplicates
    const p3 = ev.evaluate(
      makeProbe({
        url: 'https://github.com/org/repo',
        title: 'org/repo',
        authSessionFingerprint: 'c:4:ls:2',
      }),
      3_000,
    )
    assert.equal(p3, null)
  })

  it('strictly vetoes every intermediate step of a multi-step SSO flow (IdP -> password -> 2FA/OTP -> OAuth consent -> dashboard)', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset(undefined)

    // Step 1: App login entry
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://app.example.com/login',
          hasLoginForm: true,
        }),
        1_000,
      ),
      null,
    )

    // Step 2: Corporate IdP password page
    const idpPassword = makeProbe({
      url: 'https://idp.corp.example.com/sso/saml',
      hasVisiblePasswordInput: true,
      hasLoginForm: true,
    })
    assert.equal(detectBlockerVeto(idpPassword), 'visible_password_input')
    assert.equal(ev.evaluate(idpPassword, 2_000), null)

    // Step 3: 2FA / OTP prompt (no password input, only OTP box)
    const otpStep = makeProbe({
      url: 'https://idp.corp.example.com/mfa/verify',
      hasVisibleOtpOrCaptchaInput: true,
    })
    assert.equal(detectBlockerVeto(otpStep), 'visible_otp_or_captcha_input')
    assert.equal(ev.evaluate(otpStep, 3_000), null)

    // Step 4: OAuth consent screen (no password, no OTP, auth/consent URL)
    const consentStep = makeProbe({
      url: 'https://accounts.google.com/o/oauth2/authorize?client_id=abc',
    })
    assert.equal(isAuthOrChallengeUrl(consentStep.url), true)
    assert.equal(detectBlockerVeto(consentStep), 'auth_or_challenge_url')
    assert.equal(ev.evaluate(consentStep, 4_000), null)

    // Step 5: Redirecting / still loading business page
    const loadingStep = makeProbe({
      url: 'https://app.example.com/workspace',
      loading: true,
      readyState: 'loading',
    })
    assert.equal(detectBlockerVeto(loadingStep), 'page_loading')
    assert.equal(ev.evaluate(loadingStep, 4_500), null)

    // Step 6: Landed on business page, settled, zero blockers -> fires login_completed!
    const done = ev.evaluate(
      makeProbe({
        url: 'https://app.example.com/workspace',
        title: 'Workspace',
      }),
      5_000,
    )
    assert.ok(done)
    assert.equal(done.type, 'handoff_ready')
    assert.equal(done.signal, 'login_completed')
    assert.equal(done.url, 'https://app.example.com/workspace')
  })

  it('B3: emits handoff_vetoed when an async SPA mounts a blocker after handoff_ready, and re-emits once cleared', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset(undefined)

    // Initial login page
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://app.example.com/login',
          hasVisiblePasswordInput: true,
          hasLoginForm: true,
        }),
        1_000,
      ),
      null,
    )

    // SPA shell loads /dashboard before async OTP modal mounts -> handoff_ready
    const first = ev.evaluate(
      makeProbe({
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
      }),
      2_000,
    )
    assert.ok(first)
    assert.equal(first.type, 'handoff_ready')
    assert.equal(first.signal, 'login_completed')

    // 500ms later (same URL, no page loading), SPA mounts a visible 2FA/OTP modal -> MUST emit handoff_vetoed!
    const veto = ev.evaluate(
      makeProbe({
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        loading: false,
        hasVisibleOtpOrCaptchaInput: true,
      }),
      2_500,
    )
    assert.ok(veto)
    assert.equal(veto.type, 'handoff_vetoed')
    assert.equal(veto.reason, 'visible_otp_or_captcha_input')
    assert.equal(veto.url, 'https://app.example.com/dashboard')

    // Subsequent poll while OTP is still visible does NOT spam handoff_vetoed
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://app.example.com/dashboard',
          hasVisibleOtpOrCaptchaInput: true,
        }),
        3_000,
      ),
      null,
    )

    // User finishes OTP -> modal unmounts -> MUST re-emit handoff_ready on the same URL!
    const recovered = ev.evaluate(
      makeProbe({
        url: 'https://app.example.com/dashboard',
        title: 'Dashboard',
        hasVisibleOtpOrCaptchaInput: false,
      }),
      4_000,
    )
    assert.ok(recovered)
    assert.equal(recovered.type, 'handoff_ready')
  })

  it('vetoes visible Turnstile/reCAPTCHA/GeeTest iframe and emits captcha_cleared once unmounted', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset(undefined)

    // Same business URL, Turnstile overlay present
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://scholar.example.com/paper/42',
          hasVisibleCaptchaFrame: true,
        }),
        1_000,
      ),
      null,
    )

    // Captcha unmounted & page interactive -> captcha_cleared
    const cleared = ev.evaluate(
      makeProbe({
        url: 'https://scholar.example.com/paper/42',
        hasVisibleCaptchaFrame: false,
        isInteractive: true,
      }),
      2_000,
    )
    assert.ok(cleared)
    assert.equal(cleared.type, 'handoff_ready')
    assert.equal(cleared.signal, 'captcha_cleared')
  })

  it('emits download_completed on CDP download completion, ignores canceled/inProgress, and emits pdf_opened', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset(undefined)

    const paperPage = makeProbe({ url: 'https://ieee.example.org/document/999', title: 'Paper 999' })
    assert.equal(ev.evaluate(paperPage, 1_000), null)

    // Download begins -> WITHOUT completed progress, MUST NEVER emit even after >500ms / >5s (B5)!
    ev.recordDownloadBegin('dl-1', 'paper-999.pdf', 1_100)
    assert.equal(ev.evaluate(paperPage, 1_600), null)
    assert.equal(ev.evaluate(paperPage, 6_500), null)
    ev.recordDownloadProgress('dl-1', 'inProgress', 6_600)
    assert.equal(ev.evaluate(paperPage, 7_000), null)

    // Canceled download must NOT trigger
    ev.recordDownloadProgress('dl-1', 'canceled', 7_100)
    assert.equal(ev.evaluate(paperPage, 8_000), null)

    // Second download completes -> triggers immediately with filename!
    ev.recordDownloadBegin('dl-2', 'final-report.pdf', 8_100)
    ev.recordDownloadProgress('dl-2', 'completed', 8_200)
    const ready = ev.evaluate(paperPage, 8_250)
    assert.ok(ready)
    assert.equal(ready.type, 'handoff_ready')
    assert.equal(ready.signal, 'download_completed')
    assert.equal(ready.filename, 'final-report.pdf')

    // Subsequent 2nd distinct download on the same page MUST also emit (not shadowed by dl-2)
    ev.recordDownloadBegin('dl-3', 'appendix.zip', 8_400)
    ev.recordDownloadProgress('dl-3', 'completed', 8_500)
    const ready2 = ev.evaluate(paperPage, 8_550)
    assert.ok(ready2)
    assert.equal(ready2.type, 'handoff_ready')
    assert.equal(ready2.signal, 'download_completed')
    assert.equal(ready2.filename, 'appendix.zip')

    // PDF navigation triggers pdf_opened
    const evPdf = new LiveBrowserAutoResumeEvaluator()
    evPdf.reset(undefined)
    assert.equal(evPdf.evaluate(paperPage, 1_000), null)
    const pdfReady = evPdf.evaluate(
      makeProbe({
        url: 'https://arxiv.org/pdf/2501.00001.pdf',
        contentType: 'application/pdf',
      }),
      2_000,
    )
    assert.ok(pdfReady)
    assert.equal(pdfReady.type, 'handoff_ready')
    assert.equal(pdfReady.signal, 'pdf_opened')
    assert.equal(pdfReady.filename, '2501.00001.pdf')
  })

  it('matches explicit resume_when criteria accurately and still enforces Blocker Veto', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset({
      urlLeave: ['/login', '/oauth'],
      urlMatch: ['/console/projects'],
      selectorAppear: '[data-testid="project-list"]',
      selectorGone: '.auth-modal',
    })

    // Still on /login
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://cloud.example.com/login',
          selectorAppearMatched: false,
          selectorGoneStillPresent: true,
        }),
        1_000,
      ),
      null,
    )

    // Left /login to /console/home (does NOT match urlMatch '/console/projects') -> must NOT fire generic login_completed!
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://cloud.example.com/console/home',
          selectorAppearMatched: false,
          selectorGoneStillPresent: false,
        }),
        2_000,
      ),
      null,
    )

    // Matched urlMatch + selectorAppear, BUT visible password input still present -> Blocker Veto wins!
    assert.equal(
      ev.evaluate(
        makeProbe({
          url: 'https://cloud.example.com/console/projects',
          selectorAppearMatched: true,
          selectorGoneStillPresent: false,
          hasVisiblePasswordInput: true,
        }),
        3_000,
      ),
      null,
    )

    // All resume_when criteria satisfied & zero blockers -> emits resume_when_matched!
    const matched = ev.evaluate(
      makeProbe({
        url: 'https://cloud.example.com/console/projects',
        selectorAppearMatched: true,
        selectorGoneStillPresent: false,
      }),
      4_000,
    )
    assert.ok(matched)
    assert.equal(matched.type, 'handoff_ready')
    assert.equal(matched.signal, 'resume_when_matched')
    assert.equal(matched.url, 'https://cloud.example.com/console/projects')

    // waitDownload resume_when waits for actual CDP completed state (B5: downloadWillBegin alone NEVER fires)
    const evDl = new LiveBrowserAutoResumeEvaluator()
    evDl.reset({ waitDownload: true })
    const biz = makeProbe({ url: 'https://journal.example.org/article/1' })
    assert.equal(evDl.evaluate(biz, 1_000), null)
    evDl.recordDownloadBegin('dl-w1', 'article.pdf', 1_200)
    assert.equal(evDl.evaluate(biz, 2_500), null)
    assert.equal(evDl.evaluate(biz, 7_500), null)
    evDl.recordDownloadProgress('dl-w1', 'completed', 8_000)
    const dlMatched = evDl.evaluate(biz, 8_050)
    assert.ok(dlMatched)
    assert.equal(dlMatched.type, 'handoff_ready')
    assert.equal(dlMatched.signal, 'resume_when_matched')
    assert.equal(dlMatched.filename, 'article.pdf')
  })

  it('B6: urlLeave strictly requires observing a matching URL before leaving (starting on /help never falsely fires)', () => {
    const ev = new LiveBrowserAutoResumeEvaluator()
    ev.reset({ urlLeave: ['/login'] })

    const helpPage = makeProbe({ url: 'https://example.com/help', title: 'Help' })
    assert.equal(ev.evaluate(helpPage, 1_000), null)
    assert.equal(ev.evaluate(helpPage, 2_000), null)
    assert.equal(ev.evaluate(makeProbe({ url: 'https://example.com/about' }), 3_000), null)

    // Once user visits /login and then leaves to /dashboard -> fires resume_when_matched
    assert.equal(ev.evaluate(makeProbe({ url: 'https://example.com/login', hasLoginForm: true }), 4_000), null)
    const afterLeave = ev.evaluate(makeProbe({ url: 'https://example.com/dashboard' }), 5_000)
    assert.ok(afterLeave)
    assert.equal(afterLeave.type, 'handoff_ready')
    assert.equal(afterLeave.signal, 'resume_when_matched')
  })
})

describe('LiveBrowserStreamManager + LiveBrowserAutoResumeWatcher integration & cleanup', () => {
  it('runs zero-token watcher only during humanTakeover, emits handoff_ready over WS, and stops cleanly on release/close', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'lb-autoresume-'))
    let evalCount = 0
    let currentProbe = makeProbe({
      url: 'https://github.com/login',
      title: 'Sign in',
      hasVisiblePasswordInput: true,
      hasLoginForm: true,
    })

    const eventHandlers = new Set<(method: string, params: any, sessionId?: string) => void>()
    const closeHandlers = new Set<() => void>()
    const mockCdp: LiveBrowserCdpTransport = {
      async send(method, params) {
        switch (method) {
          case 'Target.getTargets':
            return {
              targetInfos: [
                { targetId: 't-1', type: 'page', title: currentProbe.title, url: currentProbe.url },
              ],
            }
          case 'Target.attachToTarget':
            return { sessionId: 'sid-t-1' }
          case 'Page.getLayoutMetrics':
            return { cssVisualViewport: { clientWidth: 1280, height: 720, clientHeight: 720 } }
          case 'Runtime.evaluate':
            evalCount += 1
            return { result: { value: currentProbe } }
          default:
            return {}
        }
      },
      onEvent(h) {
        eventHandlers.add(h)
        return () => eventHandlers.delete(h)
      },
      onClose(h) {
        closeHandlers.add(h)
        return () => closeHandlers.delete(h)
      },
      close() {
        for (const h of closeHandlers) h()
      },
    }

    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const keyId = 'mak1_0123456789abcdef'
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string }
    const keyring = new Map([[keyId, new Uint8Array(Buffer.from(jwk.x, 'base64url'))]])
    const env: NodeJS.ProcessEnv = {
      OPENCLAUDE_TRUST_BRIDGE_IP: '127.0.0.1',
      OC_MODEL_AUTHORITY_KEYRING: encodeAuthorityKeyring(keyring),
      OC_USER_ID: '42',
      OC_CONTAINER_ID: '99',
    }

    const manager = new LiveBrowserStreamManager({
      getEnv: () => env,
      stateDirFor: () => stateDir,
      touchActivity: () => {},
      isAgentBusy: () => false,
      openBrowser: async () => {},
      closeBrowser: async () => {},
      discoverCdpEndpoint: () => ({
        port: 9222,
        browserWsUrl: 'ws://127.0.0.1:9222/devtools/browser/mock',
        profileDir: stateDir,
      }),
      connectCdp: async () => mockCdp,
      dnsLookup: (async () => [{ address: '93.184.216.34', family: 4 }]) as any,
      autoResumePollIntervalMs: 25,
      settledDelayMs: 500,
    })

    const server: Server = createServer()
    server.on('upgrade', (req, socket, head) => {
      if (!manager.handleUpgrade(req, socket, head)) socket.destroy()
    })
    let ws: WebSocket | null = null
    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      const assertion = signLiveBrowserAssertion(
        {
          v: LIVE_BROWSER_PROTOCOL_VERSION,
          keyId,
          uid: 42,
          containerId: 99,
          agentId: 'main',
          sessionId: '0123456789abcdef0123456789abcdef',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 20_000,
        },
        privateKey,
      )

      ws = new WebSocket(`ws://127.0.0.1:${port}${LIVE_BROWSER_INTERNAL_WS_PATH}`, {
        headers: { [LIVE_BROWSER_ASSERTION_HEADER]: assertion },
      })
      const msgs: any[] = []
      ws.on('message', (d, isBin) => {
        if (!isBin) msgs.push(JSON.parse(d.toString()))
      })

      await new Promise<void>((resolve, reject) => {
        ws!.once('open', () => resolve())
        ws!.once('error', reject)
      })
      const waitForMsg = async (pred: (m: any) => boolean) => {
        const deadline = Date.now() + 3_000
        while (Date.now() < deadline) {
          const hit = msgs.find(pred)
          if (hit) return hit
          await new Promise((r) => setTimeout(r, 15))
        }
        throw new Error('timed out waiting for WS message')
      }

      await waitForMsg((m) => m.type === 'ready')
      // Not in takeover -> zero Runtime.evaluate probes!
      await new Promise((r) => setTimeout(r, 70))
      assert.equal(evalCount, 0)

      // Enter takeover without resumeWhen (backward-compatible generic watcher)
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitForMsg((m) => m.type === 'state' && m.humanTakeover === true)
      await new Promise((r) => setTimeout(r, 70))
      assert.ok(evalCount >= 1)
      // Still on login page -> zero handoff_ready emitted
      assert.equal(msgs.some((m) => m.type === 'handoff_ready'), false)

      // User completes login -> lands on business dashboard
      currentProbe = makeProbe({
        url: 'https://github.com/my-org/my-repo',
        title: 'my-org/my-repo',
      })
      const readyMsg = (await waitForMsg(
        (m) => m.type === 'handoff_ready',
      )) as LiveBrowserHandoffReadyMessage
      assert.equal(readyMsg.signal, 'login_completed')
      assert.equal(readyMsg.url, 'https://github.com/my-org/my-repo')

      // B3: SPA mounts visible OTP blocker after handoff_ready -> gateway emits handoff_vetoed over WS!
      currentProbe = makeProbe({
        url: 'https://github.com/my-org/my-repo',
        title: 'my-org/my-repo',
        hasVisibleOtpOrCaptchaInput: true,
      })
      const vetoMsg = await waitForMsg((m) => m.type === 'handoff_vetoed')
      assert.equal(vetoMsg.reason, 'visible_otp_or_captcha_input')
      assert.equal(vetoMsg.url, 'https://github.com/my-org/my-repo')

      // Clear OTP before exiting takeover
      currentProbe = makeProbe({
        url: 'https://github.com/my-org/my-repo',
        title: 'my-org/my-repo',
      })

      // Exit takeover -> watcher MUST stop probing completely (no timer leak)
      ws.send(JSON.stringify({ type: 'takeover', active: false }))
      await waitForMsg((m) => m.type === 'state' && m.humanTakeover === false)
      const countAfterExit = evalCount
      await new Promise((r) => setTimeout(r, 90))
      assert.equal(evalCount, countAfterExit, 'watcher must stop probing after takeover release')

      // Verify explicit handoff_watch + download event path
      msgs.length = 0
      ws.send(JSON.stringify({ type: 'handoff_watch', resumeWhen: { waitDownload: true } }))
      ws.send(JSON.stringify({ type: 'takeover', active: true }))
      await waitForMsg((m) => m.type === 'state' && m.humanTakeover === true)
      for (const h of eventHandlers) {
        h('Page.downloadWillBegin', { guid: 'g-dl-1', suggestedFilename: 'paper.pdf' }, 'sid-t-1')
        h('Page.downloadProgress', { guid: 'g-dl-1', state: 'completed' }, 'sid-t-1')
      }
      const dlMsg = (await waitForMsg(
        (m) => m.type === 'handoff_ready',
      )) as LiveBrowserHandoffReadyMessage
      assert.equal(dlMsg.signal, 'resume_when_matched')
      assert.equal(dlMsg.filename, 'paper.pdf')
    } finally {
      ws?.close()
      await manager.shutdown()
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('LiveBrowserAutoResumeWatcher stops cleanly with zero late emissions after stop()', async () => {
    let emitted = 0
    let active = true
    const watcher = new LiveBrowserAutoResumeWatcher({
      getCdp: () => ({
        cdp: {
          async send() {
            await new Promise((r) => setTimeout(r, 30))
            return { result: { value: makeProbe() } }
          },
          onEvent: () => () => {},
          onClose: () => () => {},
          close: () => {},
        },
        sessionId: 'sid-1',
      }),
      isActive: () => active,
      isLoading: () => false,
      getFallbackUrl: () => 'https://example.com',
      getFallbackTitle: () => 'Example',
      now: () => Date.now(),
      pollIntervalMs: 20,
      onReady: () => {
        emitted += 1
      },
    })
    watcher.start({ urlMatch: ['example.com'] })
    active = false
    watcher.stop()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(watcher.isRunning(), false)
    assert.equal(emitted, 0)
  })
})
