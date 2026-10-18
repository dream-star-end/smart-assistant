/**
 * Frozen copy of the original Gateway._handleHttpAfterCommercial branch predicates, generated from
 * packages/gateway/src/server.ts @ 00a8b8973 before the branches moved into routes/*.ts tables
 * (FINDINGS §7.5 step 2b, OCV5-468). Do not edit by hand: this is the "old" side of the
 * dispatch equivalence test. `calls` lists the Gateway members each original branch used.
 */
import { TURN_CANCEL_IF_QUEUED_PATH } from '@openclaude/protocol'
import { V3_CODEX_RELAY_PREFIX } from '../../v3CodexRelay.js'
import { V5_GROK_RELAY_PREFIX } from '../../v5GrokRelay.js'
import { V5_ZCODE_RELAY_PREFIX } from '../../v5ZcodeRelay.js'
import { V5_ANTIGRAVITY_RELAY_PREFIX } from '../../v5AntigravityRelay.js'
import { V3_MARKETPLACE_LOCAL_RELAY_PREFIX } from '../../v3MarketplaceRelay.js'
import { SKILL_LOCAL_RELAY_PREFIX } from '../../ocSkillLocalRelay.js'
import { PROJECT_SEARCH_LOCAL_PATH } from '../../projectSearchLocal.js'
export type LegacyReq = { method?: string }
export interface LegacyRoute {
  id: string
  line: number
  calls: readonly string[]
  match: (req: LegacyReq, url: URL) => boolean
}
export interface LegacyGroup {
  lines: string
  routes: readonly LegacyRoute[]
  samples: readonly string[]
}

