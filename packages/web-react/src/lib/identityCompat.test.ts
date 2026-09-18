/**
 * msc-config 阶段 B(CFG-19):身份兼容投影的 expectedUserId 必须来自已认证身份(JWT sub),
 * 不能拿投影自身的 userId 回填让校验恒真。
 * 运行:cd packages/web-react; npx vitest run src/lib/identityCompat.test.ts --maxWorkers=1
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { createMemoryAuthSession } from './authSession'
import { authenticatedUserIdFromToken, identityCompatApi } from './identityCompat'

const profile = {
  profileId: 'p1',
  legacyAgentId: 'personal-butler',
  canonicalAgentId: 'butler',
  localPersonaPath: 'agents/personal-butler/CLAUDE.md',
  localSkillStorageId: 'personal-butler',
}
const projectionFor = (userId: string) => ({
  schema: 1,
  userId,
  profiles: [{ profile, readiness: 'ready' }],
})

function jwt(sub: unknown): string {
  const b64 = (v: unknown) =>
    btoa(JSON.stringify(v)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub, exp: 9_999_999_999 })}.sig`
}

function stubAgents(identityCompat: unknown) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ agents: [], identityCompat }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

afterEach(() => vi.restoreAllMocks())

describe('authenticatedUserIdFromToken', () => {
  test('reads a numeric sub from a JWT and rejects everything else', () => {
    expect(authenticatedUserIdFromToken(jwt('3'))).toBe('3')
    expect(authenticatedUserIdFromToken(jwt(3))).toBeUndefined()
    expect(authenticatedUserIdFromToken(jwt('0'))).toBeUndefined()
    expect(authenticatedUserIdFromToken('raw-access-token')).toBeUndefined()
    expect(authenticatedUserIdFromToken('a.b.c')).toBeUndefined()
  })
})

describe('identityCompatApi.getProjection', () => {
  test('accepts a projection owned by the JWT subject', async () => {
    stubAgents(projectionFor('3'))
    const auth = createMemoryAuthSession(() => {}, jwt('3'))
    await expect(identityCompatApi.getProjection(auth)).resolves.toMatchObject({ userId: '3' })
  })

  test('rejects a projection whose userId differs from the JWT subject (no more tautological check)', async () => {
    stubAgents(projectionFor('4'))
    const auth = createMemoryAuthSession(() => {}, jwt('3'))
    await expect(identityCompatApi.getProjection(auth)).rejects.toMatchObject({
      code: 'COMPAT_AUTHORITY_UNAVAILABLE',
    })
  })

  test('an explicit expectedUserId wins over the token', async () => {
    stubAgents(projectionFor('7'))
    const auth = createMemoryAuthSession(() => {}, jwt('3'))
    await expect(identityCompatApi.getProjection(auth, '7')).resolves.toMatchObject({ userId: '7' })
  })

  test('non-JWT tokens fall back to the server-validated projection userId (shape check only)', async () => {
    stubAgents(projectionFor('3'))
    const auth = createMemoryAuthSession(() => {}, 'raw-access-token')
    await expect(identityCompatApi.getProjection(auth)).resolves.toMatchObject({ userId: '3' })
  })

  test('absent identityCompat → null (older server / no registration UI)', async () => {
    stubAgents(undefined)
    const auth = createMemoryAuthSession(() => {}, jwt('3'))
    await expect(identityCompatApi.getProjection(auth)).resolves.toBeNull()
  })
})
