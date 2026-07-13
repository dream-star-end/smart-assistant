/**
 * 模型权威批次 · 集成缝合 —— gateway → 长驻 CCB 子进程 → 上游 `/v1/messages` 请求头。
 *
 * 覆盖的是**唯一缺失的那一段链路**:master 签发的 envelope 已经能被 gateway 验签
 * (modelAuthority.ts),egress 已经能验票(commercial/http/proxy/modelAuthorityGate.ts),
 * 但没人把票**挂到 CCB 真正发出的那个 HTTP 请求上**。
 *
 * 机制(CCB 零改动):
 *   stdin `update_environment_variables` → CCB `process.env.ANTHROPIC_CUSTOM_HEADERS`
 *   → 每请求现读(client.ts getCustomHeaders,client 每请求新建)→ `/v1/messages` header。
 *
 * 所以本文件的断言全部落在**写进 stdin 的字节序列**上 —— 那是 gateway 侧唯一可观测、
 * 也是唯一有意义的 ground truth:
 *   ① env 更新必须**先于** user message(同一管道按行处理 ⇒ 本 turn 首个上游请求必带新票);
 *   ② bridge turn → 两张票各一行 `Name: Value`;
 *   ③ 无票的 turn → **写空串清位**(上一 turn 的 envelope 绝不允许泄漏到下一 turn:
 *      authorityTurnId 已被消费 → 重放 → egress 拒 → 用户可见故障 + 安全面);
 *   ④ envelope 含 CR/LF → **一个字节都不写**(header 注入 fail-closed,本 turn 不发);
 *   ⑤ 本地路径(cron/synthetic/delegate)→ 只带 `x-oc-local-catalog`。
 *
 * 跑法:npx tsx --test packages/gateway/src/__tests__/ccbAuthorityHeaders.test.ts
 */
import * as assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, describe, it } from 'node:test'

import { CcbAdapter } from '../engine/ccbAdapter.js'
import {
  AUTHORITY_HEADER,
  LOCAL_CATALOG_HEADER,
  type ModelCatalogClient,
  ModelCatalogUnavailableError,
  TURN_LEASE_HEADER,
  _setModelCatalogClientForTests,
} from '../modelCatalogClient.js'
import {
  AuthorityHeaderRejected,
  MODEL_EXECUTION_DESCRIPTOR_ENV,
  SubprocessRunner,
  shouldRecycleForVisionCapability,
  type TurnModelAuthority,
  _buildAnthropicCustomHeadersEnv,
} from '../subprocessRunner.js'

const AUTHORITY_ENV = 'OC_MODEL_AUTHORITY'
const EXECUTION_DESCRIPTOR = {
  canonicalModel: 'glm-5.2',
  contextWindow: 1_000_000,
  capabilityZero: true,
  supportsThinking: true,
  supportsVision: false,
  supportedEfforts: ['high', 'max'],
} as const

function authority(authorityEnvelope: string, leaseEnvelope: string): TurnModelAuthority {
  return { authorityEnvelope, leaseEnvelope, executionDescriptor: EXECUTION_DESCRIPTOR }
}

// ---------------------------------------------------------------------------
// harness:一个只捕获 stdin 写入的假子进程(不 spawn 真 CCB)
// ---------------------------------------------------------------------------

interface Harness {
  runner: SubprocessRunner
  writes: string[]
  destroyed: { value: boolean }
}

function createHarness(failWrite?: number, spawnedDescriptor: unknown = EXECUTION_DESCRIPTOR): Harness {
  const runner = new SubprocessRunner({
    sessionKey: 'test',
    agentId: 'test',
    agentBaseDir: '/tmp',
    model: 'glm-5.2',
    config: {} as never,
  } as never)
  const writes: string[] = []
  const destroyed = { value: false }
  let writeNo = 0
  // proc 非空 ⇒ submit() 不会去 start() 真进程。
  ;(runner as unknown as { proc: unknown }).proc = {
    stdin: {
      write(chunk: string, callback?: (err?: Error | null) => void) {
        writeNo += 1
        writes.push(chunk)
        queueMicrotask(() => callback?.(writeNo === failWrite ? new Error(`write-${writeNo}`) : null))
        return true
      },
      destroy() { destroyed.value = true },
    },
    kill() { destroyed.value = true },
  }
  ;(runner as unknown as { spawnedExecutionDescriptor: unknown }).spawnedExecutionDescriptor =
    spawnedDescriptor
  return { runner, writes, destroyed }
}

