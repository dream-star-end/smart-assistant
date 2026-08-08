import { fileURLToPath } from 'node:url'

export interface CoreMemoryRankDocument {
  id: string
  text: string
}

export interface CoreMemoryRankedDocument {
  id: string
  score: number
}

export const CORE_MEMORY_MODEL_DIR = fileURLToPath(
  new URL('../../../../.models/core-memory/multilingual-e5-small/', import.meta.url),
)

interface CoreMemoryTokenizer {
  (
    text: string,
    options: { add_special_tokens: false },
  ): Promise<{ input_ids: { tolist(): Array<Array<number | bigint>> } }>
  encode(text: string): Array<number | bigint>
  decode(
    tokenIds: Array<number | bigint>,
    options: { skip_special_tokens: true; clean_up_tokenization_spaces: false },
  ): string
  model_max_length?: number
}

interface FeatureExtractionPipeline {
  (
    texts: string[],
    options: { pooling: 'mean'; normalize: true; truncation: false },
  ): Promise<{ tolist(): number[][] }>
  tokenizer: CoreMemoryTokenizer
}

const MODEL_MAX_TOKENS = 512
const TOKEN_OVERLAP = 48

const pipelinePromises = new Map<string, Promise<FeatureExtractionPipeline>>()

async function loadPipeline(modelDir: string): Promise<FeatureExtractionPipeline> {
  let pending = pipelinePromises.get(modelDir)
  if (!pending) {
    pending = createPipeline(modelDir)
    pipelinePromises.set(modelDir, pending)
  }
  return pending
}

async function createPipeline(modelDir: string): Promise<FeatureExtractionPipeline> {
  const transformers = await import('@huggingface/transformers')
  transformers.env.allowLocalModels = true
  transformers.env.allowRemoteModels = false
  transformers.env.useBrowserCache = false
  return (await transformers.pipeline('feature-extraction', modelDir, {
    dtype: 'q8',
  })) as unknown as FeatureExtractionPipeline
}

function dot(a: number[], b: number[]): number {
  let score = 0
  for (let i = 0; i < a.length; i++) score += a[i] * b[i]
  return score
}

async function tokenIdsWithoutSpecialTokens(
  tokenizer: CoreMemoryTokenizer,
  text: string,
): Promise<Array<number | bigint>> {
  const encoded = await tokenizer(text, { add_special_tokens: false })
  const rows = encoded.input_ids.tolist()
  if (rows.length !== 1 || !Array.isArray(rows[0])) {
    throw new Error('core memory tokenizer output mismatch')
  }
  return rows[0]
}

/**
 * Split with the model's own tokenizer. Every original token is present in at
 * least one subchunk, including tails that can exceed 512 tokens despite a
 * short JavaScript string (compatibility characters are a common example).
 */
async function splitForModel(
  tokenizer: CoreMemoryTokenizer,
  prefix: 'query: ' | 'passage: ',
  text: string,
): Promise<string[]> {
  const tokenIds = await tokenIdsWithoutSpecialTokens(tokenizer, text)
  const modelLimit = Math.min(
    MODEL_MAX_TOKENS,
    Number.isFinite(tokenizer.model_max_length)
      ? Number(tokenizer.model_max_length)
      : MODEL_MAX_TOKENS,
  )
  const specialTokenCount = tokenizer.encode('').length
  const prefixTokenCount = (await tokenIdsWithoutSpecialTokens(tokenizer, prefix)).length
  const payloadLimit = modelLimit - specialTokenCount - prefixTokenCount
  if (payloadLimit <= TOKEN_OVERLAP) throw new Error('core memory tokenizer budget invalid')
  if (tokenIds.length === 0) return [prefix]

  const chunks: string[] = []
  let start = 0
  while (start < tokenIds.length) {
    let low = start + 1
    let high = Math.min(tokenIds.length, start + payloadLimit)
    let acceptedEnd = 0
    let acceptedText = ''
    while (low <= high) {
      const end = Math.floor((low + high) / 2)
      const decoded = tokenizer.decode(tokenIds.slice(start, end), {
        skip_special_tokens: true,
        clean_up_tokenization_spaces: false,
      })
      const candidate = `${prefix}${decoded}`
      if (tokenizer.encode(candidate).length <= modelLimit) {
        acceptedEnd = end
        acceptedText = candidate
        low = end + 1
      } else {
        high = end - 1
      }
    }
    if (acceptedEnd <= start) throw new Error('core memory tokenizer made no progress')
    chunks.push(acceptedText)
    if (acceptedEnd >= tokenIds.length) break
    start = Math.max(start + 1, acceptedEnd - TOKEN_OVERLAP)
  }
  return chunks
}

