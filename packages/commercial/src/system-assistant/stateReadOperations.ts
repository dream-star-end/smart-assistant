/** Fixed PG authority reads. Session/project owner keys are c:<uid>; account status uses bare uid. */
import { z } from 'zod'
import type { ChatProject, ClientSessionMeta } from '@openclaude/storage'
import type { PgSessionsBackend } from '../db/pgSessionsBackend.js'
import type { V3ContainerStatus } from '../agent-sandbox/v3supervisor.js'
import { SystemOperationRejected, type SystemActor, type SystemOperation } from './operations.js'
export type SystemSessionReadBackend = Readonly<Pick<PgSessionsBackend,
  'getClientSessionCollabParent' | 'getClientSessionWorkspaceMode' | 'listClientSessions' | 'searchClientSessions'
  | 'listChatProjects' | 'listDeletedChatProjects' | 'listProjectAssets'>>
export interface SystemStateReadSources {
  sessions?: SystemSessionReadBackend
  readProject(owner: string, id: string): Promise<ChatProject | null>
  readRuntimeStatus(userId: string): Promise<Pick<V3ContainerStatus, 'state' | 'lastWsActivity'> | null>
}
const sessionId = z.string().regex(/^[A-Za-z0-9_-]{8,50}$/)
const projectId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/)
const empty = z.object({}).strict()
const session = z.object({ sessionId }).strict()
const listing = z.object({ limit: z.number().int().min(1).max(200).default(30), before: z.number().int().positive().safe().optional(), includeArchived: z.boolean().default(false) }).strict()
const search = z.object({ q: z.string().min(1).max(200).refine(s => s.trim().length > 0), limit: z.number().int().min(1).max(50).default(20), includeArchived: z.boolean().default(false), projectId: projectId.nullable().optional(), includeSnippet: z.boolean().default(false) }).strict()
const project = z.object({ projectId, includeInstructions: z.boolean().default(false) }).strict()
const assets = z.object({ projectId: projectId.nullable(), limit: z.number().int().min(1).max(500).default(100) }).strict()
const owner = (actor: SystemActor) => `c:${actor.userId}`
function required<T>(value: T | null | undefined): NonNullable<T> { if (value == null) throw new SystemOperationRejected('UNAVAILABLE'); return value }
function found<T>(value: T | null): T { if (value === null) throw new SystemOperationRejected('NOT_FOUND'); return value }
function projectView(row: ChatProject) {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sortOrder, createdAt: row.createdAt, updatedAt: row.updatedAt,
    sessionCount: row.sessionCount, boardProjectId: row.boardProjectId, archivedAt: row.archivedAt, pinnedAt: row.pinnedAt, template: row.template }
}
function sessionView(row: ClientSessionMeta) {
  return { id: row.id, agentId: row.agentId, title: row.title, pinned: row.pinned, createdAt: row.createdAt, lastAt: row.lastAt, updatedAt: row.updatedAt,
    messageCount: row.messageCount, persistedModelId: row.modelId ?? null, projectId: row.projectId, runState: row.runState, lastOutcome: row.lastOutcome,
    lastErrorCode: row.lastErrorCode, archived: row.archived, unread: row.unread }
}
export function stateReadOperations(deps: { authorize(actor: SystemActor): Promise<void>; sources?: SystemStateReadSources }): SystemOperation[] {
  const sources = () => required(deps.sources)
  const backend = () => required(sources().sessions)
  function op<T extends z.ZodTypeAny>(id: string, title: string, topic: string, schema: T, input: Record<string, unknown>, read: (actor: SystemActor, args: z.infer<T>) => Promise<unknown>): SystemOperation {
    return { id, title, topic, schema, input, version: 1, effect: 'read', executor: 'master', roles: ['user','admin'], authorize: deps.authorize, read: (actor, args) => read(actor, args as z.infer<T>) }
  }
  return [
    op('sessions.model.get', '查看会话保存的模型', 'models', session, { sessionId: 'owned session ID' }, async (actor, args) => {
      const b = backend()
      const row = found(await required(b.getClientSessionCollabParent).call(b, args.sessionId, owner(actor)))
      return { sessionId: row.sessionId, agentId: row.agentId, persistedModelId: row.modelId ?? null }
    }),
    op('sessions.list', '查看本人会话', 'sessions-goals', listing, { limit: 'integer1..200', before: 'optional positive epoch milliseconds', includeArchived: 'boolean; default false' }, async (actor, args) => {
      const b = backend()
      const result = await required(b.listClientSessions).call(b, owner(actor), args)
      return { sessions: result.sessions.map(sessionView), nextCursor: result.nextCursor ?? null }
    }),
    op('sessions.search', '搜索本人会话', 'sessions-goals', search, { q: 'query1..200', limit: 'integer1..50', projectId: 'optional project ID or null', includeArchived: 'boolean', includeSnippet: 'boolean; default false; untrusted excerpt' }, async (actor, args) => {
      const b = backend()
      const { includeSnippet, ...query } = args
      const result = await required(b.searchClientSessions).call(b, owner(actor), query)
      return { results: result.results.map(row => ({ sessionId: row.sessionId, title: row.title, projectId: row.projectId, matchedAt: row.matchedAt, kind: row.kind, unread: row.unread, ...(includeSnippet ? { snippet: row.snippet } : {}) })) }
    }),
    op('projects.list', '查看本人项目', 'projects-files', empty, {}, async actor => {
      const b = backend()
      return { projects: (await required(b.listChatProjects).call(b, owner(actor))).map(projectView) }
    }),
    op('projects.get', '查看本人项目详情', 'projects-files', project, { projectId: 'owned project ID', includeInstructions: 'boolean; default false; untrusted project instructions' }, async (actor, args) => {
      backend() // A PG helper must not run when the configured sessions authority is SQLite.
      const row = found(await sources().readProject(owner(actor), args.projectId))
      return { ...projectView(row), ...(args.includeInstructions ? { instructions: row.instructions } : {}) }
    }),
    op('projects.deleted.list', '查看本人可恢复项目', 'projects-files', empty, {}, async actor => {
      const b = backend()
      return { projects: (await required(b.listDeletedChatProjects).call(b, owner(actor))).map(row => ({ id: row.id, name: row.name, deletedAt: row.deletedAt, sessionCount: row.sessionCount })) }
    }),
    op('sessions.workspace-policy.get', '查看会话工作区策略', 'projects-files', session, { sessionId: 'owned session ID' }, async (actor, args) => {
      const b = backend()
      return { sessionId: args.sessionId, workspaceMode: found(await required(b.getClientSessionWorkspaceMode).call(b, args.sessionId, owner(actor))) }
    }),
    op('project.assets.list', '查看本人项目资产', 'projects-files', assets, { projectId: 'owned project ID or null', limit: 'integer1..500; default100' }, async (actor, args) => {
      const b = backend()
      return { assets: (await required(b.listProjectAssets).call(b, owner(actor), args)).map(row => ({ id: row.id, projectId: row.projectId, source: row.source,
        sessionId: row.sessionId, name: row.name, mime: row.mime, sizeBytes: row.sizeBytes, digest: row.digest, pinned: row.pinned, createdAt: row.createdAt, updatedAt: row.updatedAt, versionCount: row.versionCount ?? 1 })) }
    }),
    op('agent.status.get', '查看本人运行容器状态', 'account-privacy', empty, {}, async actor => {
      const value = await sources().readRuntimeStatus(actor.userId)
      return { scope: 'v5/docker', observed: value ? { state: value.state, lastActivityAt: value.lastWsActivity?.toISOString() ?? null } : null,
        note: value ? '仅表示容器观察状态，不代表聊天服务已就绪。' : '暂时没有可确认的活动容器状态；此读取不会启动容器。' }
    }),
  ]
}
