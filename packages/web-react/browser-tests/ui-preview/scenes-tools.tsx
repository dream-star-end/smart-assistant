/**
 * tools 模块(工具卡 / 智能体过程 / 检查器)的 UI 视觉预览场景。
 *
 * 文件名不含 manage/market,shoot.mjs 会把它并进 manage 组一起打包(只影响构建接线,
 * 场景归属看 Scene.group)。这里只渲染真实组件、只喂假数据,不改任何业务代码。
 *
 * 覆盖审计清单关心的形态:
 *   - 卡片四态(运行中 / 完成 / 未成功 / 已取消)+ 受阻,横跨主要内置工具;
 *   - 展开体:行级 diff + 代码高亮、diff 行数截断、长输出截断与展开、终端块(含 head 截断)、
 *     heredoc 写文件、Grep 命中高亮与文件列表、Glob、WebSearch 来源卡、WebFetch、TodoWrite、
 *     codex apply_patch(update/delete/add);
 *   - MCP / 子代理 / 记忆 / 技能 / 委派 / 审批 / 论文等富卡与兜底;
 *   - oc-* CLI 专属卡(文献 / 引用 / 报告产物 / 市场 / 浏览器 / 网页提取 / 委派 / 连接器 / 媒体 …);
 *   - 检查器:桌面第三列全文模式 vs 移动端贴底抽屉;
 *   - AgentAvatar 三种来源(emoji / lucide / 兜底)× 全站在用尺寸,以及 agent-group 内嵌套工具卡。
 *
 * 完成态卡片默认折叠,想看展开体的场景用 <ExpandAll> 在挂载后把表头点开一次
 * (等价于用户逐张点开,不动组件的默认折叠语义)。
 */
import { Briefcase, Code2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef } from 'react'
import { AgentAvatar } from '../../src/components/AgentAvatar'
import { InspectorPanel, InspectorPanelContent } from '../../src/components/InspectorPanel'
import { ToolCard, type ToolLike } from '../../src/components/ToolCard'
import { AgentGroupCard } from '../../src/components/chat/AgentGroupCard'
import { MediaSignProvider } from '../../src/components/chat/media'
import { ArtifactInspectContext } from '../../src/components/tool/context'
import { Sheet } from '../../src/components/ui'
import { type Agent, MAIN_AGENT } from '../../src/lib/agents'
import type { ChatMessage } from '../../src/lib/chat/model'
import type { Scene } from './types'

// ── 页面壳 ────────────────────────────────────────────────────────────────────

/**
 * 非滚动面场景的页面壳(同 scenes-messages 的 Page):生产 #root 是 position:fixed + 100dvh +
 * overflow:hidden,整页截图只截得到首屏;挂载期把 html/body/#root 放开成文档流,让 fullPage
 * 截到整列卡片,卸载时还原。只影响截图几何,不改任何组件样式。
 */
function Page({ children, title }: { children: ReactNode; title: string }) {
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    const root = document.getElementById('root')
    const prev = [html.style.height, body.style.height, body.style.overflow]
    const prevRoot = root ? [root.style.position, root.style.height, root.style.overflow] : null
    html.style.height = 'auto'
    body.style.height = 'auto'
    body.style.overflow = 'visible'
    if (root) {
      root.style.position = 'static'
      root.style.height = 'auto'
      root.style.overflow = 'visible'
    }
    return () => {
      ;[html.style.height, body.style.height, body.style.overflow] = prev
      if (root && prevRoot) [root.style.position, root.style.height, root.style.overflow] = prevRoot
    }
  }, [])
  return (
    <div className="min-h-screen bg-bg px-4 py-5 text-fg">
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="mb-3 text-caption font-semibold uppercase tracking-wide text-faint">
          {title}
        </h1>
        {children}
      </div>
    </div>
  )
}

/** 消息流里工具卡之间的间距由容器控制(MessageList gap)——这里用同量级的 space-y-2。 */
function CardColumn({ children }: { children: ReactNode }) {
  return <div className="space-y-2">{children}</div>
}

/** 挂载后把列内所有折叠的工具卡表头点开一次,让完成态展开体进入截图。 */
function ExpandAll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const root = ref.current
    if (!root) return
    const buttons = root.querySelectorAll<HTMLButtonElement>(
      'button[aria-expanded="false"][aria-label^="展开"]',
    )
    for (const btn of Array.from(buttons)) btn.click()
  }, [])
  return (
    <div ref={ref} className="space-y-2">
      {children}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 pt-3 first:pt-0">
      <h2 className="text-meta font-medium text-muted">{title}</h2>
      {children}
    </section>
  )
}

// ── 假媒体签名:容器绝对路径 → 内联 SVG 数据 URL,让截图/生成图缩略图真的画出来 ──

