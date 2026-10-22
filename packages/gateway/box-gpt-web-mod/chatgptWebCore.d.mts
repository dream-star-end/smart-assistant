export const DEFAULT_PROFILE: string
export const DEFAULT_DISPLAY: string
export const DEFAULT_CDP_PORT: number
export const DEFAULT_CHROME_BIN: string
export const DEFAULT_CHATGPT_ORIGIN: string
export const FORBIDDEN_PROXY_PORTS: Set<number>
export const LEVEL_ORDER: string[]
export const LEVEL_ALIASES: Record<string, string>
export const LEVEL_SLIDER_PCT: Record<string, string>

export function defaultGptWebSessionId(): string
export function profileDirFor(profile?: string, home?: string): string
export function cdpPortForProfile(profile?: string, explicitPort?: number | string | null): number
export function isChatGptOriginUrl(rawUrl: string): boolean
export function validateLocalOnlyProxy(proxyUrl: string | null | undefined): string | null
export function buildChromeLaunchArgs(opts?: {
  profileDir?: string
  cdpPort?: number
  proxyUrl?: string | null
  startUrl?: string
}): string[]
export function isPidAlive(pid: number): boolean
export function readProfileSingletonOwner(
  profileDir: string,
  procRoot?: string,
): {
  locked: boolean
  pid: number | null
  cdpPort: number | null
  ownsProfile: boolean
  cmdline?: string
  staleSingleton?: boolean
}

export class SerialJobQueue {
  get size(): number
  enqueue<T>(fn: () => Promise<T>, opts?: { timeoutMs?: number }): Promise<T>
}

export const BOX_GPT_WEB_BUSY_MESSAGE: string

export function withProfileFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: {
    timeoutMs?: number
    pollMs?: number
    staleMs?: number
    pidAliveFn?: (pid: number) => boolean
    busyMessage?: string | null
  },
): Promise<T>

export function loadSessionConversationMap(profileDir: string): Record<string, string>
export function saveSessionConversationId(
  profileDir: string,
  sessionId: string,
  conversationId: string,
): void
export function loadActiveTurnState(
  profileDir: string,
  sessionId: string,
): Record<string, any> | null
export function saveActiveTurnState(
  profileDir: string,
  sessionId: string,
  state: Record<string, any>,
): void
export function clearActiveTurnState(profileDir: string, sessionId: string): void
export function syncPageToSessionConversation(
  page: any,
  opts: { profileDir: string; sessionId: string; initScript?: string },
): Promise<{ conversationId: string | null; navigated: boolean }>

export function levelIndex(raw: string | null | undefined): number
export function stripTierCaption(s: string | null | undefined): string

export class TierLimitError extends Error {
  code: string
  hitLevel: string
  fallbackLevel: string | null
  constructor(info: { message?: string; hitLevel?: string; fallbackLevel?: string | null })
}

export function detectTierLimit(
  bannerTexts: string[] | string,
  targetIdx?: number,
): {
  blocked: boolean
  hitLevel: string
  fallbackLevel: string | null
  message: string
} | null

export function probeSessionState(
  page: any,
  opts?: { profileDir?: string; display?: string },
): Promise<{ ok: boolean; code: string; message: string }>

