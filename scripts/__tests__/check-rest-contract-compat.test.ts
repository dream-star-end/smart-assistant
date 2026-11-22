import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { Type } from '@sinclair/typebox'

import {
  type HttpRouteContractDef,
  type RestContractSnapshot,
  serializeRestContractSnapshot,
} from '../../packages/protocol/src/httpContracts.js'
import {
  checkRestContractCompat,
  diffRestContractSnapshots,
  formatContractBreak,
  formatSnapshotJson,
} from '../check-rest-contract-compat.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

function makeSnapshot(routes: Record<string, HttpRouteContractDef>) {
  return serializeRestContractSnapshot(routes)
}

function cloneSnapshot(snap: RestContractSnapshot): RestContractSnapshot {
  return JSON.parse(JSON.stringify(snap)) as RestContractSnapshot
}

const BASE_ROUTE: HttpRouteContractDef = {
  domain: 'sessions',
  method: 'POST',
  path: '/api/sessions/demo',
  request: Type.Object({
    title: Type.String(),
    mode: Type.Optional(Type.Union([Type.Literal('fast'), Type.Literal('deep')])),
  }),
  response: Type.Object({
    id: Type.String(),
    status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
    subtitle: Type.Union([Type.String(), Type.Null()]),
    items: Type.Array(
      Type.Object({
        key: Type.String(),
        count: Type.Number(),
      }),
    ),
  }),
}

describe('check-rest-contract-compat: breaking changes (red)', () => {
  test('blocks deleting a response field (top-level and nested array item)', () => {
    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({
      'POST /api/sessions/demo': {
        ...BASE_ROUTE,
        response: Type.Object({
          id: Type.String(),
          status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
          // removed `subtitle`
          items: Type.Array(
            Type.Object({
              key: Type.String(),
              // removed `count`
            }),
          ),
        }),
      },
    })

    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(
      breaks.map((b) => [b.rule, b.path]),
      [
        ['REST-CONTRACT-RESPONSE-FIELD-REMOVED', 'response.items[].count'],
        ['REST-CONTRACT-RESPONSE-FIELD-REMOVED', 'response.subtitle'],
      ],
    )
    assert.match(formatContractBreak(breaks[0]!), /\[GATE-ERROR\] REST-CONTRACT-RESPONSE-FIELD-REMOVED/)
  })

  test('blocks changing or narrowing response field types', () => {
    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({
      'POST /api/sessions/demo': {
        ...BASE_ROUTE,
        response: Type.Object({
          id: Type.Number(), // changed string -> number
          status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
          subtitle: Type.String(), // narrowed string | null -> string
          items: Type.Array(
            Type.Object({
              key: Type.String(),
              count: Type.Integer(), // narrowed number -> integer
            }),
          ),
        }),
      },
    })

    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(
      breaks.map((b) => [b.rule, b.path]),
      [
        ['REST-CONTRACT-TYPE-CHANGED', 'response.id'],
        ['REST-CONTRACT-TYPE-NARROWED', 'response.items[].count'],
        ['REST-CONTRACT-TYPE-NARROWED', 'response.subtitle'],
      ],
    )
  })

  test('blocks adding a required request field or promoting optional request field to required', () => {
    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({
      'POST /api/sessions/demo': {
        ...BASE_ROUTE,
        request: Type.Object({
          title: Type.String(),
          mode: Type.Union([Type.Literal('fast'), Type.Literal('deep')]), // was optional, now required
          tenantId: Type.String(), // newly added REQUIRED request field
        }),
      },
    })

    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(
      breaks.map((b) => [b.rule, b.path]),
      [
        ['REST-CONTRACT-REQUIRED-REQUEST-FIELD-ADDED', 'request.tenantId'],
        ['REST-CONTRACT-REQUEST-FIELD-MADE-REQUIRED', 'request.mode'],
      ],
    )
  })

  test('blocks deleting an existing enum value in response or request', () => {
    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({
      'POST /api/sessions/demo': {
        ...BASE_ROUTE,
        request: Type.Object({
          title: Type.String(),
          mode: Type.Optional(Type.Union([Type.Literal('fast')])), // dropped 'deep'
        }),
        response: Type.Object({
          id: Type.String(),
          status: Type.Union([Type.Literal('active')]), // dropped 'archived'
          subtitle: Type.Union([Type.String(), Type.Null()]),
          items: Type.Array(
            Type.Object({
              key: Type.String(),
              count: Type.Number(),
            }),
          ),
        }),
      },
    })

    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(
      breaks.map((b) => [b.rule, b.path]),
      [
        ['REST-CONTRACT-ENUM-VALUE-REMOVED', 'response.status'],
        ['REST-CONTRACT-ENUM-VALUE-REMOVED', 'request.mode'],
      ],
    )
  })

  test('blocks deleting an existing route contract', () => {
    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({})
    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(
      breaks.map((b) => [b.rule, b.route]),
      [['REST-CONTRACT-ROUTE-REMOVED', 'POST /api/sessions/demo']],
    )
  })

  test('blocks removing entire request/query section and tightening input bounds on real snapshot (Blocker 5)', () => {
    const realBase = serializeRestContractSnapshot()

    // 1. Removing the entire `request` block on POST /api/me/pending-decisions/:id/resolve
    const droppedRequest = cloneSnapshot(realBase)
    droppedRequest.routes['POST /api/me/pending-decisions/:id/resolve']!.request = undefined
    const rDropped = diffRestContractSnapshots(realBase, droppedRequest)
    assert.deepEqual(
      rDropped.map((b) => [b.rule, b.route, b.path]),
      [['REST-CONTRACT-SECTION-REMOVED', 'POST /api/me/pending-decisions/:id/resolve', 'request']],
    )

    // 2. Tightening query `limit.minimum` 1 -> 2 on GET /api/sessions/list
    const tightenedLimit = cloneSnapshot(realBase)
    const listQueryProps = tightenedLimit.routes['GET /api/sessions/list']!.query!
      .properties as Record<string, Record<string, unknown>>
    listQueryProps.limit!.minimum = 2
    const rTight = diffRestContractSnapshots(realBase, tightenedLimit)
    assert.deepEqual(
      rTight.map((b) => [b.rule, b.route, b.path]),
      [['REST-CONTRACT-CONSTRAINT-TIGHTENED', 'GET /api/sessions/list', 'query.limit']],
    )

    // 3. Relaxing response `minLength` on GET /api/subscription/me balance.wallet (1 -> removed)
    const relaxedResp = cloneSnapshot(realBase)
    const dataProps = (
      relaxedResp.routes['GET /api/subscription/me']!.response.properties as Record<
        string,
        Record<string, unknown>
      >
    ).data!.properties as Record<string, Record<string, unknown>>
    const balanceProps = dataProps.balance!.properties as Record<string, Record<string, unknown>>
    balanceProps.wallet!.minLength = undefined
    const rRelaxed = diffRestContractSnapshots(realBase, relaxedResp)
    assert.deepEqual(
      rRelaxed.map((b) => [b.rule, b.route, b.path]),
      [['REST-CONTRACT-CONSTRAINT-RELAXED', 'GET /api/subscription/me', 'response.data.balance.wallet']],
    )

    // 4. Collapsing PUT /api/sessions/:id response union to a plain single object (realistic TypeBox serialization of PutSessionAppliedResponseSchema only)
    const droppedBranch = cloneSnapshot(realBase)
    const putAnyOf = droppedBranch.routes['PUT /api/sessions/:id']!.response.anyOf as Record<
      string,
      unknown
    >[]
    droppedBranch.routes['PUT /api/sessions/:id']!.response = putAnyOf[0]!
    const rBranch = diffRestContractSnapshots(realBase, droppedBranch)
    assert.deepEqual(
      rBranch.map((b) => [b.rule, b.route]),
      [['REST-CONTRACT-UNION-BRANCH-REMOVED', 'PUT /api/sessions/:id']],
    )
  })

  test('detects snapshot file drift vs live httpContracts export', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rest-compat-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const snapRel = 'snap.json'
    writeFileSync(path.join(dir, snapRel), '{"schema":1,"domains":[],"routes":{}}\n')

    const res = checkRestContractCompat({
      root: dir,
      snapshotRel: snapRel,
      liveSnapshot: makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE }),
    })
    assert.equal(res.snapshotSynced, false)
    assert.deepEqual(
      res.breaks.map((b) => b.rule),
      ['REST-CONTRACT-SNAPSHOT-DRIFT'],
    )
  })
})