function svgDataUrl(label: string, from: string, to: string, w = 640, h = 400): string {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>`,
    `<rect width="${w}" height="${h}" rx="16" fill="url(#g)"/>`,
    `<text x="50%" y="52%" font-family="Inter, system-ui, sans-serif" font-size="28" fill="#fff" text-anchor="middle">${label}</text>`,
    '</svg>',
  ].join('')
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const FAKE_MEDIA: Record<string, string> = {
  '/home/agent/shots/login-page.png': svgDataUrl('页面截图 · 登录页', '#6366f1', '#a855f7'),
  '/home/agent/.openclaude/generated/poster-cover.png': svgDataUrl(
    '生成图片 · 海报封面',
    '#f97316',
    '#ec4899',
    512,
    512,
  ),
  '/home/agent/uploads/receipt.jpg': svgDataUrl(
    '识别的图片 · 发票',
    '#0ea5e9',
    '#14b8a6',
    480,
    320,
  ),
  '/home/agent/out/report.pdf': '/api/media?sig=preview&path=report.pdf',
  '/home/agent/out/report.qmd': '/api/media?sig=preview&path=report.qmd',
  '/home/agent/out/季度总结.docx': '/api/media?sig=preview&path=summary.docx',
}

async function fakeSign(paths: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    paths.map((p) => [p, FAKE_MEDIA[p] ?? svgDataUrl('媒体', '#64748b', '#334155')]),
  )
}

function Media({ children }: { children: ReactNode }) {
  return <MediaSignProvider sign={fakeSign}>{children}</MediaSignProvider>
}

// ── 假数据 ─────────────────────────────────────────────────────────────────────

const REPO = '/home/agent/work/openclaude/packages/web-react'

const TS_OLD = [
  'export function resolveToolMeta(name: string, input?: Record<string, unknown> | null): ToolMeta {',
  '  if (TOOL_META[name]) return TOOL_META[name];',
  '  const mcp = parseMcpName(name);',
  '  if (mcp) {',
  '    const srvMeta = MCP_SERVER_META[mcp.server];',
  '    return { icon: Wrench, label: mcp.op, tone: "neutral" };',
  '  }',
  '  return { icon: Wrench, label: name, tone: "neutral" };',
  '}',
].join('\n')

const TS_NEW = [
  'export function resolveToolMeta(name: string, input?: Record<string, unknown> | null): ToolMeta {',
  '  if (TOOL_META[name]) return TOOL_META[name];',
  '  const mcp = parseMcpName(name);',
  '  if (mcp) {',
  '    const srvMeta = MCP_SERVER_META[mcp.server];',
  '    const opMeta = MCP_OP_META[`${mcp.server}:${mcp.op}`];',
  '    if (opMeta) return { ...opMeta, tone: opMeta.tone ?? srvMeta?.tone ?? "accent" };',
  '    return { icon: Wrench, label: humanizeOp(mcp.op), tone: "neutral" };',
  '  }',
  '  return { icon: Wrench, label: name, tone: "neutral" };',
  '}',
].join('\n')

const LONG_NEW = Array.from(
  { length: 96 },
  (_, i) => `  case ${i + 1}: return "tool-${i + 1}";`,
).join('\n')

const LONG_TS_FILE = Array.from(
  { length: 70 },
  (_, i) =>
    `export const TOKEN_${i + 1} = { id: ${i + 1}, label: "语义色 token 第 ${i + 1} 项", contrast: ${(4.5 + (i % 7) * 0.3).toFixed(1)} };`,
).join('\n')

const LONG_BASH_OUT = [
  '> @openclaude/web-react@5.3.0 test',
  '> vitest run src/components/tool --maxWorkers=1',
  '',
  ...Array.from(
    { length: 40 },
    (_, i) =>
      ` ✓ src/components/tool/case-${i + 1}.test.tsx (${3 + (i % 5)} tests) ${120 + i * 7}ms`,
  ),
  '',
  ' Test Files  40 passed (40)',
  '      Tests  198 passed (198)',
  '   Start at  22:41:07',
  '   Duration  38.2s (transform 1.9s, setup 4.1s, collect 12.3s, tests 19.9s)',
].join('\n')

const GREP_OUT = [
  `${REPO}/src/components/ToolCard.tsx:84:export function ToolCard({`,
  `${REPO}/src/components/ToolCard.tsx:157:  const HeaderTag = hasBody ? ("button" as const) : ("div" as const);`,
  `${REPO}/src/components/InspectorPanel.tsx:74:export function InspectorPanelContent({`,
  `${REPO}/src/components/InspectorPanel.tsx:140:export function InspectorPanel({`,
  `${REPO}/src/components/chat/toolCardSlot.tsx:30:export function ToolCardSlot({ message, tokenUsage }: ToolCardProps) {`,
  `${REPO}/src/components/chat/AgentGroupCard.tsx:177:          <ToolCardSlot message={child} />`,
].join('\n')

const GREP_FILES = Array.from(
  { length: 36 },
  (_, i) => `${REPO}/src/components/tool/card-${String(i + 1).padStart(2, '0')}.tsx`,
).join('\n')

const WEB_SEARCH_OUT = [
  'Web search results for query: "WCAG 2.2 target size minimum"',
  '',
  '  - [Understanding Success Criterion 2.5.8: Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): The size of the target for pointer inputs is at least 24 by 24 CSS pixels, except where…',
  '  - [Target Size (Minimum) | Level AA | WCAG 2.2](https://www.a11y-collective.com/blog/wcag-target-size/): Practical guidance on the new 24×24 rule and how it differs from the 44×44 AAA criterion.',
  '  - [Touch target sizes - Apple Human Interface Guidelines](https://developer.apple.com/design/human-interface-guidelines/): Give controls a hit region of at least 44×44 points…',
  '',
  'REMINDER: Always cite sources.',
].join('\n')

const REMINDER_LIST_OUT = [
  '共 3 个定时提醒/任务:',
  '- **每日晨报整理** (ID: `daily-brief`) — `0 8 * * 1-5` · 重复 · 启用中 · 推送对话 · 下次 2026-09-16T00:00:00.000Z',
  '- **周报草稿** (ID: `weekly-report`) — `0 17 * * 5` · 重复 · 已停用 · 仅记录',
  '- **daily-reflection** (ID: `daily-reflection`) — `17 3 * * *` · 重复 · 启用中 · 仅记录 · 系统 · 下次 2026-09-16T03:17:00.000Z',
].join('\n')

const SKILL_SEARCH_OUT = [
  'Found 2 relevant skill(s) for "审计":',
  '',
  '### ui-audit-checklist [source: user, score: 5]',
  '按七类清单逐项审 UI/UX,输出带 file:line 的问题表与修复计划。',
  'tags: audit, ui, a11y',
  '',
  '### screenshot-review [source: platform, score: 3]',
  '对 ui-preview 截图逐张做视觉审查,输出对比度、间距、触控尺寸问题。',
  'tags: review, visual',
  '',
  'Use `skill_view` to read a skill.',
].join('\n')

const FANOUT_OUT = [
  '并行委派 3 个子任务已全部返回:2 成功 / 1 失败。',
  '',
  '### 1. ✅ coding-assistant — 核对 ToolCard 键盘可达性',
  '表头是 <button aria-expanded>,焦点环用 focus-visible:ring-inset;详情入口 IconButton 独立可聚焦。',
  '',
  '### 2. ✅ office-assistant — 整理 44px 触控靶清单',
  'IconButton 四档在 hover:none 下均升至 44px;卡内 text-xs 文字按钮(展开全部/收起)未覆盖。',
  '',
  '### 3. ❌ crawler-agent — 抓取 WCAG 2.2 目标尺寸原文',
  'Error: 站点返回 403,需浏览器插件授权后重试。',
].join('\n')

const LIT_OUT = JSON.stringify({
  sources: [
    {
      id: 's1',
      title: 'Touch target size and spacing for mobile interfaces',
      authors: [{ name: 'Parhi P.' }, { name: 'Karlson A.' }, { name: 'Bederson B.' }],
      year: 2006,
      venue: 'MobileHCI',
      doi: '10.1145/1152215.1152260',
      citationCount: 812,
      oa: { isOA: true, url: 'https://example.org/oa/parhi2006.pdf' },
    },
    {
      id: 's2',
      title: 'Web Content Accessibility Guidelines (WCAG) 2.2',
      authors: [{ name: 'W3C Accessibility Guidelines Working Group' }],
      year: 2023,
      venue: 'W3C Recommendation',
      citationCount: 120,
    },
    {
      id: 's3',
      title: 'A retracted study on color contrast perception',
      authors: [{ name: 'Doe J.' }, { name: 'Roe R.' }, { name: 'Poe E.' }, { name: 'Moe M.' }],
      year: 2019,
      venue: 'J. Vis.',
      doi: '10.1000/retracted.1',
      retracted: true,
      citationCount: 9,
    },
  ],
  warnings: ['OpenAlex 限流,部分结果来自缓存'],
})

const CITE_OUT = JSON.stringify({
  verdicts: [
    {
      identifier: '10.1145/1152215.1152260',
      resolved: true,
      retracted: false,
      gbt7714:
        'Parhi P, Karlson A K, Bederson B B. Target size study for one-handed thumb use on small touchscreen devices[C]//MobileHCI. 2006: 203-210.',
    },
    {
      identifier: '10.1000/retracted.1',
      resolved: true,
      retracted: true,
      apa: 'Doe, J., & Roe, R. (2019). A retracted study on color contrast perception. J. Vis.',
    },
    { identifier: 'arXiv:9999.99999', resolved: false },
  ],
})

const REPORT_OUT = JSON.stringify({
  output: '/home/agent/out/report.pdf',
  qmd: '/home/agent/out/report.qmd',
  references: 12,
  coverage: { verifiedClaims: 9, totalClaims: 11 },
  warnings: ['第 4 节第 2 条论断未找到直接引文支撑'],
})

const MARKET_OUT = JSON.stringify(
  Array.from({ length: 11 }, (_, i) => ({
    slug: `skill-${i + 1}`,
    name: [
      'UI 审计清单',
      '截图对比',
      '无障碍检查',
      '文案润色',
      '周报生成',
      '论文检索',
      '表格整理',
      '海报设计',
      '视频脚本',
      '数据抓取',
      '代码评审',
    ][i],
    kind: i % 4 === 3 ? 'agent' : 'skill',
    version: `1.${i}.0`,
    description: `第 ${i + 1} 项能力的一句话说明,用于验证列表在窄屏下的两行截断与「查看更多」渐进加载。`,
  })),
)

const OC_WEB_OUT = [
  '# Target Size (Minimum) — Understanding SC 2.5.8',
  '',
  'The intent of this Success Criterion is to ensure targets can be easily activated without accidentally activating an adjacent target. Targets must be at least 24 by 24 CSS pixels, with exceptions for inline targets and where spacing compensates.',
  '',
  '## Benefits',
  '',
  '- People with hand tremors or limited dexterity.',
  '- People using a device in a moving environment.',
  '',
  '## Examples',
  '',
  'A toolbar of 20×20 icons spaced so that the 24px circles do not overlap passes; a 16×16 close button touching its neighbour fails.',
].join('\n')

const SCANSCI_OUT = JSON.stringify({
  results: [
    {
      title: "Fitts' law and touch: revisiting target acquisition on tablets",
      authors: ['Bi X.', 'Li Y.', 'Zhai S.'],
      year: 2013,
      doi: '10.1145/2470654.2466180',
      source: 'openalex',
    },
    {
      title: 'Designing for thumbs: reachability on large phones',
      authors: ['Hoober S.'],
      year: 2017,
      source: 'semanticscholar',
    },
  ],
})

const CURSOR_SHELL_FAIL = JSON.stringify({
  success: {
    command: 'npm run test:browser',
    exitCode: 1,
    stdout: '',
    stderr:
      "Error: browserType.launch: Executable doesn't exist at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  },
  isBackground: false,
})

/** 稳定 key 的工具卡列表(ToolCard 要求稳定 key,展开态才跨重渲存活)。 */
type Row = {
  key: string
  message: ToolLike
  tokenUsage?: { totalTokens: number; callId?: string; shared?: boolean }
}

function Cards({ rows }: { rows: Row[] }) {
  return (
    <>
      {rows.map((r) => (
        <ToolCard key={r.key} message={r.message} tokenUsage={r.tokenUsage} />
      ))}
    </>
  )
}

// ── 场景 1:四态 + 受阻 ───────────────────────────────────────────────────────

const STATE_ROWS: Row[] = [
  {
    key: 'run-bash',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'npm run typecheck --workspace packages/web-react' },
      _completed: false,
      bashTail: {
        tail: '> @openclaude/web-react@5.3.0 typecheck\n> tsc -b\n\n正在检查 src/components/tool/bodies.tsx …',
        totalBytes: 118,
        truncatedHead: false,
      },
    },
  },
  {
    key: 'run-task',
    message: {
      toolName: 'Task',
      inputJson: {
        description: '核对 InspectorPanel 的键盘可达性',
        prompt: 'You are running inside OpenClaude …',
        subagentType: 'generalPurpose',
      },
      _completed: false,
    },
  },
  {
    key: 'run-codex-img',
    message: {
      toolName: 'codex:imageGeneration',
      inputJson: {
        type: 'imageGeneration',
        id: 'ig_run',
        status: 'in_progress',
        prompt: '一张展示四种工具卡状态的示意海报',
      },
      _completed: false,
    },
  },
  {
    key: 'done-read',
    message: {
      toolName: 'Read',
      inputJson: { file_path: `${REPO}/src/components/ToolCard.tsx` },
      output: LONG_TS_FILE,
      _completed: true,
    },
  },
  {
    key: 'done-edit',
    message: {
      toolName: 'Edit',
      inputJson: {
        file_path: `${REPO}/src/components/tool/meta.ts`,
        old_string: TS_OLD,
        new_string: TS_NEW,
      },
      output: 'The file has been updated.',
      _completed: true,
    },
  },
  {
    key: 'done-grep',
    message: {
      toolName: 'Grep',
      inputJson: { pattern: 'ToolCardSlot', path: REPO, output_mode: 'content' },
      output: GREP_OUT,
      _completed: true,
    },
  },
  {
    key: 'done-websearch',
    message: {
      toolName: 'WebSearch',
      inputJson: { query: 'WCAG 2.2 target size minimum' },
      output: WEB_SEARCH_OUT,
      _completed: true,
    },
  },
  {
    key: 'done-todo',
    message: {
      toolName: 'TodoWrite',
      inputJson: {
        todos: [
          { content: '读 ToolCard / InspectorPanel 源码', status: 'completed' },
          { content: '新增 ui-preview 场景', status: 'completed' },
          {
            content: '逐张审查 before 截图',
            status: 'in_progress',
            activeForm: '正在逐张审查 before 截图',
          },
          { content: '写审计报告五节', status: 'pending' },
          { content: 'typecheck + 提交', status: 'pending' },
        ],
      },
      _completed: true,
    },
  },
  {
    key: 'done-tokens',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'git status -sb' },
      output: '## feat/v5-selfhost-audit-tools\n?? docs/audit/tools.md',
      _completed: true,
    },
    tokenUsage: { totalTokens: 12_480, callId: 'ccb-1' },
  },
  {
    key: 'done-shared',
    message: {
      toolName: 'Glob',
      inputJson: { pattern: 'src/components/tool/**/*.tsx' },
      output: 'bodies.tsx\nconnectorCards.tsx',
      _completed: true,
    },
    tokenUsage: { totalTokens: 123_456, callId: 'ccb-2', shared: true },
  },
  {
    key: 'err-edit',
    message: {
      toolName: 'Edit',
      inputJson: {
        file_path: `${REPO}/src/components/tool/format.ts`,
        old_string: 'export function shortPath(p: unknown)',
        new_string: 'export function shortPath(p: unknown, keep = 3)',
      },
      output: 'String to replace not found in file.\nString: export function shortPath(p: unknown)',
      error: true,
      _completed: true,
    },
  },
  {
    key: 'err-bash-exit',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'npm run test:browser' },
      output: CURSOR_SHELL_FAIL,
      _completed: true,
    },
  },
  {
    key: 'cancel-agent',
    message: {
      toolName: 'Agent',
      inputJson: { description: '抓取 WCAG 目标尺寸原文' },
      _completed: false,
      _timelineRecord: true,
      _dispatchOutcome: 'interrupted',
    },
  },
  {
    key: 'cancel-codex',
    message: {
      toolName: 'codex:mcpToolCall',
      inputJson: {
        type: 'mcpToolCall',
        id: 'c1',
        server: 'openclaude_memory',
        tool: 'skill_search',
        status: 'cancelled',
        arguments: { query: 'audit' },
      },
      output: JSON.stringify({
        type: 'mcpToolCall',
        id: 'c1',
        server: 'openclaude_memory',
        tool: 'skill_search',
        status: 'cancelled',
        arguments: { query: 'audit' },
      }),
      _completed: true,
    },
  },
  {
    key: 'blocked-web',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-web extract https://blocked.example.com/pricing' },
      output: 'oc-web: blocked: Cloudflare challenge',
      _completed: true,
    },
  },
  {
    key: 'long-path',
    message: {
      toolName: 'Read',
      inputJson: {
        file_path: `${REPO}/src/components/settings/organization/billing/invoices/InvoiceLineItemBreakdownTable.stories.tsx`,
        offset: 120,
        limit: 60,
      },
      output: '// 用于验证表头摘要在 390px 下的截断',
      _completed: true,
    },
  },
  {
    key: 'no-body',
    message: { toolName: 'Read', _completed: true },
  },
]

// ── 场景 2:展开体 ─────────────────────────────────────────────────────────────

const BODY_ROWS: Row[] = [
  {
    key: 'edit-diff',
    message: {
      toolName: 'Edit',
      inputJson: {
        file_path: `${REPO}/src/components/tool/meta.ts`,
        old_string: TS_OLD,
        new_string: TS_NEW,
      },
      output: 'The file has been updated.',
      _completed: true,
    },
  },
  {
    key: 'edit-long',
    message: {
      toolName: 'Edit',
      inputJson: {
        file_path: `${REPO}/src/components/tool/labels.ts`,
        old_string: '',
        new_string: LONG_NEW,
      },
      _completed: true,
    },
  },
  {
    key: 'write-content',
    message: {
      toolName: 'Write',
      inputJson: { file_path: `${REPO}/src/lib/designTokens.ts`, content: LONG_TS_FILE },
      output:
        'File created successfully at /home/agent/work/openclaude/packages/web-react/src/lib/designTokens.ts',
      _completed: true,
    },
  },
  {
    key: 'read-long',
    message: {
      toolName: 'Read',
      inputJson: { file_path: `${REPO}/src/lib/designTokens.ts`, offset: 1, limit: 70 },
      output: LONG_TS_FILE,
      _completed: true,
    },
  },
  {
    key: 'bash-long',
    message: {
      toolName: 'Bash',
      inputJson: {
        command: 'cd packages/web-react && npx vitest run src/components/tool --maxWorkers=1',
      },
      _completed: true,
      bashTail: { tail: LONG_BASH_OUT, totalBytes: 48_213, truncatedHead: true },
    },
  },
  {
    key: 'bash-heredoc',
    message: {
      toolName: 'Bash',
      inputJson: {
        command: `mkdir -p ${REPO}/docs && cat > ${REPO}/docs/tools-audit-notes.md <<'EOF'\n# tools 审计笔记\n\n- 表头 44px 触控\n- 键盘可达\nEOF`,
      },
      output: '',
      _completed: true,
    },
  },
  {
    key: 'grep-content',
    message: {
      toolName: 'Grep',
      inputJson: { pattern: 'ToolCard(Slot)?', path: REPO, output_mode: 'content', glob: '*.tsx' },
      output: GREP_OUT,
      _completed: true,
    },
  },
  {
    key: 'grep-files',
    message: {
      toolName: 'Grep',
      inputJson: { pattern: 'useToolCardActions', path: REPO, output_mode: 'files_with_matches' },
      output: GREP_FILES,
      _completed: true,
    },
  },
  {
    key: 'glob',
    message: {
      toolName: 'Glob',
      inputJson: { pattern: 'src/components/tool/*.test.{ts,tsx}', path: REPO },
      output: [
        'bodyCards.test.tsx',
        'connectorCards.test.tsx',
        'delegateFanoutCard.test.tsx',
        'grokDisplay.test.ts',
        'lineDiff.test.ts',
        'meta.test.ts',
      ]
        .map((f) => `${REPO}/src/components/tool/${f}`)
        .join('\n'),
      _completed: true,
    },
  },
  {
    key: 'websearch',
    message: {
      toolName: 'WebSearch',
      inputJson: { query: 'WCAG 2.2 target size minimum', allowed_domains: ['w3.org'] },
      output: WEB_SEARCH_OUT,
      _completed: true,
    },
  },
  {
    key: 'webfetch',
    message: {
      toolName: 'WebFetch',
      inputJson: {
        url: 'https://api.github.com/repos/openclaude/openclaude/pulls/1284',
        prompt: '提取 PR 标题、状态与改动文件数',
      },
      output: JSON.stringify({
        title: 'feat(v5): tools 卡片触控靶与键盘可达性',
        state: 'open',
        changed_files: 7,
        additions: 214,
        deletions: 58,
      }),
      _completed: true,
    },
  },
  {
    key: 'todo',
    message: {
      toolName: 'TodoWrite',
      inputJson: {
        todos: [
          { content: '读源码', status: 'completed' },
          { content: '出截图', status: 'in_progress', activeForm: '正在出 before 截图' },
          { content: '写报告', status: 'pending' },
        ],
      },
      _completed: true,
    },
  },
  {
    key: 'codex-update',
    message: {
      toolName: 'Edit',
      inputJson: {
        file_path: `${REPO}/src/components/tool/expandable.tsx`,
        kind: 'update',
        changes: [
          {
            path: `${REPO}/src/components/tool/expandable.tsx`,
            kind: { type: 'update' },
            diff: "@@ -62,3 +62,3 @@\n const CONTROL_BTN_CLS =\n-  'rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring'\n+  'rounded text-xs text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11'\n",
          },
          {
            path: `${REPO}/src/components/tool/legacyClamp.tsx`,
            kind: { type: 'delete' },
            diff: '',
          },
        ],
      },
      output: `update: ${REPO}/src/components/tool/expandable.tsx`,
      _completed: true,
    },
  },
  {
    key: 'codex-add',
    message: {
      toolName: 'Write',
      inputJson: {
        file_path: `${REPO}/docs/audit/tools.md`,
        kind: 'add',
        changes: [
          {
            path: `${REPO}/docs/audit/tools.md`,
            kind: { type: 'add' },
            diff: '+# tools 审计\n+\n+## 1. 范围与文件清单\n+\n+- ToolCard.tsx\n+- InspectorPanel.tsx\n',
          },
        ],
      },
      output: `add: ${REPO}/docs/audit/tools.md`,
      _completed: true,
    },
  },
]

// ── 场景 3:MCP / 子代理 / 记忆 / 技能 / 委派 ─────────────────────────────────

const MCP_ROWS: Row[] = [
  {
    key: 'nav',
    message: {
      toolName: 'mcp__browser__browser_navigate',
      inputJson: { url: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html' },
      output: 'Navigated. Page Title: Understanding SC 2.5.8',
      _completed: true,
    },
  },
  {
    key: 'click',
    message: {
      toolName: 'mcp__browser__browser_click',
      inputJson: { element: '「展开详情」按钮', ref: 'e42' },
      output: 'Clicked element e42',
      _completed: true,
    },
  },
  {
    key: 'shot',
    message: {
      toolName: 'mcp__browser__browser_take_screenshot',
      inputJson: { filename: '/home/agent/shots/login-page.png' },
      output: 'Saved screenshot to /home/agent/shots/login-page.png',
      _completed: true,
    },
  },
  {
    key: 'eval',
    message: {
      toolName: 'mcp__browser__browser_evaluate',
      inputJson: {
        function:
          "() => [...document.querySelectorAll('button')].filter(b => b.getBoundingClientRect().height < 44).length",
      },
      output: '17',
      _completed: true,
    },
  },
  {
    key: 'reminders',
    message: {
      toolName: 'mcp__openclaude-memory__list_reminders',
      inputJson: {},
      output: REMINDER_LIST_OUT,
      _completed: true,
    },
  },
  {
    key: 'skill-search',
    message: {
      toolName: 'mcp__openclaude-memory__skill_search',
      inputJson: { query: '审计' },
      output: SKILL_SEARCH_OUT,
      _completed: true,
    },
  },
  {
    key: 'skill-save',
    message: {
      toolName: 'mcp__openclaude-memory__skill_save',
      inputJson: {
        name: 'tools-card-audit',
        description: '工具卡审计:四态、触控靶、键盘、截断展开、文案术语。',
        tags: ['audit', 'ui', 'a11y'],
        body: '# tools-card-audit\n\n1. 用 ui-preview 出四张图\n2. 按 §5 七类逐项过\n3. 每条问题带 file:line',
      },
      output: 'Saved skill tools-card-audit (user).',
      _completed: true,
    },
  },
  {
    key: 'fanout',
    message: {
      toolName: 'mcp__openclaude-memory__delegate_tasks',
      inputJson: {
        tasks: [
          { agentId: 'coding-assistant', goal: '核对 ToolCard 键盘可达性' },
          { agentId: 'office-assistant', goal: '整理 44px 触控靶清单' },
          { agentId: 'crawler-agent', goal: '抓取 WCAG 2.2 目标尺寸原文' },
        ],
      },
      output: FANOUT_OUT,
      _completed: true,
    },
  },
  {
    key: 'advisor',
    message: {
      toolName: 'mcp__openclaude-memory__consult_advisor',
      inputJson: { question: '工具卡内的文字按钮要不要统一升到 44px?', model: 'advisor-opus-5' },
      outputJson: {
        advice:
          '建议统一:卡内「展开全部 / 收起 / 继续显示」都是高频触控点,应与 IconButton 一样在 hover:none 下补 min-h-11;桌面渲染零变化。',
        model: 'advisor-opus-5',
        status: 'settled',
        durationMs: 4180,
        usage: { inputTokens: 1820, outputTokens: 140 },
      },
      output: '',
      _completed: true,
    },
  },
  {
    key: 'approval',
    message: {
      toolName: 'mcp__openclaude-memory__present_task_approval',
      inputJson: { id: 'OCV5-312', prompt: '修复计划已就绪,是否批准开工?' },
      output: '',
      _completed: true,
    },
  },
  {
    key: 'reminder-err',
    message: {
      toolName: 'mcp__openclaude-memory__create_reminder',
      inputJson: { schedule: 'every monday 9', message: '周会前整理待办' },
      output: 'error: 创建提醒失败: 无法解析计划 "every monday 9"',
      error: true,
      _completed: true,
    },
  },
  {
    key: 'scansci',
    message: {
      toolName: 'mcp__scansci-pdf__scansci_pdf_search',
      inputJson: { query: 'touch target acquisition tablets' },
      output: SCANSCI_OUT,
      _completed: true,
    },
  },
  {
    key: 'sub-agent',
    message: {
      toolName: 'codex:subAgentActivity',
      inputJson: {
        type: 'subAgentActivity',
        id: 'call_1',
        kind: 'started',
        agentThreadId: '019f-abc',
        agentPath: '/root/audit/tools',
      },
      _completed: true,
    },
  },
  {
    key: 'compaction',
    message: {
      toolName: 'codex:contextCompaction',
      inputJson: { type: 'contextCompaction', id: 'ctx1' },
      output: JSON.stringify({
        type: 'contextCompaction',
        id: 'ctx1',
        tokensBefore: 182_000,
        tokensAfter: 61_000,
        note: '保留了最近 6 轮与全部工具结果摘要',
      }),
      _completed: true,
    },
  },
  {
    key: 'mcp-resources',
    message: {
      toolName: 'mcp__codex__list_mcp_resources',
      inputJson: {},
      output: JSON.stringify({ resources: [] }),
      _completed: true,
    },
  },
  {
    key: 'search-extra',
    message: {
      toolName: 'SearchExtraTools',
      inputJson: { query: 'reminder' },
      output:
        'Found 3 deferred tool(s): mcp__openclaude-memory__create_reminder, mcp__openclaude-memory__list_reminders, mcp__openclaude-memory__delete_reminder.\nUse ExecuteExtraTool to call them.',
      _completed: true,
    },
  },
  {
    key: 'generic-mcp',
    message: {
      toolName: 'mcp__quant-system__backtest_run',
      inputJson: {
        strategy: 'mean-reversion',
        from: '2026-01-01',
        to: '2026-06-30',
        capital: 100000,
      },
      output: JSON.stringify({ sharpe: 1.42, maxDrawdown: -0.083, trades: 212 }),
      _completed: true,
    },
  },
  {
    key: 'task-done',
    message: {
      toolName: 'Agent',
      inputJson: { description: '核对 44px 触控靶', prompt: 'internal prompt' },
      output:
        '结论:ToolCard 表头 min-h-11 达标;卡内 4 处文字按钮(展开全部/收起/继续显示/查看更多)在触屏下高度 16–20px,未达标。',
      _completed: true,
    },
  },
  {
    key: 'task-output',
    message: {
      toolName: 'TaskOutput',
      inputJson: { task_ids: ['call-7fc87448-146b-411e-973e-a9271d19fe32-63'] },
      _completed: false,
    },
  },
]

// ── 场景 4:oc-* CLI 专属卡 ────────────────────────────────────────────────────

const OC_ROWS: Row[] = [
  {
    key: 'lit',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-lit search "touch target size mobile" --limit 3' },
      output: LIT_OUT,
      _completed: true,
    },
  },
  {
    key: 'cite',
    message: {
      toolName: 'Bash',
      inputJson: {
        command: 'oc-cite verify 10.1145/1152215.1152260 10.1000/retracted.1 arXiv:9999.99999',
      },
      output: CITE_OUT,
      _completed: true,
    },
  },
  {
    key: 'report',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-report build --input notes.md --out /home/agent/out/report.pdf' },
      output: REPORT_OUT,
      _completed: true,
    },
  },
  {
    key: 'market',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-market search 审计' },
      output: MARKET_OUT,
      _completed: true,
    },
  },
  {
    key: 'browser',
    message: {
      toolName: 'Bash',
      inputJson: {
        command:
          'oc-browser open "https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html" && oc-browser snapshot',
      },
      output:
        '- Page URL: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html\n- Page Title: Understanding Success Criterion 2.5.8: Target Size (Minimum)\n- Page Snapshot:\n```yaml\n- banner:\n  - link "W3C"\n- main:\n  - heading "Target Size (Minimum)" [level=1]\n```',
      _completed: true,
    },
  },
  {
    key: 'web',
    message: {
      toolName: 'Bash',
      inputJson: {
        command:
          'oc-web extract --url https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html',
      },
      output: OC_WEB_OUT,
      _completed: true,
    },
  },
  {
    key: 'delegate-run',
    message: {
      toolName: 'Bash',
      text: 'Bash',
      output: null,
      inputJson: {
        command:
          'oc-memory delegate --agent-id coding-assistant --goal "把卡内文字按钮升到 44px 触控靶"',
      },
      _completed: false,
    },
  },
  {
    key: 'session-search',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-memory session-search "触控靶 44px"' },
      output:
        '找到 2 条相关历史:\n1. 09-12 · shell 审计 · IconButton 四档在 hover:none 下升到 44px 已下沉进原语。\n2. 09-14 · composer 审计 · 附件 chip 的删除按钮触控靶 28px,待修。',
      _completed: true,
    },
  },
  {
    key: 'connect',
    message: {
      toolName: 'Bash',
      inputJson: {
        command:
          'oc-connect call feishu send_message --chat "审计群" --text "tools 阶段 A 报告已提交"',
      },
      output:
        '{"oc_connect":{"type":"confirmation_required","id":"c0ffee12-3456-7890-abcd-ef0123456789"}}',
      error: true,
      _completed: true,
    },
  },
  {
    key: 'mmx',
    message: {
      toolName: 'Bash',
      inputJson: {
        command:
          'mmx image --prompt "四种工具卡状态的示意海报" --out /home/agent/.openclaude/generated',
      },
      output: '/home/agent/.openclaude/generated/poster-cover.png\nbilling: 12 credits',
      _completed: true,
    },
  },
  {
    key: 'vision',
    message: {
      toolName: 'Bash',
      inputJson: {
        command: 'oc-vision understand /home/agent/uploads/receipt.jpg --prompt "发票金额与日期"',
      },
      output: '金额:¥1,280.00;开票日期:2026-09-12;销售方:某某科技有限公司。',
      _completed: true,
    },
  },
  {
    key: 'task',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-task ticket get OCV5-312 --json' },
      output: JSON.stringify({
        identifier: 'OCV5-312',
        title: 'tools 卡片触控靶与键盘可达性',
        status: 'waiting_human',
        priority: 'P2',
        assignee: 'coding-assistant',
        labels: ['ui', 'a11y'],
        body: '把卡内文字按钮升到 44px;详情面板补焦点管理。',
        created_at: '2026-09-15T10:00:00Z',
      }),
      _completed: true,
    },
  },
  {
    key: 'docx',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-docx build notes.md -o /home/agent/out/季度总结.docx' },
      output: 'pandoc: writing /home/agent/out/季度总结.docx',
      _completed: true,
    },
  },
  {
    key: 'memory-fail',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-memory archival-search "触控靶"' },
      output: JSON.stringify({
        success: {
          command: 'oc-memory archival-search',
          exitCode: 2,
          stdout: '',
          stderr: 'oc-memory: active turn policy is missing or expired',
        },
        isBackground: false,
      }),
      error: true,
      _completed: true,
    },
  },
  {
    key: 'xlsx',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'oc-xlsx build data.json --output ./out/触控靶清单.xlsx' },
      output: 'wrote 3 sheets',
      _completed: true,
    },
  },
]

