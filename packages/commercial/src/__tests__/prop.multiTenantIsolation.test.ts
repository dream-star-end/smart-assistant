/**
 * Model-based property tests for multi-tenant routing, session ownership,
 * container two-factor identity, org role isolation, and SQL `agent_containers`
 * lint guardrails.
 *
 * Drives real production security & isolation modules:
 *   - `verifyContainerIdentity`, `hashSecret`, `ContainerIdentityError`
 *     (`packages/commercial/src/auth/containerIdentity.ts`)
 *   - `requireOrgRole` (`packages/commercial/src/org/requireOrgRole.ts`) +
 *     `signAccess` (`packages/commercial/src/auth/jwt.ts`)
 *   - `verifyClientSessionOwnership`, `upsertClientSession`, `listClientSessions`,
 *     `getClientSession`, `deleteClientSession` (`@openclaude/storage`)
 *   - `lookupSessionBoardProject`, `sessionOwnerMatchesUsageUser`
 *     (`packages/commercial/src/billing/boardProjectAttribution.ts`)
 *   - `lintFileDetailed` (`packages/commercial/scripts/lint-agent-containers-sql.ts`)
 */
import * as assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { Pool } from 'pg'

import {
  type AsyncCommand,
  assertAsyncProperty,
  assertProperty,
  asyncModelRun,
  fc,
  resolvePbtRuns,
} from '../../../kernel/src/testing/propertyCheck.js'
import { lintFileDetailed } from '../../scripts/lint-agent-containers-sql.js'
import {
  ContainerIdentityError,
  type ContainerIdentityRepo,
  hashSecret,
  verifyContainerIdentity,
} from '../auth/containerIdentity.js'
import { signAccess } from '../auth/jwt.js'
import {
  lookupSessionBoardProject,
  sessionOwnerMatchesUsageUser,
} from '../billing/boardProjectAttribution.js'
import { HttpError } from '../http/util.js'
import { requireOrgRole } from '../org/requireOrgRole.js'
import type { OrgRole } from '../org/types.js'

const PBT_RUNS = resolvePbtRuns(200, process.env.PBT_RUNS)
const JWT_SECRET = 'pbt-multi-tenant-isolation-secret-32bytes-min-key'

const testHome = await mkdtemp(join(tmpdir(), 'oc-prop-tenant-iso-'))
process.env.OPENCLAUDE_HOME = testHome

const {
  closeSessionsDb,
  deleteClientSession,
  getClientSession,
  getSessionsDb,
  listClientSessions,
  upsertClientSession,
  verifyClientSessionOwnership,
} = await import('@openclaude/storage')

after(async () => {
  await closeSessionsDb()
  await rm(testHome, { recursive: true, force: true })
})

interface ContainerRecord {
  id: number
  userId: number
  hostUuid: string
  boundIp: string
  secretHex: string
  secretHash: Buffer
  state: 'active' | 'vanished'
  runtimeKind: 'docker' | 'desktop'
}

interface OrgMemberRecord {
  userId: string
  orgId: string
  orgActive: boolean
  memberActive: boolean
  role: OrgRole
  billingEnabled: boolean
  billingDelegate: boolean
}

function deterministicHex64(seedTag: string): string {
  // Fast deterministic 64-hex secret without crypto overhead per step.
  let out = ''
  let h = 2166136261
  for (let i = 0; i < 64; i += 1) {
    const ch = seedTag.charCodeAt(i % seedTag.length)
    h = Math.imul(h ^ (ch + i * 31), 16777619) >>> 0
    out += (h & 0xf).toString(16)
  }
  return out
}