/**
 * Stateless local ranking. The model is process-local, while query/document
 * vectors live only for this request and are never cached or persisted.
 */
export async function rankCoreMemoryDocuments(
  query: string,
  documents: CoreMemoryRankDocument[],
  modelDir = CORE_MEMORY_MODEL_DIR,
): Promise<CoreMemoryRankedDocument[]> {
  if (documents.length === 0) return []
  const featureExtraction = await loadPipeline(modelDir)
  const queryTexts = await splitForModel(featureExtraction.tokenizer, 'query: ', query)
  const documentTexts: string[] = []
  const documentRanges: Array<{ start: number; end: number }> = []
  for (const document of documents) {
    const start = documentTexts.length
    documentTexts.push(
      ...(await splitForModel(featureExtraction.tokenizer, 'passage: ', document.text)),
    )
    documentRanges.push({ start, end: documentTexts.length })
  }
  const texts = [...queryTexts, ...documentTexts]
  const vectors = (
    await featureExtraction(texts, {
      pooling: 'mean',
      normalize: true,
      truncation: false,
    })
  ).tolist()
  if (vectors.length !== texts.length) {
    throw new Error('core memory embedding count mismatch')
  }
  const queryVectors = vectors.slice(0, queryTexts.length)
  return documents
    .map((document, index) => {
      const range = documentRanges[index]
      let score = Number.NEGATIVE_INFINITY
      for (const queryVector of queryVectors) {
        for (let at = range.start; at < range.end; at++) {
          const vector = vectors[queryTexts.length + at]
          if (!queryVector || !vector || vector.length !== queryVector.length) {
            throw new Error('core memory embedding dimension mismatch')
          }
          score = Math.max(score, dot(queryVector, vector))
        }
      }
      if (!Number.isFinite(score)) throw new Error('core memory embedding score mismatch')
      return { id: document.id, score }
    })
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
}

interface QueueItem {
  ownerKey: string
  query: string
  documents: CoreMemoryRankDocument[]
  signal?: AbortSignal
  onAbort?: () => void
  resolve: (value: CoreMemoryRankedDocument[]) => void
  reject: (reason: Error) => void
}

// A queued request can hold at most the authenticated route's 512 KiB body.
// Eight pending requests therefore cap retained request bodies near 4 MiB,
// while one pending slot per user prevents one tenant from filling the FIFO.
const MAX_QUEUED_REQUESTS = 8
const MAX_QUEUED_PER_OWNER = 1

/** Single-concurrency bounded, cancellable FIFO so simultaneous users cannot saturate master. */
export class CoreMemoryRankQueue {
  private readonly items: QueueItem[] = []
  private running = false

  constructor(
    private readonly rankImpl: (
      query: string,
      documents: CoreMemoryRankDocument[],
    ) => Promise<CoreMemoryRankedDocument[]> = rankCoreMemoryDocuments,
  ) {}

  rank(
    query: string,
    documents: CoreMemoryRankDocument[],
    signal?: AbortSignal,
    ownerKey = 'anonymous',
  ): Promise<CoreMemoryRankedDocument[]> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('core memory rank cancelled'))
        return
      }
      const ownerQueued = this.items.filter((item) => item.ownerKey === ownerKey).length
      if (this.items.length >= MAX_QUEUED_REQUESTS || ownerQueued >= MAX_QUEUED_PER_OWNER) {
        reject(new Error('core memory rank queue saturated'))
        return
      }
      const item: QueueItem = { ownerKey, query, documents, signal, resolve, reject }
      if (signal) {
        item.onAbort = () => {
          const at = this.items.indexOf(item)
          if (at < 0) return
          this.items.splice(at, 1)
          signal.removeEventListener('abort', item.onAbort as () => void)
          item.onAbort = undefined
          item.reject(new Error('core memory rank cancelled'))
        }
        signal.addEventListener('abort', item.onAbort, { once: true })
      }
      this.items.push(item)
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.items.length > 0) {
        const item = this.items.shift() as QueueItem
        if (item.signal && item.onAbort) {
          item.signal.removeEventListener('abort', item.onAbort)
          item.onAbort = undefined
        }
        if (item.signal?.aborted) {
          item.reject(new Error('core memory rank cancelled'))
          continue
        }
        try {
          const ranked = await this.rankImpl(item.query, item.documents)
          if (item.signal?.aborted) item.reject(new Error('core memory rank cancelled'))
          else item.resolve(ranked)
        } catch (err) {
          item.reject(err instanceof Error ? err : new Error(String(err)))
        }
      }
    } finally {
      this.running = false
    }
  }
}
