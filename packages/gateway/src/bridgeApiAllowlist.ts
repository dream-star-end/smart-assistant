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

  { label: '/api/cron', re: /^\/api\/cron$/, methods: M('GET', 'POST'), proxyFromCommercial: true },
  {
    label: '/api/cron/:id',
    re: /^\/api\/cron\/[^/]+$/,
    methods: M('GET', 'PUT', 'DELETE'),
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