// ── 场景 5:检查器 ─────────────────────────────────────────────────────────────

const INSPECT_TARGET: ToolLike = {
  toolName: 'Edit',
  inputJson: {
    file_path: `${REPO}/src/components/tool/labels.ts`,
    old_string: TS_OLD,
    new_string: `${TS_NEW}\n${LONG_NEW}`,
  },
  output: 'The file has been updated.',
  _completed: true,
}

const INSPECT_ROWS: Row[] = [
  { key: 'i-edit', message: INSPECT_TARGET },
  {
    key: 'i-bash',
    message: {
      toolName: 'Bash',
      inputJson: { command: 'npx vitest run src/components/tool --maxWorkers=1' },
      output: LONG_BASH_OUT,
      _completed: true,
    },
  },
  {
    key: 'i-read',
    message: {
      toolName: 'Read',
      inputJson: { file_path: `${REPO}/src/lib/designTokens.ts` },
      output: LONG_TS_FILE,
      _completed: true,
    },
  },
]

function InspectorDesktop() {
  return (
    <ArtifactInspectContext.Provider value={{ open: () => {} }}>
      <div className="flex h-screen bg-bg text-fg">
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <div className="mx-auto w-full max-w-3xl space-y-2">
              <Cards rows={INSPECT_ROWS} />
            </div>
          </div>
        </main>
        <InspectorPanel target={{ kind: 'tool', message: INSPECT_TARGET }} onClose={() => {}} />
      </div>
    </ArtifactInspectContext.Provider>
  )
}

