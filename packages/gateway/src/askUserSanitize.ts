/**
 * Ask-user input sanitizers
 *
 * Moved verbatim out of server.ts (FINDINGS §7.6, OCV5-484); server.ts re-exports
 * these names, so importers are unchanged.
 */

/**
 * Sanitize a client-supplied `updatedInput` for the AskUserQuestion tool.
 *
 * The frontend sends `{ answers: { [questionText]: string }, annotations?: {
 * [questionText]: { preview?: string, notes?: string } } }` merged into a
 * copy of the original input. We must not forward arbitrary client data to
 * CCB: an attacker that compromises the websocket could otherwise smuggle
 * tool-schema extras through this path.
 *
 * Rules enforced here (matches the LLM-visible shape of the original CCB
 * `AskUserQuestion` schema):
 *   - Ignore every top-level key in `raw` that is not `answers` or
 *     `annotations`; the rest of the payload is inherited verbatim from the
 *     server-trusted `pending.input`.
 *   - `answers` keys must equal the exact `question` text of one of the
 *     pending questions (CCB uses the question string as the map key).
 *   - `answers` values must be strings, ≤ `ASK_USER_QUESTION_STRING_MAX_LEN`.
 *   - `annotations` keys must also be valid question texts.
 *   - `annotations[q].preview` must equal one of that question's
 *     `options[].preview` — the client is not allowed to invent preview text.
 *   - `annotations[q].notes` must be a short string if provided.
 *
 * Returns `null` when no valid `answers` or `annotations` entries survive
 * sanitization — the caller should treat this as a client error and deny
 * the permission request. (Silently forwarding `pending.input` with empty
 * answers would leave the model unable to tell why the user didn't answer.)
 */