describe('check-rest-contract-compat: additive evolution (green)', () => {
  test('allows adding optional response fields, optional request fields, and new routes (including on real snapshot)', () => {
    const realBase = serializeRestContractSnapshot()
    const realEvolved = cloneSnapshot(realBase)
    const listRespProps = realEvolved.routes['GET /api/sessions/list']!.response
      .properties as Record<string, unknown>
    listRespProps.serverTime = { type: 'number' }
    const listQueryProps = realEvolved.routes['GET /api/sessions/list']!.query!
      .properties as Record<string, unknown>
    listQueryProps.projectId = { type: 'string' }
    assert.deepEqual(diffRestContractSnapshots(realBase, realEvolved), [])

    const base = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    const curr = makeSnapshot({
      'POST /api/sessions/demo': {
        ...BASE_ROUTE,
        request: Type.Object({
          title: Type.String(),
          mode: Type.Optional(
            Type.Union([Type.Literal('fast'), Type.Literal('deep'), Type.Literal('auto')]),
          ),
          traceTag: Type.Optional(Type.String()), // new optional request field
        }),
        response: Type.Object({
          id: Type.String(),
          status: Type.Union([Type.Literal('active'), Type.Literal('archived')]),
          subtitle: Type.Union([Type.String(), Type.Null()]),
          items: Type.Array(
            Type.Object({
              key: Type.String(),
              count: Type.Number(),
              badge: Type.Optional(Type.String()), // new optional nested response field
            }),
          ),
          extraLabel: Type.Optional(Type.String()), // new optional top-level response field
        }),
      },
      'GET /api/sessions/extra': {
        domain: 'sessions',
        method: 'GET',
        path: '/api/sessions/extra',
        response: Type.Object({ ok: Type.Boolean() }),
      },
    })

    const breaks = diffRestContractSnapshots(base, curr)
    assert.deepEqual(breaks, [])
  })

  test('passes when snapshot file matches live export', (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rest-compat-ok-'))
    t.after(() => rmSync(dir, { recursive: true, force: true }))
    const live = makeSnapshot({ 'POST /api/sessions/demo': BASE_ROUTE })
    writeFileSync(path.join(dir, 'snap.json'), formatSnapshotJson(live))

    const res = checkRestContractCompat({
      root: dir,
      snapshotRel: 'snap.json',
      liveSnapshot: live,
    })
    assert.equal(res.snapshotSynced, true)
    assert.deepEqual(res.breaks, [])
  })

  test('repo rest-contract-snapshot.json is in sync with live httpContracts.ts', () => {
    const res = checkRestContractCompat({ root: ROOT })
    assert.equal(res.snapshotSynced, true)
    assert.deepEqual(res.breaks, [])
    assert.ok(res.routeCount >= 5)
  })
})
