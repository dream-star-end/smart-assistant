/**
 * 模型权威批次 · 切片 5 —— 容器侧 catalog client(modelCatalogClient.ts)。
 *
 * 跑法:npx tsx --test packages/gateway/src/__tests__/modelCatalogClient.test.ts
 *
 * 覆盖(方案 §3):
 *   - fresh:TTL 内不打网络(单飞 + 30s 免检窗口)
 *   - 并发单飞:N 个并发 getView 只产生一次全量拉取
 *   - LKG:冷启读盘 → **必须先验 epoch**;epoch 相等 → 用 LKG(不重拉全量)
 *   - epoch 漂移 → 强拉全量;强拉失败 → 拒(不得回落旧快照)
 *   - epoch 端点不通 → 拒(证明不了新鲜就不许用)
 *   - 冷启无 LKG 且 master 不可达 → 拒(**无 baked 回落**,R1-B1)
 *   - token:携 projectionRevision + epoch,kind='local_catalog'
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  LOCAL_CATALOG_KIND,
  MODEL_CATALOG_EPOCH_PATH,
  MODEL_CATALOG_PATH,
  ModelCatalogClient,
  ModelCatalogUnavailableError,
} from '../modelCatalogClient.js'

const ENV = {
  OPENCLAUDE_V3_MASTER_BASE_URL: 'http://master.invalid:18791',
  OPENCLAUDE_V3_CONTAINER_TOKEN: 'oc-v3.1.deadbeef',
} as NodeJS.ProcessEnv

const CATALOG_BODY = {
  models: [
    {
      model_id: 'glm-5.2',
      display_name: 'GLM 5.2',
      engine: 'ccb',
      provider_id: 'ark',
      context_window: 1_000_000,
      supported_efforts: ['high', 'max'],
      supports_vision: false,
      default_effort: 'high',
    },
    {
      model_id: 'gpt-5.6-sol',
      display_name: 'Sol',
      engine: 'codex',
      provider_id: 'codex',
      context_window: null,
      supported_efforts: ['low', 'high'],
      supports_vision: false,
      default_effort: null,
    },
  ],
  projection_revision: 'proj-rev-1',
  security_epoch: '5',
}

interface Call {
  path: string
}

/** undici request 桩:按 path 决定响应;可注入失败。 */
function fakeFetcher(opts: {
  catalog?: { status: number; body?: unknown } | 'network-error'
  epoch?: { status: number; body?: unknown } | 'network-error'
  calls?: Call[]
}) {
  // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  return (async (url: string): Promise<any> => {
    const path = url.includes(MODEL_CATALOG_EPOCH_PATH) ? MODEL_CATALOG_EPOCH_PATH : MODEL_CATALOG_PATH
    opts.calls?.push({ path })
    const spec = path === MODEL_CATALOG_EPOCH_PATH ? opts.epoch : opts.catalog
    if (spec === 'network-error' || spec === undefined) {
      throw new Error('ECONNREFUSED')
    }
    const text = JSON.stringify(spec.body ?? {})
    return {
      statusCode: spec.status,
      body: (async function* () {
        yield Buffer.from(text, 'utf8')
      })(),
    }
    // biome-ignore lint/suspicious/noExplicitAny: 测试桩
  }) as any
}

function tmpLkg(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'oc-catalog-lkg-'))
  return {
    path: join(dir, 'model-catalog-lkg.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('modelCatalogClient — 新鲜快照', () => {
  test('首次拉取成功 → view 可用;TTL 内二次调用不再打网络', async () => {
    const calls: Call[] = []
    const lkg = tmpLkg()
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ catalog: { status: 200, body: CATALOG_BODY }, calls }),
    })
    const v1 = await client.getView()
    assert.equal(v1.securityEpoch, '5')
    assert.equal(v1.projectionRevision, 'proj-rev-1')
    assert.ok(v1.isRoutable('glm-5.2'))
    assert.ok(!v1.isRoutable('not-granted'))
    assert.equal(v1.isCodexModel('gpt-5.6-sol'), true)
    assert.equal(v1.resolve('glm-5.2')?.providerId, 'ark')

    await client.getView()
    assert.deepEqual(
      calls.map((c) => c.path),
      [MODEL_CATALOG_PATH], // TTL 内零网络
    )
    lkg.cleanup()
  })

  test('并发单飞:5 个并发 getView → 只有一次全量拉取', async () => {
    const calls: Call[] = []
    const lkg = tmpLkg()
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ catalog: { status: 200, body: CATALOG_BODY }, calls }),
    })
    await Promise.all([1, 2, 3, 4, 5].map(() => client.getView()))
    assert.equal(calls.filter((c) => c.path === MODEL_CATALOG_PATH).length, 1)
    lkg.cleanup()
  })

  test('token 携 projectionRevision + epoch,kind=local_catalog', async () => {
    const lkg = tmpLkg()
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ catalog: { status: 200, body: CATALOG_BODY } }),
    })
    const token = await client.getToken()
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    assert.deepEqual(decoded, {
      v: 1,
      kind: LOCAL_CATALOG_KIND,
      projectionRevision: 'proj-rev-1',
      securityEpoch: '5',
    })
    lkg.cleanup()
  })
})