/** 窄屏(<md):App 用贴底 Sheet 复用同一 InspectorPanelContent。截图由 shoot.mjs 裁到 [role=dialog]。 */
function InspectorMobile() {
  return (
    <ArtifactInspectContext.Provider value={{ open: () => {} }}>
      <div className="h-screen bg-bg p-3 text-fg">
        <div className="space-y-2">
          <Cards rows={INSPECT_ROWS} />
        </div>
      </div>
      <Sheet open onOpenChange={() => {}} side="bottom" srTitle="产物详情" className="h-[85dvh]">
        <InspectorPanelContent
          target={{ kind: 'tool', message: INSPECT_TARGET }}
          onClose={() => {}}
        />
      </Sheet>
    </ArtifactInspectContext.Provider>
  )
}

// ── 场景 6:AgentAvatar + agent-group 嵌套 ────────────────────────────────────

const CODER: Agent = {
  id: 'coding-assistant',
  name: '编程助手',
  description: '读仓库、定位报错、补测试。',
  avatarEmoji: '🧑‍💻',
  grad: 'from-sky-500 to-indigo-600',
}
const OFFICE: Agent = {
  id: 'office-assistant',
  name: '办公助手',
  description: '周报、纪要、汇报大纲。',
  avatarEmoji: '📄',
  grad: 'from-amber-400 to-orange-500',
}
const ICON_ONLY: Agent = {
  id: 'reviewer',
  name: '代码评审',
  description: '评审 diff。',
  icon: Code2,
  grad: 'from-rose-500 to-pink-600',
}
const ICON_NO_GRAD: Agent = {
  id: 'pm',
  name: '项目经理',
  description: '排期与验收。',
  icon: Briefcase,
}
const FALLBACK: Agent = { id: 'unknown', name: '未知智能体', description: '既无 emoji 也无图标。' }
const WIDE_EMOJI: Agent = {
  id: 'family',
  name: '多码点 emoji',
  description: 'ZWJ 序列。',
  avatarEmoji: '👨‍👩‍👧‍👦',
  grad: 'from-emerald-500 to-teal-600',
}

