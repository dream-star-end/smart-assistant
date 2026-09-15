/**
 * messages 模块(消息渲染与会话时间线)的 UI 视觉预览场景。
 *
 * 直接给真实 MessageList 喂 reducer 已消化过的 ChatMessage[](不经 ChatSocket),覆盖审计清单
 * 关心的形态:富 Markdown 正文(标题/列表/表格/宽代码块/行内码/链接/引用)、思考卡折叠与
 * 实时展开、工具卡、流式光标与本轮活动指示、各类终态错误卡、用户行失败重试、计划/目标/
 * 委派/系统卡、AskUserQuestion 弹窗、会话内查找条与待回答 dock、长会话画窗 + 回到底部按钮。
 *
 * 不传 scrollParent 的场景走「非滚动面契约」(整棵树平铺,整页截图看全貌);需要滚动几何的
 * 场景自己造一个 h-screen 滚动容器并把它作为 scrollParent 传入。
 */
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { MessageList, type MessageListArchive } from '../../src/components/MessageRenderer'
import { resetPermissionAutoOpenMemory } from '../../src/components/chat/PermissionCard'
import {
  type ResponseRatingCtx,
  ResponseRatingProvider,
} from '../../src/components/chat/ResponseRating'
import type { CardCallbacks } from '../../src/components/chat/cards'
import type { ChatMessage } from '../../src/lib/chat/model'
import type { Scene } from './types'

// ── 假数据工厂 ────────────────────────────────────────────────────────────────
const NOW = Date.now()
// 每条消息按 1 分钟步进往前排;每个时间线工厂开头都要 resetClock(),否则 render() 被多次调用
// (每个视口 × 主题各一次)时 seq 会一路涨过 60,ts 跑到未来,TimeAgo 就会显示「N 分钟后」。
let seq = 0
function resetClock(): void {
  seq = 0
}
function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>): ChatMessage {
  seq += 1
  return {
    id: partial.id ?? `m-${seq}`,
    text: '',
    ts: NOW - Math.max(1, 60 - seq) * 60_000,
    _source: 'server',
    ...partial,
  }
}

const noop = () => {}
const cb: CardCallbacks = {
  onRegenerate: noop,
  onContinue: noop,
  onTopUp: noop,
  onStartNewSession: noop,
  onFeedback: noop,
  onRetrySend: noop,
  onQuote: noop,
  onEditResend: noop,
  onOpenModelPicker: noop,
  subscriptionPaid: false,
  resolveRetryTarget: () => undefined,
}

const ratingCtx: ResponseRatingCtx = {
  ratings: new Map([['a-rated', { rating: 'up', tags: [] }]]),
  submit: noop,
  sessionId: 'preview-session',
}

const RICH_MARKDOWN = `## 结论

本轮已完成对 \`packages/web-react\` 消息渲染链路的梳理，**三个结论**如下：

1. 流式期正文与思考走同一套 \`messageSignature\` memo 防闪；
2. 长会话首屏只挂载最新 80 条，更早的靠「查看更早历史记录」按钮翻出；
3. 宽内容(代码/表格)必须留在自己的滚动容器里，不能把时间线撑宽。

| 模块 | 文件 | 体量 | 风险 |
|---|---|---|---|
| 渲染入口 | MessageRenderer.tsx | 102 KB | 高 |
| 非工具卡 | chat/cards.tsx | 50 KB | 中 |
| 持久化 | lib/persist.ts | 111 KB | 高 |
| WS 状态机 | lib/chat/socket.ts | 278 KB | 高 |

> 引用:「渲染层不做业务判断，业务判断收口在 lib/chat/render.ts」。

\`\`\`ts
export function shouldShowScrollToBottom(following: boolean | undefined, messageCount: number, distance = Number.POSITIVE_INFINITY): boolean {
  return messageCount > 0 && following === false && distance > 80; // 距底 80px 内视为贴底,不显示「回到底部」
}
\`\`\`

行内代码 \`npm run typecheck --workspace packages/web-react\`，外链见 [作业手册](https://example.com/playbook)。中英文混排 English words 与数字 42 的间距请留意。`

