/**
 * Gateway ask-user and permission flow: permission response/broadcast/sweep/force-deny, in-window and detached ask-user cards
 *
 * Moved verbatim out of Gateway (server.ts) — FINDINGS §7.6, OCV5-479. The class
 * keeps one-line forwarders that call these with the instance as `this`, so behaviour, closures and
 * `this.x` reads/writes are unchanged. AskUserPermissionsHost lists exactly the Gateway members this code
 * touches (typed from the class itself).
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import {
  getClientSession,
  readArchivedMessages,
  appendServerAuthoredMessageDurable,
  patchServerAuthoredMessage,
} from '@openclaude/storage'
import {
  DETACHED_ASK_USER_TTL_MS,
  agentIdFromAskUserSessionKey,
  buildDetachedAskUserAnswerMessageId,
  buildDetachedAskUserAnsweredResult,
  buildDetachedAskUserPersistMessage,
  buildDetachedAskUserPostedResult,
  buildDetachedAskUserResolvedSinkPayload,
  buildDetachedAskUserSinkPayload,
  buildDetachedAskUserSkippedResult,
  findDetachedAskUserCardInMessages,
  formatAskUserAnswerMessage,
  isDetachedAskUserPending,
  isDetachedAskUserRequestId,
  pendingFromDetachedAskUserMessage,
} from './detachedAskUser.js'
import {
  AskUserWaiter,
  askUserHttpUnwritable,
  askUserHttpWriteSucceeded,
  resolveAskUserWaitMs,
  type AskUserWaiterAnswer,
} from './askUserWaiter.js'
import {
  fetchAskUserPermissionCard,
  getV3MasterSinkOrNull,
  readV3MasterSinkConfig,
} from './v3MasterSink.js'
import {
  makePeerKey,
  sanitizeEngineAskUserQuestions,
  sanitizeAskUserQuestionUpdatedInput,
} from './server.js'
import type { Gateway } from './server.js'

export interface AskUserPermissionsHost {
  _askUserWaiters: Gateway['_askUserWaiters']
  _broadcastPermissionSettled: Gateway['_broadcastPermissionSettled']
  _compensateInWindowAskUserAnswer: Gateway['_compensateInWindowAskUserAnswer']
  _finishInWindowAskUserWait: Gateway['_finishInWindowAskUserWait']
  _forceDenyPendingPermission: Gateway['_forceDenyPendingPermission']
  _hydrateDetachedAskUserPending: Gateway['_hydrateDetachedAskUserPending']
  _loadDetachedAskUserCard: Gateway['_loadDetachedAskUserCard']
  _lookupSettlement: Gateway['_lookupSettlement']
  _patchDetachedAskUserResolved: Gateway['_patchDetachedAskUserResolved']
  _pendingPermissions: Gateway['_pendingPermissions']
  _persistDetachedAskUserCard: Gateway['_persistDetachedAskUserCard']
  _recordSettlement: Gateway['_recordSettlement']
  _sendStampedSessionFrame: Gateway['_sendStampedSessionFrame']
  _submitDetachedAskUserAnswer: Gateway['_submitDetachedAskUserAnswer']
  dispatchInbound: Gateway['dispatchInbound']
  log: Gateway['log']
  readBody: Gateway['readBody']
  sendError: Gateway['sendError']
  sendJson: Gateway['sendJson']
  sessions: Gateway['sessions']
}

export type HandlePermissionResponseFrame = {
    type: 'inbound.permission_response'
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    agentId?: string
    requestId: string
    behavior: 'allow' | 'deny'
    message?: string
    /** Optional client-supplied tool input override (currently only used by
     *  AskUserQuestion to carry user-selected `answers` + `annotations`).
     *  Sanitized via `sanitizeAskUserQuestionUpdatedInput` before being
     *  forwarded to CCB; untrusted client fields are dropped. */
    updatedInput?: Record<string, unknown>
  }

