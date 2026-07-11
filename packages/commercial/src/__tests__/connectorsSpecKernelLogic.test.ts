/**
 * 连接器 Contract 内核 · 纯逻辑单测(无 DB)。
 *
 * 覆盖(RFC §8b 切片① 验收核心 = 篡改即 fail-closed):
 *   - canonical 确定性(键序无关同 bytes / 同 hash)
 *   - sign/verify roundtrip;篡改 specHash/execContractHash/policyVersion/versionId/
 *     listingSlug/compilerVersion/signature/keyId 任一 → verify 失败
 *   - compileSpec 确定性(同输入同 ExecContract + hash)
 *   - effect 规则(GET→read;非 GET→write;safe-read POST→read;DELETE/PUT/PATCH 不可 override)
 *   - 结构性封堵:bodyTemplate/query 引用 credential.* → schema 拒;保留头/placement source;
 *     path 注入;pipeline 环/slot;originMode↔authMode;builtin fail-closed
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

// KMS key 必须在任何 sign/verify 前就位。
process.env.OPENCLAUDE_KMS_KEY = randomBytes(32).toString('base64')

import { canonicalBytes, canonicalSha256Hex, sha256Hex } from '../connectors/spec/canonical.js'
import { compileSpec } from '../connectors/spec/compiler.js'
import { type ContractSignMeta, signContract, verifyContract } from '../connectors/spec/signer.js'
import { ConnectorSpecError } from '../connectors/spec/types.js'

function isCode(code: string) {
  return (err: unknown) => err instanceof ConnectorSpecError && err.code === code
}

// ─── fixtures ────────────────────────────────────────────────────────────────

function baseSpec(): Record<string, unknown> {
  return {
    id: 'notion',
    label: 'Notion',
    description: 'read notion',
    authMode: 'static-token',
    auth: {
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    },
    originMode: 'fixed-reviewed',
    credentialPipeline: {
      nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
    },
    actions: [
      {
        id: 'get_page',
        description: 'get a page',
        request: {
          method: 'GET',
          pathTemplate: '/v1/pages',
          query: { pageId: '/params/pageId' },
        },
        params: { type: 'object', additionalProperties: false },
        result: { type: 'object', additionalProperties: false },
        usesSlot: 'api-token',
      },
      {
        id: 'search',
        description: 'search pages (POST but read-only)',
        request: {
          method: 'POST',
          pathTemplate: '/v1/search',
          bodyTemplate: { obj: { query: { ref: '/params/query' } } },
        },
        params: { type: 'object', additionalProperties: false },
        result: { type: 'object', additionalProperties: false },
        usesSlot: 'api-token',
      },
    ],
  }
}

function baseDecision(): Record<string, unknown> {
  return {
    audience: {
      authorizationOrigins: [],
      tokenOrigins: [],
      apiOrigins: ['https://api.notion.com:443'],
      unauthenticatedUploadOrigins: [],
    },
    actions: {
      // POST /v1/search 被 reviewer 签为 safe-read-non-get → read。
      search: { safeReadNonGet: true },
    },
  }
}

// ─── canonical ───────────────────────────────────────────────────────────────

describe('canonical', () => {
  test('键序无关 → 同 bytes / 同 hash', () => {
    const a = { b: 1, a: 2, nested: { z: [1, 2], y: 'x' } }
    const b = { nested: { y: 'x', z: [1, 2] }, a: 2, b: 1 }
    assert.deepEqual(canonicalBytes(a), canonicalBytes(b))
    assert.equal(canonicalSha256Hex(a), canonicalSha256Hex(b))
  })

  test('数组保序影响 hash', () => {
    assert.notEqual(canonicalSha256Hex([1, 2]), canonicalSha256Hex([2, 1]))
  })

  test('sha256Hex 稳定', () => {
    assert.equal(sha256Hex(Buffer.from('')), sha256Hex(Buffer.from('')))
    assert.match(canonicalSha256Hex({ x: 1 }), /^[0-9a-f]{64}$/)
  })
})

// ─── sign / verify(篡改即失败) ─────────────────────────────────────────────

describe('signer', () => {
  const meta: ContractSignMeta = {
    listingSlug: 'notion',
    versionId: 42,
    kind: 'connector',
    specHash: 'a'.repeat(64),
    execContractHash: 'b'.repeat(64),
    compilerVersion: 1,
    policyVersion: 1,
  }

  test('roundtrip 通过', () => {
    const { signature, keyId } = signContract(meta)
    assert.equal(keyId, 'v1')
    assert.match(signature, /^[0-9a-f]{64}$/)
    assert.equal(verifyContract(meta, signature, keyId), true)
  })

  test('覆盖字段任一被篡改 → verify 失败', () => {
    const { signature, keyId } = signContract(meta)
    const tampers: ContractSignMeta[] = [
      { ...meta, specHash: 'c'.repeat(64) },
      { ...meta, execContractHash: 'd'.repeat(64) },
      { ...meta, policyVersion: 2 },
      { ...meta, versionId: 43 },
      { ...meta, listingSlug: 'evil' },
      { ...meta, compilerVersion: 2 },
    ]
    for (const t of tampers) {
      assert.equal(verifyContract(t, signature, keyId), false)
    }
  })

  test('签名字节被篡改 → verify 失败', () => {
    const { signature, keyId } = signContract(meta)
    const flipped = (signature[0] === '0' ? '1' : '0') + signature.slice(1)
    assert.equal(verifyContract(meta, flipped, keyId), false)
    // 非法形状签名一律 false
    assert.equal(verifyContract(meta, 'not-hex', keyId), false)
    assert.equal(verifyContract(meta, `${signature}ff`, keyId), false)
  })

  test('未知 keyId → verify 失败', () => {
    const { signature } = signContract(meta)
    assert.equal(verifyContract(meta, signature, 'v99'), false)
  })
})

// ─── compileSpec ─────────────────────────────────────────────────────────────

describe('compileSpec', () => {
  test('确定性:同输入 → 同 ExecContract + 同 hash', () => {
    const c1 = compileSpec(baseSpec(), baseDecision())
    const c2 = compileSpec(baseSpec(), baseDecision())
    assert.deepEqual(c1.execContract, c2.execContract)
    assert.equal(c1.execContractHash, c2.execContractHash)
    assert.equal(c1.specHash, c2.specHash)
    assert.match(c1.specHash, /^[0-9a-f]{64}$/)
    assert.match(c1.execContractHash, /^[0-9a-f]{64}$/)
  })

  test('spec_hash 键序无关', () => {
    const s1 = baseSpec()
    const s2: Record<string, unknown> = {}
    // 反序插入顶层键
    for (const k of Object.keys(s1).reverse()) s2[k] = s1[k]
    assert.equal(compileSpec(s1, baseDecision()).specHash, compileSpec(s2, baseDecision()).specHash)
  })

  test('effect:GET→read;safe-read POST→read', () => {
    const { execContract } = compileSpec(baseSpec(), baseDecision())
    const byId = Object.fromEntries(execContract.actions.map((a) => [a.id, a.effect]))
    assert.equal(byId.get_page, 'read')
    assert.equal(byId.search, 'read')
    // effect 只在 ExecContract,ConnectorSpec action 无 effect 字段
    assert.equal('effect' in (baseSpec().actions as Record<string, unknown>[])[0], false)
  })

  test('effect:非 GET 默认 write', () => {
    const spec = baseSpec()
    const decision = baseDecision()
    // 去掉 search 的 safe-read override → 应为 write
    ;(decision.actions as Record<string, unknown>) = {}
    const { execContract } = compileSpec(spec, decision)
    const search = execContract.actions.find((a) => a.id === 'search')
    assert.equal(search?.effect, 'write')
  })

  test('effect:reviewer 可签 send', () => {
    const decision = baseDecision()
    ;(decision.actions as Record<string, unknown>) = { search: { effect: 'send' } }
    const { execContract } = compileSpec(baseSpec(), decision)
    assert.equal(execContract.actions.find((a) => a.id === 'search')?.effect, 'send')
  })

  test('effect:非 GET 想签 read 但无 safeReadNonGet → 拒', () => {
    const decision = baseDecision()
    ;(decision.actions as Record<string, unknown>) = { search: { effect: 'read' } }
    assert.throws(() => compileSpec(baseSpec(), decision), isCode('EFFECT_OVERRIDE_FORBIDDEN'))
  })

  test('effect:DELETE/PUT/PATCH 不可 safe-read override', () => {
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      const spec = baseSpec()
      ;(spec.actions as Record<string, unknown>[])[1].request = {
        method,
        pathTemplate: '/v1/things',
      }
      const decision = baseDecision()
      ;(decision.actions as Record<string, unknown>) = { search: { safeReadNonGet: true } }
      assert.throws(() => compileSpec(spec, decision), isCode('EFFECT_OVERRIDE_FORBIDDEN'), method)
    }
  })

  test('bodyTemplate/query 引用 credential.* → schema 拒(结构性封堵)', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[1].request = {
      method: 'POST',
      pathTemplate: '/v1/search',
      bodyTemplate: { obj: { token: { ref: '/credential/secret' } } },
    }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('SPEC_SCHEMA_INVALID'))

    const spec2 = baseSpec()
    ;(spec2.actions as Record<string, unknown>[])[0].request = {
      method: 'GET',
      pathTemplate: '/v1/pages',
      query: { secret: '/credential/secret' },
    }
    assert.throws(() => compileSpec(spec2, baseDecision()), isCode('SPEC_SCHEMA_INVALID'))
  })

  test('placement:authorization-bearer 只能 access_token', () => {
    const spec = baseSpec()
    ;(spec.auth as Record<string, unknown>).apiCredentialPlacements = [
      { source: 'client_id', placement: 'authorization-bearer' },
    ]
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('BAD_PLACEMENT'))
  })

  test('placement:通用 header 禁 Authorization/Host', () => {
    for (const name of ['Authorization', 'authorization', 'Host']) {
      const spec = baseSpec()
      ;(spec.auth as Record<string, unknown>).apiCredentialPlacements = [
        { source: 'access_token', placement: 'header', name },
      ]
      assert.throws(() => compileSpec(spec, baseDecision()), isCode('RESERVED_HEADER'), name)
    }
  })

  test('placement:source 不能是 client_secret/refresh_token(schema 枚举拒)', () => {
    const spec = baseSpec()
    ;(spec.auth as Record<string, unknown>).apiCredentialPlacements = [
      { source: 'client_secret', placement: 'header', name: 'X-Secret' },
    ]
    // 无变体匹配该 auth → 外层 ConnectorSpec union 直接拒。
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('SPEC_SCHEMA_INVALID'))
  })

  test('auth 与 authMode 不匹配 → AUTH_SCHEMA_INVALID', () => {
    const spec = baseSpec()
    // oauth2 形状的 auth,但 authMode 仍是 static-token → 过 union,但过不了权威逐字段校验。
    spec.auth = {
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientAuth: 'basic',
      scopeSeparator: ' ',
      refreshRotation: false,
      refreshEncoding: 'form',
      pkce: 'required',
      tokenOutputs: { accessToken: '/access_token' },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('AUTH_SCHEMA_INVALID'))
  })

  test('path 注入(//host / scheme / userinfo / ..)→ 拒', () => {
    for (const pathTemplate of ['//evil.com/x', '/a/../b', '/x@evil', '/http://x']) {
      const spec = baseSpec()
      ;(spec.actions as Record<string, unknown>[])[0].request = { method: 'GET', pathTemplate }
      assert.throws(
        () => compileSpec(spec, baseDecision()),
        isCode('BAD_PATH_TEMPLATE'),
        pathTemplate,
      )
    }
  })

  test('path 占位符引用未声明 params 字段 → BAD_PATH_PLACEHOLDER', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].request = {
      method: 'GET',
      pathTemplate: '/v1/pages/{/params/pageId}',
    }
    // params schema 未声明 pageId
    ;(spec.actions as Record<string, unknown>[])[0].params = {
      type: 'object',
      additionalProperties: false,
    }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('BAD_PATH_PLACEHOLDER'))
  })

  test('path 占位符引用已声明 params 字段 → 通过', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].request = {
      method: 'GET',
      pathTemplate: '/v1/pages/{/params/pageId}',
    }
    ;(spec.actions as Record<string, unknown>[])[0].params = {
      type: 'object',
      additionalProperties: false,
      properties: { pageId: { type: 'string' } },
      required: ['pageId'],
    }
    // 不抛即通过
    compileSpec(spec, baseDecision())
  })

  test('path 占位符非 /params/<顶层字段>(嵌套/非 params)→ BAD_PATH_PLACEHOLDER', () => {
    for (const pathTemplate of [
      '/v1/pages/{/params/a/b}', // 嵌套
      '/v1/pages/{/credential/token}', // 越权指向凭据
      '/v1/pages/{pageId}', // 非 pointer
    ]) {
      const spec = baseSpec()
      ;(spec.actions as Record<string, unknown>[])[0].request = { method: 'GET', pathTemplate }
      ;(spec.actions as Record<string, unknown>[])[0].params = {
        type: 'object',
        additionalProperties: false,
        properties: { pageId: { type: 'string' }, a: { type: 'object' } },
      }
      assert.throws(
        () => compileSpec(spec, baseDecision()),
        isCode('BAD_PATH_PLACEHOLDER'),
        pathTemplate,
      )
    }
  })

  test('staticHeaders:合法头搬进 ExecAction.request;保留头 → RESERVED_HEADER', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].request = {
      method: 'GET',
      pathTemplate: '/v1/pages',
      staticHeaders: { 'Notion-Version': '2022-06-28', Accept: 'application/json' },
    }
    const { execContract } = compileSpec(spec, baseDecision())
    assert.deepEqual(execContract.actions[0]!.request.staticHeaders, {
      'Notion-Version': '2022-06-28',
      Accept: 'application/json',
    })

    for (const reserved of ['Authorization', 'Host', 'Content-Type']) {
      const bad = baseSpec()
      ;(bad.actions as Record<string, unknown>[])[0].request = {
        method: 'GET',
        pathTemplate: '/v1/pages',
        staticHeaders: { [reserved]: 'x' },
      }
      assert.throws(() => compileSpec(bad, baseDecision()), isCode('RESERVED_HEADER'), reserved)
    }
  })

  test('identity:probeActionId=已声明 read action + pointer 合法 → 通过并签进 contract', () => {
    const spec = baseSpec()
    spec.identity = { probeActionId: 'get_page', accountKeyPointer: '/id', accountHintPointer: '/name' }
    const { execContract } = compileSpec(spec, baseDecision())
    assert.deepEqual((execContract as Record<string, unknown>).identity, {
      probeActionId: 'get_page',
      accountKeyPointer: '/id',
      accountHintPointer: '/name',
    })
  })

  test('identity:probeActionId 指向不存在的 action → IDENTITY_INVALID', () => {
    const spec = baseSpec()
    spec.identity = { probeActionId: 'nope', accountKeyPointer: '/id' }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('IDENTITY_INVALID'))
  })

  test('identity:probeActionId 指向 write action → IDENTITY_INVALID', () => {
    const spec = baseSpec()
    // 追加一个未签 safe-read-non-get 的 POST(effect=write)。
    ;(spec.actions as Record<string, unknown>[]).push({
      id: 'do_write',
      description: 'a write',
      request: { method: 'POST', pathTemplate: '/v1/write' },
      params: { type: 'object', additionalProperties: false },
      result: { type: 'object', additionalProperties: false },
    })
    spec.identity = { probeActionId: 'do_write', accountKeyPointer: '/id' }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('IDENTITY_INVALID'))
  })

  test('identity:accountKeyPointer 污染段 → IDENTITY_INVALID', () => {
    const spec = baseSpec()
    spec.identity = { probeActionId: 'get_page', accountKeyPointer: '/__proto__' }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('IDENTITY_INVALID'))
  })

  // ─── token-exchange 契约携带(slice⑤ 基础) ──────────────────────────────────
  function tokenExchangeSpec(): Record<string, unknown> {
    return {
      id: 'feishu-like',
      label: 'Feishu-like',
      description: 'tenant token exchange',
      authMode: 'token-exchange',
      auth: {
        exchangeRequest: {
          method: 'POST',
          path: '/open-apis/auth/v3/tenant_access_token/internal',
          encoding: 'json',
          credentialFieldNames: { app_id: 'client_id', app_secret: 'client_secret' },
          staticFields: {},
          grantValue: 'client_credentials',
        },
        tokenResponse: { successPredicate: '/code', providerErrorCodePointer: '/code' },
        tokenOutputs: { accessToken: '/tenant_access_token', expiresIn: '/expire' },
        apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
      },
      originMode: 'fixed-reviewed',
      credentialPipeline: {
        nodes: [
          { id: 'tenant-token', authMode: 'token-exchange', subject: 'app', audience: 'token' },
          {
            id: 'api-cred',
            authMode: 'token-exchange',
            subject: 'app',
            audience: 'api',
            dependsOn: ['tenant-token'],
          },
        ],
      },
      actions: [
        {
          id: 'send_message',
          description: 'send a message',
          request: { method: 'GET', pathTemplate: '/open-apis/im/v1/messages' },
          params: { type: 'object', additionalProperties: false },
          result: { type: 'object', additionalProperties: false },
          usesSlot: 'api-cred',
        },
      ],
    }
  }
  const tokenExchangeDecision = {
    audience: {
      authorizationOrigins: [],
      tokenOrigins: ['https://open.feishu.test:443'],
      apiOrigins: ['https://open.feishu.test:443'],
      unauthenticatedUploadOrigins: [],
    },
    actions: {},
  }

  test('token-exchange:exchangeRequest/tokenResponse 搬进 contract + tokenOutputs 携带', () => {
    const { execContract } = compileSpec(tokenExchangeSpec(), tokenExchangeDecision)
    const c = execContract as Record<string, unknown>
    assert.ok(c.tokenAcquisition, 'tokenAcquisition carried')
    assert.deepEqual((c.tokenAcquisition as Record<string, unknown>).exchangeRequest, {
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      encoding: 'json',
      credentialFieldNames: { app_id: 'client_id', app_secret: 'client_secret' },
      staticFields: {},
      grantValue: 'client_credentials',
    })
    assert.deepEqual(c.tokenOutputs, { accessToken: '/tenant_access_token', expiresIn: '/expire' })
  })

  test('token-exchange:缺 tokenOrigins → AUDIENCE_MISSING', () => {
    const decision = {
      audience: { ...tokenExchangeDecision.audience, tokenOrigins: [] },
      actions: {},
    }
    assert.throws(() => compileSpec(tokenExchangeSpec(), decision), isCode('AUDIENCE_MISSING'))
  })

  test('token-exchange:credentialFieldNames 引用不可注入 source → AUTH_SCHEMA_INVALID', () => {
    const spec = tokenExchangeSpec()
    ;(spec.auth as Record<string, Record<string, Record<string, string>>>).exchangeRequest
      .credentialFieldNames = { grant: 'access_token' } // access_token 非交换输入 source
    assert.throws(() => compileSpec(spec, tokenExchangeDecision), isCode('AUTH_SCHEMA_INVALID'))
  })

  test('credentialPipeline:cacheKey 字段被 schema strict 拒', () => {
    const spec = baseSpec()
    ;(spec.credentialPipeline as Record<string, unknown>).nodes = [
      {
        id: 'api-token',
        authMode: 'static-token',
        subject: 'user',
        audience: 'api',
        cacheKey: 'x',
      },
    ]
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('SPEC_SCHEMA_INVALID'))
  })

  test('credentialPipeline:环 → 拒', () => {
    const spec = baseSpec()
    ;(spec.credentialPipeline as Record<string, unknown>).nodes = [
      {
        id: 'slot-a',
        authMode: 'token-exchange',
        subject: 'app',
        audience: 'token',
        dependsOn: ['slot-b'],
      },
      {
        id: 'slot-b',
        authMode: 'static-token',
        subject: 'user',
        audience: 'api',
        dependsOn: ['slot-a'],
      },
    ]
    ;(spec.actions as Record<string, unknown>[])[0].usesSlot = 'slot-b'
    ;(spec.actions as Record<string, unknown>[])[1].usesSlot = 'slot-b'
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('PIPELINE_CYCLE'))
  })

  test('usesSlot:未知 slot / 非 api audience → 拒', () => {
    const unknown = baseSpec()
    ;(unknown.actions as Record<string, unknown>[])[0].usesSlot = 'ghost'
    assert.throws(() => compileSpec(unknown, baseDecision()), isCode('SLOT_UNKNOWN'))

    const mismatch = baseSpec()
    ;(mismatch.credentialPipeline as Record<string, unknown>).nodes = [
      { id: 'tok', authMode: 'token-exchange', subject: 'app', audience: 'token' },
    ]
    ;(mismatch.actions as Record<string, unknown>[])[0].usesSlot = 'tok'
    ;(mismatch.actions as Record<string, unknown>[])[1].usesSlot = 'tok'
    assert.throws(() => compileSpec(mismatch, baseDecision()), isCode('SLOT_AUDIENCE_MISMATCH'))
  })

  test('originMode ↔ authMode 一致性', () => {
    const spec = baseSpec()
    spec.originMode = 'user-bound-webdav' // 但 authMode=static-token
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('ORIGIN_MODE_MISMATCH'))
  })

  test('fixed-reviewed 缺 audience / 缺 apiOrigin → 拒', () => {
    assert.throws(() => compileSpec(baseSpec(), {}), isCode('AUDIENCE_MISSING'))
    const decision = baseDecision()
    ;(decision.audience as Record<string, unknown>).apiOrigins = []
    assert.throws(() => compileSpec(baseSpec(), decision), isCode('AUDIENCE_MISSING'))
  })

  test('bad origin(非 https / userinfo)→ 拒', () => {
    const decision = baseDecision()
    ;(decision.audience as Record<string, unknown>).apiOrigins = ['http://api.notion.com:80']
    assert.throws(() => compileSpec(baseSpec(), decision), isCode('SECURITY_DECISION_INVALID'))
  })

  test('origin 规范化:补默认端口 443', () => {
    const decision = baseDecision()
    ;(decision.audience as Record<string, unknown>).apiOrigins = ['https://api.notion.com']
    const { execContract } = compileSpec(baseSpec(), decision)
    assert.deepEqual(execContract.credentialAudiencePolicy.apiOrigins, [
      'https://api.notion.com:443',
    ])
  })

  test('builtin 引用 → fail-closed(slice① 无 builtin 层)', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].requestTransform = 'some-transform'
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('BUILTIN_NOT_ALLOWED'))
  })

  test('ExecContract 承载 tokenOutputs(token 模式)', () => {
    const spec = baseSpec()
    spec.authMode = 'token-exchange'
    spec.auth = {
      exchangeRequest: {
        method: 'POST',
        path: '/token',
        encoding: 'json',
        credentialFieldNames: { appid: 'client_id', secret: 'client_secret' },
      },
      // token/expires 指针唯一权威 = tokenOutputs(P1-5②);tokenResponse 只留可选字段。
      tokenResponse: {},
      tokenOutputs: { accessToken: '/access_token', expiresIn: '/expires_in' },
      apiCredentialPlacements: [{ source: 'access_token', placement: 'authorization-bearer' }],
    }
    // api slot 的 authMode 须与 connector authMode 一致(P1-5④)。
    ;(spec.credentialPipeline as Record<string, unknown>).nodes = [
      { id: 'api-token', authMode: 'token-exchange', subject: 'app', audience: 'api' },
    ]
    const decision = baseDecision()
    ;(decision.audience as Record<string, unknown>).tokenOrigins = ['https://api.notion.com:443']
    ;(decision.actions as Record<string, unknown>) = { search: { safeReadNonGet: true } }
    const { execContract } = compileSpec(spec, decision)
    assert.deepEqual(execContract.tokenOutputs, {
      accessToken: '/access_token',
      expiresIn: '/expires_in',
    })
  })

  // ─── 审计整改新增(P0-4 / P1-5 / P1-6) ─────────────────────────────────────

  test('P0-4:params/result 签进 ExecAction', () => {
    const { execContract } = compileSpec(baseSpec(), baseDecision())
    for (const a of execContract.actions) {
      assert.deepEqual(a.params, { type: 'object', additionalProperties: false })
      assert.deepEqual(a.result, { type: 'object', additionalProperties: false })
    }
  })

  test('P0-4:params 非 strict → UNSAFE_SCHEMA', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].params = { type: 'object' } // 缺 additionalProperties:false
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('UNSAFE_SCHEMA'))
  })

  test('P0-4:params 含远程 $ref → UNSAFE_SCHEMA', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[0].params = {
      type: 'object',
      additionalProperties: false,
      properties: { x: { $ref: 'https://evil/schema' } },
    }
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('UNSAFE_SCHEMA'))
  })

  test('P1-5①:重复 action id → DUPLICATE_ACTION_ID', () => {
    const spec = baseSpec()
    ;(spec.actions as Record<string, unknown>[])[1].id = 'get_page' // 与 [0] 撞
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('DUPLICATE_ACTION_ID'))
  })

  test('P1-5①:decision 指向不存在的 action → UNKNOWN_DECISION_ACTION', () => {
    const decision = baseDecision()
    ;(decision.actions as Record<string, unknown>) = { nonexistent: { effect: 'write' } }
    assert.throws(() => compileSpec(baseSpec(), decision), isCode('UNKNOWN_DECISION_ACTION'))
  })

  test('P1-5③:placement auxiliary.X 未在 tokenOutputs.auxiliary → UNKNOWN_AUXILIARY', () => {
    const spec = baseSpec()
    spec.authMode = 'token-exchange'
    spec.auth = {
      exchangeRequest: {
        method: 'POST',
        path: '/token',
        encoding: 'json',
        credentialFieldNames: { appid: 'client_id' },
      },
      tokenResponse: {},
      tokenOutputs: { accessToken: '/access_token' }, // 无 auxiliary
      apiCredentialPlacements: [
        { source: 'auxiliary.openId', placement: 'header', name: 'Open-Id' },
      ],
    }
    ;(spec.credentialPipeline as Record<string, unknown>).nodes = [
      { id: 'api-token', authMode: 'token-exchange', subject: 'app', audience: 'api' },
    ]
    const decision = baseDecision()
    ;(decision.audience as Record<string, unknown>).tokenOrigins = ['https://api.notion.com:443']
    assert.throws(() => compileSpec(spec, decision), isCode('UNKNOWN_AUXILIARY'))
  })

  test('P1-5④:api slot 的 authMode 与 connector authMode 不一致 → SLOT_MODE_MISMATCH', () => {
    const spec = baseSpec() // connector authMode=static-token
    ;(spec.credentialPipeline as Record<string, unknown>).nodes = [
      { id: 'api-token', authMode: 'oauth2-auth-code', subject: 'user', audience: 'api' },
    ]
    assert.throws(() => compileSpec(spec, baseDecision()), isCode('SLOT_MODE_MISMATCH'))
  })

  test('P1-6:bodyTemplate/query 含 __proto__ 等污染键 → POLLUTION_KEY', () => {
    // 真实攻击面 = JSON.parse 生成的自有 "__proto__"/"constructor" 键(对象字面量的
    // {__proto__:…} 只改原型、不产生自有键,故用 JSON.parse 构造)。
    const body = baseSpec()
    ;(body.actions as Record<string, unknown>[])[1].request = {
      method: 'POST',
      pathTemplate: '/v1/search',
      bodyTemplate: { obj: JSON.parse(String.raw`{"__proto__":{"lit":1}}`) },
    }
    assert.throws(() => compileSpec(body, baseDecision()), isCode('POLLUTION_KEY'))

    const q = baseSpec()
    ;(q.actions as Record<string, unknown>[])[0].request = {
      method: 'GET',
      pathTemplate: '/v1/pages',
      query: JSON.parse(String.raw`{"constructor":"/params/x"}`),
    }
    assert.throws(() => compileSpec(q, baseDecision()), isCode('POLLUTION_KEY'))
  })
})
