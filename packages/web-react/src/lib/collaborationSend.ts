import { api } from './api'
import {
  type CollabUiState,
  collaborationPutBody,
  continuePrimaryWithoutAdvisor,
  recommendedAdvisorModel,
  refreshOriginalAdvisorForSend,
} from './collaborationConfig'

type Auth = Parameters<typeof api.getCollaborationConfig>[0]

/** Bounded recovery of this send's original advisor; never adopt another send's intent. */
export async function prepareAdvisorSend(input: {
  agentId: string
  original: CollabUiState
  auth: Auth | null
  sessionId: string | null | undefined
  parentEngine?: string
  isCurrent: () => boolean
  update: (state: CollabUiState, recovered: boolean) => void
}): Promise<{ state: CollabUiState; recoveredAdvisor: boolean } | null> {
  const { original, auth, isCurrent } = input
  let state = original
  let continueSolo = continuePrimaryWithoutAdvisor(original)
  let refreshed = false
  if (
    input.agentId === 'main' &&
    original.mode === 'advisor' &&
    (!original.advisorCatalogResolved ||
      original.advisorModels.length === 0 ||
      original.advisorUnavailableReason) &&
    auth
  ) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 5000)
    try {
      const fresh = await api.getCollaborationConfig(auth, input.sessionId || undefined, {
        signal: controller.signal,
      })
      if (!isCurrent()) return null
      const recovered = refreshOriginalAdvisorForSend(original, fresh, input.parentEngine)
      state = recovered.state
      continueSolo = recovered.continueSolo
      refreshed = true
    } catch {
      if (!isCurrent()) return null
      // Retain the submitted intent; recover a still-blocked catalog below.
    } finally {
      window.clearTimeout(timer)
    }
  }
  if (!isCurrent()) return null
  const blockedUnknownAdvisor =
    input.agentId === 'main' &&
    original.mode === 'advisor' &&
    !state.advisorCatalogResolved &&
    !!state.advisorUnavailableReason
  continueSolo ||= blockedUnknownAdvisor
  const recoveredAdvisor = input.agentId === 'main' && continueSolo
  if (recoveredAdvisor) {
    state = { ...state, mode: 'solo', advisorModel: null, configVersion: '' }
    input.update(state, true)
  } else if (refreshed) input.update(state, false)
  return { state, recoveredAdvisor }
}

/** Keep the original identity fence across session creation and config persistence. */
export async function saveInitialCollaboration(
  auth: Auth,
  sessionId: string,
  state: CollabUiState,
  asDefault: boolean,
  identityEpoch: number,
) {
  try {
    const doc = await api.putCollaborationConfig(
      auth,
      collaborationPutBody({
        sessionId,
        mode: state.mode,
        advisorModel:
          state.mode === 'advisor' ? (state.advisorModel ?? recommendedAdvisorModel(state)) : null,
        expectedRev: state.rev,
        asDefault,
      }),
    )
    return auth.snapshot().epoch === identityEpoch ? doc : null
  } catch (error) {
    if (auth.snapshot().epoch !== identityEpoch) return null
    throw error
  }
}

/** Send already carries solo: session-only persistence must never block or replay it. */
export async function persistRecoveredAdvisor(input: {
  auth: Auth
  sessionId: string
  rev: number
  isCurrent: () => boolean
  ensureSession: (sessionId: string) => Promise<unknown> | undefined
}): Promise<void> {
  try {
    if (!input.isCurrent()) return
    const ensured = await input.ensureSession(input.sessionId)
    if (!ensured || !input.isCurrent()) return
    await api.putCollaborationConfig(
      input.auth,
      collaborationPutBody({
        sessionId: input.sessionId,
        mode: 'solo',
        advisorModel: null,
        expectedRev: input.rev,
      }),
    )
  } catch {
    /* The turn has already been sent exactly once. */
  }
}