const AVATAR_AGENTS: Array<{ label: string; agent: Agent }> = [
  { label: '内置 · lucide(MAIN_AGENT)', agent: MAIN_AGENT },
  { label: '市场 · emoji', agent: CODER },
  { label: '市场 · emoji', agent: OFFICE },
  { label: '内置 · 图标 + 渐变', agent: ICON_ONLY },
  { label: '内置 · 图标,无 grad(默认紫)', agent: ICON_NO_GRAD },
  { label: '兜底 · Sparkles', agent: FALLBACK },
  { label: '多码点 emoji', agent: WIDE_EMOJI },
]

/** 全站在用的 AgentAvatar 尺寸组合(ChatHeader / AgentPicker 行 / Landing / EmptyState / AgentPicker 头)。 */
const AVATAR_SIZES: Array<{ label: string; className: string; iconSize: number }> = [
  { label: 'size-7 · ChatHeader', className: 'size-7 rounded-lg', iconSize: 15 },
  { label: 'size-10 · AgentPicker 行', className: 'size-10 rounded-lg shadow-sm', iconSize: 19 },
  { label: 'size-11 · Landing', className: 'size-11 rounded-[14px]', iconSize: 21 },
  { label: 'size-16 · EmptyState', className: 'size-16 rounded-xl2 shadow-float', iconSize: 30 },
]