export function resolveVisibleLocator(
  page: any,
  selector: string,
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<any>

export function selectProTierInPage(
  page: any,
  opts?: { requestedTier?: string },
): Promise<{
  modelLabel: string
  tier: string
  sliderIndex: number
  selectedCaption: string | null
}>

export function uploadAttachmentsToComposer(
  page: any,
  filePaths: string[],
  opts?: { timeoutMs?: number; pollMs?: number },
): Promise<{ uploadedCount: number }>

export function typeMultilinePreservingAttachments(page: any, text: string): Promise<void>
export function backendFetchTeeInitScript(): string

/** Map<refId (e.g. turn0search3) | `matched:${markerText}`, sources> (OCV5-584). */
export type ChatgptCitationSources = Map<string, Array<{ url: string; title: string }>>
export const CHATGPT_MARKER_MAX_LEN: number
export function collectChatgptCitationSources(
  value: unknown,
  into?: ChatgptCitationSources,
): ChatgptCitationSources
export type ChatgptCitationState = {
  rendered: Array<[string, string]>
  numbers: Array<[string, number]>
  nextNumber: number
  pendingRefs: Array<{ markerText: string; refs: string[] }>
}
export class ChatgptCitationRenderer {
  constructor(opts?: { sources?: ChatgptCitationSources | null })
  addSources(sources: ChatgptCitationSources | null | undefined): void
  /** Serializable rendering state (persisted with the active turn so a reconnect renders delivered markers alike). */
  exportState(): ChatgptCitationState
  restoreState(state: ChatgptCitationState | null | undefined): void
  render(rawText: string, opts?: { final?: boolean; delivered?: string }): string
}

export class SseAccumulator {
  conversationId: string | null
  messageId: string | null
  role: string | null
  channel: string | null
  contentType: string | null
  finalText: string
  thinkingText: string
  citationSources: ChatgptCitationSources
  done: boolean
  streamHandoff: boolean
  error: string | null
  lastEventAt: number
  constructor(opts?: {
    onThinkingDelta?: ((delta: string) => void) | null
    onTextDelta?: ((delta: string) => void) | null
    nowFn?: () => number
  })
  feedDataLine(raw: string): void
}

export const DEFAULT_BASE_TIMEOUT_MS: number
export const DEFAULT_STEP_EXTEND_MS: number
export const DEFAULT_MAX_TIMEOUT_MS: number
export const DEFAULT_STALL_WINDOW_MS: number

export function extractAssistantFromMapping(
  conv: any,
  opts?: { baselineNodeId?: string | null; allowInProgress?: boolean },
): { text: string; messageId: string } | null

export function fetchConversationPayloadInPage(
  page: any,
  fallbackConvId?: string | null,
  opts?: { retries?: number; tokenTtlMs?: number },
): Promise<{ conv: any | null; convId: string | null; status?: number }>

export function inspectExistingTurnInConversation(
  conv: any,
  opts?: { promptText?: string; baselineNodeId?: string | null },
): {
  status: 'not_found' | 'in_progress' | 'completed'
  baselineNodeId: string | null
  userNodeId: string | null
  reply: { text: string; messageId: string } | null
}

export function extractTurnProgressFromMapping(
  conv: any,
  opts?: { baselineNodeId?: string | null },
): {
  thinkingSteps: Array<{ key: string; text: string }>
  liveFinalText: string
  finishedFinal: { text: string; messageId: string } | null
  citationSources: ChatgptCitationSources
  currentNode: string | null
}

export function extractLiveProgressFromDomInPage(page: any): Promise<{
  stopBtn: boolean
  activeThinking: boolean
  statusLines: string[]
}>

export function safeStreamableTextLength(text: string): number

export class TurnProgressStreamer {
  stepTextByKey: Map<string, string>
  seenDomPhaseKeys: Set<string>
  emittedFinalText: string
  lastThinkingEmitAt: number
  citations: ChatgptCitationRenderer
  constructor(opts?: {
    nowFn?: () => number
    initialEmittedFinalText?: string
    initialStepTextByKey?: Record<string, string> | null
  })
  restoreState(
    state?: {
      emittedFinalText?: string
      stepTextByKey?: Record<string, string> | null
      citations?: ChatgptCitationState | null
    } | null,
  ): void
  exportState(): {
    emittedFinalText: string
    stepTextByKey: Record<string, string>
    citations: ChatgptCitationState
  }
  ingestMappingProgress(progress: {
    thinkingSteps?: Array<{ key: string; text: string }>
    liveFinalText?: string
    finishedFinal?: { text: string; messageId: string } | null
    citationSources?: ChatgptCitationSources | null
  }): { thinkingDeltas: string[]; textDeltas: string[] }
  ingestDomProgress(
    domProgress: { stopBtn?: boolean; activeThinking?: boolean; statusLines?: string[] },
    opts?: { now?: number; startedAt?: number; heartbeatIntervalMs?: number },
  ): { thinkingDeltas: string[] }
  consumeIncrementalFinalText(fullText: string, opts?: { finalFlush?: boolean }): string
}

export function classifyApprovalCard(opts?: {
  text?: string
  buttons?: Array<string | { index?: number; label?: string }>
}): {
  decision: 'allow_this_chat' | 'skip'
  buttonIndex: number | null
  buttonLabel: string
  targetHost: string | null
  summary: string
  announcement: string
}

export function inspectAndHandleApprovalCardInPage(page: any): Promise<{
  handled: boolean
  decision?: 'allow_this_chat' | 'skip'
  buttonIndex?: number | null
  buttonLabel?: string
  targetHost?: string | null
  summary?: string
  announcement?: string
}>

export interface GptWebOutputArtifactRef {
  name: string
  sandboxUrl?: string
  sandboxPath?: string
  fileId?: string
  mimeType?: string
  messageId?: string | null
}

export interface GptWebDownloadedArtifact {
  name: string
  sandboxUrl?: string
  sandboxPath?: string
  fileId?: string
  mimeType?: string
  size: number
  base64: string
}

export function extractTurnOutputArtifactRefs(opts?: {
  text?: string
  conv?: any
  baselineNodeId?: string | null
  finalMessageId?: string | null
  maxFiles?: number
}): GptWebOutputArtifactRef[]

export function downloadTurnOutputArtifactsInPage(
  page: any,
  opts?: {
    convId?: string | null
    finalMessageId?: string | null
    artifactRefs?: GptWebOutputArtifactRef[]
    maxBytesPerFile?: number
  },
): Promise<GptWebDownloadedArtifact[]>

export function computeAdaptiveDeadline(opts: {
  startedAt: number
  now: number
  lastActivityAt: number
  stopVisible: boolean
  activeThinkingVisible?: boolean
  stopGoneSince?: number | null
  hasFinalText?: boolean
  baseTimeoutMs?: number
  stepExtendMs?: number
  maxTimeoutMs?: number
  stallWindowMs?: number
  rescueAfterStopGoneMs?: number
  currentDeadline?: number
}): {
  deadline: number
  extended: boolean
  shouldRescue: boolean
  expired: boolean
}

export function resolveTurnCompletionDecision(opts?: {
  accDone?: boolean
  shouldRescue?: boolean
  accFinalText?: string
  rescued?: {
    text?: string | null
    messageId?: string | null
    convId?: string | null
    conv?: any
  } | null
  latestProg?: {
    liveFinalText?: string
    finishedFinal?: { text: string; messageId: string } | null
  } | null
  emittedFinalText?: string
  stopVisible?: boolean
  activeThinkingVisible?: boolean
  stopGoneSince?: number | null
  lastFinalTextGrowthAt?: number | null
  now?: number
  emptyDoneGraceMs?: number
}): {
  action: 'continue' | 'wait_grace' | 'finalize' | 'error_empty'
  text?: string
  messageId?: string | null
  convId?: string | null
  conv?: any | null
  source?: 'sse' | 'rescue' | 'mapping_finished' | 'partial_fallback'
}

export function formatStreamJsonSystemInit(opts: {
  sessionId: string
  model?: string
  cwd?: string
}): string
export function formatStreamJsonMessageStart(opts?: {
  messageId?: string
  model?: string
}): string
export function formatStreamJsonThinkingBlockStart(opts?: { index?: number }): string
export function formatStreamJsonContentBlockStop(opts?: { index?: number }): string
export function formatStreamJsonThinkingDelta(thinking: string): string
export function formatStreamJsonTextDelta(
  text: string,
  opts?: { outputAttachments?: GptWebDownloadedArtifact[] | null },
): string
export function formatStreamJsonAssistantMessage(opts: {
  messageId?: string
  model?: string
  text?: string
  thinking?: string
  outputAttachments?: GptWebDownloadedArtifact[] | null
}): string
export function formatStreamJsonResult(opts: {
  sessionId: string
  resultText?: string
  isError?: boolean
  durationMs?: number
  outputAttachments?: GptWebDownloadedArtifact[] | null
}): string
export function formatStreamJsonControlResponse(opts: {
  requestId: string
  subtype?: string
}): string
export function formatStreamJsonKeepalive(opts: {
  sessionId: string
  elapsedMs?: number
}): string
export function extractInboundDispatchAttachments(
  rawText: string,
  opts?: { allowedUploadRoots?: readonly string[]; stripWithoutVerify?: boolean },
): {
  cleanText: string
  extractedPaths: string[]
}
export function parseStdinFrame(
  line: string,
  opts?: { stagingDir?: string | null; allowedUploadRoots?: readonly string[] },
):
  | { kind: 'control_request'; requestId: string; subtype: string }
  | { kind: 'user'; text: string; files: string[]; turnId?: string; deliveredText?: string }
  | null
export function extractUserTurnFromStdinFrame(
  line: string,
  opts?: { stagingDir?: string | null; allowedUploadRoots?: readonly string[] },
): { text: string; files: string[]; turnId?: string; deliveredText?: string } | null

export function resetComposerDraftInPage(page: any): Promise<void>
export function resolveTrustedAttachmentPath(
  filePath: string,
  allowedUploadRoots?: readonly string[],
): string | null