/** Handle permission approval/denial from the web frontend */
export async function handlePermissionResponse(
  this: AskUserPermissionsHost,
  frame: HandlePermissionResponseFrame,
): Promise<void> {
  // Consume pending first so we can use its authoritative channel/peer/sessionKey
  // instead of trusting the client-supplied frame fields. For the not-found /
  // dead-session branches we fall back to frame.* because we have nothing else.
  let pending = this._pendingPermissions.get(frame.requestId)
  if (pending) this._pendingPermissions.delete(frame.requestId)
  if (!pending) {
    pending = (await this._hydrateDetachedAskUserPending(frame)) ?? undefined
  }
  if (!pending) {
    // Race: another tab (or our own /stop / timeout path) settled this
    // requestId first. Replay the authoritative behavior from the recent-
    // settlements map so a 3rd tab that missed the first broadcast doesn't
    // end up labeled with the LATE responder's behavior (which may differ).
    // If we have no record at all (expired / server restarted), fall back
    // to the late responder's own behavior — the only signal we have.
    const prior = this._lookupSettlement(frame.requestId)
    this.log.warn('permission response for unknown/already-settled request', {
      requestId: frame.requestId,
      hasPrior: !!prior,
      lateBehavior: frame.behavior,
    })
    if (prior) {
      // Route the rebroadcast using prior.* (server-trusted) so a late
      // duplicate can't steer the settlement to a peerKey of its choosing.
      const priorPeerKey = makePeerKey(prior.userId, prior.channel, prior.peer.id)
      this._broadcastPermissionSettled(priorPeerKey, {
        sessionKey: prior.sessionKey,
        channel: prior.channel,
        peer: prior.peer,
        requestId: frame.requestId,
        behavior: prior.behavior,
        reason: 'already_settled',
        ...(prior.answers ? { answers: prior.answers } : {}),
      })
    } else {
      // No server-side record survives — fall back to frame.* because
      // that's the only signal we have for where to route the settlement.
      // Use the ws-stashed userId (set by the inbound handler) so we don't
      // have to trust a client-supplied userId field.
      const fallbackUserId: string =
        typeof (frame as any)._userId === 'string' ? (frame as any)._userId : 'default'
      const peerKey = makePeerKey(fallbackUserId, frame.channel, frame.peer.id)
      this._broadcastPermissionSettled(peerKey, {
        sessionKey: '',
        channel: frame.channel,
        peer: frame.peer,
        requestId: frame.requestId,
        behavior: frame.behavior,
        reason: 'already_settled',
      })
    }
    return
  }

  const session = this.sessions.getByKey(pending.sessionKey)
  if (
    !session &&
    (isDetachedAskUserPending(pending) || isDetachedAskUserRequestId(frame.requestId))
  ) {
    // Detached ask_user answers start a new turn via dispatchInbound;
    // an evicted in-memory session is expected after hours away.
  } else if (!session) {
    this.log.warn('permission response for dead session', { sessionKey: pending.sessionKey })
    // Session is gone, but tabs still hold the modal — clear them.
    // Record the authoritative deny so any late duplicate rebroadcasts deny.
    // Use pending.* (server-trusted) instead of frame.* (client-supplied).
    this._recordSettlement(frame.requestId, {
      behavior: 'deny',
      channel: pending.channel,
      peer: pending.peer,
      sessionKey: pending.sessionKey,
      userId: pending.userId,
    })
    this._broadcastPermissionSettled(pending.peerKey, {
      sessionKey: pending.sessionKey,
      channel: pending.channel,
      peer: pending.peer,
      requestId: frame.requestId,
      behavior: 'deny',
      reason: 'disconnect',
    })
    return
  }
  // Build the updatedInput that will be passed to CCB.
  // Default: preserve original input so CCB doesn't receive an empty object.
  // Tool-specific exception: AskUserQuestion lets the client merge in
  // `answers` / `annotations` — we validate & whitelist them first so a
  // compromised client can't inject arbitrary keys into the tool payload.
  //
  // `effectiveBehavior` starts at frame.behavior but can be downgraded to
  // 'deny' if the AskUserQuestion sanitizer finds nothing usable in the
  // client-supplied updatedInput. Silently allowing an empty-answers
  // AskUserQuestion turn would pass the tool call through with zero
  // answers and leave the model wondering what the user said — far
  // harder to diagnose than an explicit deny.
  let forwardedInput: Record<string, unknown> = pending.input
  let effectiveBehavior: 'allow' | 'deny' = frame.behavior
  let effectiveMessage = frame.message
  // AskUserQuestion allow *requires* valid client-supplied answers. If the
  // client forgot to send updatedInput (buggy tab), sent a non-object, or
  // sent one whose fields all fail whitelist, we must downgrade to deny —
  // otherwise CCB receives an empty-answers AskUserQuestion turn and the
  // model has no idea why the user didn't answer. We run this branch
  // *unconditionally* when the tool is AskUserQuestion + behavior=allow;
  // the sanitizer itself handles every shape of bad input.
  if (frame.behavior === 'allow' && pending.toolName === 'AskUserQuestion') {
    const rawCandidate =
      frame.updatedInput &&
      typeof frame.updatedInput === 'object' &&
      !Array.isArray(frame.updatedInput)
        ? frame.updatedInput
        : {}
    const sanitized = sanitizeAskUserQuestionUpdatedInput(pending.input, rawCandidate)
    if (sanitized === null) {
      this.log.warn('AskUserQuestion allow without valid answers — denying', {
        requestId: frame.requestId,
        receivedUpdatedInput: typeof frame.updatedInput,
      })
      effectiveBehavior = 'deny'
      effectiveMessage = 'No valid answers supplied'
    } else {
      forwardedInput = sanitized
    }
  }
  const response =
    effectiveBehavior === 'allow'
      ? { behavior: 'allow' as const, updatedInput: forwardedInput, toolUseID: pending.toolUseId }
      : {
          behavior: 'deny' as const,
          message: effectiveMessage || 'User denied',
          toolUseID: pending.toolUseId,
        }
  const settledAnswers =
    effectiveBehavior === 'allow' &&
    pending.toolName === 'AskUserQuestion' &&
    forwardedInput !== pending.input &&
    (forwardedInput as { answers?: unknown }).answers &&
    typeof (forwardedInput as { answers?: unknown }).answers === 'object'
      ? (forwardedInput as { answers: Record<string, string> }).answers
      : undefined
  if (isDetachedAskUserPending(pending) || isDetachedAskUserRequestId(frame.requestId)) {
    this._recordSettlement(frame.requestId, {
      behavior: effectiveBehavior,
      channel: pending.channel,
      peer: pending.peer,
      sessionKey: pending.sessionKey,
      userId: pending.userId,
      ...(settledAnswers ? { answers: settledAnswers } : {}),
    })
    this._broadcastPermissionSettled(pending.peerKey, {
      sessionKey: pending.sessionKey,
      channel: pending.channel,
      peer: pending.peer,
      requestId: frame.requestId,
      behavior: effectiveBehavior,
      reason: 'remote',
      ...(settledAnswers ? { answers: settledAnswers } : {}),
    })
    const answerText =
      effectiveBehavior === 'allow'
        ? formatAskUserAnswerMessage(pending.input, settledAnswers ?? {})
        : undefined
    const answerId = answerText ? buildDetachedAskUserAnswerMessageId(frame.requestId) : undefined
    const waiter = this._askUserWaiters?.get(frame.requestId)
    const inWindow =
      waiter?.tryAnswer({
        behavior: effectiveBehavior,
        answers: settledAnswers,
        answerText,
      }) === true
    if (inWindow) {
      this._askUserWaiters.delete(frame.requestId)
      // Patch the tape card so the UI renders "already answered". Do not
      // append a user-answer row or dispatchInbound — the in-flight turn
      // consumes the answer via the MCP tool result.
      void this._patchDetachedAskUserResolved(pending, frame.requestId, {
        _resolved: true,
        _behavior: effectiveBehavior,
        _settledReason: 'remote',
        ...(settledAnswers ? { _answers: settledAnswers } : {}),
      })
      this.log.info('detached ask_user settled', {
        requestId: frame.requestId,
        behavior: effectiveBehavior,
        startedTurn: false,
        inWindow: true,
      })
      return
    }
    void this._patchDetachedAskUserResolved(
      pending,
      frame.requestId,
      {
        _resolved: true,
        _behavior: effectiveBehavior,
        _settledReason: 'remote',
        ...(settledAnswers ? { _answers: settledAnswers } : {}),
      },
      answerText && answerId ? { id: answerId, text: answerText } : undefined,
    )
    if (answerText && answerId) {
      await this._submitDetachedAskUserAnswer(pending, answerText, frame.requestId, answerId)
    }
    this.log.info('detached ask_user settled', {
      requestId: frame.requestId,
      behavior: effectiveBehavior,
      startedTurn: effectiveBehavior === 'allow',
      inWindow: false,
    })
    return
  }
  if (!session) {
    this.log.warn('permission response for dead session', { sessionKey: pending.sessionKey })
    return
  }
  const ok = session.runner.sendPermissionResponse(frame.requestId, response)
  this.log.info('permission response', {
    requestId: frame.requestId,
    behavior: effectiveBehavior,
    clientBehavior: frame.behavior,
    ok,
    toolName: pending.toolName,
    askUserQuestionMerged:
      pending.toolName === 'AskUserQuestion' && forwardedInput !== pending.input,
  })
  if (!ok) {
    // The Codex reverse-RPC write did not reach a live stdin. Keep the
    // authoritative prompt pending instead of recording/broadcasting a
    // settlement the engine never received.
    this._pendingPermissions.set(frame.requestId, pending)
    this.log.warn('permission response write failed; request restored', {
      requestId: frame.requestId,
      sessionKey: pending.sessionKey,
    })
    return
  }
  // Record the authoritative result BEFORE broadcasting so any late
  // duplicate response that arrives between here and the broadcast round
  // will see the correct behavior. Use pending.* so late duplicates replay
  // the server-trusted peer identity, not whatever the current client sent.
  // effectiveBehavior may differ from frame.behavior when the AskUserQuestion
  // sanitizer downgraded a malformed allow to deny — record the downgrade
  // so other tabs see the truth.
  //
  // For AskUserQuestion allow we also record + broadcast the sanitized
  // answers so other tabs can fill in their permission card correctly
  // (without having the user re-enter anything) and the sender tab can
  // reconcile its optimistic state if the gateway-visible answers ever
  // differ from what the tab cached locally.
  this._recordSettlement(frame.requestId, {
    behavior: effectiveBehavior,
    channel: pending.channel,
    peer: pending.peer,
    sessionKey: pending.sessionKey,
    userId: pending.userId,
    ...(settledAnswers ? { answers: settledAnswers } : {}),
  })
  // Tell every tab attached to this peer (including the sender) that the
  // request is resolved. Other tabs dismiss their stuck prompt with the
  // actual behavior. The sender tab previously treated this as a no-op,
  // but now uses the broadcast to reconcile optimistic state (especially
  // important when the gateway downgraded allow→deny).
  this._broadcastPermissionSettled(pending.peerKey, {
    sessionKey: pending.sessionKey,
    channel: pending.channel,
    peer: pending.peer,
    requestId: frame.requestId,
    behavior: effectiveBehavior,
    reason: 'remote',
    ...(settledAnswers ? { answers: settledAnswers } : {}),
  })
}

