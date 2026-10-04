/**
 * OCV5-310「处理过程」重设计的视觉预览:真实 MessageList + 真 CSS。
 *
 * - live:一轮进行中(思考 + 8 条命令,最后一条仍在跑)——用户截图里的那种形态;
 * - done:同一轮结束后的默认折叠态;
 * - done-open:结束后展开,混合读取/搜索/编辑/命令/未成功一步 + 中间说明 + 最终回答。
 */
import { type ReactNode, useEffect, useRef } from 'react'
import { MessageList } from '../../src/components/MessageRenderer'
import type { CardCallbacks } from '../../src/components/chat/cards'
import type { ChatMessage } from '../../src/lib/chat/model'
import type { Scene } from './types'

const NOW = Date.now()
let seq = 0
function msg(partial: Partial<ChatMessage> & Pick<ChatMessage, 'role'>, ageSec?: number): ChatMessage {
  seq += 1
  return {
    id: partial.id ?? `p-${seq}`,
    text: '',
    ts: NOW - (ageSec ?? Math.max(1, 60 - seq)) * 1000,
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

function bash(id: string, command: string, output: string, extra: Partial<ChatMessage> = {}, ageSec?: number): ChatMessage {
  return msg(
    {
      id,
      role: 'tool',
      text: 'Bash',
      toolName: 'Bash',
      inputJson: { command },
      output,
      _completed: true,
      ...extra,
    },
    ageSec,
  )
}

function tool(id: string, toolName: string, inputJson: Record<string, unknown>, output: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return msg({ id, role: 'tool', text: toolName, toolName, inputJson, output, _completed: true, ...extra })
}

const COMMANDS: [string, string][] = [
  ['git status -sb', '## feat/v5-selfhost...origin/feat/v5-selfhost'],
  ['ls packages/web-react/src/components/chat', 'ProcessDisclosure.tsx\ncards.tsx\nTurnActivity.tsx'],
  ['rg -n "operationSummary" packages/web-react/src', 'src/components/chat/ProcessDisclosure.tsx:489'],
  ['wc -l packages/web-react/src/components/chat/ProcessDisclosure.tsx', '922'],
  ['sed -n 700,780p packages/web-react/src/components/chat/ProcessDisclosure.tsx', '…'],
  ['npx tsc -p packages/web-react --noEmit', ''],
  ['df -h / | tail -1', '/dev/vda1  194G  186G  8.1G  96% /'],
]

function liveTurn(): ChatMessage[] {
  seq = 0
  return [
    msg({ id: 'u-1', role: 'user', text: '帮我看看处理过程这块为什么显得很廉价，然后给出改进。', status: 'sent' }, 48),
    msg({ id: 'th-1', role: 'thinking', text: '**梳理处理过程的渲染链路**\n\n先看 ProcessDisclosure 的分段与计数逻辑。', _source: 'local' }, 46),
    ...COMMANDS.map(([command, output], i) => bash(`b-${i}`, command, output, {}, 44 - i * 4)),
    bash(
      'b-run',
      'npx vitest run src/components/MessageList.processDisclosure.test.tsx',
      '',
      {
        _completed: false,
        _source: 'local',
        bashTail: { tail: ' ✓ processSections 合并相邻工具段 (4 ms)\n ✓ 已回答的提问进入过程', totalBytes: 80, truncatedHead: false },
      },
      6,
    ),
  ]
}

function doneTurn(): ChatMessage[] {
  seq = 0
  return [
    msg({ id: 'u-1', role: 'user', text: '把处理过程重新设计一下，参考 Manus 的工作流展示。', status: 'replied' }, 600),
    msg({ id: 'th-1', role: 'thinking', text: '**先读现状再动手**\n\n过程壳、工具卡、思考卡三处共同决定观感。' }, 590),
    tool('r-1', 'Read', { file_path: '/repo/packages/web-react/src/components/chat/ProcessDisclosure.tsx' }, '…'),
    tool('g-1', 'Grep', { pattern: 'oc-live-status-shine', path: 'packages/web-react/src' }, 'src/styles.css:320'),
    bash('b-1', 'npx vitest run src/components/ToolCard.test.tsx', '✓ 96 passed'),
    msg({ id: 'a-mid', role: 'assistant', text: '现状读完了：标题只有计数，展开后是一叠带边框的完整工具卡。接下来改成时间轴。' }),
    tool('e-1', 'Edit', { file_path: '/repo/packages/web-react/src/components/ToolCard.tsx', old_string: 'rounded-md border', new_string: 'rounded-lg' }, 'ok'),
    tool('e-2', 'Edit', { file_path: '/repo/packages/web-react/src/styles.css', old_string: 'a', new_string: 'b' }, 'ok'),
    bash('b-2', 'cat /repo/missing.txt', 'cat: /repo/missing.txt: No such file or directory', { error: true, _isError: true }),
    bash('b-3', 'npx tsc -p packages/web-react --noEmit', ''),
    tool('w-1', 'WebSearch', { query: 'Manus agent workflow timeline UI' }, '3 results'),
    msg({
      id: 'a-final',
      role: 'assistant',
      text: '已完成重设计：\n\n1. 过程标题实时显示当前动作与耗时；\n2. 步骤改为带图标节点的时间轴，较早步骤自动收起；\n3. 状态色只用于运行中与未成功，其余保持安静。',
    }),
  ]
}

function Clicker({ selector, children }: { selector: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const id = window.setTimeout(() => {
      for (const btn of Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(selector) ?? [])) btn.click()
    }, 60)
    return () => window.clearTimeout(id)
  }, [selector])
  return <div ref={ref}>{children}</div>
}

function List({ messages, sending }: { messages: ChatMessage[]; sending: boolean }) {
  return (
    <div className="min-h-screen bg-bg px-5 py-8 text-fg">
      <MessageList
        messages={messages}
        sending={sending}
        cb={cb}
        onRespondPermission={noop}
        sessionId="preview-process"
        processDisclosure
        turnActivity={sending ? { startedAt: NOW - 48_000, lastFrameAt: NOW - 300, agentName: '主助手' } : null}
      />
    </div>
  )
}

export const processScenes: Scene[] = [
  {
    id: 'process-live',
    label: '处理过程 · 进行中(思考 + 8 条命令,末条运行中)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <List messages={liveTurn()} sending />,
  },
  {
    id: 'process-done',
    label: '处理过程 · 已结束默认折叠',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <List messages={doneTurn()} sending={false} />,
  },
  {
    id: 'process-done-open',
    label: '处理过程 · 已结束展开(混合步骤 + 未成功一步)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <Clicker selector='[data-testid="process-toggle"][aria-expanded="false"]'>
        <List messages={doneTurn()} sending={false} />
      </Clicker>
    ),
  },
]
