# OpenClaude Architecture

## Overview

OpenClaude is a personal AI assistant built on top of Claude Code Best (CCB) as the execution harness.

```
┌─────────────────────────────────────────────────────────┐
│                    Interface Layer                       │
│  Web UI (app.js)  │  Telegram  │  OpenAI-compat API    │
├─────────────────────────────────────────────────────────┤
│                  Orchestration Layer                     │
│  SessionManager  │  EventBus  │  CronScheduler          │
│  WebhookRouter   │  TaskStore │  RunLog                 │
├─────────────────────────────────────────────────────────┤
│                    Harness Layer                         │
│  SubprocessRunner  │  CcbMessageParser  │  PromptSlots  │
│  TerminalBackend (local / docker)                       │
├─────────────────────────────────────────────────────────┤
│                  Plugin / Capability                     │
│  ChannelPlugin  │  ProviderPlugin  │  AutomationPlugin  │
│  CapabilityPlugin (host extension point)                │
├─────────────────────────────────────────────────────────┤
│                    CCB (claude-code-best)                │
│  Agent loop  │  Tool system  │  OAuth  │  Resume        │
└─────────────────────────────────────────────────────────┘
```

## Key Files

| Layer | File | Responsibility |
|-------|------|----------------|
| Harness | `subprocessRunner.ts` | Spawn/manage CCB subprocess |
| Harness | `ccbMessageParser.ts` | Parse CCB stream-json output |
| Harness | `promptSlots.ts` | Build structured system prompt (SOUL/USER/AGENTS/SKILLS/MEMORY/TOOLS) |
| Harness | `terminalBackend.ts` | Abstraction for local/docker execution |
| Orchestration | `sessionManager.ts` | Session lifecycle, mutex, retry, FTS5 indexing |
| Orchestration | `eventBus.ts` | In-process typed event bus (6 event types) |
| Orchestration | `cron.ts` | YAML-based cron scheduler |
| Orchestration | `webhooks.ts` | Webhook routing with HMAC verification |
| Orchestration | `runLog.ts` | In-memory ring buffer for run metrics |
| Orchestration | `server.ts` | HTTP/WS gateway, routing, OAuth, file serving |
| Storage | `taskStore.ts` | Persistent task definitions + execution records |
| Storage | `config.ts` | Config types (toolsets, terminal backend, etc.) |
| Interface | `openaiCompat.ts` | `/v1/chat/completions` + `/v1/models` |
| Interface | `app.js` | Web UI (vanilla JS) |
| Plugin | `plugin-sdk/index.ts` | Channel/Provider/Automation/Capability interfaces |

## Prompt Slots

System prompt is assembled from 6 ordered slots:

1. **SOUL** — Agent persona (CLAUDE.md / SOUL.md)
2. **USER** — User identity & preferences (USER.md)
3. **AGENTS** — Platform capabilities, agent list, provider tips
4. **SKILLS** — Skill summaries (top 15)
5. **MEMORY** — Agent notes (MEMORY.md)
6. **TOOLS** — Learning system instructions, cron/reminder hints

Static content first (cache-friendly), dynamic last.

## Event Bus

Events flow through `GatewayEventBus`:

- `task.created` — CCB CronCreate bridge or API
- `task.deleted` — CCB CronDelete bridge or API
- `webhook.received` — incoming webhook → agent execution
- `cron.fired` — cron job completion
- `agent.delegated` — delegate_task initiated
- `agent.completed` — delegated task finished

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/v1/chat/completions` | POST | OpenAI-compatible chat (streaming + non-streaming) |
| `/v1/models` | GET | List agents as models |
| `/api/cron` | GET/POST | List/create cron jobs |
| `/api/cron/:id` | PUT/DELETE | Update/delete cron job |
| `/api/tasks` | GET/POST | List/create background tasks |
| `/api/tasks/:id` | GET/PUT/DELETE/POST | CRUD + manual trigger |
| `/api/tasks-executions` | GET | Recent execution records |
| `/api/webhooks` | GET | List webhooks |
| `/api/webhooks/:id` | POST/DELETE | Trigger/delete webhook |
| `/api/agents/:id/message` | POST | Async inter-agent message |
| `/api/agents/:id/delegate` | POST | Sync task delegation |
| `/api/doctor` | GET | Diagnostic summary |
| `/api/runs` | GET | Recent run log |

## Toolsets

Optional MCP server grouping:

```json
{
  "toolsets": {
    "research": ["browser"],
    "coding": ["openclaude-memory"],
    "browser": ["browser"]
  },
  "defaults": { "toolsets": ["research", "coding"] }
}
```

If not configured, all MCP servers are available to all agents (backward compatible).