export type BroadcastPermissionSettledPayload = {
    sessionKey: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    requestId: string
    behavior: 'allow' | 'deny'
    reason: 'remote' | 'already_settled' | 'disconnect' | 'timeout' | 'crashed' | 'user_stop'
    answers?: Record<string, string>
  }

/** Broadcast a settlement event to all WS clients at a peerKey.
 *  `answers` is only set for AskUserQuestion allow settlements — lets
 *  other tabs render the collected answers in the permission card, and
 *  lets the sender tab keep its optimistic state in sync if we later
 *  switch semantics (e.g. if answers get server-side post-processing). */
export function _broadcastPermissionSettled(
  this: AskUserPermissionsHost,
  peerKey: string,
  payload: BroadcastPermissionSettledPayload,
): void {
  // Route through the stamped session-frame helper so the settlement is
  // recorded in the outbound ring buffer keyed by sessionKey. A reconnecting
  // tab that missed the live broadcast (e.g. iOS Safari suspended its WS)
  // can then receive the settled frame via ring replay and update the
  // inline permission card from "Waiting" to "Allowed/Denied".
  this._sendStampedSessionFrame(payload.sessionKey, peerKey, {
    type: 'outbound.permission_settled',
    ...payload,
  })
}

/** Shared auto-deny + settle + broadcast for one pending permission entry.
 *  Used by disconnect / timeout / session-crash paths. Safe to call on
 *  sessions that no longer exist — the runner-response step silently
 *  skips in that case (the subprocess is already gone). */