export const LEGACY_HTTP_DISPATCH: Record<string, LegacyGroup> = {
  PRE_AUTH_ROUTES: {
    lines: 'L3915-L4107',
    routes: [
      {
        id: 'V3_CODEX_RELAY_PREFIX',
        line: 3922,
        calls: ['sendJson', 'log', 'sendJson'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === V3_CODEX_RELAY_PREFIX ||
              url.pathname.startsWith(`${V3_CODEX_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'V5_GROK_RELAY_PREFIX',
        line: 3939,
        calls: ['sendJson', 'log', 'sendJson'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === V5_GROK_RELAY_PREFIX ||
              url.pathname.startsWith(`${V5_GROK_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'V5_ZCODE_RELAY_PREFIX',
        line: 3956,
        calls: ['sendJson', 'log', 'sendJson'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === V5_ZCODE_RELAY_PREFIX ||
              url.pathname.startsWith(`${V5_ZCODE_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'V5_ANTIGRAVITY_RELAY_PREFIX',
        line: 3973,
        calls: ['sendJson', 'log', 'sendJson'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === V5_ANTIGRAVITY_RELAY_PREFIX ||
              url.pathname.startsWith(`${V5_ANTIGRAVITY_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'V3_MARKETPLACE_LOCAL_RELAY_PREFIX',
        line: 3992,
        calls: ['sendJson', 'log', 'sendJson'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === V3_MARKETPLACE_LOCAL_RELAY_PREFIX ||
              url.pathname.startsWith(`${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'SKILL_LOCAL_RELAY_PREFIX',
        line: 4014,
        calls: [
          'sendJson',
          'sendJson',
          'sendInternalError',
          '_handleSkillTrainStart',
          '_handleSkillTrainRun',
          '_handleSkillEvalGenStart',
          '_handleSkillEvalGenStatus',
        ],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === SKILL_LOCAL_RELAY_PREFIX ||
              url.pathname.startsWith(`${SKILL_LOCAL_RELAY_PREFIX}/`),
          ),
      },
      {
        id: 'PROJECT_SEARCH_LOCAL_PATH',
        line: 4045,
        calls: ['extractToken', 'deps', 'sendJson', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === PROJECT_SEARCH_LOCAL_PATH),
      },
      {
        id: 'POST /api/auth/login',
        line: 4059,
        calls: [
          'rateLimiter',
          'sendJson',
          'readBody',
          'sendJson',
          'sendJson',
          'deps',
          'sendJson',
          'deps',
          'deps',
          'sendJson',
          'sendJson',
          'sendJson',
          'sendJson',
          'deps',
          'sendJson',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/auth/login' && req.method === 'POST'),
      },
    ],
    samples: [
      V3_CODEX_RELAY_PREFIX,
      `${V3_CODEX_RELAY_PREFIX}/x`,
      `${V3_CODEX_RELAY_PREFIX}x`,
      V5_GROK_RELAY_PREFIX,
      `${V5_GROK_RELAY_PREFIX}/x`,
      `${V5_GROK_RELAY_PREFIX}x`,
      V5_ZCODE_RELAY_PREFIX,
      `${V5_ZCODE_RELAY_PREFIX}/x`,
      `${V5_ZCODE_RELAY_PREFIX}x`,
      V5_ANTIGRAVITY_RELAY_PREFIX,
      `${V5_ANTIGRAVITY_RELAY_PREFIX}/x`,
      `${V5_ANTIGRAVITY_RELAY_PREFIX}x`,
      V3_MARKETPLACE_LOCAL_RELAY_PREFIX,
      `${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}/x`,
      `${V3_MARKETPLACE_LOCAL_RELAY_PREFIX}x`,
      SKILL_LOCAL_RELAY_PREFIX,
      `${SKILL_LOCAL_RELAY_PREFIX}/x`,
      `${SKILL_LOCAL_RELAY_PREFIX}x`,
      PROJECT_SEARCH_LOCAL_PATH,
      `${PROJECT_SEARCH_LOCAL_PATH}/x`,
      `${PROJECT_SEARCH_LOCAL_PATH}x`,
      '/api/auth/login',
    ],
  },
  PLATFORM_ROUTES: {
    lines: 'L4130-L4480',
    routes: [
      {
        id: '/v1/*',
        line: 4133,
        calls: [
          '_getAgentsConfigUserView',
          'deps',
          'deps',
          'sessions',
          '_runLog',
          'readBody',
          'sendJson',
          'sendError',
          'sendError',
          'sendInternalError',
        ],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname.startsWith('/v1/')),
      },
      {
        id: 'POST /api/auth/session',
        line: 4158,
        calls: ['checkHttpAuth', 'setSessionCookie', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/auth/session' && req.method === 'POST'),
      },
      {
        id: 'POST /api/auth/logout',
        line: 4176,
        calls: ['isHttps', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/auth/logout' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/runtime-recycle-drain',
        line: 4185,
        calls: [
          'checkInboundBypass',
          'sendJson',
          '_runtimeRecycleDrainCoordinator',
          '_runtimeRecycleDrainUntil',
          '_runtimeRecycleDrainUntil',
          '_runtimeRecycleDrainUntil',
          'sessions',
          'sessions',
          'sessions',
          '_runtimeRecycleIngressActive',
          '_ensureDelegateJobStore',
          '_ensureDelegateJobStore',
          '_ensureDelegateJobStore',
          '_ensureDelegateJobStore',
          '_runtimeRecycleDrainCoordinator',
          'sendJson',
          'sendJson',
          '_runtimeRecycleDrainUntil',
          'sessions',
          'log',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/runtime-recycle-drain' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/delegate-begin-cutover',
        line: 4245,
        calls: [
          'checkInboundBypass',
          'sendJson',
          'sendJson',
          '_ensureDelegateJobStore',
          '_delegateRunnerIdle',
          'sendJson',
          'log',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/delegate-begin-cutover' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/delegate-end-cutover',
        line: 4274,
        calls: [
          'checkInboundBypass',
          'sendJson',
          'sendJson',
          '_ensureDelegateJobStore',
          'sendJson',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/delegate-end-cutover' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/wechat-inbound',
        line: 4303,
        calls: ['checkInboundBypass', 'sendJson', 'handleWechatInbound', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/wechat-inbound' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/qq-inbound',
        line: 4318,
        calls: ['checkInboundBypass', 'sendJson', 'handleWechatInbound', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/qq-inbound' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/engine-preheat',
        line: 4336,
        calls: ['checkInboundBypass', 'sendJson', 'handleEnginePreheat', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/engine-preheat' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/wechat-inbound-compensate',
        line: 4361,
        calls: [
          'checkInboundBypass',
          'sendJson',
          'handleWechatInboundCompensate',
          'log',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === '/internal/v3/wechat-inbound-compensate' && req.method === 'POST',
          ),
      },
      {
        id: 'POST /internal/v3/qq-inbound-compensate',
        line: 4377,
        calls: [
          'checkInboundBypass',
          'sendJson',
          'handleWechatInboundCompensate',
          'log',
          'sendJson',
        ],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/qq-inbound-compensate' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/wechat-stop',
        line: 4397,
        calls: ['checkInboundBypass', 'sendJson', 'handleWechatStop', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/wechat-stop' && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/qq-stop',
        line: 4412,
        calls: ['checkInboundBypass', 'sendJson', 'handleWechatStop', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/qq-stop' && req.method === 'POST'),
      },
      {
        id: 'POST TURN_CANCEL_IF_QUEUED_PATH',
        line: 4434,
        calls: ['checkInboundBypass', 'sendJson', 'handleTurnCancelIfQueued', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === TURN_CANCEL_IF_QUEUED_PATH && req.method === 'POST'),
      },
      {
        id: 'POST /internal/v3/turn-reject-if-absent',
        line: 4449,
        calls: ['checkInboundBypass', 'sendJson', 'handleTurnRejectIfAbsent', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/turn-reject-if-absent' && req.method === 'POST'),
      },
      {
        id: 'GET /internal/v3/turn-dispatch-state',
        line: 4466,
        calls: ['checkInboundBypass', 'sendJson', 'handleTurnDispatchState', 'log', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/internal/v3/turn-dispatch-state' && req.method === 'GET'),
      },
    ],
    samples: [
      '/v1/x',
      '/v1',
      '/api/auth/session',
      '/api/auth/logout',
      '/internal/v3/runtime-recycle-drain',
      '/internal/v3/delegate-begin-cutover',
      '/internal/v3/delegate-end-cutover',
      '/internal/v3/wechat-inbound',
      '/internal/v3/qq-inbound',
      '/internal/v3/engine-preheat',
      '/internal/v3/wechat-inbound-compensate',
      '/internal/v3/qq-inbound-compensate',
      '/internal/v3/wechat-stop',
      '/internal/v3/qq-stop',
      TURN_CANCEL_IF_QUEUED_PATH,
      `${TURN_CANCEL_IF_QUEUED_PATH}/x`,
      `${TURN_CANCEL_IF_QUEUED_PATH}x`,
      '/internal/v3/turn-reject-if-absent',
      '/internal/v3/turn-dispatch-state',
    ],
  },
  SYSTEM_ROUTES: {
    lines: 'L4480-L4713',
    routes: [
      {
        id: 'POST /api/web-trace',
        line: 4488,
        calls: ['getUserId', 'readBody', 'sendJson', 'sendJson', 'log', 'sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/web-trace' && req.method === 'POST'),
      },
      {
        id: '/healthz',
        line: 4519,
        calls: ['deps', '_dispatchAuthority', '_durableTurnDispatchReady'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/healthz'),
      },
      {
        id: '/metrics',
        line: 4635,
        calls: ['sessions'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/metrics'),
      },
      {
        id: 'GET /version',
        line: 4645,
        calls: ['sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/version' && req.method === 'GET'),
      },
      {
        id: '/api/doctor',
        line: 4662,
        calls: ['_runLog', '_runLog', 'sessions', 'webhookRouter', 'sendJson'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/doctor'),
      },
      {
        id: 'GET /api/usage',
        line: 4677,
        calls: ['sendJson', 'sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/usage' && req.method === 'GET'),
      },
      {
        id: 'GET /api/usage/events',
        line: 4693,
        calls: ['sendJson', 'sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/usage/events' && req.method === 'GET'),
      },
      {
        id: 'GET /api/runs',
        line: 4710,
        calls: ['sendJson', '_runLog'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/runs' && req.method === 'GET'),
      },
    ],
    samples: [
      '/api/web-trace',
      '/healthz',
      '/metrics',
      '/version',
      '/api/doctor',
      '/api/usage',
      '/api/usage/events',
      '/api/runs',
    ],
  },
  APP_CONFIG_ROUTES: {
    lines: 'L4715-L4752',
    routes: [
      {
        id: '/api/features',
        line: 4718,
        calls: ['sendError', 'sendJson'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/features'),
      },
      {
        id: '/api/config',
        line: 4723,
        calls: ['deps', 'deps', 'deps', 'deps', 'deps', 'deps', 'deps', 'deps', 'deps'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/config'),
      },
    ],
    samples: ['/api/features', '/api/config'],
  },
  AGENT_ROUTES: {
    lines: 'L4752-L5033',
    routes: [
      {
        id: '/api/agents',
        line: 4753,
        calls: ['handleAgentsCollection', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/agents'),
      },
      {
        id: '/api/agents/:1',
        line: 4757,
        calls: ['handleAgentItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/agents/:1/persona',
        line: 4764,
        calls: ['handlePersona', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/persona$/)),
      },
      {
        id: '/api/agents/:1/memory/:2',
        line: 4771,
        calls: ['handleMemory', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/(memory|user)$/)),
      },
      {
        id: '/api/agents/:1/memory/usage',
        line: 4780,
        calls: ['handleMemoryUsage', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/usage$/)),
      },
      {
        id: '/api/agents/:1/auto-dream-report',
        line: 4789,
        calls: ['handleAutoDreamReport', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-report$/)),
      },
      {
        id: '/api/agents/:1/auto-dream-optimizer',
        line: 4798,
        calls: ['handleAutoDreamOptimizer', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer$/)),
      },
      {
        id: '/api/agents/:1/auto-dream-optimizer/cancel',
        line: 4807,
        calls: ['handleAutoDreamOptimizerCancel', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer\/cancel$/),
          ),
      },
      {
        id: '/api/agents/:1/auto-dream-optimizer/proposals/:2/:3',
        line: 4816,
        calls: ['handleAutoDreamOptimizerProposal', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname.match(
              /^\/api\/agents\/([a-zA-Z0-9_-]+)\/auto-dream-optimizer\/proposals\/([0-9a-f]{32})\/(apply|dismiss)$/,
            ),
          ),
      },
      {
        id: '/api/agents/:1/memory/files/:2',
        line: 4830,
        calls: ['handleMemoryFile', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/memory\/files\/([^/]+)$/)),
      },
      {
        id: '/api/skills',
        line: 4840,
        calls: ['handleUserSkillsList', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/skills'),
      },
      {
        id: '/api/skills/:1/files',
        line: 4844,
        calls: ['_handleUserSkillFiles', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/files$/)),
      },
      {
        id: '/api/skills/:1/history',
        line: 4851,
        calls: ['_handleUserSkillHistory', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/history$/)),
      },
      {
        id: '/api/skills/:1/restore',
        line: 4858,
        calls: ['_handleUserSkillRestore', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/restore$/)),
      },
      {
        id: '/api/skills/:1',
        line: 4865,
        calls: ['handleUserSkillItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)$/)),
      },
      {
        id: '/api/agents/:1/skills',
        line: 4872,
        calls: ['handleSkillsList', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills$/)),
      },
      {
        id: '/api/agents/:1/skills/:2',
        line: 4879,
        calls: ['handleSkillItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/skills\/([a-z0-9-]+)$/)),
      },
      {
        id: '/api/skills/:1/evals',
        line: 4889,
        calls: ['_handleSkillEvalsFile', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/evals$/)),
      },
      {
        id: '/api/skills/:1/eval-run',
        line: 4896,
        calls: ['_handleSkillEvalStart', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/eval-run$/)),
      },
      {
        id: '/api/skill-eval/:1',
        line: 4903,
        calls: ['_handleSkillEvalRunStatus', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skill-eval\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/skills/:1/evals/generate',
        line: 4912,
        calls: ['_handleSkillEvalGenStart', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/evals\/generate$/)),
      },
      {
        id: '/api/skill-eval-gen/:1',
        line: 4921,
        calls: ['_handleSkillEvalGenStatus', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skill-eval-gen\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/v5/release-jobs/:1',
        line: 4928,
        calls: ['_handleReleaseJobStatus'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname.match(/^\/api\/v5\/release-jobs\/(rel-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12})$/),
          ),
      },
      {
        id: '/api/skills/:1/train',
        line: 4935,
        calls: ['_handleSkillTrainStart', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skills\/([a-z0-9-]+)\/train$/)),
      },
      {
        id: '/api/skill-training/:1/drafts/:2',
        line: 4942,
        calls: ['_handleSkillTrainDraftItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)$/),
          ),
      },
      {
        id: '/api/skill-training/:1/drafts/:2/comment',
        line: 4954,
        calls: ['_handleSkillTrainComment', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname.match(
              /^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts\/([a-z0-9-]+)\/comment$/,
            ),
          ),
      },
      {
        id: '/api/skill-training/:1/drafts',
        line: 4966,
        calls: ['_handleSkillTrainDrafts', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/drafts$/)),
      },
      {
        id: '/api/skill-training/:1/merge',
        line: 4975,
        calls: ['_handleSkillTrainMerge', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)\/merge$/)),
      },
      {
        id: '/api/skill-training',
        line: 4985,
        calls: ['_handleSkillTrainList', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/skill-training'),
      },
      {
        id: '/api/skill-training/:1',
        line: 4989,
        calls: ['_handleSkillTrainRun', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/skill-training\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/agents/:1/message',
        line: 4997,
        calls: ['handleAgentMessage', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/message$/)),
      },
      {
        id: '/api/delegate/wait',
        line: 5005,
        calls: ['handleDelegateWait', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/delegate/wait'),
      },
      {
        id: 'POST /api/agents/advisor/consult',
        line: 5010,
        calls: ['handleConsultAdvisor', 'sendInternalError'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/agents/advisor/consult' && req.method === 'POST'),
      },
      {
        id: '/api/collaboration-config',
        line: 5014,
        calls: ['handleCollaborationConfig', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/collaboration-config'),
      },
      {
        id: '/api/agents/:1/delegate',
        line: 5019,
        calls: ['handleDelegateTask', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([A-Za-z0-9._:-]+)\/delegate$/)),
      },
      {
        id: '/api/agents/:1/ask-user',
        line: 5027,
        calls: ['handleEngineAskUser', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/agents\/([a-zA-Z0-9_-]+)\/ask-user$/)),
      },
    ],
    samples: [
      '/api/agents',
      '/api/agents/a',
      '/api/agents/aaa',
      '/api/agents/a/persona',
      '/api/agents/aaa/persona',
      '/api/agents/a/memory/memory',
      '/api/agents/aaa/memory/user',
      '/api/agents/a/memory/usage',
      '/api/agents/aaa/memory/usage',
      '/api/agents/a/auto-dream-report',
      '/api/agents/aaa/auto-dream-report',
      '/api/agents/a/auto-dream-optimizer',
      '/api/agents/aaa/auto-dream-optimizer',
      '/api/agents/a/auto-dream-optimizer/cancel',
      '/api/agents/aaa/auto-dream-optimizer/cancel',
      '/api/agents/a/auto-dream-optimizer/proposals/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/apply',
      '/api/agents/aaa/auto-dream-optimizer/proposals/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/dismiss',
      '/api/agents/a/memory/files/a',
      '/api/agents/aaa/memory/files/aaa',
      '/api/skills',
      '/api/skills/a/files',
      '/api/skills/aaa/files',
      '/api/skills/a/history',
      '/api/skills/aaa/history',
      '/api/skills/a/restore',
      '/api/skills/aaa/restore',
      '/api/skills/a',
      '/api/skills/aaa',
      '/api/agents/a/skills',
      '/api/agents/aaa/skills',
      '/api/agents/a/skills/a',
      '/api/agents/aaa/skills/aaa',
      '/api/skills/a/evals',
      '/api/skills/aaa/evals',
      '/api/skills/a/eval-run',
      '/api/skills/aaa/eval-run',
      '/api/skill-eval/a',
      '/api/skill-eval/aaa',
      '/api/skills/a/evals/generate',
      '/api/skills/aaa/evals/generate',
      '/api/skill-eval-gen/a',
      '/api/skill-eval-gen/aaa',
      '/api/v5/release-jobs/rel-00000000T000000Z-aaaaaaaaaaaa',
      '/api/skills/a/train',
      '/api/skills/aaa/train',
      '/api/skill-training/a/drafts/a',
      '/api/skill-training/aaa/drafts/aaa',
      '/api/skill-training/a/drafts/a/comment',
      '/api/skill-training/aaa/drafts/aaa/comment',
      '/api/skill-training/a/drafts',
      '/api/skill-training/aaa/drafts',
      '/api/skill-training/a/merge',
      '/api/skill-training/aaa/merge',
      '/api/skill-training',
      '/api/skill-training/a',
      '/api/skill-training/aaa',
      '/api/agents/a/message',
      '/api/agents/aaa/message',
      '/api/delegate/wait',
      '/api/agents/advisor/consult',
      '/api/collaboration-config',
      '/api/agents/a/delegate',
      '/api/agents/aaa/delegate',
      '/api/agents/a/ask-user',
      '/api/agents/aaa/ask-user',
    ],
  },
  WORKSPACE_API_ROUTES: {
    lines: 'L5033-L5289',
    routes: [
      {
        id: 'GET /api/changelog',
        line: 5035,
        calls: ['sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/changelog' && req.method === 'GET'),
      },
      {
        id: 'POST /api/feedback',
        line: 5048,
        calls: ['readBody', 'sendJson', 'getUserId', 'sendJson', 'log', 'sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/feedback' && req.method === 'POST'),
      },
      {
        id: 'GET /api/feedback',
        line: 5077,
        calls: ['getUserId', 'sendJson', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/feedback' && req.method === 'GET'),
      },
      {
        id: '/api/search',
        line: 5099,
        calls: ['handleSearch', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/search'),
      },
      {
        id: '/api/cron/channels',
        line: 5105,
        calls: ['handleCronChannels', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/cron/channels'),
      },
      {
        id: '/api/cron',
        line: 5109,
        calls: ['handleCronApi', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/cron'),
      },
      {
        id: '/api/cron/:1',
        line: 5113,
        calls: ['handleCronItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/cron\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/board/projects | /api/board/tickets | /api/board/pipelines | /api/board/agents | /api/board/settings | /api/board/stats/cost | /api/board/templates | /api/board/reports/weekly',
        line: 5123,
        calls: [
          'deps',
          'verifyCommercialJwt',
          'checkBridgeBypass',
          '_getAgentsConfigUserView',
          'sendInternalError',
        ],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(
            url.pathname === '/api/board/projects' ||
              url.pathname === '/api/board/tickets' ||
              url.pathname === '/api/board/pipelines' ||
              url.pathname === '/api/board/agents' ||
              url.pathname === '/api/board/settings' ||
              url.pathname === '/api/board/stats/cost' ||
              url.pathname === '/api/board/templates' ||
              url.pathname === '/api/board/reports/weekly' ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/board$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/context$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/context\/preview$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/ensure$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/workspace$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/workspace\/file$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/memories$/) ||
              url.pathname.match(/^\/api\/board\/projects\/([^/]+)\/memories\/([^/]+)$/) ||
              url.pathname.match(
                /^\/api\/board\/projects\/([^/]+)\/memories\/([^/]+)\/(promote|reject|deprecate)$/,
              ) ||
              url.pathname.match(/^\/api\/board\/runs\/([^/]+)\/context$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/(ready|claim|advance)$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/(block|approve|reject)$/) ||
              url.pathname.match(
                /^\/api\/board\/tickets\/([^/]+)\/(done|cancel|comment|patrol|move)$/,
              ) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/runs$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/relations$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/comments$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/activity$/) ||
              url.pathname.match(/^\/api\/board\/tickets\/([^/]+)\/timeline$/) ||
              url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)\/reorder$/) ||
              url.pathname.match(/^\/api\/board\/pipelines\/([^/]+)\/stages$/) ||
              url.pathname.match(/^\/api\/board\/stages\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/runs\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/relations\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/templates\/([^/]+)$/) ||
              url.pathname.match(/^\/api\/board\/templates\/([^/]+)\/apply$/),
          ),
      },
      {
        id: '/api/tasks',
        line: 5183,
        calls: ['_handleTasksApi', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/tasks'),
      },
      {
        id: '/api/tasks/:1',
        line: 5187,
        calls: ['_handleTaskItem', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/tasks\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: 'GET /api/tasks-executions',
        line: 5194,
        calls: ['_taskStore', 'sendJson', 'sendInternalError'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/tasks-executions' && req.method === 'GET'),
      },
      {
        id: 'GET /api/webhooks',
        line: 5203,
        calls: ['webhookRouter', 'sendJson'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/webhooks' && req.method === 'GET'),
      },
      {
        id: '/api/webhooks/:1',
        line: 5208,
        calls: ['_handleWebhook', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) =>
          Boolean(url.pathname.match(/^\/api\/webhooks\/([a-zA-Z0-9_-]+)$/)),
      },
      {
        id: '/api/wechat/*',
        line: 5223,
        calls: ['_handleWechat', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname.startsWith('/api/wechat/')),
      },
      {
        id: '/api/auth/claude/start',
        line: 5231,
        calls: ['handleOAuthStart', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/auth/claude/start'),
      },
      {
        id: '/api/auth/claude/callback',
        line: 5235,
        calls: ['handleOAuthCallback', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/auth/claude/callback'),
      },
      {
        id: '/api/auth/claude/status',
        line: 5239,
        calls: ['deps', 'sendJson'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/auth/claude/status'),
      },
      {
        id: 'POST /api/uploads',
        line: 5255,
        calls: ['handleUpload', 'sendInternalError'],
        match: (req: LegacyReq, url: URL) =>
          Boolean(url.pathname === '/api/uploads' && req.method === 'POST'),
      },
      {
        id: '/api/media/:1',
        line: 5264,
        calls: ['handleMediaGet', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname.match(/^\/api\/media\/(.+)$/)),
      },
      {
        id: '/api/file',
        line: 5280,
        calls: ['handleApiFile', 'sendInternalError'],
        match: (_req: LegacyReq, url: URL) => Boolean(url.pathname === '/api/file'),
      },
    ],
    samples: [
      '/api/changelog',
      '/api/feedback',
      '/api/search',
      '/api/cron/channels',
      '/api/cron',
      '/api/cron/a',
      '/api/cron/aaa',
      '/api/board/projects',
      '/api/board/tickets',
      '/api/board/pipelines',
      '/api/board/agents',
      '/api/board/settings',
      '/api/board/stats/cost',
      '/api/board/templates',
      '/api/board/reports/weekly',
      '/api/tasks',
      '/api/tasks/a',
      '/api/tasks/aaa',
      '/api/tasks-executions',
      '/api/webhooks',
      '/api/webhooks/a',
      '/api/webhooks/aaa',
      '/api/wechat/x',
      '/api/wechat',
      '/api/auth/claude/start',
      '/api/auth/claude/callback',
      '/api/auth/claude/status',
      '/api/uploads',
      '/api/media/x',
      '/api/media/xxx',
      '/api/file',
    ],
  },
}