/** 假 catalog client(本地路径 token 的来源;生产是 master 的 /internal/v3/model-catalog)。 */
function fakeCatalog(opts: {
  configured: boolean
  token?: string
  throws?: Error
}): ModelCatalogClient {
  return {
    get configured() {
      return opts.configured
    },
    async getToken() {
      if (opts.throws) throw opts.throws
      return opts.token ?? 'tok'
    },
    async getView() {
      if (opts.throws) throw opts.throws
      return {
        canonicalize: (model: string) => model,
        resolve: (model: string) => model === EXECUTION_DESCRIPTOR.canonicalModel
          ? {
              modelId: model,
              engine: 'ccb',
              contextWindow: EXECUTION_DESCRIPTOR.contextWindow,
              capabilityZero: EXECUTION_DESCRIPTOR.capabilityZero,
              supportsThinking: EXECUTION_DESCRIPTOR.supportsThinking,
              supportsVision: EXECUTION_DESCRIPTOR.supportsVision,
              supportedEfforts: [...EXECUTION_DESCRIPTOR.supportedEfforts],
            }
          : null,
      }
    },
  } as unknown as ModelCatalogClient
}

function parseEnvLine(line: string): Record<string, string> {
  const msg = JSON.parse(line) as { type: string; variables: Record<string, string> }
  assert.equal(msg.type, 'update_environment_variables')
  return msg.variables
}

/** `ANTHROPIC_CUSTOM_HEADERS` 串 → header map(逐字节复刻 CCB getCustomHeaders 的解析)。 */
function parseCustomHeaders(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of raw.split(/\n|\r\n/)) {
    if (!line.trim()) continue
    const i = line.indexOf(':')
    if (i === -1) continue
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return out
}

afterEach(() => {
  delete process.env[AUTHORITY_ENV]
  _setModelCatalogClientForTests(null)
})

// ---------------------------------------------------------------------------
// ① 写入顺序:env 更新必须先于 user message
// ---------------------------------------------------------------------------

describe('CCB authority headers — stdin 写入序列', () => {
  it('prewarm/长驻进程的 vision capability 漂移必须 recycle', () => {
    assert.equal(shouldRecycleForVisionCapability(undefined, EXECUTION_DESCRIPTOR), true)
    assert.equal(shouldRecycleForVisionCapability(EXECUTION_DESCRIPTOR, EXECUTION_DESCRIPTOR), false)
    assert.equal(
      shouldRecycleForVisionCapability(
        EXECUTION_DESCRIPTOR,
        { ...EXECUTION_DESCRIPTOR, supportsVision: true },
      ),
      true,
    )
  })
  it('每个 turn 都先写 update_environment_variables,再写 user message', async () => {
    const { runner, writes } = createHarness()
    await runner.submit('hello', undefined, authority('AUTH1', 'LEASE1'))

    assert.equal(writes.length, 2)
    // 顺序是本方案的正确性根基:同一条 stdin 按行处理 ⇒ CCB 在解析 user message 之前
    // 已经把 env 写进 process.env ⇒ 本 turn 的第一个 /v1/messages 必带本 turn 的票。
    const vars = parseEnvLine(writes[0]!)
    assert.ok('ANTHROPIC_CUSTOM_HEADERS' in vars)
    assert.deepEqual(JSON.parse(vars[MODEL_EXECUTION_DESCRIPTOR_ENV]!), EXECUTION_DESCRIPTOR)
    const userMsg = JSON.parse(writes[1]!) as { type: string; message: { role: string } }
    assert.equal(userMsg.type, 'user')
    assert.equal(userMsg.message.role, 'user')
    // 每行一条 JSON(CCB stream-json 输入格式)。
    for (const w of writes) assert.ok(w.endsWith('\n'), 'stdin 每次写入必须以换行结尾')
  })
})

