/**
 * v3 master → user-container bridge API allowlist.
 *
 * These paths may bypass the container's random personal accessToken when all
 * bridge bindings are valid: source IP is the docker bridge gateway,
 * X-OpenClaude-Container-Id matches env.OC_CONTAINER_ID, and
 * X-OpenClaude-Bridge-Nonce matches env.OC_BRIDGE_NONCE.
 *
 * Keep this list deliberately small. It is shared by:
 *   - container gateway `checkBridgeBypass()`; and
 *   - commercial master `containerApiProxy` route matching.
 */

export interface BridgeApiAllowRule {
  label: string
  re: RegExp
  methods: ReadonlySet<string>
  /** True when the commercial master may proxy this route to a per-user container. */
  proxyFromCommercial: boolean
}

const M = (...methods: string[]) => new Set(methods)

export const BRIDGE_API_ALLOWLIST: readonly BridgeApiAllowRule[] = [
  // Existing v3 file/media proxy bypass. Handled by containerFileProxy on the master side.
  {
    label: '/api/file',
    re: /^\/api\/file$/,
    methods: M('GET', 'HEAD'),
    proxyFromCommercial: false,
  },
  {
    label: '/api/media/:file',
    re: /^\/api\/media\/.+$/,
    methods: M('GET', 'HEAD'),
    proxyFromCommercial: false,
  },

  // P0/P1 commercial-safe user-container management APIs. These are host-dangerous
  // only when served by the master singleton; proxied to a user's own container they
  // operate on that user's isolated volume/session state.
  {
    // v5 纯市场模型:用户不能自建容器内 agent(其它 agent 一律走市场安装,由
    // syncMarketplaceHub 直写 agents.yaml)。故砍掉唯一的创建路径 POST /api/agents,
    // 只保留 GET(列表)。这样容器里无 source 标记的非 main agent 只可能是已退役的平台
    // 幽灵 seed → listCollaboratorAgents 的 marketplace-source 过滤可证明完备。
    label: '/api/agents',
    re: /^\/api\/agents$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id',
    re: /^\/api\/agents\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/persona',
    re: /^\/api\/agents\/[^/]+\/persona$/,
    methods: M('GET', 'PUT'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/memory/:target',
    re: /^\/api\/agents\/[^/]+\/memory\/(memory|user)$/,
    methods: M('GET', 'PUT'),
    proxyFromCommercial: true,
  },
  {
    // memdir 单条记忆文件 CRUD。:file 用 [^/]+(容器 handler 再过 basename+MEMORY_FILE_RE
    // 双保险,拒 `..`/非法名),桥门不比 handler 更松。操作用户自己容器卷内的记忆文件,故 proxy。
    label: '/api/agents/:id/memory/files/:file',
    re: /^\/api\/agents\/[^/]+\/memory\/files\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    // Auto-Dream 用户侧只读报告。容器 handler 只返回严格白名单投影，不暴露模型、
    // prompt、原始会话/记忆正文或内部错误；商业宿主仍按登录 uid 只代理进自己的容器。
    label: '/api/agents/:id/auto-dream-report',
    re: /^\/api\/agents\/[^/]+\/auto-dream-report$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/auto-dream-optimizer',
    re: /^\/api\/agents\/[A-Za-z0-9_-]+\/auto-dream-optimizer$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/auto-dream-optimizer/cancel',
    re: /^\/api\/agents\/[A-Za-z0-9_-]+\/auto-dream-optimizer\/cancel$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/auto-dream-optimizer/proposals/:proposalId/:action',
    re: /^\/api\/agents\/[A-Za-z0-9_-]+\/auto-dream-optimizer\/proposals\/[0-9a-f]{32}\/(apply|dismiss)$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/skills',
    re: /^\/api\/agents\/[^/]+\/skills$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/agents/:id/skills/:name',
    re: /^\/api\/agents\/[^/]+\/skills\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    // Cursor MCP `ask_user` 在容器内运行,经 bridge 把提问卡推到 Web。
    // handler 仅 POST;sessionKey 必须命中本容器会话且 session.agentId === :id。
    label: '/api/agents/:id/ask-user',
    re: /^\/api\/agents\/[a-zA-Z0-9_-]+\/ask-user$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  // User-level shared skill library (agentId-less). Proxied to the user's own
  // container, where it operates on that user's shared/legacy skill volume.
  {
    label: '/api/skills',
    re: /^\/api\/skills$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name',
    re: /^\/api\/skills\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  // SkillOpt training (async; train → diff → confirm-merge). All operate on the user's
  // OWN container skill volume, so they must be proxied to the container (and the
  // container re-validates incoming bridge requests against this same allowlist).
  {
    label: '/api/skills/:name/files',
    re: /^\/api\/skills\/[a-z0-9-]+\/files$/,
    methods: M('PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name/history',
    re: /^\/api\/skills\/[a-z0-9-]+\/history$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name/restore',
    re: /^\/api\/skills\/[a-z0-9-]+\/restore$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name/evals',
    re: /^\/api\/skills\/[a-z0-9-]+\/evals$/,
    methods: M('GET', 'PUT'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name/eval-run',
    re: /^\/api\/skills\/[a-z0-9-]+\/eval-run$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-eval/:runId',
    re: /^\/api\/skill-eval\/[A-Za-z0-9_-]+$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    // P1 AI 生成评测用例:启动(skill 名段 [a-z0-9-]+ 与容器路由一致)+ 状态轮询。
    // 与 /api/skills/:name/eval-run + /api/skill-eval/:runId 完全对齐(生成不落库,
    // 只回草稿供编辑器审阅保存,写仍走 PUT /api/skills/:name/evals)。
    label: '/api/skills/:name/evals/generate',
    re: /^\/api\/skills\/[a-z0-9-]+\/evals\/generate$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-eval-gen/:runId',
    re: /^\/api\/skill-eval-gen\/[A-Za-z0-9_-]+$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skills/:name/train',
    // skill name segment matches the container route exactly ([a-z0-9-]+) so the
    // bridge gate is no looser than the handler (rejects %2F/%5C/uppercase/dots).
    re: /^\/api\/skills\/[a-z0-9-]+\/train$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    // 集合端点:训练 run 列表(找回入口)。精确匹配,不吞 :runId 形态。
    label: '/api/skill-training',
    re: /^\/api\/skill-training$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-training/:runId',
    re: /^\/api\/skill-training\/[A-Za-z0-9_-]+$/,
    methods: M('GET', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-training/:runId/drafts',
    re: /^\/api\/skill-training\/[A-Za-z0-9_-]+\/drafts$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-training/:runId/drafts/:name',
    // draft :name is a skill name → match the container's [a-z0-9-]+ exactly.
    re: /^\/api\/skill-training\/[A-Za-z0-9_-]+\/drafts\/[a-z0-9-]+$/,
    methods: M('GET', 'PUT'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-training/:runId/drafts/:name/comment',
    re: /^\/api\/skill-training\/[A-Za-z0-9_-]+\/drafts\/[a-z0-9-]+\/comment$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/skill-training/:runId/merge',
    re: /^\/api\/skill-training\/[A-Za-z0-9_-]+\/merge$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  // v5 轻量组队重构:旧「团队」重后端(team_run 服务端实体 + /api/agent-teams、
  // /api/team-runs* 路由)已整套删除(gateway 路由/handler、storage teamRunStore、
  // /ws/agent 入口皆已移除),组队 = main 队长 turn 级自主 delegate_task。
  // host 侧 commercial router 的 BLOCKED_FOR_USER_RULES 仍保留 team 条目作为 deny 兜底。

  { label: '/api/cron', re: /^\/api\/cron$/, methods: M('GET', 'POST'), proxyFromCommercial: true },
  {
    label: '/api/cron/:id',
    re: /^\/api\/cron\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },

  // Taskboard (`/api/board/*`). 每条子路径 + method 都要有条目,且必须
  // proxyFromCommercial:true,否则 commercial 不代理进容器,containerRouteProxyClosure 红。
  {
    label: '/api/board/projects',
    re: /^\/api\/board\/projects$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/projects/:id',
    re: /^\/api\/board\/projects\/[^/]+$/,
    methods: M('GET', 'PATCH', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/projects/:id/board',
    re: /^\/api\/board\/projects\/[^/]+\/board$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets',
    re: /^\/api\/board\/tickets$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id',
    re: /^\/api\/board\/tickets\/[^/]+$/,
    methods: M('GET', 'PATCH'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/:action',
    re: /^\/api\/board\/tickets\/[^/]+\/(ready|claim|advance|block|approve|reject|done|cancel|comment|patrol|move)$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/runs',
    re: /^\/api\/board\/tickets\/[^/]+\/runs$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/relations',
    re: /^\/api\/board\/tickets\/[^/]+\/relations$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/comments',
    re: /^\/api\/board\/tickets\/[^/]+\/comments$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/activity',
    re: /^\/api\/board\/tickets\/[^/]+\/activity$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/tickets/:id/timeline',
    re: /^\/api\/board\/tickets\/[^/]+\/timeline$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/pipelines',
    re: /^\/api\/board\/pipelines$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/pipelines/:id',
    re: /^\/api\/board\/pipelines\/[^/]+$/,
    methods: M('GET', 'PATCH'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/pipelines/:id/stages',
    re: /^\/api\/board\/pipelines\/[^/]+\/stages$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/stages/:id',
    re: /^\/api\/board\/stages\/[^/]+$/,
    methods: M('GET', 'PATCH'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/runs/:id',
    re: /^\/api\/board\/runs\/[^/]+$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/relations/:id',
    re: /^\/api\/board\/relations\/[^/]+$/,
    methods: M('DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/agents',
    re: /^\/api\/board\/agents$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/settings',
    re: /^\/api\/board\/settings$/,
    methods: M('GET', 'PATCH'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/stats/cost',
    re: /^\/api\/board\/stats\/cost$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/templates',
    re: /^\/api\/board\/templates$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/templates/:id',
    re: /^\/api\/board\/templates\/[^/]+$/,
    methods: M('GET', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/templates/:id/apply',
    re: /^\/api\/board\/templates\/[^/]+\/apply$/,
    methods: M('POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/board/reports/weekly',
    re: /^\/api\/board\/reports\/weekly$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },

  {
    label: '/api/tasks',
    re: /^\/api\/tasks$/,
    methods: M('GET', 'POST'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/tasks/:id',
    re: /^\/api\/tasks\/[A-Za-z0-9_-]+$/,
    methods: M('GET', 'POST', 'PUT', 'DELETE'),
    proxyFromCommercial: true,
  },
  {
    label: '/api/tasks-executions',
    re: /^\/api\/tasks-executions$/,
    methods: M('GET'),
    proxyFromCommercial: true,
  },
]

export function matchBridgeApiAllowlist(path: string, method: string): BridgeApiAllowRule | null {
  const normalizedMethod = method.toUpperCase()
  for (const rule of BRIDGE_API_ALLOWLIST) {
    if (!rule.methods.has(normalizedMethod)) continue
    if (rule.re.test(path)) return rule
  }
  return null
}

export function matchCommercialContainerApiProxy(
  path: string,
  method: string,
): BridgeApiAllowRule | null {
  const rule = matchBridgeApiAllowlist(path, method)
  return rule?.proxyFromCommercial ? rule : null
}
