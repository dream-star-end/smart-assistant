export const DEFAULT_PROFILE: string
export const DEFAULT_DISPLAY: string
export const DEFAULT_CDP_PORT: number
export const DEFAULT_CHROME_BIN: string
export const DEFAULT_CHATGPT_ORIGIN: string
export const FORBIDDEN_PROXY_PORTS: Set<number>
export const LEVEL_ORDER: string[]
export const LEVEL_ALIASES: Record<string, string>
export const LEVEL_SLIDER_PCT: Record<string, string>

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

export function withProfileFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: {
    timeoutMs?: number
    pollMs?: number
    staleMs?: number
    pidAliveFn?: (pid: number) => boolean
  },
): Promise<T>

export function loadSessionConversationMap(profileDir: string): Record<string, string>
export function saveSessionConversationId(
  profileDir: string,
  sessionId: string,
  conversationId: string,
): void
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

export class SseAccumulator {
  conversationId: string | null
  messageId: string | null
  role: string | null
  channel: string | null
  contentType: string | null
  finalText: string
  thinkingText: string
  done: boolean
  error: string | null
  lastEventAt: number
  constructor(opts?: {
    onThinkingDelta?: ((delta: string) => void) | null
    onTextDelta?: ((delta: string) => void) | null
    nowFn?: () => number
  })
  feedDataLine(raw: string): void
}

export function extractAssistantFromMapping(conv: any): { text: string; messageId: string } | null

export function computeAdaptiveDeadline(opts: {
  startedAt: number
  now: number
  lastActivityAt: number
  stopVisible: boolean
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

export function formatStreamJsonSystemInit(opts: {
  sessionId: string
  model?: string
  cwd?: string
}): string
export function formatStreamJsonThinkingDelta(thinking: string): string
export function formatStreamJsonTextDelta(text: string): string
export function formatStreamJsonAssistantMessage(opts: {
  messageId?: string
  model?: string
  text?: string
  thinking?: string
}): string
export function formatStreamJsonResult(opts: {
  sessionId: string
  resultText?: string
  isError?: boolean
  durationMs?: number
}): string
export function formatStreamJsonControlResponse(opts: {
  requestId: string
  subtype?: string
}): string
export function extractInboundDispatchAttachments(rawText: string): {
  cleanText: string
  extractedPaths: string[]
}
export function parseStdinFrame(
  line: string,
  opts?: { stagingDir?: string | null },
):
  | { kind: 'control_request'; requestId: string; subtype: string }
  | { kind: 'user'; text: string; files: string[] }
  | null
export function extractUserTurnFromStdinFrame(
  line: string,
  opts?: { stagingDir?: string | null },
): { text: string; files: string[] } | null
