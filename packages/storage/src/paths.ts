import { homedir } from 'node:os'
import { join } from 'node:path'

export const HOME = process.env.OPENCLAUDE_HOME ?? join(homedir(), '.openclaude')

export const paths = {
  home: HOME,
  config: join(HOME, 'openclaude.json'),
  agentsYaml: join(HOME, 'agents.yaml'),
  credentialsDir: join(HOME, 'credentials'),
  agentsDir: join(HOME, 'agents'),
  logsDir: join(HOME, 'logs'),
  agentDir: (agentId: string) => join(HOME, 'agents', agentId),
  agentClaudeMd: (agentId: string) => join(HOME, 'agents', agentId, 'CLAUDE.md'),
  // Memory system (L1): per-agent MEMORY.md + USER.md with char budget
  agentMemoryMd: (agentId: string) => join(HOME, 'agents', agentId, 'MEMORY.md'),
  agentUserMd: (agentId: string) => join(HOME, 'agents', agentId, 'USER.md'),
  // Skills system (L3): per-agent skill directory
  agentSkillsDir: (agentId: string) => join(HOME, 'agents', agentId, 'skills'),
  agentSkillDir: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'skills', skillName),
  agentSkillMd: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'skills', skillName, 'SKILL.md'),
  // Session search (L2): SQLite FTS5 DB per install (not per agent)
  sessionsDb: join(HOME, 'sessions.db'),
  // Phase 0.2: durable outbox for server-authored messages that couldn't be
  // written to sessions.db immediately (disk full, SQLite BUSY, crash mid-write).
  // Replayed on gateway startup. JSONL format, one queued write per line.
  msgOutbox: join(HOME, 'msg-outbox.jsonl'),
  // Cron (L3)
  cronYaml: join(HOME, 'cron.yaml'),
  cronOutputsDir: join(HOME, 'cron', 'outputs'),
  // User uploads (images, files) from WebChat — landed on local disk so agent's
  // tools (Read / understand_image / etc.) can access them by path.
  uploadsDir: join(HOME, 'uploads'),
  // MCP-generated media (images, audio, video) — served via /api/media/
  generatedDir: join(HOME, 'generated'),
  // Runtime token file written by gateway, mtime-watched by ccb subprocesses
  // so an OAuth refresh propagates without subprocess restart.
  runtimeClaudeOauthToken: join(HOME, 'runtime', 'claude_oauth_token.json'),
  // Existing
  agentSessionsDir: (agentId: string) => join(HOME, 'agents', agentId, 'sessions'),
  sessionLog: (agentId: string, sessionKey: string) =>
    join(HOME, 'agents', agentId, 'sessions', `${sessionKey.replace(/[:/]/g, '_')}.jsonl`),
}
