import { chmodSync, existsSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { paths } from '@openclaude/storage'
import { issueDelegateContextToken } from '../delegateContext.js'
import { resolveMcpMemoryEntry } from '../mcpMemoryEntry.js'

export const ZCODE_MEMORY_MCP_TOOLS = [
  'skill_search',
  'skill_list',
  'skill_view',
  'skill_save',
  'skill_delete',
  'create_reminder',
  'list_reminders',
  'update_reminder',
  'delete_reminder',
  'send_to_agent',
  'delegate_task',
  'delegate_tasks',
  'request_review',
  'task_create',
  'task_update',
  'task_comment',
  'task_list',
  'task_get',
] as const

const CONTEXT_PREFIX = join(tmpdir(), 'oc-zcode-context-')
const HOT_HOOK_COLLECTOR = '/run/oc/platform/current/bin/oc-zcode-hook'
const MAX_REASONING_PART_CHARS = 64 * 1024
const require = createRequire(import.meta.url)

export interface ZcodePlatformArtifacts {
  contextDir: string
  platformConfigFile: string | null
  hookJournalFile: string | null
  databaseFile: string
  advertisedMcpTools: string[]
}

export interface CreateZcodePlatformArtifactsInput {
  agentId: string
  sessionKey: string
  gatewayPort: number
  gatewayToken: string
  delegationDepth: number
  claudeCodePath?: string
  skillEvalMode?: boolean
  skillEvalExclude?: string
  skillEvalDraft?: { name: string; dir: string }
  skillTrainRunId?: string
}

function writePrivate(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 })
  chmodSync(path, 0o600)
}

function trustedRootOwnedFile(path: string): boolean {
  try {
    const st = lstatSync(path)
    if (!st.isFile() || st.isSymbolicLink() || st.uid !== 0 || (st.mode & 0o022) !== 0) return false
    return true
  } catch {
    return false
  }
}

function resolveHookCollector(): string | null {
  const override = process.env.OC_ZCODE_HOOK_COLLECTOR_BIN?.trim()
  if (override) {
    if (process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK === '1' && existsSync(override))
      return override
    return trustedRootOwnedFile(override) ? override : null
  }
  return trustedRootOwnedFile(HOT_HOOK_COLLECTOR) ? HOT_HOOK_COLLECTOR : null
}

function durableDatabasePath(openclaudeHome: string): string {
  return join(openclaudeHome, 'zcode-cli', 'cli', 'db', 'db.sqlite')
}

export function createZcodePlatformArtifacts(
  input: CreateZcodePlatformArtifactsInput,
): ZcodePlatformArtifacts {
  const contextDir = mkdtempSync(CONTEXT_PREFIX)
  chmodSync(contextDir, 0o700)
  try {
    const openclaudeHome = process.env.OPENCLAUDE_HOME?.trim() || paths.home
    const databaseFile = durableDatabasePath(openclaudeHome)
    const config: Record<string, unknown> = {}
    const advertisedMcpTools: string[] = []

    const mcpEntry = resolveMcpMemoryEntry(input.claudeCodePath)
    const trustedTsxCli = mcpEntry
      ? resolve(dirname(mcpEntry), '../../../node_modules/tsx/dist/cli.mjs')
      : null
    if (mcpEntry && trustedTsxCli && existsSync(trustedTsxCli) && input.gatewayToken) {
      const tokenFile = join(contextDir, 'gateway-token')
      const delegateContextFile = join(contextDir, 'delegate-context')
      writePrivate(tokenFile, input.gatewayToken)
      writePrivate(
        delegateContextFile,
        `${issueDelegateContextToken({
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          depth: input.delegationDepth,
        })}\n`,
      )
      const env: Record<string, string> = {
        OPENCLAUDE_AGENT_ID: input.agentId,
        OPENCLAUDE_HOME: openclaudeHome,
        OPENCLAUDE_SESSION_KEY: input.sessionKey,
        OPENCLAUDE_GATEWAY_PORT: String(input.gatewayPort),
        OPENCLAUDE_GATEWAY_TOKEN_FILE: tokenFile,
        OPENCLAUDE_DELEGATE_CONTEXT_FILE: delegateContextFile,
        OPENCLAUDE_DELEGATION_DEPTH: String(input.delegationDepth),
        OPENCLAUDE_ENGINE: 'zcode',
        ...(process.env.OPENCLAUDE_BASELINE_SKILLS_DIR
          ? { OPENCLAUDE_BASELINE_SKILLS_DIR: process.env.OPENCLAUDE_BASELINE_SKILLS_DIR }
          : {}),
        ...(input.skillEvalMode ? { OPENCLAUDE_SKILL_EVAL_MODE: '1' } : {}),
        ...(input.skillEvalExclude
          ? { OPENCLAUDE_SKILL_EVAL_EXCLUDE: input.skillEvalExclude }
          : {}),
        ...(input.skillEvalDraft
          ? {
              OPENCLAUDE_SKILL_EVAL_DRAFT_NAME: input.skillEvalDraft.name,
              OPENCLAUDE_SKILL_EVAL_DRAFT_DIR: input.skillEvalDraft.dir,
            }
          : {}),
        ...(input.skillTrainRunId ? { OPENCLAUDE_SKILL_TRAIN_RUN_ID: input.skillTrainRunId } : {}),
      }
      config.features = { mcp: true }
      config.mcp = {
        servers: {
          openclaude_memory: {
            type: 'stdio',
            command: '/usr/local/bin/node',
            args: [trustedTsxCli, mcpEntry],
            env,
          },
        },
      }
      advertisedMcpTools.push(...ZCODE_MEMORY_MCP_TOOLS)
    }

    const hookCollector = resolveHookCollector()
    let hookJournalFile: string | null = null
    if (hookCollector) {
      const hookNode =
        process.env.OC_ZCODE_TEST_ALLOW_UNTRUSTED_HOOK === '1' &&
        process.env.OC_ZCODE_TEST_NODE_BIN?.trim()
          ? process.env.OC_ZCODE_TEST_NODE_BIN.trim()
          : '/usr/local/bin/node'
      hookJournalFile = join(contextDir, 'tool-events.jsonl')
      writePrivate(hookJournalFile, '')
      const hook = {
        matcher: '*',
        hooks: [
          {
            type: 'process',
            command: hookNode,
            args: ['--experimental-default-type=module', hookCollector, hookJournalFile],
            timeoutMs: 3_000,
          },
        ],
      }
      config.hooks = {
        enabled: true,
        timeoutMs: 3_000,
        maxOutputBytes: 4_096,
        events: {
          PreToolUse: [hook],
          PostToolUse: [hook],
          PostToolUseFailure: [hook],
        },
      }
    }

    let platformConfigFile: string | null = null
    if (Object.keys(config).length > 0) {
      platformConfigFile = join(contextDir, 'platform-config.json')
      writePrivate(platformConfigFile, `${JSON.stringify(config)}\n`)
    }

    return {
      contextDir,
      platformConfigFile,
      hookJournalFile,
      databaseFile,
      advertisedMcpTools,
    }
  } catch (err) {
    try {
      rmSync(contextDir, { recursive: true, force: true })
    } catch {}
    throw err
  }
}