// ── 场景 1:完整历史时间线(非流式) ──────────────────────────────────────────
function richTimeline(): ChatMessage[] {
  resetClock()
  return [
    msg({
      id: 'u-1',
      role: 'user',
      text: '帮我梳理一下 web-react 消息渲染链路，给出结论和风险表。',
      status: 'replied',
    }),
    msg({
      id: 'th-1',
      role: 'thinking',
      text: '**梳理渲染链路**\n\n先看 MessageRenderer 的分派表，再看 cards.tsx 各卡的 memo 策略。',
    }),
    msg({
      id: 'th-2',
      role: 'thinking',
      text: '**核对签名字段**\n\nmessageSignature 已覆盖 text/usage/_errorCode 等渲染所读字段。',
    }),
    msg({
      id: 'tool-1',
      role: 'tool',
      text: 'Bash',
      toolName: 'Bash',
      inputJson: { command: "rg -n 'messageSignature' packages/web-react/src | wc -l" },
      output: '27\n',
      _completed: true,
    }),
    msg({
      id: 'a-rated',
      role: 'assistant',
      text: RICH_MARKDOWN,
      completedAt: NOW - 50 * 60_000,
      usage: {
        traceId: '7f3a9c2e1b4d5e6f',
        costCredits: '1280',
        inputTokens: 5120,
        outputTokens: 860,
        totalTokens: 5980,
      },
      _clientMessageId: 'u-1',
    }),
    msg({
      id: 'u-2',
      role: 'user',
      text: '第 2 点里的 80 条是怎么定的？',
      status: 'replied',
      _replyTo: {
        messageId: 'a-rated',
        role: 'assistant',
        text: '长会话首屏只挂载最新 80 条，更早的靠「查看更早历史记录」按钮翻出',
      },
    }),
    msg({
      id: 'plan-1',
      role: 'plan',
      text: '核对 80 条阈值的来源',
      explanation: '先找常量定义，再看测试如何锁定它。',
      steps: [
        { step: '定位 TIMELINE_INITIAL_TAIL_ITEMS 常量', status: 'completed' },
        { step: '查 MessageRenderer.test 对应用例', status: 'completed' },
        { step: '确认与画窗 PAINT_MIN_ITEMS 的关系', status: 'inProgress' },
        { step: '整理结论', status: 'pending' },
      ],
    }),
    msg({
      id: 'goal-1',
      role: 'goal',
      text: '完成消息模块审计',
      goalStatus: '进行中',
      tokenBudget: 200_000,
      tokensUsed: 86_400,
      timeUsedSeconds: 1260,
    }),
    msg({
      id: 'ag-1',
      role: 'agent-group',
      text: '让编程助手核对测试用例',
      _delegateAgentId: 'coder',
      _delegateGoal: '核对 MessageRenderer.test 中 80 条阈值的断言',
      _completed: true,
      _duration: 42_000,
      _resultPreview:
        '已确认:TIMELINE_INITIAL_TAIL_ITEMS=80 在 MessageRenderer.test.tsx 的「首屏只挂尾部 80 条」用例中被锁定。',
    }),
    msg({ id: 'sys-1', role: 'system', text: '已切换到编程助手 · 模型 claude-sonnet' }),
    msg({
      id: 'a-2',
      role: 'assistant',
      text: '80 条来自 `TIMELINE_INITIAL_TAIL_ITEMS`，与画窗常量 `PAINT_MIN_ITEMS` 独立；它决定首屏挂载量，而画窗决定其中真正参与布局的行数。',
      completedAt: NOW - 20 * 60_000,
      usage: { traceId: '0c1d2e3f4a5b6c7d', costCredits: '320', totalTokens: 1420 },
      _clientMessageId: 'u-2',
      _truncated: 'max_tokens',
    }),
  ]
}

// ── 场景 2/3:流式中 ─────────────────────────────────────────────────────────
function thinkingLive(): ChatMessage[] {
  resetClock()
  return [
    msg({
      id: 'u-live',
      role: 'user',
      text: '对比一下 stickToBottom 与 wheelFence 的职责边界。',
      status: 'sent',
    }),
    msg({
      id: 'th-live',
      role: 'thinking',
      text: '**拆解两个模块**\n\nstickToBottom 是唯一的 scrollTop 写者；wheelFence 只负责在滚轮/惯性期间挂起写入。接下来看 200ms quiet window 的释放条件',
      _source: 'local',
    }),
  ]
}