/**
 * Cursor ask_user: persist the question on the session tape, then wait up
 * to `waitMs` for an in-turn answer. Omitting waitMs (legacy clients) is
 * treated as 0 — fully detached, immediate posted. Explicit values are
 * clamped to 55s, under the 60s MCP tools/call wall. On timeout / client
 * abort the waiter releases to the existing detached path (later allow →
 * dispatchInbound). If tryAnswer already won but the HTTP response can no
 * longer be written, the consumed answer is compensated through that same
 * dispatchInbound path so it cannot vanish. The HTTP response is always
 * produced by the waiter timer or a terminal claim — it cannot hang past waitMs.
 */
export async function handleEngineAskUser(
  this: AskUserPermissionsHost,
  req: IncomingMessage,
  res: ServerResponse,
  targetAgentId: string,
): Promise<void> {
  if (req.method !== 'POST') return this.sendError(res, 405, 'method not allowed')
  const body = await this.readBody(req)
  let parsed: any
  try {
    parsed = JSON.parse(body)
  } catch {
    return this.sendError(res, 400, 'invalid JSON')
  }
  const questions = sanitizeEngineAskUserQuestions(parsed?.questions)
  if (!questions) {
    return this.sendError(
      res,
      400,
      'questions invalid: need 1-4 items with question + 2-4 options each',
    )
  }
  const sessionKey = typeof parsed.sessionKey === 'string' ? parsed.sessionKey : ''
  if (!sessionKey) return this.sendError(res, 400, 'sessionKey required')
  const session = this.sessions.getByKey(sessionKey)
  if (!session) return this.sendError(res, 404, 'session not found')
  if (session.agentId !== targetAgentId) {
    return this.sendError(res, 409, 'session belongs to another agent')
  }
  if (session.providerTag && session.providerTag !== 'cursor') {
    return this.sendError(res, 409, 'ask_user is only available on the cursor engine')
  }
  if (!session.runner.isRunning) {
    return this.sendError(res, 409, 'no active turn on session')
  }

  const waitMs = resolveAskUserWaitMs(parsed.waitMs)
  const deadlineAt = Date.now() + waitMs
  const input = { questions }
  const requestId = `ask-user:${randomBytes(16).toString('hex')}`
  const userId = session.userId ?? 'default'
  const channel = session.channel
  const peer = {
    id: session.peerId,
    kind: sessionKey.includes(':group:') ? ('group' as const) : ('dm' as const),
  }
  const peerKey = makePeerKey(userId, channel, peer.id)
  const expiresAt = Date.now() + DETACHED_ASK_USER_TTL_MS
  if (!this._askUserWaiters) this._askUserWaiters = new Map()
  const waiter = new AskUserWaiter()
  this._askUserWaiters.set(requestId, waiter)
  this._pendingPermissions.set(requestId, {
    sessionKey,
    toolName: 'AskUserQuestion',
    input,
    peerKey,
    userId,
    channel,
    peer,
    expiresAt,
    detachedAskUser: true,
  })

  let clientGone = false
  const releaseOnDisconnect = () => {
    clientGone = true
    waiter.tryRelease()
  }
  req.on('aborted', releaseOnDisconnect)
  req.on('close', () => {
    if (!res.headersSent) releaseOnDisconnect()
  })

  const persistArgs = {
    requestId,
    questions,
    sessionKey,
    userId,
    channel,
    peer,
    expiresAt,
    agentId: session.agentId,
  }
  const persistP = this._persistDetachedAskUserCard(persistArgs)
  const persistBudget = Math.max(0, deadlineAt - Date.now())
  await Promise.race([persistP, new Promise<void>((resolve) => setTimeout(resolve, persistBudget))])
  // Persist-first: the tape row exists (or we hit the waitMs budget) before
  // the card is shown, so a later patch cannot beat the insert. The persist
  // promise keeps running if we raced the deadline.
  void persistP
  this._sendStampedSessionFrame(sessionKey, peerKey, {
    type: 'outbound.permission_request',
    sessionKey,
    channel,
    peer,
    requestId,
    toolName: 'AskUserQuestion',
    inputPreview: JSON.stringify(input).slice(0, 400),
    inputJson: input,
    expiresAt,
    detachedAskUser: true,
  })
  this.log.info('engine ask_user posted', {
    requestId,
    sessionKey,
    agentId: session.agentId,
    waitMs,
  })

  const pendingForWait = { sessionKey, userId, channel, peer }
  try {
    const remaining = Math.max(0, deadlineAt - Date.now())
    waiter.startTimer(remaining)
    const result = await waiter.wait()
    this._askUserWaiters.delete(requestId)
    if (result.status === 'answered') {
      await this._finishInWindowAskUserWait({
        req,
        res,
        waiter,
        result,
        requestId,
        pending: pendingForWait,
        clientGone,
      })
      return
    }
    if (clientGone || askUserHttpUnwritable(req, res)) return
    this.sendJson(res, 200, buildDetachedAskUserPostedResult(requestId))
  } catch (err) {
    waiter.tryRelease()
    this._askUserWaiters.delete(requestId)
    this.log.error('engine ask_user wait failed', { requestId }, err as Error)
    const answered = waiter.getAnswer()
    if (waiter.getPhase() === 'answered_in_window' && answered) {
      await this._finishInWindowAskUserWait({
        req,
        res,
        waiter,
        result: { status: 'answered', answer: answered },
        requestId,
        pending: pendingForWait,
        clientGone,
      })
      return
    }
    if (clientGone || askUserHttpUnwritable(req, res)) return
    this.sendJson(res, 200, buildDetachedAskUserPostedResult(requestId))
  }
}

