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
  // memdir 范式(见 storage/src/memoryDir.ts):Core 记忆从单个 §-blob 改为
  // 「每条记忆一个 frontmatter 文件 + MEMORY.md 纯索引」。
  //  - agentMemoryMd(id)  = 索引路径(**不变**,跨组件契约:volumeContextReader /
  //    Go usercontext / platformEnvelopeBuilder / UI 全读这个路径)。
  //  - agentMemoryDir(id) = 记忆文件目录 agents/<id>/memory/。
  //  - agentMemoryFile(id, base) = 目录下单条记忆文件(base 必须过 MEMORY_FILE_RE
  //    校验;这里只做路径拼接,不做校验——校验在 MemoryDir 写/读侧)。
  agentMemoryDir: (agentId: string) => join(HOME, 'agents', agentId, 'memory'),
  agentMemoryFile: (agentId: string, base: string) =>
    join(HOME, 'agents', agentId, 'memory', base),
  agentUserMd: (agentId: string) => join(HOME, 'agents', agentId, 'USER.md'),
  sharedUserMd: join(HOME, 'user.md'),
  sharedUserLock: join(HOME, 'user.md.lock'),
  // per-agent MEMORY.md 的跨进程写锁(= agentMemoryMd + '.lock',同目录语义)。v5 下
  // 该文件被容器 gateway(UI PUT overwrite)与 mcp-memory 子进程(AI add/replace/remove)
  // 两个进程写,不再是单 writer → 写路径必须取此锁做 read-modify-write 互斥。
  agentMemoryLock: (agentId: string) => join(HOME, 'agents', agentId, 'MEMORY.md.lock'),
  // Crash-recovery journal for one all-or-nothing MemoryDir batch. The file is
  // intentionally outside memory/ so list()/injection can never treat it as a
  // user memory entry.
  agentMemoryBatchJournal: (agentId: string) =>
    join(HOME, 'agents', agentId, '.memory-batch-journal.json'),
  // Foreground native Write/Edit holds this inode shared for the whole turn;
  // Auto-Dream batch apply/recovery takes it exclusive.
  agentMemoryBarrier: (agentId: string) => join(HOME, 'agents', agentId, 'memory-barrier.lock'),
  // V5 Auto-Dream keeps its own scheduler state/serialization lock beside the
  // agent memory.  The lock file is a stable inode used by kernel flock: never
  // unlink or atomically replace it (doing so would split the lock domain).
  agentAutoDreamState: (agentId: string) => join(HOME, 'agents', agentId, 'auto-dream-state.json'),
  agentAutoDreamLock: (agentId: string) => join(HOME, 'agents', agentId, 'auto-dream.lock'),
  agentAutoDreamOptimizerState: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer-state.json'),
  agentAutoDreamOptimizerLock: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer.lock'),
  agentAutoDreamOptimizerRunLock: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer-run.lock'),
  agentAutoDreamOptimizerActions: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer-actions.json'),
  agentAutoDreamOptimizerBilling: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer-billing.json'),
  agentAutoDreamOptimizerFindings: (agentId: string) =>
    join(HOME, 'agents', agentId, 'auto-dream-optimizer-findings.json'),
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
  // Skill-training drafts (SkillOpt feature). A candidate SKILL.md produced by a
  // training run / AI revision / manual edit is STAGED here before the user
  // confirms a merge into the authoritative library above. Keyed by runId then
  // skill name so one run can stage multiple candidates. Under HOME → persisted in
  // the per-user named volume (survives container recycle). This is NEVER a write
  // target for the authoritative SkillStore; promoting a draft is an explicit,
  // separate store.save()/store.delete() at merge time.
  skillDraftsDir: join(HOME, 'skill-drafts'),
  skillDraftRunDir: (runId: string) => join(HOME, 'skill-drafts', runId),
  skillEvalsDir: join(HOME, 'skill-evals'),
  skillEvalRunDir: (runId: string) => join(HOME, 'skill-evals', runId),
  skillDraftDir: (runId: string, skillName: string) =>
    join(HOME, 'skill-drafts', runId, skillName),
  skillDraftMd: (runId: string, skillName: string) =>
    join(HOME, 'skill-drafts', runId, skillName, 'SKILL.md'),
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
  // Research working outputs (reports, figures, manifests) produced by the
  // research CLIs (oc-report / scientific-figures / oc-figcheck). A trusted
  // media root alongside uploads/generated so vision tools may review
  // agent-produced figures (not only user uploads). Keeping it a first-class
  // path constant means the vision SSRF allow-list has a single authority to
  // reference instead of hard-coding the string in multiple call sites.
  researchDir: join(HOME, 'research'),
  // Existing
  agentSessionsDir: (agentId: string) => join(HOME, 'agents', agentId, 'sessions'),
  sessionLog: (agentId: string, sessionKey: string) =>
    join(HOME, 'agents', agentId, 'sessions', `${sessionKey.replace(/[:/]/g, '_')}.jsonl`),
}