// ---------------------------------------------------------------------------
// ② bridge turn:两张票各一行
// ---------------------------------------------------------------------------

describe('CCB authority headers — bridge turn', () => {
  it('authority + lease 各一行 `Name: Value`,不带 local_catalog', async () => {
    const { runner, writes } = createHarness()
    await runner.submit('hi', 'req-1', authority('eyJhdXRoIjoxfQ', 'eyJsZWFzZSI6MX0'))

    const raw = parseEnvLine(writes[0]!).ANTHROPIC_CUSTOM_HEADERS!
    assert.equal(raw.split('\n').length, 2)
    const headers = parseCustomHeaders(raw)
    assert.deepEqual(headers, {
      [AUTHORITY_HEADER]: 'eyJhdXRoIjoxfQ',
      [TURN_LEASE_HEADER]: 'eyJsZWFzZSI6MX0',
    })
    // bridge 票据与本地路径 token 是**不同 kind、不同 header**,不允许互相伪装(R3-M6)。
    assert.ok(!(LOCAL_CATALOG_HEADER in headers))
  })

  it('bridge turn 不受 OC_MODEL_AUTHORITY flag 影响(有票就带票,不去拉 catalog)', async () => {
    // flag 开 + catalog 会抛:若实现错误地对 bridge turn 也去取 local token,这里会炸。
    process.env[AUTHORITY_ENV] = '1'
    _setModelCatalogClientForTests(
      fakeCatalog({ configured: true, throws: new ModelCatalogUnavailableError('boom') }),
    )
    const { runner, writes } = createHarness()
    await runner.submit('hi', undefined, authority('A', 'L'))
    const headers = parseCustomHeaders(parseEnvLine(writes[0]!).ANTHROPIC_CUSTOM_HEADERS!)
    assert.equal(headers[AUTHORITY_HEADER], 'A')
    assert.equal(headers[TURN_LEASE_HEADER], 'L')
  })
})

// ---------------------------------------------------------------------------
// ③ 清位:无票的 turn 写空串,上一 turn 的 envelope 不得残留
// ---------------------------------------------------------------------------

describe('CCB authority headers — 清位语义', () => {
  it('turn1 有票 → turn2 无票:第二次 env 写入必须是空串(旧 envelope 不残留)', async () => {
    const { runner, writes } = createHarness()
    await runner.submit('turn1', undefined, authority('AUTH1', 'LEASE1'))
    // 本用例只验证 env 清位；视觉能力变化触发的真实 recycle 由独立用例覆盖。
    ;(runner as unknown as { spawnedExecutionDescriptor: unknown }).spawnedExecutionDescriptor = undefined
    await runner.submit('turn2') // 本地路径 / flag 未开

    assert.equal(writes.length, 4)
    assert.equal(
      parseEnvLine(writes[2]!).ANTHROPIC_CUSTOM_HEADERS,
      '',
      '第二个 turn 必须显式清位 —— CCB 对空串按「未设置」处理',
    )
    // 残留 = 拿已消费的 authorityTurnId 去打上游 = egress 重放拒(用户可见故障 + 安全面)。
    assert.ok(!writes[2]!.includes('AUTH1'))
    assert.ok(!writes[2]!.includes('LEASE1'))
  })

  it('flag 未开 → 不去碰 catalog client(个人版/影子期零行为变化)', async () => {
    let touched = false
    _setModelCatalogClientForTests({
      get configured() {
        touched = true
        return true
      },
      async getToken() {
        touched = true
        return 'tok'
      },
    } as unknown as ModelCatalogClient)
    const { runner, writes } = createHarness(undefined, null)
    await runner.submit('local turn')
    assert.equal(parseEnvLine(writes[0]!).ANTHROPIC_CUSTOM_HEADERS, '')
    assert.equal(touched, false)
  })

  it('flag 开但 catalog 未装配 → fail-closed 拒 turn', async () => {
    process.env[AUTHORITY_ENV] = '1'
    _setModelCatalogClientForTests(fakeCatalog({ configured: false }))
    const { runner, writes } = createHarness()
    await assert.rejects(
      runner.submit('local turn'),
      (err: unknown) => err instanceof ModelCatalogUnavailableError,
    )
    assert.equal(writes.length, 0)
  })
})