function assistantStreaming(): ChatMessage[] {
  resetClock()
  return [
    msg({
      id: 'u-live',
      role: 'user',
      text: '对比一下 stickToBottom 与 wheelFence 的职责边界。',
      status: 'sent',
    }),
    msg({
      id: 'th-done',
      role: 'thinking',
      text: '**拆解两个模块**\n\n先分别读两份源码。',
      _source: 'local',
    }),
    msg({
      id: 'tool-run',
      role: 'tool',
      text: 'Bash',
      toolName: 'Bash',
      inputJson: {
        command: 'npx vitest run src/components/chat/stickToBottom.test.ts --maxWorkers=1',
      },
      _partial: false,
      _completed: false,
      bashTail: {
        tail: ' ✓ stickToBottom.test.ts (18 tests) 412ms\n ✓ wheelFence.test.ts (6 tests)',
        totalBytes: 96,
        truncatedHead: false,
      },
      _source: 'local',
    }),
    msg({
      id: 'a-stream',
      role: 'assistant',
      text: '两者是**单写者 + 篱笆**的关系：\n\n- `stickToBottom` 是唯一会写 `scrollTop` 的地方，靠「写前核对上次写入值」判断用户是否离底；\n- `wheelFence` 在滚轮/触控惯性期间挂起所有程序化写入，等 200ms 静默窗',
      _source: 'local',
    }),
  ]
}

// ── 场景 4:终态与错误形态 ──────────────────────────────────────────────────
function errorStates(): ChatMessage[] {
  resetClock()
  return [
    msg({
      id: 'u-fail',
      role: 'user',
      text: '这条消息在断网时发出去了。',
      status: 'error',
      _source: 'local',
    }),
    msg({ id: 'u-stop', role: 'user', text: '写一段 200 字的项目介绍。', status: 'replied' }),
    msg({
      id: 'a-stop',
      role: 'assistant',
      text: 'OpenClaude 个人版是一套自托管的智能体工作台，把模型、容器与',
      _errorCode: 'user_cancelled',
      _clientMessageId: 'u-stop',
      usage: { traceId: 'aa11bb22cc33dd44', costCredits: '40' },
    }),
    msg({ id: 'u-lost', role: 'user', text: '帮我跑一下全部单测。', status: 'error' }),
    msg({
      id: 'st-lost',
      role: 'assistant',
      text: '',
      _turnStatusRecord: true,
      _errorCode: 'dispatch_lost',
      _clientMessageId: 'u-lost',
    }),
    msg({ id: 'u-credit', role: 'user', text: '继续生成后半部分。', status: 'replied' }),
    msg({
      id: 'a-credit',
      role: 'assistant',
      text: '',
      _errorCode: 'insufficient_credits',
      _clientMessageId: 'u-credit',
    }),
    msg({ id: 'u-ctx', role: 'user', text: '把上面所有文件都读一遍再总结。', status: 'replied' }),
    msg({
      id: 'a-ctx',
      role: 'assistant',
      text: '',
      _errorCode: 'context_too_long',
      _clientMessageId: 'u-ctx',
    }),
    msg({ id: 'u-engine', role: 'user', text: '用 mermaid 画一下时序图。', status: 'replied' }),
    msg({
      id: 'a-engine',
      role: 'assistant',
      text: '先给出参与方：浏览器、gateway、master。\n\n[turn failed: engine exited with code 137]',
      _errorCode: 'engine_error',
      _errorDetail:
        '{"error":{"type":"internal","message":"stack overflow at renderer.ts:120"},"requestId":"9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a"}',
      _clientMessageId: 'u-engine',
    }),
    msg({
      id: 'dp-1',
      role: 'delegate-progress',
      text: '让测试助手复核用例',
      _completed: true,
      _isError: true,
      summary: '复核未完成:vitest 在 media.test.tsx 上超时退出。',
      entries: [
        {
          phase: 'tool',
          text: 'npx vitest run src/components/chat/media.test.tsx',
          ts: NOW - 30_000,
        },
        { phase: 'error', text: 'Test timed out in 40000ms', ts: NOW - 20_000, isError: true },
      ],
    }),
    msg({
      id: 'ag-fail',
      role: 'agent-group',
      text: '让编程助手修复 media.test.tsx 超时',
      _delegateAgentId: 'coder',
      _completed: true,
      _isError: true,
      _delegateStatus: 'failed',
      _duration: 61_000,
      _resultPreview: '修复失败:jsdom 下 IntersectionObserver 未定义，需补 polyfill。',
    }),
    msg({ id: 'sys-2', role: 'system', text: '连接已恢复，已同步 3 条服务端记录' }),
    msg({ id: 'u-cap', role: 'user', text: '再试一次刚才的总结。', status: 'replied' }),
    msg({
      id: 'a-cap',
      role: 'assistant',
      text: '',
      _errorCode: 'model_capacity',
      _clientMessageId: 'u-cap',
    }),
  ]
}