export type FinishInWindowAskUserWaitArgs = {
    req: IncomingMessage
    res: ServerResponse
    waiter: AskUserWaiter
    result: { status: 'answered'; answer: AskUserWaiterAnswer }
    requestId: string
    pending: {
      sessionKey: string
      userId: string
      channel: string
      peer: { id: string; kind: 'dm' | 'group' }
    }
    clientGone: boolean
  }

/**
 * Deliver an in-window ask_user answer over HTTP, or compensate with the
 * same dispatchInbound path used after timeout. `tryClaimDelivery` is the
 * synchronous one-shot so HTTP success and compensation cannot both fire.
 */
export async function _finishInWindowAskUserWait(
  this: AskUserPermissionsHost,
  args: FinishInWindowAskUserWaitArgs,
): Promise<void> {
  const { req, res, waiter, result, requestId, pending, clientGone } = args
  const answer = result.answer
  const httpBlocked = clientGone || askUserHttpUnwritable(req, res)

  if (!httpBlocked) {
    if (!waiter.tryClaimDelivery()) return
    try {
      if (answer.behavior === 'deny') {
        this.sendJson(res, 200, buildDetachedAskUserSkippedResult(requestId))
      } else {
        this.sendJson(
          res,
          200,
          buildDetachedAskUserAnsweredResult({
            requestId,
            answers: answer.answers,
            answerText: answer.answerText,
          }),
        )
      }
      if (askUserHttpWriteSucceeded(res)) return
    } catch (err) {
      this.log.warn('in-window ask_user HTTP write failed', { requestId }, err as Error)
    }
    if (answer.behavior === 'allow' && answer.answerText) {
      try {
        await this._compensateInWindowAskUserAnswer(pending, requestId, answer)
      } catch (err) {
        this.log.error('in-window ask_user compensation failed', { requestId }, err as Error)
      }
    }
    return
  }

  if (answer.behavior === 'allow' && answer.answerText) {
    if (!waiter.tryClaimDelivery()) return
    try {
      await this._compensateInWindowAskUserAnswer(pending, requestId, answer)
    } catch (err) {
      this.log.error('in-window ask_user compensation failed', { requestId }, err as Error)
    }
    return
  }
  waiter.tryClaimDelivery()
}

export type CompensateInWindowAskUserAnswerPending = {
    sessionKey: string
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
  }

/**
 * In-window answer could not be written back to the MCP HTTP caller.
 * Reuse the timeout-then-answer path: tape user-answer row + dispatchInbound.
 */
export async function _compensateInWindowAskUserAnswer(
  this: AskUserPermissionsHost,
  pending: CompensateInWindowAskUserAnswerPending,
  requestId: string,
  answer: AskUserWaiterAnswer,
): Promise<void> {
  if (answer.behavior !== 'allow' || !answer.answerText) return
  const answerId = buildDetachedAskUserAnswerMessageId(requestId)
  void this._patchDetachedAskUserResolved(
    pending,
    requestId,
    {
      _resolved: true,
      _behavior: 'allow',
      _settledReason: 'remote',
      ...(answer.answers ? { _answers: answer.answers } : {}),
    },
    { id: answerId, text: answer.answerText },
  )
  this.log.info('in-window ask_user compensated via new turn', { requestId })
  await this._submitDetachedAskUserAnswer(pending, answer.answerText, requestId, answerId)
}