// ---------------------------------------------------------------------------
// ④ header 注入 fail-closed
// ---------------------------------------------------------------------------

describe('CCB authority headers — fail-closed', () => {
  it('envelope 含 \\n → 拒发 turn,stdin 一个字节都不写', async () => {
    const { runner, writes } = createHarness()
    await assert.rejects(
      runner.submit('hi', undefined, {
        // ANTHROPIC_CUSTOM_HEADERS 按 \n 切行 → 值里的 \n 可以凭空造出第二个 header。
        ...authority('GOOD\nx-injected: evil', 'LEASE'),
      }),
      (err: unknown) => err instanceof AuthorityHeaderRejected,
    )
    assert.equal(writes.length, 0, '拒绝必须发生在任何 stdin 写入之前(本 turn 不发)')
  })

  it('envelope 含 \\r → 同样拒发', async () => {
    const { runner, writes } = createHarness()
    await assert.rejects(
      runner.submit('hi', undefined, authority('A\rB', 'L')),
      (err: unknown) => err instanceof AuthorityHeaderRejected,
    )
    assert.equal(writes.length, 0)
  })

  it('本地路径 catalog 不可用 → 拒新 turn(无 baked 回落),stdin 不写', async () => {
    process.env[AUTHORITY_ENV] = '1'
    _setModelCatalogClientForTests(
      fakeCatalog({ configured: true, throws: new ModelCatalogUnavailableError('master down') }),
    )
    const { runner, writes } = createHarness()
    await assert.rejects(
      runner.submit('cron turn'),
      (err: unknown) => err instanceof ModelCatalogUnavailableError,
    )
    assert.equal(writes.length, 0)
  })

  for (const failWrite of [1, 2]) {
    it(`stdin 第 ${failWrite} 次异步写失败 → reject 且销毁子进程`, async () => {
      const { runner, writes, destroyed } = createHarness(failWrite)
      await assert.rejects(
        runner.submit('hi', undefined, authority('A', 'L')),
        new RegExp(`write-${failWrite}`),
      )
      assert.equal(writes.length, failWrite)
      assert.equal(destroyed.value, true)
    })
  }
})

// ---------------------------------------------------------------------------
// ⑤ 本地路径:只带 x-oc-local-catalog
// ---------------------------------------------------------------------------

