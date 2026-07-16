import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { PluginBlueprintError, compilePluginBlueprint } from '../marketplace/pluginBlueprint.js'
import { prepareConnectorPublish } from '../marketplace/publishConnectorPipeline.js'

function action(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'whoami',
    description: '读取当前账号',
    method: 'GET',
    path: '/v1/me',
    params: { type: 'object', properties: {}, additionalProperties: false },
    result: {
      type: 'object',
      properties: { id: { type: 'string' }, name: { type: 'string' } },
      additionalProperties: false,
    },
    ...overrides,
  }
}

function blueprint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 'plugin-blueprint-v1',
    slug: 'compact-api',
    name: 'Compact API',
    description: 'Agent authored compact Plugin',
    category: 'daily-tools',
    useCases: ['读取外部服务账号和条目'],
    apiOrigin: 'https://api.example.com',
    auth: { mode: 'static-token' },
    identity: {
      actionId: 'whoami',
      accountKeyPointer: '/id',
      accountHintPointer: '/name',
    },
    actions: [action()],
    ...overrides,
  }
}

describe('agent Plugin blueprint compiler', () => {
  test('静态令牌 blueprint 确定性补齐安全样板、路径/query/body 引用并走权威编译', () => {
    const input = blueprint({
      actions: [
        action(),
        action({
          id: 'create_item',
          description: '创建条目',
          method: 'POST',
          path: '/v1/spaces/{spaceId}/items',
          query: { dry_run: 'dryRun' },
          body: { title: '$title', enabled: true, literal: 'hello' },
          params: {
            type: 'object',
            properties: {
              spaceId: { type: 'string' },
              dryRun: { type: 'boolean' },
              title: { type: 'string' },
            },
            required: ['spaceId', 'title'],
            additionalProperties: false,
          },
          result: {
            type: 'object',
            properties: { id: { type: 'string' } },
            additionalProperties: false,
          },
        }),
      ],
    })
    const first = compilePluginBlueprint(input)
    const second = compilePluginBlueprint(structuredClone(input))
    assert.deepEqual(first, second)
    const spec = first.spec as Record<string, unknown>
    assert.equal(spec.authMode, 'static-token')
    assert.deepEqual(spec.credentialPipeline, {
      nodes: [{ id: 'api-token', authMode: 'static-token', subject: 'user', audience: 'api' }],
    })
    const actions = spec.actions as Array<Record<string, unknown>>
    assert.deepEqual(actions[1]!.request, {
      method: 'POST',
      pathTemplate: '/v1/spaces/{/params/spaceId}/items',
      query: { dry_run: '/params/dryRun' },
      bodyTemplate: {
        obj: {
          title: { ref: '/params/title' },
          enabled: { lit: true },
          literal: { lit: 'hello' },
        },
      },
    })
    assert.deepEqual(first.securityDecision, {
      audience: {
        authorizationOrigins: [],
        tokenOrigins: [],
        apiOrigins: ['https://api.example.com:443'],
        unauthenticatedUploadOrigins: [],
      },
      actions: { whoami: { effect: 'read' }, create_item: { effect: 'write' } },
    })
    const prepared = prepareConnectorPublish(first)
    assert.equal(prepared.ok, true, prepared.ok ? undefined : prepared.message)
  })

  test('token-exchange 与 OAuth BYOA 只声明必要网络信息，自动派生受众和凭据 DAG', () => {
    const exchange = compilePluginBlueprint(
      blueprint({
        slug: 'exchange-api',
        auth: {
          mode: 'token-exchange',
          tokenOrigin: 'https://auth.example.com',
          exchangePath: '/oauth/token',
          credentialFields: { app_id: 'client_id', app_secret: 'client_secret' },
          accessTokenPointer: '/token',
          expiresInPointer: '/expires',
        },
      }),
    )
    const exchangePrepared = prepareConnectorPublish(exchange)
    assert.equal(
      exchangePrepared.ok,
      true,
      exchangePrepared.ok ? undefined : exchangePrepared.message,
    )
    if (exchangePrepared.ok) {
      assert.equal(exchangePrepared.permissionSummary.authMode, 'token-exchange')
      assert.deepEqual(exchangePrepared.permissionSummary.origins.tokenOrigins, [
        'https://auth.example.com:443',
      ])
      assert.deepEqual(exchangePrepared.permissionSummary.requiredCredentialSources, [
        'client_id',
        'client_secret',
      ])
    }

    const oauth = compilePluginBlueprint(
      blueprint({
        slug: 'oauth-api',
        auth: {
          mode: 'oauth2-auth-code',
          authorizeEndpoint: 'https://login.example.com/oauth/authorize',
          tokenEndpoint: 'https://login.example.com/oauth/token',
          scopes: ['profile.read'],
        },
      }),
    )
    const oauthPrepared = prepareConnectorPublish(oauth)
    assert.equal(oauthPrepared.ok, true, oauthPrepared.ok ? undefined : oauthPrepared.message)
    if (oauthPrepared.ok) {
      assert.equal(oauthPrepared.permissionSummary.authMode, 'oauth2-auth-code')
      assert.equal(oauthPrepared.permissionSummary.clientProvisioning, 'byoa')
      assert.deepEqual(oauthPrepared.permissionSummary.origins.authorizationOrigins, [
        'https://login.example.com:443',
      ])
      assert.deepEqual(oauthPrepared.permissionSummary.origins.tokenOrigins, [
        'https://login.example.com:443',
      ])
    }
  })

  test('拒绝未知字段、未声明参数引用和非固定 origin；不接受任何凭据值字段', () => {
    for (const bad of [
      blueprint({ token: 'secret' }),
      blueprint({ apiOrigin: 'http://127.0.0.1' }),
      blueprint({ actions: [action({ path: '/v1/{missing}' })] }),
      blueprint({
        auth: { mode: 'static-token', placement: { type: 'header', name: 'Authorization' } },
      }),
    ]) {
      assert.throws(
        () => {
          const compiled = compilePluginBlueprint(bad)
          const prepared = prepareConnectorPublish(compiled)
          if (!prepared.ok) throw new PluginBlueprintError(prepared.message)
        },
        (error: unknown) => error instanceof PluginBlueprintError,
      )
    }
  })
})