export function cleanupZcodePlatformArtifacts(artifacts: ZcodePlatformArtifacts | null): void {
  if (!artifacts) return
  const dir = artifacts.contextDir
  if (!dir.startsWith(CONTEXT_PREFIX) || !isAbsolute(dir)) return
  try {
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.isSymbolicLink()) return
  } catch {
    return
  }
  rmSync(dir, { recursive: true, force: true })
}

export interface ZcodeReasoningPart {
  id: string
  text: string
  ts: number
  truncated: boolean
}

export interface ZcodeContentPart extends ZcodeReasoningPart {
  kind: 'reasoning' | 'text'
}

export interface ZcodeContentSnapshot {
  available: boolean
  parts: ZcodeContentPart[]
}

type DatabaseSyncCtor = new (
  path: string,
  options?: { open?: boolean; readOnly?: boolean; timeout?: number },
) => {
  exec(sql: string): void
  prepare(sql: string): { all(...params: unknown[]): unknown[] }
  close(): void
}

function databaseCtor(): DatabaseSyncCtor | null {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync?: DatabaseSyncCtor }
    return sqlite.DatabaseSync ?? null
  } catch {
    return null
  }
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

export function readZcodeContentSnapshot(input: {
  databaseFile: string
  sessionId: string
  startedAt: number
}): ZcodeContentSnapshot {
  const Ctor = databaseCtor()
  if (!Ctor || !input.sessionId.startsWith('sess_')) return { available: false, parts: [] }
  try {
    const st = lstatSync(input.databaseFile)
    if (!st.isFile() || st.isSymbolicLink()) return { available: false, parts: [] }
  } catch {
    return { available: false, parts: [] }
  }
  let db: InstanceType<DatabaseSyncCtor> | null = null
  try {
    db = new Ctor(input.databaseFile, { open: true, readOnly: true, timeout: 0 })
    db.exec('PRAGMA busy_timeout=0')
    const rows = db
      .prepare(
        `SELECT p.id,
                p.time_created,
                p.sequence AS part_sequence,
                p.data AS part_data,
                m.time_created AS message_time_created,
                m.sequence AS message_sequence,
                m.data AS message_data
           FROM part p
           JOIN message m
             ON m.id = p.message_id
            AND m.session_id = p.session_id
          WHERE p.session_id = ?
            AND m.time_created >= ?
          ORDER BY m.time_created ASC,
                   m.sequence ASC,
                   p.time_created ASC,
                   p.sequence ASC
          LIMIT 1024`,
      )
      .all(input.sessionId, Math.max(0, input.startedAt)) as Array<Record<string, unknown>>
    const out: ZcodeContentPart[] = []
    for (const row of rows) {
      const message = jsonObject(row.message_data)
      const data = jsonObject(row.part_data)
      if (message?.role !== 'assistant') continue
      if (data?.type !== 'reasoning' && data?.type !== 'text') continue
      if (typeof data.text !== 'string' || !data.text || typeof row.id !== 'string') continue
      const rawText = data.text
      const truncated = rawText.length > MAX_REASONING_PART_CHARS
      const time =
        data.time && typeof data.time === 'object' && !Array.isArray(data.time)
          ? (data.time as Record<string, unknown>)
          : null
      out.push({
        id: row.id,
        kind: data.type,
        text: truncated ? rawText.slice(0, MAX_REASONING_PART_CHARS) : rawText,
        ts:
          typeof time?.start === 'number'
            ? time.start
            : typeof row.time_created === 'number'
              ? row.time_created
              : Date.now(),
        truncated,
      })
    }
    return { available: true, parts: out }
  } catch {
    return { available: false, parts: [] }
  } finally {
    try {
      db?.close()
    } catch {
      /* fail-soft read sidecar */
    }
  }
}

export function readZcodeReasoningParts(input: {
  databaseFile: string
  sessionId: string
  startedAt: number
}): ZcodeReasoningPart[] {
  return readZcodeContentSnapshot(input).parts
    .filter((part) => part.kind === 'reasoning')
    .map(({ kind: _kind, ...part }) => part)
}

export const _zcodePlatformInternals = {
  CONTEXT_PREFIX,
  HOT_HOOK_COLLECTOR,
  trustedRootOwnedFile,
  durableDatabasePath,
}