export type PersistDetachedAskUserCardArgs = {
    requestId: string
    questions: Array<Record<string, unknown>>
    sessionKey: string
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    expiresAt: number
    agentId: string
  }

export async function _persistDetachedAskUserCard(
  this: AskUserPermissionsHost,
  args: PersistDetachedAskUserCardArgs,
): Promise<void> {
  const msg = buildDetachedAskUserPersistMessage(args)
  const sink = getV3MasterSinkOrNull()
  if (sink) {
    try {
      const outcome = await sink.persistOrQueue(
        buildDetachedAskUserSinkPayload({
          requestId: args.requestId,
          questions: args.questions,
          sessionKey: args.sessionKey,
          agentId: args.agentId,
          sessionId: args.peer.id,
          channel: args.channel,
          peer: args.peer,
          expiresAt: args.expiresAt,
          ts: msg.ts,
        }),
      )
      if (outcome.ok) {
        this.log.info('detached ask_user persist acked via master sink', {
          requestId: args.requestId,
        })
        return
      }
      if ('queued' in outcome && outcome.queued) {
        this.log.error('detached ask_user persist queued for master-sink retry', {
          requestId: args.requestId,
          errorClass: outcome.errorClass,
        })
        return
      }
      this.log.error('detached ask_user persist dropped by master sink', {
        requestId: args.requestId,
        reason: 'droppedReason' in outcome ? outcome.droppedReason : 'dropped',
      })
    } catch (err) {
      this.log.error(
        'detached ask_user persist via master sink failed',
        { requestId: args.requestId },
        err as Error,
      )
    }
    return
  }
  try {
    const r = await appendServerAuthoredMessageDurable(args.peer.id, args.userId, msg)
    if (r.applied || r.reason === 'already_exists') return
    this.log.error('detached ask_user persist not applied', {
      requestId: args.requestId,
      reason: r.reason,
      ...('error' in r ? { error: r.error } : {}),
    })
  } catch (err) {
    this.log.error('detached ask_user persist failed', { requestId: args.requestId }, err as Error)
  }
}

export type PatchDetachedAskUserResolvedPending = {
    peer: { id: string; kind?: 'dm' | 'group' }
    userId: string
    sessionKey: string
    channel?: string
  }

export async function _patchDetachedAskUserResolved(
  this: AskUserPermissionsHost,
  pending: PatchDetachedAskUserResolvedPending,
  requestId: string,
  patch: Record<string, unknown>,
  userAnswer?: { id: string; text: string; ts?: number },
): Promise<void> {
  const behavior =
    patch._behavior === 'allow' || patch._behavior === 'deny' ? patch._behavior : 'deny'
  const settledReason =
    patch._settledReason === 'remote' ||
    patch._settledReason === 'already_settled' ||
    patch._settledReason === 'disconnect' ||
    patch._settledReason === 'timeout' ||
    patch._settledReason === 'crashed' ||
    patch._settledReason === 'user_stop'
      ? patch._settledReason
      : 'remote'
  const answers =
    patch._answers && typeof patch._answers === 'object' && !Array.isArray(patch._answers)
      ? (patch._answers as Record<string, string>)
      : undefined
  const sink = getV3MasterSinkOrNull()
  if (sink) {
    try {
      const outcome = await sink.persistOrQueue(
        buildDetachedAskUserResolvedSinkPayload({
          requestId,
          agentId: agentIdFromAskUserSessionKey(pending.sessionKey),
          sessionId: pending.peer.id,
          sessionKey: pending.sessionKey,
          behavior,
          settledReason,
          answers,
          userAnswer,
        }),
      )
      if (outcome.ok) {
        this.log.info('detached ask_user resolved persist acked via master sink', { requestId })
        return
      }
      if ('queued' in outcome && outcome.queued) {
        this.log.error('detached ask_user resolved persist queued for master-sink retry', {
          requestId,
          errorClass: outcome.errorClass,
        })
        return
      }
      this.log.error('detached ask_user resolved persist dropped by master sink', {
        requestId,
        reason: 'droppedReason' in outcome ? outcome.droppedReason : 'dropped',
      })
    } catch (err) {
      this.log.error(
        'detached ask_user resolved persist via master sink failed',
        { requestId },
        err as Error,
      )
    }
    return
  }
  try {
    const r = await patchServerAuthoredMessage(pending.peer.id, pending.userId, requestId, patch)
    if (!r.applied) {
      this.log.error('detached ask_user tape patch not applied', {
        requestId,
        reason: r.reason,
      })
    }
  } catch (err) {
    this.log.error('detached ask_user tape patch failed', { requestId }, err as Error)
  }
  if (!userAnswer) return
  try {
    const r = await appendServerAuthoredMessageDurable(pending.peer.id, pending.userId, {
      id: userAnswer.id,
      role: 'user',
      text: userAnswer.text,
      ts: userAnswer.ts ?? Date.now(),
    })
    if (r.applied || r.reason === 'already_exists') return
    this.log.error('detached ask_user answer persist not applied', {
      requestId,
      reason: r.reason,
      ...('error' in r ? { error: r.error } : {}),
    })
  } catch (err) {
    this.log.error('detached ask_user answer persist failed', { requestId }, err as Error)
  }
}