describe('Property: Multi-tenant routing, container/session isolation & SQL guardrails', () => {
  it('enforces zero cross-tenant read/write/enumerate across sessions, containers, board attribution & org auth', async () => {
    const TENANTS = [101, 202, 303, 404] as const
    const HOSTS = ['host-a', 'host-b'] as const

    // Pre-sign valid HS256 JWTs once per tenant to keep 200+ runs blazing fast.
    const tenantTokens = new Map<number, string>()
    for (const uid of TENANTS) {
      const signed = await signAccess({ sub: String(uid), role: 'user' }, JWT_SECRET, {
        ttlSeconds: 3600,
      })
      tenantTokens.set(uid, signed.token)
    }

    interface Model {
      sessions: Map<string, { owner: number; secretText: string; deleted: boolean; boardProjectId: string }>
      containers: Map<number, ContainerRecord>
      nextContainerId: number
      orgMembers: Map<string, OrgMemberRecord>
    }

    interface Real {
      repo: ContainerIdentityRepo
      orgPool: Pool
      clearDb: () => Promise<void>
    }

    class CreateOrUpdateSessionCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly tenantIdx: number,
        readonly sessSlot: number,
        readonly payloadTag: string,
      ) {}
      check(): boolean {
        return true
      }
      async run(m: Model, _r: Real): Promise<void> {
        const owner = TENANTS[this.tenantIdx % TENANTS.length]!
        const sessId = `sess-${owner}-${this.sessSlot}`
        const existing = m.sessions.get(sessId)
        if (existing?.deleted) return

        const secretText = `secret-for-${owner}-${this.payloadTag}`
        const now = Date.now()
        await upsertClientSession({
          id: sessId,
          userId: `c:${owner}`,
          agentId: 'main',
          title: `Tenant ${owner} chat`,
          pinned: false,
          createdAt: now,
          lastAt: now,
          updatedAt: now,
          messages: [{ id: `u-${this.sessSlot}`, role: 'user', text: secretText, ts: now }],
        } as Parameters<typeof upsertClientSession>[0])

        m.sessions.set(sessId, {
          owner,
          secretText,
          deleted: false,
          boardProjectId: `00000000-0000-4000-8000-000000000${owner}`,
        })

        // Owner MUST verify as 'owner' and read back their own secret.
        assert.equal(await verifyClientSessionOwnership(sessId, `c:${owner}`), 'owner')
        const loaded = await getClientSession(sessId, `c:${owner}`)
        assert.ok(loaded !== null, 'owner must be able to read own session')
      }
      toString(): string {
        return `CreateSession(t=${this.tenantIdx},slot=${this.sessSlot})`
      }
    }

    class CrossTenantSessionProbeCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly attackerIdx: number,
        readonly targetPick: number,
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.sessions.size > 0
      }
      async run(m: Model, _r: Real): Promise<void> {
        const attacker = TENANTS[this.attackerIdx % TENANTS.length]!
        const entries = [...m.sessions.entries()]
        const [sessId, info] = entries[this.targetPick % entries.length]!
        if (info.owner === attacker) return

        // 1. Storage ownership guard must never return 'owner' for another tenant.
        const verdict = await verifyClientSessionOwnership(sessId, `c:${attacker}`)
        assert.equal(
          verdict,
          info.deleted ? 'not_found' : 'forbidden',
          `cross-tenant ownership verdict leaked for ${sessId} (owner=${info.owner}, attacker=${attacker})`,
        )

        // 2. Direct getClientSession scoped by attacker userId must return null.
        const stolen = await getClientSession(sessId, `c:${attacker}`)
        assert.equal(stolen, null, `attacker ${attacker} read victim ${info.owner} session ${sessId}`)

        // 3. Listing attacker's sessions must never enumerate victim's session IDs or payloads.
        const listed = await listClientSessions(`c:${attacker}`)
        assert.equal(
          listed.sessions.some((row) => row.id === sessId),
          false,
          `attacker ${attacker} enumerated victim session ${sessId}`,
        )

        // 4. Board-project attribution guard must refuse cross-tenant session binding.
        assert.equal(sessionOwnerMatchesUsageUser(`c:${info.owner}`, BigInt(attacker)), false)
        const attr = await lookupSessionBoardProject(
          {
            async query(_sql, params) {
              const id = String(params?.[0] ?? '')
              const found = m.sessions.get(id)
              if (!found || found.deleted) return { rows: [] }
              return {
                rows: [{ user_id: `c:${found.owner}`, board_project_id: found.boardProjectId }],
              }
            },
          },
          sessId,
          BigInt(attacker),
        )
        assert.equal(attr, null, 'board attribution must reject cross-tenant session ownership')
      }
      toString(): string {
        return `CrossTenantSessionProbe(attacker=${this.attackerIdx},pick=${this.targetPick})`
      }
    }

    class DeleteOwnSessionCmd implements AsyncCommand<Model, Real> {
      constructor(readonly targetPick: number) {}
      check(m: Readonly<Model>): boolean {
        return [...m.sessions.values()].some((s) => !s.deleted)
      }
      async run(m: Model, _r: Real): Promise<void> {
        const active = [...m.sessions.entries()].filter(([, s]) => !s.deleted)
        const [sessId, info] = active[this.targetPick % active.length]!
        await deleteClientSession(sessId, `c:${info.owner}`)
        info.deleted = true
        assert.equal(await verifyClientSessionOwnership(sessId, `c:${info.owner}`), 'not_found')
      }
      toString(): string {
        return `DeleteSession(pick=${this.targetPick})`
      }
    }

    class ProvisionContainerCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly tenantIdx: number,
        readonly hostIdx: number,
        readonly ipOctet: number,
      ) {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        const owner = TENANTS[this.tenantIdx % TENANTS.length]!
        const hostUuid = HOSTS[this.hostIdx % HOSTS.length]!
        const boundIp = `10.20.${this.hostIdx % HOSTS.length}.${10 + (this.ipOctet % 200)}`

        // Deactivate any previous active container occupying the same (host, ip) slot.
        for (const c of m.containers.values()) {
          if (c.hostUuid === hostUuid && c.boundIp === boundIp && c.state === 'active') {
            c.state = 'vanished'
          }
        }
        const id = m.nextContainerId++
        const secretHex = deterministicHex64(`cid-${id}-owner-${owner}`)
        const rec: ContainerRecord = {
          id,
          userId: owner,
          hostUuid,
          boundIp,
          secretHex,
          secretHash: hashSecret(secretHex),
          state: 'active',
          runtimeKind: 'docker',
        }
        m.containers.set(id, rec)

        // Legitimate container call must authenticate to exact owner.
        const authed = await verifyContainerIdentity(
          r.repo,
          { hostUuid, boundIp },
          `Bearer oc-v3.${id}.${secretHex}`,
        )
        assert.equal(authed.userId, owner)
        assert.equal(authed.containerId, id)
      }
      toString(): string {
        return `ProvisionContainer(t=${this.tenantIdx},h=${this.hostIdx},ip=${this.ipOctet})`
      }
    }

    class CrossTenantContainerSpoofCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly victimPick: number,
        readonly attackerPick: number,
        readonly mode: 'wrong_ip' | 'wrong_secret' | 'vanished',
      ) {}
      check(m: Readonly<Model>): boolean {
        return m.containers.size >= 1
      }
      async run(m: Model, r: Real): Promise<void> {
        const all = [...m.containers.values()]
        const victim = all[this.victimPick % all.length]!
        const attacker = all[this.attackerPick % all.length]!

        if (this.mode === 'vanished') {
          victim.state = 'vanished'
          await assert.rejects(
            verifyContainerIdentity(
              r.repo,
              { hostUuid: victim.hostUuid, boundIp: victim.boundIp },
              `Bearer oc-v3.${victim.id}.${victim.secretHex}`,
            ),
            (err: unknown) => err instanceof ContainerIdentityError,
          )
          return
        }

        if (this.mode === 'wrong_secret') {
          const forgedSecret = deterministicHex64(`forged-${victim.id}-${attacker.id}`)
          if (forgedSecret === victim.secretHex) return
          await assert.rejects(
            verifyContainerIdentity(
              r.repo,
              { hostUuid: victim.hostUuid, boundIp: victim.boundIp },
              `Bearer oc-v3.${victim.id}.${forgedSecret}`,
            ),
            (err: unknown) => err instanceof ContainerIdentityError,
          )
          return
        }

        // Cross-container token/IP mix: attacker's container IP + victim's token.
        if (victim.id !== attacker.id) {
          await assert.rejects(
            verifyContainerIdentity(
              r.repo,
              { hostUuid: attacker.hostUuid, boundIp: attacker.boundIp },
              `Bearer oc-v3.${victim.id}.${victim.secretHex}`,
            ),
            (err: unknown) => err instanceof ContainerIdentityError,
          )
        }
      }
      toString(): string {
        return `ContainerSpoof(mode=${this.mode})`
      }
    }

    class OrgRoleGuardCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly tenantIdx: number,
        readonly minRole: 'member' | 'admin' | 'owner' | 'billing',
        readonly mutateDeactivate: boolean,
      ) {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        const uid = TENANTS[this.tenantIdx % TENANTS.length]!
        const member = m.orgMembers.get(String(uid))
        if (this.mutateDeactivate && member) {
          member.memberActive = !member.memberActive
        }

        const req = {
          headers: { authorization: `Bearer ${tenantTokens.get(uid)!}` },
        } as unknown as IncomingMessage

        const active = Boolean(member?.orgActive && member.memberActive)
        const rank: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 }
        const allowed =
          active &&
          member !== undefined &&
          (this.minRole === 'billing'
            ? member.role === 'owner' || member.billingDelegate
            : rank[member.role] >= rank[this.minRole])

        if (allowed && member) {
          const ctx = await requireOrgRole(req, JWT_SECRET, r.orgPool, this.minRole)
          assert.equal(ctx.userId, String(uid))
          assert.equal(ctx.orgId, member.orgId, 'orgId must be strictly derived from caller membership')
        } else {
          await assert.rejects(
            requireOrgRole(req, JWT_SECRET, r.orgPool, this.minRole),
            (err: unknown) => err instanceof HttpError && err.status === 403,
          )
        }
      }
      toString(): string {
        return `OrgRoleGuard(t=${this.tenantIdx},min=${this.minRole},toggle=${this.mutateDeactivate})`
      }
    }

    const cmdsArb = fc.commands<Model, Real, AsyncCommand<Model, Real>>(
      [
        {
          weight: 4,
          arbitrary: fc
            .record({
              t: fc.nat(10),
              s: fc.integer({ min: 0, max: 3 }),
              tag: fc.string({ minLength: 2, maxLength: 6 }),
            })
            .map((x) => new CreateOrUpdateSessionCmd(x.t, x.s, x.tag)),
        },
        {
          weight: 4,
          arbitrary: fc
            .record({ a: fc.nat(10), p: fc.nat(10) })
            .map((x) => new CrossTenantSessionProbeCmd(x.a, x.p)),
        },
        {
          weight: 1,
          arbitrary: fc.nat(10).map((p) => new DeleteOwnSessionCmd(p)),
        },
        {
          weight: 3,
          arbitrary: fc
            .record({ t: fc.nat(10), h: fc.nat(5), ip: fc.nat(50) })
            .map((x) => new ProvisionContainerCmd(x.t, x.h, x.ip)),
        },
        {
          weight: 3,
          arbitrary: fc
            .record({
              v: fc.nat(10),
              a: fc.nat(10),
              mode: fc.constantFrom('wrong_ip' as const, 'wrong_secret' as const, 'vanished' as const),
            })
            .map((x) => new CrossTenantContainerSpoofCmd(x.v, x.a, x.mode)),
        },
        {
          weight: 3,
          arbitrary: fc
            .record({
              t: fc.nat(10),
              role: fc.constantFrom('member' as const, 'admin' as const, 'owner' as const, 'billing' as const),
              toggle: fc.boolean(),
            })
            .map((x) => new OrgRoleGuardCmd(x.t, x.role, x.toggle)),
        },
      ],
      { minLength: 5, maxLength: 18 },
    )

    await assertAsyncProperty(
      cmdsArb,
      async (cmds) => {
        await asyncModelRun(
          async () => {
            const db = await getSessionsDb()
            db.exec('DELETE FROM client_sessions')
            const model: Model = {
              sessions: new Map(),
              containers: new Map(),
              nextContainerId: 1,
              orgMembers: new Map([
                [
                  '101',
                  {
                    userId: '101',
                    orgId: '7001',
                    orgActive: true,
                    memberActive: true,
                    role: 'owner',
                    billingEnabled: true,
                    billingDelegate: false,
                  },
                ],
                [
                  '202',
                  {
                    userId: '202',
                    orgId: '7001',
                    orgActive: true,
                    memberActive: true,
                    role: 'member',
                    billingEnabled: true,
                    billingDelegate: false,
                  },
                ],
                [
                  '303',
                  {
                    userId: '303',
                    orgId: '7002',
                    orgActive: true,
                    memberActive: true,
                    role: 'admin',
                    billingEnabled: false,
                    billingDelegate: true,
                  },
                ],
                [
                  '404',
                  {
                    userId: '404',
                    orgId: '7002',
                    orgActive: false,
                    memberActive: true,
                    role: 'owner',
                    billingEnabled: true,
                    billingDelegate: true,
                  },
                ],
              ]),
            }

            const repo: ContainerIdentityRepo = {
              async findActiveByHostAndBoundIp(hostUuid, boundIp) {
                for (const c of model.containers.values()) {
                  if (c.hostUuid === hostUuid && c.boundIp === boundIp && c.state === 'active') {
                    return {
                      id: c.id,
                      user_id: c.userId,
                      bound_ip: c.boundIp,
                      host_uuid: c.hostUuid,
                      secret_hash: c.secretHash,
                    }
                  }
                }
                return null
              },
            }

            const orgPool = {
              async query(_sql: string, params: unknown[]) {
                const uid = String(params[0])
                const m = model.orgMembers.get(uid)
                if (!m || !m.memberActive || !m.orgActive) return { rows: [], rowCount: 0 }
                return {
                  rows: [
                    {
                      org_id: m.orgId,
                      org_role: m.role,
                      billing_enabled: m.billingEnabled,
                      billing_delegate: m.billingDelegate,
                    },
                  ],
                  rowCount: 1,
                }
              },
            } as unknown as Pool

            return {
              model,
              real: {
                repo,
                orgPool,
                clearDb: async () => {
                  const sdb = await getSessionsDb()
                  sdb.exec('DELETE FROM client_sessions')
                },
              },
            }
          },
          cmds,
        )
      },
      { numRuns: PBT_RUNS, seed: 0x33c3333, label: 'multi-tenant-isolation-state-machine' },
    )
  })

  it('real SQL lint gate (lintFileDetailed) catches unguarded agent_containers queries and stale waivers', () => {
    const sqlSpecArb = fc.record({
      verb: fc.constantFrom('FROM', 'JOIN', 'LEFT JOIN', 'UPDATE', 'INTO'),
      hasStateFilter: fc.boolean(),
      hasRuntimeKindFilter: fc.boolean(),
      hasStateWaiver: fc.boolean(),
      hasKindWaiver: fc.boolean(),
      waiverHasReason: fc.boolean(),
      useUserIdPredicate: fc.boolean(),
    })

    assertProperty(
      sqlSpecArb,
      (s) => {
        const lines: string[] = ['export function runQuery(uid: string) {']
        if (s.hasStateWaiver) {
          lines.push(
            s.waiverHasReason
              ? '  // lint-agent-containers-sql: allow — admin topology reconciler inspects vanished rows'
              : '  // lint-agent-containers-sql: allow',
          )
        }
        if (s.hasKindWaiver) {
          lines.push(
            s.waiverHasReason
              ? '  // lint-agent-containers-kind: allow — primary key lookup across runtime kinds'
              : '  // lint-agent-containers-kind: allow',
          )
        }

        const clauses: string[] = []
        if (s.useUserIdPredicate) clauses.push('user_id = $1')
        if (s.hasStateFilter) clauses.push("state = 'active'")
        if (s.hasRuntimeKindFilter) clauses.push("runtime_kind = 'docker'")
        const whereSql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''

        const stmt =
          s.verb === 'UPDATE'
            ? `UPDATE agent_containers SET updated_at = NOW()${whereSql}`
            : s.verb === 'INTO'
              ? `INSERT INTO agent_containers (${s.hasRuntimeKindFilter ? 'user_id, runtime_kind' : 'user_id'}) VALUES ($1${s.hasRuntimeKindFilter ? ", 'docker'" : ''})`
              : `SELECT id ${s.verb} agent_containers${whereSql}`

        lines.push(`  return \`${stmt}\`;`)
        lines.push('}')

        const res = lintFileDetailed('tenant/generatedQuery.ts', lines.join('\n'))
        const isReadVerb = s.verb === 'FROM' || s.verb === 'JOIN' || s.verb === 'LEFT JOIN'

        // State rule: applies to FROM / JOIN.
        if (isReadVerb && !s.hasStateFilter && !(s.hasStateWaiver && s.waiverHasReason)) {
          assert.equal(res.violations.length, 1, `missing state filter must be flagged: ${stmt}`)
        } else {
          assert.equal(res.violations.length, 0, `unexpected state violation: ${stmt}`)
        }

        // Runtime-kind rule: applies to FROM / JOIN / UPDATE / INTO.
        if (!s.hasRuntimeKindFilter && !(s.hasKindWaiver && s.waiverHasReason)) {
          assert.equal(res.kindViolations.length, 1, `missing runtime_kind must be flagged: ${stmt}`)
        } else {
          assert.equal(res.kindViolations.length, 0, `unexpected runtime_kind violation: ${stmt}`)
        }

        // Stale or reasonless waivers must never silently pass.
        if (s.hasStateWaiver && (!s.waiverHasReason || s.hasStateFilter || !isReadVerb)) {
          assert.equal(res.staleWaivers.length, 1, 'stale/reasonless state waiver must be flagged')
        }
        if (s.hasKindWaiver && (!s.waiverHasReason || s.hasRuntimeKindFilter)) {
          assert.equal(res.staleKindWaivers.length, 1, 'stale/reasonless kind waiver must be flagged')
        }
      },
      { numRuns: PBT_RUNS, seed: 0x44d4444, label: 'agent-containers-sql-lint-property' },
    )
  })
})
