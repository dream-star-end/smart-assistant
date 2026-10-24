const balance = '10000'
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from '../src/components/Composer'
import { useConfirm } from '../src/components/ui/ConfirmDialog'
import { TooltipProvider, ToastProvider } from '../src/components/ui'
import { useModelSwitchCost } from '../src/hooks/useModelSwitchCost'
import { createMemoryAuthSession } from '../src/lib/authSession'
import { api } from '../src/lib/api'
import { mintMsgId } from '../src/lib/chat/model'
import type { ModelSwitchCostQuote } from '@openclaude/protocol/browser'
let mode: 'estimate' | 'risk' = 'estimate'
let confirmedId = ''
const requests: string[] = []
api.modelSwitchCost = async (_auth, input, proof) => {
  await new Promise((resolve) => setTimeout(resolve, 30))
  if (proof?.quoteToken) confirmedId = input.requestId
  return {
    mode,
    requestId: input.requestId,
    targetModel: input.targetModel,
    targetName: 'GPT-6-Astra',
    sourceModel: 'gpt-6-luna',
    sourceName: 'GPT-6-Luna',
    contextTokens: mode === 'risk' ? null : 200453,
    contextSource: mode === 'risk' ? 'unknown' : 'last-call',
    outputTokens: 2048,
    sampleCount: 1,
    targetCost:
      mode === 'risk' ? null : { lowCredits: '121', expectedCredits: '128', highCredits: '154' },
    currentCost:
      mode === 'risk' ? null : { lowCredits: '5', expectedCredits: '5', highCredits: '6' },
    targetUnitPrice: { input: '598', output: '3598', cacheRead: '60', cacheWrite: '0' },
    balanceCredits: '10000',
    requiresConfirmation: confirmedId !== input.requestId,
    canConfirm: balance !== '1',
    expiresAt: Date.now() + 300000,
    quoteToken: 'fixture-quote',
    ...(confirmedId === input.requestId ? { consent: 'fixture-consent' } : {}),
  } as ModelSwitchCostQuote
}
function Harness() {
  const [confirm, dialog] = useConfirm()
  const authRef = useRef(createMemoryAuthSession(() => {}, 'fixture'))
  const [model, setModel] = useState('gpt-6-luna')
  const [sent, setSent] = useState('')
  const [session, setSession] = useState('A')
  const [reply, setReply] = useState(false)
  const authorize = useModelSwitchCost({ authRef, confirmDialog: confirm, toast: () => {} })
  const select = async () => {
    const permit = await authorize(
      { sessionId: session, requestId: mintMsgId(), targetModel: 'gpt-6-astra', agentId: 'main' },
      {
        primeNextTurn: true,
        notice: {
          title: '切换模型？',
          body: <p>目标不支持图片上下文。</p>,
          confirmText: '压缩并切换',
          altText: '直接切换',
        },
      },
    )
    if (permit) setModel('gpt-6-astra')
  }
  return (
    <TooltipProvider>
      <ToastProvider>
        <button
          type="button"
          onClick={() => {
            mode = 'risk'
            confirmedId = ''
          }}
        >
          risk fixture
        </button>
        <button
          type="button"
          onClick={() => {
            mode = 'estimate'
            confirmedId = ''
          }}
        >
          estimate fixture
        </button>
        <button type="button" onClick={() => void select()}>
          select expensive
        </button>
        <button type="button" onClick={() => setSession(session === 'A' ? 'B' : 'A')}>
          navigate
        </button>
        <button type="button" onClick={() => setReply(true)}>
          quote message
        </button>
        <output data-testid="model">{model}</output>
        <output data-testid="sent">{sent}</output>
        <Composer
          draftKey={session}
          replyTo={
            reply ? { messageId: 'quote-id', role: 'assistant', text: 'quoted message' } : undefined
          }
          onCancelReply={() => setReply(false)}
          onUpload={async () => ({
            type: 'file',
            url: '/fixture-file',
            name: 'fixture.txt',
            mime: 'text/plain',
          })}
          onSend={async (text) => {
            const permit = await authorize(
              {
                sessionId: session,
                requestId: mintMsgId(),
                targetModel: 'gpt-6-astra',
                agentId: 'main',
                text,
              },
              { useCachedRequestId: true },
            )
            if (!permit) return false
            requests.push(permit.requestId)
            setSent(requests.join(','))
            return true
          }}
        />
        {dialog}
      </ToastProvider>
    </TooltipProvider>
  )
}
createRoot(document.getElementById('root')!).render(<Harness />)