function AvatarMatrix() {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface p-3">
      <table className="w-full text-caption text-muted">
        <thead>
          <tr>
            <th className="pb-2 text-left font-medium text-faint">来源</th>
            {AVATAR_SIZES.map((s) => (
              <th key={s.label} className="pb-2 text-left font-medium text-faint">
                {s.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {AVATAR_AGENTS.map(({ label, agent }) => (
            <tr key={agent.id} className="border-t border-border/60">
              <td className="py-2 pr-3 align-middle text-fg">{label}</td>
              {AVATAR_SIZES.map((s) => (
                <td key={s.label} className="py-2 pr-3 align-middle">
                  <AgentAvatar agent={agent} className={s.className} iconSize={s.iconSize} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const NOW = Date.now()

function groupMsg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'text'>): ChatMessage {
  return { role: 'agent-group', ts: NOW - 120_000, _source: 'local', ...partial } as ChatMessage
}

const GROUP_RUNNING = groupMsg({
  id: 'ag-run',
  text: '让编程助手核对工具卡触控靶',
  _delegateAgentId: 'coding-assistant',
  _delegateGoal: '核对 ToolCard 与卡内按钮的触控靶尺寸',
  _completed: false,
  childBlocks: [
    { kind: 'thinking', text: '先找出卡内所有可点元素,再量它们在 hover:none 下的高度。' },
    {
      kind: 'tool_use',
      blockId: 'b1',
      toolName: 'Grep',
      inputJson: {
        pattern: 'text-xs text-accent',
        path: `${REPO}/src/components/tool`,
        output_mode: 'files_with_matches',
      },
      output: `${REPO}/src/components/tool/expandable.tsx\n${REPO}/src/components/tool/bodies.tsx`,
      _completed: true,
    },
    {
      kind: 'tool_use',
      blockId: 'b2',
      toolName: 'Read',
      inputJson: { file_path: `${REPO}/src/components/tool/expandable.tsx` },
      output: LONG_TS_FILE.slice(0, 600),
      _completed: true,
    },
    {
      kind: 'tool_use',
      blockId: 'b3',
      toolName: 'Agent',
      inputJson: { description: '量一遍 390px 下的按钮高度' },
      _completed: false,
    },
    { kind: 'text', text: '已定位到 **4 处**卡内文字按钮,正在量高度…' },
  ],
})

const GROUP_DONE = groupMsg({
  id: 'ag-done',
  text: '让办公助手整理触控靶清单',
  _delegateAgentId: 'office-assistant',
  _completed: true,
  _duration: 42_000,
  childBlocks: [
    {
      kind: 'tool_use',
      blockId: 'c1',
      toolName: 'Bash',
      inputJson: { command: "rg -n 'min-h-11' src/components/tool | wc -l" },
      output: '0\n',
      _completed: true,
    },
    {
      kind: 'tool_use',
      blockId: 'c2',
      toolName: 'Write',
      inputJson: {
        file_path: `${REPO}/docs/audit/touch-targets.md`,
        content:
          '# 触控靶清单\n\n| 元素 | 高度 | 达标 |\n|---|---|---|\n| 表头 | 44 | ✓ |\n| 展开全部 | 16 | ✗ |',
      },
      output: 'File created successfully',
      _completed: true,
    },
    { kind: 'text', text: '清单已写入 `docs/audit/touch-targets.md`,共 6 项,2 项未达标。' },
  ],
})

const GROUP_FAILED = groupMsg({
  id: 'ag-fail',
  text: '让数据采集助手抓取 WCAG 原文',
  _delegateAgentId: 'crawler-agent',
  _completed: true,
  _isError: true,
  _delegateStatus: 'failed',
  _duration: 61_000,
  childBlocks: [
    {
      kind: 'tool_use',
      blockId: 'd1',
      toolName: 'mcp__browser__browser_navigate',
      inputJson: { url: 'https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html' },
      output: '### Error\nnet::ERR_TUNNEL_CONNECTION_FAILED',
      error: true,
      _completed: true,
    },
    { kind: 'error', text: '浏览器插件未授权,无法继续。', isError: true },
  ],
})

function AgentProcess() {
  return (
    <div className="space-y-3">
      <AgentGroupCard msg={GROUP_RUNNING} />
      <AgentGroupCard msg={GROUP_DONE} delegateCost="1280" />
      <AgentGroupCard msg={GROUP_FAILED} />
    </div>
  )
}

// ── 导出 ─────────────────────────────────────────────────────────────────────

export const toolsScenes: Scene[] = [
  {
    id: 'tools-states',
    label: '工具卡 · 四态(运行中/完成/未成功/已取消)+ 受阻 × 主要内置工具',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Page title="tools · 卡片状态(默认折叠语义原样)">
        <CardColumn>
          <Cards rows={STATE_ROWS} />
        </CardColumn>
      </Page>
    ),
  },
  {
    id: 'tools-bodies',
    label: '工具卡 · 展开体(diff/高亮/截断展开/终端/搜索/待办/apply_patch)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Page title="tools · 展开体(挂载后点开全部表头)">
        <ExpandAll>
          <Cards rows={BODY_ROWS} />
        </ExpandAll>
      </Page>
    ),
  },
  {
    id: 'tools-mcp',
    label: '工具卡 · MCP/子代理/记忆/技能/委派/审批/论文富卡与兜底',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Media>
        <Page title="tools · MCP 与智能体过程卡(挂载后点开全部表头)">
          <ExpandAll>
            <Cards rows={MCP_ROWS} />
          </ExpandAll>
        </Page>
      </Media>
    ),
  },
  {
    id: 'tools-oc-cli',
    label: '工具卡 · oc-* CLI 专属卡(文献/引用/报告/市场/浏览器/网页/委派/连接器/媒体)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Media>
        <Page title="tools · oc-* CLI 专属卡(挂载后点开全部表头)">
          <ExpandAll>
            <Cards rows={OC_ROWS} />
          </ExpandAll>
        </Page>
      </Media>
    ),
  },
  {
    id: 'tools-inspector',
    label: '检查器 · 桌面第三列全文 diff / 移动端贴底抽屉',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    // 与 App 的 useMdViewport 同一分界(md=768px):桌面内联 aside,窄屏 Sheet。
    render: () => (window.innerWidth >= 768 ? <InspectorDesktop /> : <InspectorMobile />),
  },
  {
    id: 'tools-agent-avatar',
    label: '智能体头像 · emoji/图标/兜底 × 全站尺寸 + agent-group 嵌套工具卡',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Page title="tools · AgentAvatar 与子代理过程">
        <Section title="AgentAvatar · 来源 × 尺寸">
          <AvatarMatrix />
        </Section>
        <Section title="agent-group · 运行中 / 完成 / 失败(内嵌工具卡与嵌套子任务)">
          <AgentProcess />
        </Section>
      </Page>
    ),
  },
]
