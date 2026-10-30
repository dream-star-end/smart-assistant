/**
 * Persistent archival/session vectors are keyed by backend + model + dimensions.
 * A model switch re-embeds existing rows before KNN. A failed rebuild refuses
 * the comparison. Fake keys and a mocked fetch only — no paid API calls.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ENV_KEYS = [
  'OPENCLAUDE_HOME',
  'OPENAI_API_KEY',
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'EMBEDDING_DIMENSIONS',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_API_KEY',
  'EMBEDDING_BATCH_SIZE',
  'EMBEDDING_TIMEOUT_MS',
  'OPENCLAUDE_CORE_MEMORY_LOCAL_SEMANTIC',
] as const

test('persistent vectors stay inside one embedding model across a switch and a switch back', async () => {
  const home = await mkdtemp(join(tmpdir(), 'emb-index-identity-'))
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const calls: Array<{ model: string; texts: string[] }> = []
  let failOpenAi = false
  let storage: typeof import('../index.ts') | null = null

  function apply(entries: string[]): void {
    for (const key of ENV_KEYS) {
      if (key !== 'OPENCLAUDE_HOME') delete process.env[key]
    }
    for (const entry of entries) {
      const eq = entry.indexOf('=')
      process.env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
  }

  function dashscopeEnv(): string[] {
    return [
      'EMBEDDING_PROVIDER=openai',
      'EMBEDDING_MODEL=text-embedding-v4',
      'EMBEDDING_DIMENSIONS=1024',
      'EMBEDDING_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1',
      'EMBEDDING_API_KEY=fake-dashscope-key',
      'EMBEDDING_BATCH_SIZE=10',
    ]
  }

  try {
    process.env.OPENCLAUDE_HOME = home
    storage = await import('../index.ts')
    const { buildCoreMemoryEmbeddingContainerEnv } = await import(
      '../../../commercial/src/agent-sandbox/coreMemoryEmbeddingEnv.ts'
    )

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      const body = JSON.parse(String(init?.body)) as { model: string; input: string[]; dimensions: number }
      if (failOpenAi && body.model === 'text-embedding-3-large') {
        throw new Error('simulated embedding failure')
      }
      assert.ok(['dashscope.aliyuncs.com', 'api.openai.com'].includes(url.hostname))
      assert.ok(['text-embedding-v4', 'text-embedding-3-large'].includes(body.model))
      calls.push({ model: body.model, texts: body.input })
      const rotated = body.model === 'text-embedding-3-large'
      const data = body.input.map((text, index) => {
        const relevant = text === 'paraphrase' || text.includes('needle')
        const axis = relevant ? (rotated ? 1 : 0) : (rotated ? 0 : 1)
        const embedding = Array(body.dimensions).fill(0)
        embedding[axis] = 1
        return { index, embedding }
      })
      return new Response(JSON.stringify({ data, usage: { prompt_tokens: 1, total_tokens: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    apply(dashscopeEnv())
    const before = storage.getEmbeddingProvider()
    assert.equal(before.modelId, 'text-embedding-v4')
    assert.equal(before.backendId, 'dashscope.aliyuncs.com')
    await storage.archivalCount('acceptance-agent')
    await storage.initVectorStore(before.dimensions)
    for (const content of ['needle archive', 'haystack archive']) {
      const id = await storage.archivalAdd('acceptance-agent', content)
      const [vec] = await before.embed([content], 'document')
      await storage.upsertArchivalVector(id, vec)
    }

    const db = await storage.getSessionsDb()
    const insertMeta = db.prepare(
      `INSERT INTO sessions_meta (id, agent_id, channel, peer_id, title, started_at, last_at, turn_count)
       VALUES (?, 'acceptance-agent', 'web', 'peer', ?, 1, 1, 1)`,
    )
    const insertFts = db.prepare(
      `INSERT INTO sessions_fts (session_id, turn_idx, role, content, content_fts) VALUES (?, 0, 'user', ?, ?)`,
    )
    for (const [id, content] of [
      ['needle-session', 'needle session turn'],
      ['haystack-session', 'haystack session turn'],
    ] as const) {
      insertMeta.run(id, content)
      insertFts.run(id, content, content)
      const [vec] = await before.embed([content], 'document')
      await storage.upsertSessionVector(storage.encodeSessionVecId(id, 0, 'user'), vec)
    }

    const original = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', before, 2)
    assert.equal(original[0]?.content, 'needle archive')
    assert.equal(original[0]?.bm25Rank, null)
    const originalSessions = await storage.hybridSessionSearch('paraphrase', before, 2, 'acceptance-agent')
    assert.equal(originalSessions[0]?.sessionId, 'needle-session')
    assert.equal(originalSessions[0]?.bm25Rank, null)

    const stamped = calls.length
    await storage.closeSessionsDb()
    storage.resetVectorStore()
    storage.resetEmbeddingProvider()
    apply(dashscopeEnv())
    const same = storage.getEmbeddingProvider()
    await storage.initVectorStore(same.dimensions)
    const sameHits = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', same, 2)
    assert.equal(sameHits[0]?.content, 'needle archive')
    assert.equal(
      calls.slice(stamped).some((call) => call.texts.some((text) => text.includes('needle archive'))),
      false,
      'same model must not re-embed the index',
    )

    failOpenAi = true
    storage.resetEmbeddingProvider()
    apply(buildCoreMemoryEmbeddingContainerEnv({}, { openAiApiKey: 'sk-fake-openai-key' }))
    const blocked = storage.getEmbeddingProvider()
    assert.equal(blocked.modelId, 'text-embedding-3-large')
    const refused = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', blocked, 2)
    assert.equal(refused.length, 0, 'a failed rebuild must not rank old-model vectors')
    const identityDb = await storage.getSessionsDb()
    const stillOld = identityDb.prepare(
      'SELECT backend, model, dimensions FROM embedding_index_identity WHERE id = 1',
    ).get() as { backend: string; model: string; dimensions: number }
    assert.equal(stillOld.model, 'text-embedding-v4')
    assert.equal(stillOld.backend, 'dashscope.aliyuncs.com')
    failOpenAi = false

    identityDb.prepare('DELETE FROM embedding_index_identity').run()
    const legacyCalls = calls.length
    await storage.closeSessionsDb()
    storage.resetVectorStore()
    storage.resetEmbeddingProvider()
    apply(buildCoreMemoryEmbeddingContainerEnv({}, { openAiApiKey: 'sk-fake-openai-key' }))
    const switched = storage.getEmbeddingProvider()
    await storage.initVectorStore(switched.dimensions)
    const switchedHits = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', switched, 2)
    const switchedSessions = await storage.hybridSessionSearch('paraphrase', switched, 2, 'acceptance-agent')
    assert.equal(switchedHits[0]?.content, 'needle archive')
    assert.equal(switchedSessions[0]?.sessionId, 'needle-session')
    const rebuilt = calls.slice(legacyCalls).filter((call) => call.model === 'text-embedding-3-large')
    const rebuiltTexts = rebuilt.flatMap((call) => call.texts)
    assert.ok(rebuiltTexts.includes('needle archive'))
    assert.ok(rebuiltTexts.includes('haystack archive'))
    assert.ok(rebuiltTexts.includes('needle session turn'))
    assert.ok(rebuiltTexts.includes('haystack session turn'))
    const switchedIdentity = (await storage.getSessionsDb()).prepare(
      'SELECT backend, model, dimensions FROM embedding_index_identity WHERE id = 1',
    ).get() as { backend: string; model: string; dimensions: number }
    assert.equal(switchedIdentity.backend, 'api.openai.com')
    assert.equal(switchedIdentity.model, 'text-embedding-3-large')
    assert.equal(switchedIdentity.dimensions, 1024)

    await storage.closeSessionsDb()
    storage.resetVectorStore()
    storage.resetEmbeddingProvider()
    apply(dashscopeEnv())
    const back = storage.getEmbeddingProvider()
    await storage.initVectorStore(back.dimensions)
    const backHits = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', back, 2)
    const backSessions = await storage.hybridSessionSearch('paraphrase', back, 2, 'acceptance-agent')
    assert.equal(backHits[0]?.content, 'needle archive')
    assert.equal(backSessions[0]?.sessionId, 'needle-session')
    const backIdentity = (await storage.getSessionsDb()).prepare(
      'SELECT backend, model FROM embedding_index_identity WHERE id = 1',
    ).get() as { backend: string; model: string }
    assert.equal(backIdentity.backend, 'dashscope.aliyuncs.com')
    assert.equal(backIdentity.model, 'text-embedding-v4')

    const narrow = new storage.OpenAIEmbeddingProvider({
      model: 'text-embedding-v4',
      dimensions: 8,
      apiKey: 'fake-dashscope-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    })
    await storage.initVectorStore(8, narrow)
    const narrowHits = await storage.hybridArchivalSearch('acceptance-agent', 'paraphrase', narrow, 2)
    assert.equal(narrowHits[0]?.content, 'needle archive')
    const narrowIdentity = (await storage.getSessionsDb()).prepare(
      'SELECT dimensions FROM embedding_index_identity WHERE id = 1',
    ).get() as { dimensions: number }
    assert.equal(narrowIdentity.dimensions, 8)
  } finally {
    globalThis.fetch = originalFetch
    if (storage) {
      await storage.closeSessionsDb()
      storage.resetVectorStore()
      storage.resetEmbeddingProvider()
    }
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(home, { recursive: true, force: true })
  }
})
