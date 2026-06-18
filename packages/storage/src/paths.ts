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
  // Memory system (L1): MEMORY.md per-agent; USER.md user-level shared.
  // MEMORY.md = agent's own working notes (per-agent, stays isolated). USER.md = who
  // the user is / preferences → user-level shared at the volume root so any agent's
  // learning about the user reaches ALL agents. `agentUserMd` kept only as the legacy
  // per-agent path for migration / back-compat read.
  agentMemoryMd: (agentId: string) => join(HOME, 'agents', agentId, 'MEMORY.md'),
  agentUserMd: (agentId: string) => join(HOME, 'agents', agentId, 'USER.md'),
  sharedUserMd: join(HOME, 'user.md'),
  sharedUserLock: join(HOME, 'user.md.lock'),
  // Skills system (L3): per-agent skill directory.
  // NOTE: with the user-level shared skill library (see sharedSkillsDir below),
  // this per-agent dir is a read-only "legacy" overlay layer kept only for
  // backward-compat / migration. New writes go to sharedSkillsDir; platform
  // seeds live in agentSeedSkillsDir.
  agentSkillsDir: (agentId: string) => join(HOME, 'agents', agentId, 'skills'),
  agentSkillDir: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'skills', skillName),
  agentSkillMd: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'skills', skillName, 'SKILL.md'),
  // Per-agent platform seed skills (read-only). Physically separated from the
  // user-writable agentSkillsDir so platform seeds (e.g. scientist's科研 libs)
  // never collide with shared/legacy user-skill semantics (overlay & delete).
  agentSeedSkillsDir: (agentId: string) => join(HOME, 'agents', agentId, 'seed-skills'),
  agentSeedSkillDir: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'seed-skills', skillName),
  agentSeedSkillMd: (agentId: string, skillName: string) =>
    join(HOME, 'agents', agentId, 'seed-skills', skillName, 'SKILL.md'),
  // User-level shared skill library (writable; single authoritative write source).
  // Lives at the volume root (~/.openclaude/skills) so it is visible to ALL of a
  // user's agents — self-authored / auto-sedimented skills are reusable everywhere.
  sharedSkillsDir: join(HOME, 'skills'),
  sharedSkillDir: (skillName: string) => join(HOME, 'skills', skillName),
  sharedSkillMd: (skillName: string) => join(HOME, 'skills', skillName, 'SKILL.md'),
  // ClawHub installed skills (shared across agents)
  hubDir: join(HOME, 'hub'),
  hubLockfile: join(HOME, 'hub', 'lock.json'),
  hubSkillDir: (slug: string) => join(HOME, 'hub', 'skills', slug),
  hubSkillMd: (slug: string) => join(HOME, 'hub', 'skills', slug, 'SKILL.md'),
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
  // Existing
  agentSessionsDir: (agentId: string) => join(HOME, 'agents', agentId, 'sessions'),
  sessionLog: (agentId: string, sessionKey: string) =>
    join(HOME, 'agents', agentId, 'sessions', `${sessionKey.replace(/[:/]/g, '_')}.jsonl`),
}