// ── 场景 5:AskUserQuestion 与权限卡 ────────────────────────────────────────
function permissionTimeline(liveRequestId: string): ChatMessage[] {
  resetClock()
  return [
    msg({ id: 'u-p1', role: 'user', text: '把 README 里的安装步骤改成中文。', status: 'replied' }),
    msg({
      id: 'perm-bash',
      role: 'permission',
      text: 'Bash',
      toolName: 'Bash',
      requestId: 'req-bash-1',
      inputPreview: "sed -i 's/Install/安装/' README.md",
      inputJson: { command: "sed -i 's/Install/安装/' README.md" },
      _resolved: true,
      _behavior: 'allow',
    }),
    msg({
      id: 'perm-aq-done',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-aq-done',
      inputJson: {
        questions: [
          {
            question: '术语「Install」统一译为？',
            header: '术语',
            options: [{ label: '安装' }, { label: '部署' }],
          },
        ],
      },
      _resolved: true,
      _behavior: 'allow',
      _answers: { '术语「Install」统一译为？': '安装' },
    }),
    msg({
      id: 'a-p1',
      role: 'assistant',
      text: '已按「安装」统一替换 3 处。',
      _clientMessageId: 'u-p1',
      usage: { traceId: '1234567890abcdef' },
    }),
    msg({ id: 'u-p2', role: 'user', text: '接着把贡献指南也翻一下。', status: 'sent' }),
    msg({
      id: 'perm-aq-live',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: liveRequestId,
      ts: NOW,
      _askUserExpiresAt: NOW + 20 * 60_000,
      _source: 'local',
      inputJson: {
        questions: [
          {
            question: '贡献指南里的 PR 模板要保留英文原文对照吗？',
            header: 'PR 模板',
            options: [
              { label: '保留英文对照', description: '中英双语,便于海外贡献者' },
              { label: '只保留中文', description: '更简洁,面向国内团队' },
            ],
          },
          {
            question: '需要同步更新哪些文档？',
            header: '范围',
            multiSelect: true,
            options: [
              { label: 'CONTRIBUTING.md' },
              { label: 'CODE_OF_CONDUCT.md' },
              { label: 'docs/ 目录' },
            ],
          },
        ],
      },
    }),
  ]
}

// ── 场景 6:查找条 + 待回答 dock ────────────────────────────────────────────
function findTimeline(): ChatMessage[] {
  resetClock()
  return [
    msg({
      id: 'u-f1',
      role: 'user',
      text: '解释一下 wheelFence 的 quiet window。',
      status: 'replied',
    }),
    msg({
      id: 'a-f1',
      role: 'assistant',
      text: 'quiet window 是 200ms：最后一次滚轮输入之后 200ms 内没有新输入且滚动已静止，篱笆才释放。',
      _clientMessageId: 'u-f1',
    }),
    msg({
      id: 'perm-aq-dock',
      role: 'permission',
      text: 'AskUserQuestion',
      toolName: 'AskUserQuestion',
      requestId: 'req-aq-dock',
      ts: NOW,
      _askUserExpiresAt: NOW + 20 * 60_000,
      inputJson: {
        questions: [
          { question: '要把 200ms 改成可配置吗？', options: [{ label: '要' }, { label: '不要' }] },
        ],
      },
    }),
    msg({ id: 'u-f2', role: 'user', text: '先不改，继续看 stickToBottom。', status: 'replied' }),
    msg({
      id: 'a-f2',
      role: 'assistant',
      text: 'stickToBottom 只在 scroll 事件里根据「上次写入值」判断离底/重新贴底，不设手势计时器。',
      _clientMessageId: 'u-f2',
    }),
  ]
}

// ── 场景 7:长会话画窗 + 回到底部 ────────────────────────────────────────────
function longTimeline(count: number): ChatMessage[] {
  resetClock()
  const out: ChatMessage[] = []
  for (let i = 0; i < count; i++) {
    const user = i % 2 === 0
    out.push(
      msg({
        id: `long-${i}`,
        role: user ? 'user' : 'assistant',
        text: user
          ? `第 ${i / 2 + 1} 个问题：这一段长会话里第 ${i + 1} 条消息。`
          : `第 ${(i + 1) / 2} 个回答：用于验证首屏尾窗 80 条与画窗 spacer 的长会话消息 #${i + 1}。`,
        status: user ? 'replied' : undefined,
      }),
    )
  }
  return out
}

const archiveMore: MessageListArchive = {
  hasMore: true,
  loading: false,
  error: false,
  onLoadOlder: noop,
}