export function sanitizeAskUserQuestionUpdatedInput(
  pendingInput: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> | null {
  const questions = Array.isArray((pendingInput as { questions?: unknown }).questions)
    ? ((pendingInput as { questions: unknown[] }).questions as unknown[])
    : []
  // Map question text → allowed preview strings for that question.
  const previewsByQuestion = new Map<string, Set<string>>()
  const validQuestionTexts = new Set<string>()
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue
    const questionText = (q as { question?: unknown }).question
    if (typeof questionText !== 'string' || questionText.length === 0) continue
    validQuestionTexts.add(questionText)
    const previews = new Set<string>()
    const options = (q as { options?: unknown }).options
    if (Array.isArray(options)) {
      for (const opt of options) {
        if (!opt || typeof opt !== 'object') continue
        const preview = (opt as { preview?: unknown }).preview
        if (typeof preview === 'string' && preview.length > 0) previews.add(preview)
      }
    }
    previewsByQuestion.set(questionText, previews)
  }

  // answers
  const sanitizedAnswers: Record<string, string> = {}
  const rawAnswers = (raw as { answers?: unknown }).answers
  if (rawAnswers && typeof rawAnswers === 'object' && !Array.isArray(rawAnswers)) {
    for (const [k, v] of Object.entries(rawAnswers as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (typeof v !== 'string') continue
      if (v.length > ASK_USER_QUESTION_STRING_MAX_LEN) continue
      // Reject blank answers: a whitespace-only string is indistinguishable
      // from "user didn't answer this" for the model, so we treat both as
      // absent. This matches CCB native `AskUserQuestionPermissionRequest`
      // which requires a non-empty selection before enabling submit.
      if (v.trim().length === 0) continue
      sanitizedAnswers[k] = v
    }
  }

  // annotations
  const sanitizedAnnotations: Record<string, { preview?: string; notes?: string }> = {}
  const rawAnnotations = (raw as { annotations?: unknown }).annotations
  if (rawAnnotations && typeof rawAnnotations === 'object' && !Array.isArray(rawAnnotations)) {
    for (const [k, v] of Object.entries(rawAnnotations as Record<string, unknown>)) {
      if (!validQuestionTexts.has(k)) continue
      if (!v || typeof v !== 'object' || Array.isArray(v)) continue
      const out: { preview?: string; notes?: string } = {}
      const preview = (v as { preview?: unknown }).preview
      if (typeof preview === 'string' && preview.length <= ASK_USER_QUESTION_STRING_MAX_LEN) {
        const allowed = previewsByQuestion.get(k)
        // biome-ignore lint/complexity/useOptionalChain: moved verbatim from server.ts (OCV5-484); pre-existing there
        if (allowed && allowed.has(preview)) out.preview = preview
      }
      const notes = (v as { notes?: unknown }).notes
      if (
        typeof notes === 'string' &&
        notes.length > 0 &&
        notes.length <= ASK_USER_QUESTION_STRING_MAX_LEN
      ) {
        out.notes = notes
      }
      if (out.preview !== undefined || out.notes !== undefined) {
        sanitizedAnnotations[k] = out
      }
    }
  }

  const hasAnswers = Object.keys(sanitizedAnswers).length > 0
  const hasAnnotations = Object.keys(sanitizedAnnotations).length > 0
  // Require at least one real answer — annotations alone are not a valid
  // submission (the model needs answers, annotations are auxiliary). A
  // client that sent only annotations (or nothing valid) is either buggy
  // or hostile; silently falling back to pending.input would forward an
  // empty-answer AskUserQuestion turn.
  if (!hasAnswers) return null
  return {
    ...pendingInput,
    answers: sanitizedAnswers,
    ...(hasAnnotations ? { annotations: sanitizedAnnotations } : {}),
  }
}

/**
 * Server-side validator for the engine ask_user bridge. The MCP client is not
 * trusted: clamp counts/lengths and strip unknown keys before the questions
 * enter a pending-permission payload that the web renders (and that
 * sanitizeAskUserQuestionUpdatedInput later keys answers against). Mirrors the
 * MCP-side normalizer in packages/mcp-memory toolDefs.ts — two copies on
 * purpose: different packages, different trust domains, no shared dependency.
 *
 * Returns the normalized product-shape questions array, or null when the input
 * is structurally unusable.
 */
export function sanitizeEngineAskUserQuestions(
  raw: unknown,
): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null
  const questions: Array<Record<string, unknown>> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const question = (item as { question?: unknown }).question
    if (typeof question !== 'string' || question.trim().length === 0 || question.length > 2000) {
      return null
    }
    const optionsRaw = (item as { options?: unknown }).options
    if (!Array.isArray(optionsRaw) || optionsRaw.length < 2 || optionsRaw.length > 4) return null
    const options: Array<Record<string, unknown>> = []
    for (const opt of optionsRaw) {
      if (!opt || typeof opt !== 'object' || Array.isArray(opt)) return null
      const label = (opt as { label?: unknown }).label
      if (typeof label !== 'string' || label.trim().length === 0 || label.length > 300) {
        return null
      }
      const description = (opt as { description?: unknown }).description
      options.push({
        label,
        ...(typeof description === 'string' && description.length > 0 && description.length <= 1000
          ? { description }
          : {}),
      })
    }
    const header = (item as { header?: unknown }).header
    const multiSelect = (item as { multiSelect?: unknown }).multiSelect
    questions.push({
      question,
      ...(typeof header === 'string' && header.length > 0 ? { header: header.slice(0, 12) } : {}),
      ...(multiSelect === true ? { multiSelect: true } : {}),
      options,
    })
  }
  return questions
}

// ── AskUserQuestion updatedInput sanitizer ──

/**
 * Hard cap on individual answer / notes / preview string length. Matches the
 * rough upper bound of a reasonable user reply; anything larger is almost
 * certainly abuse / a hostile client trying to blow up the forwarded payload.
 */
export const ASK_USER_QUESTION_STRING_MAX_LEN = 8192

// ── Engine ask_user bridge (cursor MCP) input sanitizer ──

/** Settlement payload handed back to the waiting MCP ask_user HTTP caller. */
export type EngineAskUserSettlement = {
  status: 'answered' | 'skipped' | 'posted'
  answers?: Record<string, string>
  reason?: string
  requestId?: string
  message?: string
}