describe('CCB authority headers — 本地路径(cron/synthetic/delegate)', () => {
  it('无票 + flag 开 + catalog 已装配 → 只带 x-oc-local-catalog', async () => {
    process.env[AUTHORITY_ENV] = '1'
    _setModelCatalogClientForTests(fakeCatalog({ configured: true, token: 'bG9jYWwtdG9rZW4' }))
    const { runner, writes } = createHarness()
    await runner.submit('cron turn')

    const raw = parseEnvLine(writes[0]!).ANTHROPIC_CUSTOM_HEADERS!
    assert.equal(raw.split('\n').length, 1)
    const headers = parseCustomHeaders(raw)
    assert.deepEqual(headers, { [LOCAL_CATALOG_HEADER]: 'bG9jYWwtdG9rZW4' })
    // 本地路径**不是**授权凭据(容器没私钥)——绝不能伪装成 bridge authority。
    assert.ok(!(AUTHORITY_HEADER in headers))
    assert.ok(!(TURN_LEASE_HEADER in headers))
  })

  it('token 每 turn 现取(携当前 epoch;缓存下来会在安全变更后撞 fence)', async () => {
    process.env[AUTHORITY_ENV] = '1'
    let n = 0
    const base = fakeCatalog({ configured: true })
    _setModelCatalogClientForTests({
      get configured() {
        return true
      },
      async getToken() {
        n += 1
        return `tok-${n}`
      },
      getView: () => base.getView(),
    } as unknown as ModelCatalogClient)
    const { runner, writes } = createHarness()
    await runner.submit('t1')
    await runner.submit('t2')
    assert.equal(
      parseCustomHeaders(parseEnvLine(writes[0]!).ANTHROPIC_CUSTOM_HEADERS!)[LOCAL_CATALOG_HEADER],
      'tok-1',
    )
    assert.equal(
      parseCustomHeaders(parseEnvLine(writes[2]!).ANTHROPIC_CUSTOM_HEADERS!)[LOCAL_CATALOG_HEADER],
      'tok-2',
    )
  })
})

// ---------------------------------------------------------------------------
// engine 接线:TurnParams.modelAuthority → runner.submit 第三参
// ---------------------------------------------------------------------------

describe('CcbAdapter — modelAuthority 透传', () => {
  it('submitTurn 的 modelAuthority 原样进 runner.submit(第三参)', async () => {
    const seen: Array<TurnModelAuthority | undefined> = []
    const fakeRunner = new (class extends EventEmitter {
      lastActivityAt = Date.now()
      async submit(
        _input: unknown,
        _requestId?: string,
        authority?: TurnModelAuthority,
      ): Promise<void> {
        seen.push(authority)
      }
    })()
    const adapter = new CcbAdapter({} as never, fakeRunner as unknown as SubprocessRunner)

    const bridge: TurnModelAuthority = authority('A', 'L')
    await adapter.submitTurn({
      input: 'hi',
      modelAuthority: bridge,
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    }).submitted
    // 本地路径:不传 → runner 侧自取 local_catalog / 清位(判定不在 adapter)。
    await adapter.submitTurn({
      input: 'cron',
      onEvent: () => {},
      sessionTotals: { totalCostUSD: 0, turns: 0 },
      toolUseIdToName: new Map(),
    }).submitted

    assert.deepEqual(seen, [bridge, undefined])
  })
})

// ---------------------------------------------------------------------------
// 串构造单测(wire 格式锁)
// ---------------------------------------------------------------------------

describe('_buildAnthropicCustomHeadersEnv', () => {
  it('三个 header 各一行 `Name: Value`(顺序稳定)', () => {
    const { ANTHROPIC_CUSTOM_HEADERS: raw } = _buildAnthropicCustomHeadersEnv({
      authority: 'A',
      lease: 'L',
      localCatalog: 'C',
    })
    assert.deepEqual(raw.split('\n'), [
      `${AUTHORITY_HEADER}: A`,
      `${TURN_LEASE_HEADER}: L`,
      `${LOCAL_CATALOG_HEADER}: C`,
    ])
  })

  it('undefined / 空集合 → 空串(= CCB 视作未设置)', () => {
    assert.equal(_buildAnthropicCustomHeadersEnv(undefined).ANTHROPIC_CUSTOM_HEADERS, '')
    assert.equal(_buildAnthropicCustomHeadersEnv({}).ANTHROPIC_CUSTOM_HEADERS, '')
  })

  it('空值 / 空格 / 非 ASCII 一律拒(白名单:可见 ASCII)', () => {
    for (const bad of ['', 'has space', 'ü', 'tab\there']) {
      assert.throws(
        () => _buildAnthropicCustomHeadersEnv({ authority: bad }),
        (err: unknown) => err instanceof AuthorityHeaderRejected,
        `expected reject for ${JSON.stringify(bad)}`,
      )
    }
  })
})