/**
 * 非滚动面场景的页面壳。生产 body 是 overflow:hidden(滚动只发生在内部 overflow-y-auto 容器里),
 * 整页截图因此只能截到首屏;这里在挂载期把 html/body 放开成文档流滚动,让 fullPage 截到整条
 * 时间线,卸载时还原。只影响截图几何,不改任何组件样式。
 */
function Page({ children }: { children: ReactNode }) {
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    // 生产 #root 是 position:fixed + 100dvh + overflow:hidden(见 styles.css),同样要放开。
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
  return <div className="min-h-screen bg-bg text-fg">{children}</div>
}

function StaticList(
  props: Partial<Parameters<typeof MessageList>[0]> & { messages: ChatMessage[] },
) {
  return (
    <Page>
      <ResponseRatingProvider value={ratingCtx}>
        <MessageList
          sending={false}
          cb={cb}
          onRespondPermission={noop}
          sessionId="preview-session"
          {...props}
        />
      </ResponseRatingProvider>
    </Page>
  )
}

/** 造一个真实滚动容器,挂载后滚回顶部,让「回到底部」与本地窗口按钮同时进画面。 */
function ScrollWindowScene() {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const messages = useMemo(() => longTimeline(120), [])
  const followBottomRef = useMemo(
    () => ({
      current: false,
      jumpToBottom: (el: { scrollTop: number; scrollHeight: number }) => {
        el.scrollTop = el.scrollHeight
      },
    }),
    [],
  )
  useEffect(() => {
    if (!scroller) return
    const id = window.setTimeout(() => {
      scroller.scrollTop = 0
    }, 120)
    return () => window.clearTimeout(id)
  }, [scroller])
  return (
    <div
      ref={setScroller}
      className="h-screen overflow-y-auto overflow-x-hidden bg-bg text-fg chat-scroll-area"
    >
      <MessageList
        messages={messages}
        sending={false}
        cb={cb}
        onRespondPermission={noop}
        sessionId="preview-long"
        scrollParent={scroller}
        followBottomRef={followBottomRef}
        archive={archiveMore}
      />
    </div>
  )
}

export const messagesScenes: Scene[] = [
  {
    id: 'messages-timeline-rich',
    label: '消息 · 完整历史时间线(富文本/思考/工具/计划/目标/委派/系统卡)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <StaticList messages={richTimeline()} archive={archiveMore} />,
  },
  {
    id: 'messages-thinking-live',
    label: '消息 · 思考卡实时展开 + 本轮活动指示',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <StaticList
        messages={thinkingLive()}
        sending
        turnActivity={{ startedAt: NOW - 8_000, lastFrameAt: NOW - 500, agentName: '主助手' }}
      />
    ),
  },
  {
    id: 'messages-assistant-streaming',
    label: '消息 · 正文流式(光标)+ 运行中工具卡 + 已完成思考折叠',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <StaticList
        messages={assistantStreaming()}
        sending
        turnActivity={{
          startedAt: NOW - 23_000,
          lastFrameAt: NOW - 300,
          agentName: '主助手',
          hasPlated: true,
        }}
      />
    ),
  },
  {
    id: 'messages-error-states',
    label: '消息 · 终态与错误形态(失败重试/已停止/免单/耗尽/超限/内部错误/委派失败)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <StaticList
        messages={errorStates()}
        transientNotice={{ text: '较长时间未收到新内容，正在与服务器同步…' }}
        historyLoading
        journalDegraded
        onRetryJournal={noop}
        cb={{
          ...cb,
          resolveRetryTarget: (cmid) =>
            cmid === 'u-cap'
              ? msg({ id: 'u-cap', role: 'user', text: '再试一次刚才的总结。', status: 'error' })
              : undefined,
        }}
      />
    ),
  },
  {
    id: 'messages-ask-user-question',
    label: '消息 · AskUserQuestion 提问弹窗 + 已解析权限卡',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      const liveRequestId = `req-aq-live-${Date.now()}`
      return <StaticList messages={permissionTimeline(liveRequestId)} sending />
    },
  },
  {
    id: 'messages-find-toolbar',
    label: '消息 · 会话内查找条 + 待回答 dock(非活动轮的未决提问)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => {
      resetPermissionAutoOpenMemory()
      return <StaticList messages={findTimeline()} find={{ onClose: noop }} />
    },
  },
  {
    id: 'messages-scroll-window',
    label: '消息 · 长会话首屏尾窗 + 查看更早 + 回到底部按钮',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <ScrollWindowScene />,
  },
]
