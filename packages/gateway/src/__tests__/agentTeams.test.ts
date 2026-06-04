import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { normalizeAgentTeamInput } from '../agentTeams.js'

const agents = [
  { id: 'main' },
  { id: 'researcher' },
  { id: 'reviewer' },
]

describe('agent team validation', () => {
  it('normalizes a valid team and strips control characters from display fields', () => {
    const team = normalizeAgentTeamInput(
      {
        id: 'dev_team',
        name: '  研发\n小队  ',
        description: '代码\t协作',
        leaderAgentId: 'main',
        leaderRole: ' 科研\n负责人 ',
        leaderPrompt: '先拆解问题。\n\n\n再分派任务。',
        members: [
          {
            agentId: 'researcher',
            role: '调研\n员',
            responsibility: '找资料\r\n列出处',
            rolePrompt: '区分事实\r\n假设和争议',
          },
          { agentId: 'reviewer', role: '审阅', responsibility: '检查风险' },
        ],
        policy: { maxParallel: 3, requireReview: true, reviewAgentId: 'reviewer' },
      },
      agents,
      [],
    )

    assert.equal(team.id, 'dev_team')
    assert.equal(team.name, '研发 小队')
    assert.equal(team.description, '代码 协作')
    assert.equal(team.leaderAgentId, 'main')
    assert.equal(team.leaderRole, '科研 负责人')
    assert.equal(team.leaderPrompt, '先拆解问题。\n\n再分派任务。')
    assert.deepEqual(team.members.map((m: { agentId: string }) => m.agentId), [
      'researcher',
      'reviewer',
    ])
    assert.equal(team.members[0]!.role, '调研 员')
    assert.equal(team.members[0]!.responsibility, '找资料 列出处')
    assert.equal(team.members[0]!.rolePrompt, '区分事实\n假设和争议')
    assert.equal(team.policy?.maxParallel, 3)
    assert.equal(team.policy?.requireReview, true)
    assert.equal(team.policy?.reviewAgentId, 'reviewer')
    assert.match(team.updatedAt!, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('rejects unknown leader, unknown member, duplicate members and bad policy bounds', () => {
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          { id: 'x', name: 'X', leaderAgentId: 'missing', members: [{ agentId: 'main' }] },
          agents,
          [],
        ),
      /leader agent "missing" not found/,
    )
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          { id: 'x', name: 'X', leaderAgentId: 'main', members: [{ agentId: 'missing' }] },
          agents,
          [],
        ),
      /member agent "missing" not found/,
    )
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          {
            id: 'x',
            name: 'X',
            leaderAgentId: 'main',
            members: [{ agentId: 'reviewer' }, { agentId: 'reviewer' }],
          },
          agents,
          [],
        ),
      /duplicate member "reviewer"/,
    )
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          {
            id: 'x',
            name: 'X',
            leaderAgentId: 'main',
            members: [{ agentId: 'reviewer' }],
            policy: { maxParallel: 6 },
          },
          agents,
          [],
        ),
      /maxParallel/,
    )
  })

  it('enforces ids, duplicate team ids and the per-user team cap', () => {
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          { id: 'bad.id', name: 'X', leaderAgentId: 'main', members: [{ agentId: 'reviewer' }] },
          agents,
          [],
        ),
      /invalid team id/,
    )
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          { id: 'same', name: 'X', leaderAgentId: 'main', members: [{ agentId: 'reviewer' }] },
          agents,
          [{ id: 'same', name: 'Same', leaderAgentId: 'main', members: [{ agentId: 'reviewer' }] }],
        ),
      /team already exists/,
    )
    assert.throws(
      () =>
        normalizeAgentTeamInput(
          { id: 'extra', name: 'X', leaderAgentId: 'main', members: [{ agentId: 'reviewer' }] },
          agents,
          Array.from({ length: 16 }, (_, i) => ({
            id: `t${i}`,
            name: `T${i}`,
            leaderAgentId: 'main',
            members: [{ agentId: 'reviewer' }],
          })),
        ),
      /too many teams/,
    )
  })
})
