/** Optional, conservative native idle fit. This never changes the transcript. */
import type { Message } from '../../types/message.js'
import type { Attachment } from '../../utils/attachments.js'
import { normalizeAttachmentForAPI } from '../../utils/messages.js'
import { getAuthorityModelCapabilities } from '../../utils/model/staticKeyModels.js'
import { BOX_API_OUTPUT_TOKENS, BOX_NATIVE_CONTEXT_MODELS } from '../../utils/model/boxNativeRemoteContext.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'
import type { IdleNativeFit } from './idleRecover.js'

// Retain the larger existing 1M autocompact buffer, plus the whole output cap.
const SAFETY_TOKENS = 50_000
const ESTIMATED_IMAGE_TOKENS = 2_000
// Above the existing <=2000x2000 image estimate (~5334), not a tokenizer claim.
const BOUNDED_IMAGE_TOKENS = 8_192

type Row = Record<string, unknown>
const row = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v)

export async function buildIdleNativeFit(
  messages: readonly Message[],
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IdleNativeFit | undefined> {
  try {
    // Do not trust user [1m] suffixes or local context-window overrides.
    const authority = getAuthorityModelCapabilities(model, env)
    if (!authority) return undefined
    const canonical = authority.canonicalModel.trim().toLowerCase()
    if (!BOX_NATIVE_CONTEXT_MODELS.includes(canonical)) return undefined
    const window = authority.contextWindow
    const output = Object.hasOwn(BOX_API_OUTPUT_TOKENS, canonical)
      ? BOX_API_OUTPUT_TOKENS[canonical] : undefined
    if (!Number.isSafeInteger(window) || !window || !output) return undefined
    const inputBudget = window - output - SAFETY_TOKENS
    if (inputBudget <= 0) return undefined

    let imageCount = 0
    const checked = new Map<string, string>()
    const imageFits = async (source: unknown): Promise<boolean> => {
      if (!authority.supportsVision || !row(source) || source.type !== 'base64'
        || !['image/jpeg', 'image/png'].includes(String(source.media_type))
        || typeof source.data !== 'string' || !source.data.length
        || source.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(source.data)) return false
      const mediaType = String(source.media_type)
      const old = checked.get(source.data)
      if (old !== undefined) return old === mediaType
      // Bind dimensions to the actual bytes; a Read fallback need not be resized.
      const bytes = Buffer.from(source.data, 'base64')
      const sharp = (await import('sharp')).default
      const info = await sharp(bytes, { animated: true, limitInputPixels: 4_000_000 }).metadata()
      if (info.format !== (mediaType === 'image/jpeg' ? 'jpeg' : 'png')
        || !info.width || !info.height || info.width > 2000 || info.height > 2000
        || (info.pages ?? 1) !== 1 || info.pageHeight !== undefined
        || info.delay !== undefined || info.loop !== undefined) return false
      checked.set(source.data, mediaType)
      return true
    }
    const contentCovered = async (content: unknown): Promise<boolean> => {
      if (content === undefined || typeof content === 'string') return true
      if (!Array.isArray(content)) return false
      for (const block of content) {
        if (typeof block === 'string') continue
        if (!row(block)) return false
        switch (block.type) {
          case 'text': if (typeof block.text !== 'string') return false; break
          case 'thinking': if (typeof block.thinking !== 'string') return false; break
          case 'redacted_thinking': if (typeof block.data !== 'string') return false; break
          case 'tool_use':
            if (typeof block.name !== 'string') return false
            break // The real estimator includes the entire input JSON.
          case 'tool_result':
            if (!await contentCovered(block.content)) return false
            break
          case 'image':
            if (!await imageFits(block.source)) return false
            imageCount++
            break
          // PDFs may contain many pages; URL/unknown blocks have no proven bound.
          default: return false
        }
      }
      return true
    }
    // model-provider keeps attachments open at the internal message boundary.
    // This is the same producer contract used by the API normalizer; projected
    // content is still checked below, and malformed input keeps the old path.
    const estimateRows: Parameters<typeof roughTokenCountEstimationForMessages>[0] = messages.map(message => ({
      type: message.type, message: message.message,
      attachment: message.attachment as Attachment | undefined,
    }))
    for (const message of estimateRows) {
      if (message.type === 'user' || message.type === 'assistant') {
        if (!message.message || !await contentCovered(message.message.content)) return undefined
      } else if (message.type === 'attachment') {
        if (!message.attachment) return undefined
        for (const projected of normalizeAttachmentForAPI(message.attachment)) {
          if (!await contentCovered(projected.message.content)) return undefined
        }
      }
    }
    const outer = roughTokenCountEstimationForMessages(estimateRows)
    const observed = tokenCountWithEstimation(messages)
    if (![outer, observed].every(n => Number.isFinite(n) && n >= 0)) return undefined
    // Full outer content prevents a compacted inner leaf's low usage hiding it.
    // Pad media even when the usage estimate already counted it: conservative.
    const inputTokens = Math.ceil(Math.max(outer, observed))
      + imageCount * (BOUNDED_IMAGE_TOKENS - ESTIMATED_IMAGE_TOKENS)
    return Number.isSafeInteger(inputTokens) ? { inputTokens, inputBudget } : undefined
  } catch {
    // Missing/invalid authority, media metadata or coverage keeps the old path.
    return undefined
  }
}