export async function _loadDetachedAskUserCard(
  this: AskUserPermissionsHost,
  sessionId: string,
  userId: string,
  requestId: string,
): Promise<Record<string, unknown> | null> {
  if (getV3MasterSinkOrNull() || readV3MasterSinkConfig()) {
    return fetchAskUserPermissionCard({ sessionId, requestId })
  }
  const sess = await getClientSession(sessionId, userId)
  const hot = findDetachedAskUserCardInMessages(sess?.messages, requestId)
  if (hot) return hot
  let beforeSeq = 0
  for (let pageNo = 0; pageNo < 16; pageNo++) {
    const page = await readArchivedMessages(sessionId, userId, beforeSeq, 200)
    const archived = findDetachedAskUserCardInMessages(page.messages, requestId)
    if (archived) return archived
    if (!page.hasMore || page.oldestSeq == null) break
    beforeSeq = page.oldestSeq
  }
  return null
}

export type HydrateDetachedAskUserPendingFrame = {
    requestId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
    /** Stashed by the WS entrypoint from the authenticated connection, never
     *  from the client frame — this is the only user identity we can trust
     *  once the in-memory pending entry is gone (restart / TTL rebuild). */
    _userId?: unknown
  }

export async function _hydrateDetachedAskUserPending(
  this: AskUserPermissionsHost,
  frame: HydrateDetachedAskUserPendingFrame,
): Promise<ReturnType<typeof pendingFromDetachedAskUserMessage>> {
  if (!isDetachedAskUserRequestId(frame.requestId)) return null
  const userId = typeof frame._userId === 'string' && frame._userId ? frame._userId : 'default'
  try {
    const msg = await this._loadDetachedAskUserCard(frame.peer.id, userId, frame.requestId)
    if (!msg) return null
    return pendingFromDetachedAskUserMessage(msg, {
      userId,
      channel: frame.channel,
      peer: frame.peer,
      peerKey: makePeerKey(userId, frame.channel, frame.peer.id),
    })
  } catch (err) {
    this.log.error('detached ask_user hydrate failed', { requestId: frame.requestId }, err as Error)
    return null
  }
}

export type SubmitDetachedAskUserAnswerPending = {
    sessionKey: string
    userId: string
    channel: string
    peer: { id: string; kind: 'dm' | 'group' }
  }

export async function _submitDetachedAskUserAnswer(
  this: AskUserPermissionsHost,
  pending: SubmitDetachedAskUserAnswerPending,
  text: string,
  requestId: string,
  clientMessageId: string = buildDetachedAskUserAnswerMessageId(requestId),
): Promise<void> {
  const agentId = agentIdFromAskUserSessionKey(pending.sessionKey)
  await this.dispatchInbound({
    type: 'inbound.message',
    channel: pending.channel,
    peer: pending.peer,
    agentId,
    content: { text },
    ts: Date.now(),
    idempotencyKey: `ask-user-answer:${requestId}`,
    clientMessageId,
    _userId: pending.userId,
  } as any)
}

export function _forceDenyPendingPermission(
  this: AskUserPermissionsHost,
  requestId: string,
  reason: 'disconnect' | 'timeout' | 'crashed' | 'user_stop',
  denyMessage: string,
): boolean {
  const pending = this._pendingPermissions.get(requestId)
  if (!pending) return false
  this._pendingPermissions.delete(requestId)
  // Unblock a held ask_user HTTP waiter (if any) before anything that could
  // throw, so it never hangs to the 60s MCP tools/call wall.
  this._askUserWaiters?.get(requestId)?.tryRelease()
  this._askUserWaiters?.delete(requestId)
  const session = this.sessions.getByKey(pending.sessionKey)
  if (session && !isDetachedAskUserPending(pending)) {
    // sendPermissionResponse swallows its own errors and returns false if
    // the subprocess is gone — `false` is expected on crash/exit paths.
    const ok = session.runner.sendPermissionResponse(requestId, {
      behavior: 'deny',
      message: denyMessage,
      toolUseID: pending.toolUseId,
    })
    this.log.info('auto-denied pending permission', {
      requestId,
      reason,
      runnerAccepted: ok,
    })
  }
  if (isDetachedAskUserPending(pending)) {
    void this._patchDetachedAskUserResolved(pending, requestId, {
      _resolved: true,
      _behavior: 'deny',
      _settledReason: reason,
    })
  }
  // Record authoritative 'deny' so a late duplicate response (from a
  // reconnecting tab or a redelivered frame) replays the correct result
  // instead of whatever the late responder happens to have sent.
  this._recordSettlement(requestId, {
    behavior: 'deny',
    channel: pending.channel,
    peer: pending.peer,
    sessionKey: pending.sessionKey,
    userId: pending.userId,
  })
  // Broadcast so any still-connected tab dismisses its modal immediately.
  // No-op when no clients remain (e.g. disconnect path).
  this._broadcastPermissionSettled(pending.peerKey, {
    sessionKey: pending.sessionKey,
    channel: pending.channel,
    peer: pending.peer,
    requestId,
    behavior: 'deny',
    reason,
  })
  return true
}