describe('modelCatalogClient — LKG + epoch 协议', () => {
  test('冷启从 LKG 读盘:必须先验 epoch;epoch 相等 → 用 LKG(不重拉全量)', async () => {
    const lkg = tmpLkg()
    writeFileSync(lkg.path, JSON.stringify(CATALOG_BODY))
    const calls: Call[] = []
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({
        catalog: { status: 200, body: CATALOG_BODY },
        epoch: { status: 200, body: { epoch: '5' } },
        calls,
      }),
    })
    const v = await client.getView()
    assert.equal(v.securityEpoch, '5')
    assert.deepEqual(
      calls.map((c) => c.path),
      [MODEL_CATALOG_EPOCH_PATH], // 只验了 epoch,没有重拉全量
    )
    lkg.cleanup()
  })

  test('LKG 存在但 epoch 漂移 → 强拉全量(新快照生效)', async () => {
    const lkg = tmpLkg()
    writeFileSync(lkg.path, JSON.stringify(CATALOG_BODY)) // epoch=5
    const calls: Call[] = []
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({
        epoch: { status: 200, body: { epoch: '6' } },
        catalog: { status: 200, body: { ...CATALOG_BODY, security_epoch: '6' } },
        calls,
      }),
    })
    const v = await client.getView()
    assert.equal(v.securityEpoch, '6')
    assert.deepEqual(
      calls.map((c) => c.path),
      [MODEL_CATALOG_EPOCH_PATH, MODEL_CATALOG_PATH],
    )
    lkg.cleanup()
  })

  test('epoch 漂移但全量拉不到 → 拒(**不得**回落到旧 LKG)', async () => {
    const lkg = tmpLkg()
    writeFileSync(lkg.path, JSON.stringify(CATALOG_BODY))
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({
        epoch: { status: 200, body: { epoch: '6' } },
        catalog: 'network-error',
      }),
    })
    await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
    lkg.cleanup()
  })

  test('epoch 端点不通 → 拒(证明不了新鲜就不许用 LKG)', async () => {
    const lkg = tmpLkg()
    writeFileSync(lkg.path, JSON.stringify(CATALOG_BODY))
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ epoch: 'network-error', catalog: { status: 200, body: CATALOG_BODY } }),
    })
    await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
    lkg.cleanup()
  })

  test('TTL 过期后:先验 epoch,相等则顺延(不重拉全量)', async () => {
    const lkg = tmpLkg()
    const calls: Call[] = []
    let now = 1_000_000
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      now: () => now,
      ttlMs: 30_000,
      fetcher: fakeFetcher({
        catalog: { status: 200, body: CATALOG_BODY },
        epoch: { status: 200, body: { epoch: '5' } },
        calls,
      }),
    })
    await client.getView() // 全量
    now += 31_000 // TTL 过期
    await client.getView() // 只验 epoch
    assert.deepEqual(
      calls.map((c) => c.path),
      [MODEL_CATALOG_PATH, MODEL_CATALOG_EPOCH_PATH],
    )
    lkg.cleanup()
  })

  test('LKG 落盘:成功拉取后写盘,内容可被新进程复用', async () => {
    const lkg = tmpLkg()
    const c1 = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ catalog: { status: 200, body: CATALOG_BODY } }),
    })
    await c1.getView()

    // 新进程(新 client):master 全量端点挂了,但 epoch 端点在 → 应能靠 LKG 起来
    const c2 = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({
        catalog: 'network-error',
        epoch: { status: 200, body: { epoch: '5' } },
      }),
    })
    const v = await c2.getView()
    assert.equal(v.projectionRevision, 'proj-rev-1')
    lkg.cleanup()
  })
})

describe('modelCatalogClient — fail-closed(无 baked 回落)', () => {
  test('冷启无 LKG 且 master 不可达 → 拒(拒新 turn,不回落 baked 表)', async () => {
    const lkg = tmpLkg()
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({ catalog: 'network-error' }),
    })
    await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
    lkg.cleanup()
  })

  test('master 返回 5xx / 404(未部署端点)→ 拒', async () => {
    const lkg = tmpLkg()
    for (const status of [404, 500, 503]) {
      const client = new ModelCatalogClient({
        env: ENV,
        lkgPath: lkg.path,
        fetcher: fakeFetcher({ catalog: { status, body: {} } }),
      })
      await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
    }
    lkg.cleanup()
  })

  test('响应形状非法 → 拒(不拿半个投影去判定)', async () => {
    const lkg = tmpLkg()
    const client = new ModelCatalogClient({
      env: ENV,
      lkgPath: lkg.path,
      fetcher: fakeFetcher({
        catalog: { status: 200, body: { models: [{ model_id: 'x' }], projection_revision: 'r', security_epoch: '1' } },
      }),
    })
    await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
    lkg.cleanup()
  })

  test('env 未注入(个人版 / 非托管容器)→ configured=false 且 getView 拒', async () => {
    const client = new ModelCatalogClient({ env: {}, fetcher: fakeFetcher({}) })
    assert.equal(client.configured, false)
    await assert.rejects(() => client.getView(), ModelCatalogUnavailableError)
  })
})
