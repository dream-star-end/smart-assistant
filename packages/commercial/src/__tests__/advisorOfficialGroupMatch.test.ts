/**
 * E7: official group selected for the model must match the bound account's
 * claude_accounts.group_id. Uses the live createCommercialCodexRoute closure
 * and makeDefaultCodexRelayDb SQL. Controlled pool only — no live PG.
 *
 * Run: node --import tsx --test packages/commercial/src/__tests__/advisorOfficialGroupMatch.test.ts
 */
import assert from 'node:assert/strict'
import { after, describe, it } from 'node:test'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { setPoolOverride, resetPool } from '../db/index.js'
import {
  makeDefaultCodexRelayDb,
  makeCodexRelayHandler,
  CODEX_RELAY_PREFIX,
} from '../http/internalCodexRelay.js'
import { selectAdvisorCodexAdmitRoute } from '../billing/advisorCodexAdmitRoute.js'
import { hashSecret } from '../auth/containerIdentity.js'
import {
  listEnabledGroupsForModel,
  hasActiveOfficialOAuthAccountInGroup,
} from '../account-pool/groups.js'
import { Gateway } from '../../../gateway/src/server.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const source = readFileSync(join(ROOT, 'packages/commercial/src/index.ts'), 'utf8')
const start = source.indexOf('  const createCommercialCodexRoute = async')
const end = source.indexOf('  commercialCodexRouteRef.current', start)
assert.ok(start > 0 && end > start, 'createCommercialCodexRoute closure not found')
const actualSelectorJs = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText
const createRoute = new Function(
  'isGrokEngineModel',
  'listEnabledGroupsForModel',
  'hasActiveOfficialOAuthAccountInGroup',
  `${actualSelectorJs};return createCommercialCodexRoute;`,
)(() => false, listEnabledGroupsForModel, hasActiveOfficialOAuthAccountInGroup)

const ORIG_CHANNEL = process.env.OC_RUNTIME_CHANNEL
process.env.OC_RUNTIME_CHANNEL = 'v5'

const accounts = new Map([
  ['53', { id: '53', groupId: '8', provider: 'codex', status: 'active' }],
  ['54', { id: '54', groupId: '9', provider: 'codex', status: 'active' }],
])
const group9 = {
  id: '9',
  label: 'target',
  kind: 'official_oauth',
  provider: 'codex',
  enabled: true,
  priority: 1,
  models: ['gpt-6-astra'],
  created_at: new Date(),
  updated_at: new Date(),
}

const sql: string[] = []
const db = makeDefaultCodexRelayDb()
setPoolOverride({
  query: async (q: string, params: unknown[]) => {
    sql.push(q)
    if (q.includes('FROM account_groups g')) {
      if (q.includes('gm.model_id = $1')) assert.deepEqual(params, ['gpt-6-astra', 'codex'])
      else assert.deepEqual(params, ['9'])
      return { rows: [group9] }
    }
    if (q.includes('SELECT 1 AS ok') && q.includes('FROM claude_accounts')) {
      assert.deepEqual(params, ['codex', 'v5', '9'])
      return {
        rows: [...accounts.values()]
          .filter((a) => a.groupId === '9' && a.status === 'active')
          .map(() => ({ ok: 1 }))
          .slice(0, 1),
      }
    }
    if (q.includes('FROM agent_containers ac')) {
      assert.deepEqual(params, [11, 'v5'])
      const a = accounts.get('53')!
      return {
        rows: [
          {
            codex_account_id: a.id,
            user_id: '42',
            state: 'active',
            provider: a.provider,
            account_status: a.status,
            account_group_id: a.groupId,
          },
        ],
      }
    }
    throw new Error(`unhandled SQL: ${q.slice(0, 180)}`)
  },
  end: async () => {},
} as never)

after(async () => {
  await resetPool()
  if (ORIG_CHANNEL === undefined) delete process.env.OC_RUNTIME_CHANNEL
  else process.env.OC_RUNTIME_CHANNEL = ORIG_CHANNEL
})

async function run(boundGroup: string) {
  accounts.get('53')!.groupId = boundGroup
  const beforeSql = sql.length
  const route = await selectAdvisorCodexAdmitRoute({
    containerId: 11,
    userId: 42n,
    modelId: 'gpt-6-astra',
    createRoute,
    readBinding: (id) => db.readContainerBinding(id),
  })
  let status: number | undefined
  const accountReads: string[] = []
  let upstreamCalls = 0
  if (route.kind === 'official_oauth') {
    const gw = Object.create(Gateway.prototype) as {
      deps: { config: { gateway: { port: number } } }
      _advisorConsultRouteOverride: (
        route: { kind: 'official_oauth'; groupId: string },
        model: string,
      ) => { baseUrl: string } | null
    }
    gw.deps = { config: { gateway: { port: 19111 } } }
    const override = gw._advisorConsultRouteOverride(route, 'gpt-6-astra')
    assert.ok(override)
    const secret = 'e'.repeat(64)
    const ctx = { hostUuid: 'm16-fixture-host', boundIp: '172.30.0.11' }
    const handler = makeCodexRelayHandler({
      identityRepo: {
        findActiveByHostAndBoundIp: async (h: string, ip: string) =>
          h === ctx.hostUuid && ip === ctx.boundIp
            ? {
                id: 11,
                user_id: 42,
                bound_ip: ip,
                host_uuid: h,
                secret_hash: hashSecret(secret),
              }
            : null,
      },
      db,
      resolveDispatcher: async (accountId: bigint) => ({
        accountId,
        proxyId: 4n,
        dispatcher: {} as never,
      }),
      readBoundAccountAccessToken: async (id: bigint) => {
        accountReads.push(String(id))
        return Buffer.from('m16-synthetic-account-token')
      },
      fetchImpl: (async () => {
        upstreamCalls += 1
        return new Response('fixture-only', { status: 200 })
      }) as typeof fetch,
    })
    const server = createServer((req, res) => {
      void handler(req, res, ctx)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}${CODEX_RELAY_PREFIX}/backend-api/codex/responses`, {
        method: 'POST',
        headers: {
          authorization: `Bearer oc-v3.11.${secret}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: 'gpt-6-astra', input: 'fixture' }),
      })
      status = res.status
      await res.text()
    } finally {
      await new Promise<void>((r, j) => server.close((e) => (e ? j(e) : r())))
    }
    assert.equal(override.baseUrl, 'http://127.0.0.1:19111/internal/v3/codex-relay/backend-api/codex')
  }
  const slice = sql.slice(beforeSql)
  return {
    route,
    status,
    accountReads,
    upstreamCalls,
    groupQueried: slice.some((s) => /ca\.group_id/.test(s)),
    readQueries: slice.length,
  }
}

describe('advisor official group matches bound account', () => {
  it('same-group official binding is a real relay positive control', async () => {
    const x = await run('9')
    assert.equal(x.route.kind, 'official_oauth')
    assert.equal(x.status, 200)
    assert.deepEqual(x.accountReads, ['53'])
    assert.equal(x.upstreamCalls, 1)
    assert.equal(x.groupQueried, true)
  })

  it('E7: active binding from a different group refuses before using that account', async () => {
    const x = await run('8')
    assert.equal(x.route.kind, 'unavailable')
    if (x.route.kind === 'unavailable') {
      assert.equal(x.route.reason, 'bound_account_group_mismatch')
    }
    assert.equal(x.upstreamCalls, 0)
    assert.deepEqual(x.accountReads, [])
    assert.equal(x.groupQueried, true)
  })
})