/**
 * Reap ordinary pending permission requests after a session crash so the
 * map does not leak and connected tabs dismiss their stuck modal.
 *
 * Detached ask_user cards are the exception: they are not bound to the
 * subprocess lifetime. The card stays answerable for 24h even after crash,
 * turn end, or session eviction; the user's answer is delivered as a later
 * inbound message (possibly to a new session). Same contract as
 * `_autoDenyPendingPermissions` and `_sweepStalePendingPermissions`.
 */
export function _reapCrashedSessionPendingPermissions(
  this: AskUserPermissionsHost,
  sessionKey: string,
): void {
  const pendingToReap: string[] = []
  for (const [requestId, pending] of this._pendingPermissions) {
    if (isDetachedAskUserPending(pending)) continue
    if (pending.sessionKey === sessionKey) pendingToReap.push(requestId)
  }
  for (const requestId of pendingToReap) {
    this._forceDenyPendingPermission(requestId, 'crashed', 'Session crashed')
  }
}

/**
 * Settle pending permission requests for a turn the user just stopped.
 *
 * `interruptClientTurn` / `sessions.interrupt` only abort the CCB turn; the
 * `_pendingPermissions` entry created for a blocking `can_use_tool` (incl.
 * AskUserQuestion) otherwise survives until the 10-minute janitor. During
 * that window every hello replays the dead card to the browser (which
 * renders it read-only since the turn is no longer `sending`) and the
 * durable master row stays `pending` until the reconciler runs. Force-deny
 * here so the runtime map, the master row and every connected tab converge
 * on the same `user_stop` settlement the moment Stop is acknowledged.
 *
 * Detached ask_user cards are exempt (same contract as crash/disconnect/
 * sweep): they outlive the turn by design and are answered later as a new
 * inbound message.
 *
 * When `clientMessageId` is given, only entries owned by that browser turn
 * are settled (entries recorded without a clientMessageId are assumed to
 * belong to the stopped turn — the runtime never holds two blocking
 * permissions for different turns of one session at once). Returns the
 * number of settled requests.
 */
export function _settlePendingPermissionsForStop(
  this: AskUserPermissionsHost,
  sessionKey: string,
  clientMessageId?: string,
): number {
  const toSettle: string[] = []
  for (const [requestId, pending] of this._pendingPermissions) {
    if (isDetachedAskUserPending(pending)) continue
    if (pending.sessionKey !== sessionKey) continue
    if (clientMessageId && pending.clientMessageId && pending.clientMessageId !== clientMessageId) {
      continue
    }
    toSettle.push(requestId)
  }
  let settled = 0
  for (const requestId of toSettle) {
    if (this._forceDenyPendingPermission(requestId, 'user_stop', 'User stopped the turn')) {
      settled += 1
    }
  }
  if (settled > 0) {
    this.log.info('stop settled pending permissions', {
      sessionKey,
      clientMessageId,
      count: settled,
    })
  }
  return settled
}

/** Auto-deny all pending permission requests associated with a peerKey (on disconnect) */
export function _autoDenyPendingPermissions(this: AskUserPermissionsHost, peerKey: string): void {
  // Snapshot requestIds first — the helper mutates _pendingPermissions.
  const requestIds: string[] = []
  for (const [requestId, pending] of this._pendingPermissions) {
    if (pending.detachedAskUser || pending.blockingUserInput) continue
    if (pending.peerKey === peerKey) requestIds.push(requestId)
  }
  for (const requestId of requestIds) {
    this._forceDenyPendingPermission(requestId, 'disconnect', 'Client disconnected')
  }
}

/** Periodic janitor: auto-deny permissions whose wait has exceeded the TTL.
 *  Also cleans up entries whose session no longer exists (subprocess was
 *  evicted or destroyed without going through the crash event path). */
export function _sweepStalePendingPermissions(this: AskUserPermissionsHost): void {
  const now = Date.now()
  const toExpire: Array<{ requestId: string; reason: 'timeout' | 'crashed' }> = []
  for (const [requestId, pending] of this._pendingPermissions) {
    if (isDetachedAskUserPending(pending)) {
      // 24h TTL only. Turn end / session eviction must not kill the card.
      if (now >= pending.expiresAt) toExpire.push({ requestId, reason: 'timeout' })
      continue
    }
    if (now >= pending.expiresAt) {
      toExpire.push({ requestId, reason: 'timeout' })
    } else if (!this.sessions.getByKey(pending.sessionKey)) {
      // Orphan: session was evicted/ended without the crash event firing.
      // Treat as "crashed" for the UI — the underlying subprocess is gone.
      toExpire.push({ requestId, reason: 'crashed' })
    }
  }
  if (toExpire.length === 0) return
  for (const { requestId, reason } of toExpire) {
    const msg = reason === 'timeout' ? 'Permission request timed out' : 'Session ended'
    this._forceDenyPendingPermission(requestId, reason, msg)
  }
  this.log.info('pending permission sweep', {
    expired: toExpire.length,
    remaining: this._pendingPermissions.size,
  })
}
