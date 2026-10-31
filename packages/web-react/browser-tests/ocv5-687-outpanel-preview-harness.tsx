import { useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { InspectorPanel, type PaneRequest } from '../src/components/InspectorPanel'
import MarkdownImpl from '../src/components/MarkdownImpl'
import { MediaSignProvider } from '../src/components/chat/media'
import { ArtifactInspectContext } from '../src/components/tool/context'
import type { ChatMessage } from '../src/lib/chat/model'

const TS = 1_700_000_000_000
const CSV_PATH = '/home/agent/.openclaude/generated/销售明细.csv'
const XLSX_PATH = '/home/agent/.openclaude/generated/季度汇总.xlsx'
const DOCX_PATH = '/home/agent/.openclaude/generated/复盘纪要.docx'

const MULTI_TURN_MESSAGES: ChatMessage[] = [
  { id: 'u1', role: 'user', text: '生成销售明细与汇总表', ts: TS, status: 'replied' },
  {
    id: 'a1',
    role: 'assistant',
    text: `已生成报表：\n\n- [销售明细.csv](${encodeURI(CSV_PATH)})\n- [季度汇总.xlsx](${encodeURI(XLSX_PATH)})\n- [复盘纪要.docx](${encodeURI(DOCX_PATH)})`,
    ts: TS + 5_000,
  },
  { id: 'u2', role: 'user', text: '补充问一句结论', ts: TS + 10_000, status: 'replied' },
  { id: 'a2', role: 'assistant', text: '整体华东区增速最快，无需改动原文件。', ts: TS + 15_000 },
]

function HarnessApp() {
  const [mode, setMode] = useState<'first-running' | 'multi-turn'>(() =>
    new URLSearchParams(window.location.search).get('mode') === 'first-running'
      ? 'first-running'
      : 'multi-turn',
  )
  const [request, setRequest] = useState<PaneRequest | null>(null)

  const inspect = useMemo(
    () => ({
      openFile: (filePath: string) =>
        setRequest({
          tab: 'outputs',
          message: { toolName: '_output_file', inputJson: { file_path: filePath } },
          nonce: Date.now() + Math.random(),
        }),
    }),
    [],
  )

  const messages = mode === 'first-running' ? [] : MULTI_TURN_MESSAGES
  const running = mode === 'first-running'

  return (
    <MediaSignProvider
      authKey="ocv5-687-fixture"
      sign={async (paths) => {
        const res = await fetch('/api/media-sign', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ paths }),
        })
        return res.json()
      }}
    >
      <ArtifactInspectContext.Provider value={inspect}>
        <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
          <main className="min-w-0 flex-1 overflow-auto p-6" data-testid="chat-stream">
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                data-testid="switch-multi-turn"
                onClick={() => setMode('multi-turn')}
                className="rounded border border-border px-2.5 py-1 text-xs"
              >
                切换到多轮对话
              </button>
            </div>
            {messages
              .filter((m) => m.role === 'assistant')
              .map((m) => (
                <div key={m.id} className="mb-4">
                  <MarkdownImpl signMedia>{m.text}</MarkdownImpl>
                </div>
              ))}
          </main>
          <InspectorPanel
            width={440}
            messages={messages}
            running={running}
            request={request}
            onClose={() => {}}
          />
        </div>
      </ArtifactInspectContext.Provider>
    </MediaSignProvider>
  )
}

createRoot(document.getElementById('root')!).render(<HarnessApp />)
