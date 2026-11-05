/** Real error-card Continue -> continuation action -> authorizer -> backend quote. */
import { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Composer } from '../src/components/Composer'
import { TurnStatusCard } from '../src/components/chat/TurnErrorNotice'
import { useConfirm } from '../src/components/ui/ConfirmDialog'
import { TooltipProvider, ToastProvider } from '../src/components/ui'
import { useModelSwitchCost } from '../src/hooks/useModelSwitchCost'
import { continueManualTask } from '../src/hooks/manualTaskContinuationAction'
import type { ChatCardActionsInput } from '../src/hooks/useChatCardActions'
import { createMemoryAuthSession } from '../src/lib/authSession'
import { captureIdentityAttempt, resolveIdentity } from '../src/lib/resolvedIdentity'
import { manualTaskContinuationSource } from '../src/lib/chat/manualTaskContinuation'
import { api } from '../src/lib/api'
import { mintMsgId, type ChatMessage } from '../src/lib/chat/model'
import type { ModelSwitchCostQuote } from '@openclaude/protocol/browser'

const user = { id: 'msg-1', role: 'user', text: '原任务目标：完成检查', ts: 1,
  status: 'error', _routing: { model: 'cheap', teamMode: false } } as ChatMessage
const error = { id: 'error-1', role: 'system', text: '', ts: 2, _source: 'server',
  _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: 'ENGINE_ERROR',
  _clientMessageId: user.id } as ChatMessage
const rows = [user, error]
const requests: string[] = []
const sentFrames: Array<{ model: string; text: string; displayText?: string }> = []
Object.assign(window, { __costContinueFrames: sentFrames })

api.modelSwitchCost = async (_auth, input, proof) => {
  const response = await fetch('/quote', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, proof }),
  })
  const body = (await response.json()) as { quote?: ModelSwitchCostQuote; error?: string }
  if (!response.ok || !body.quote) throw new Error(body.error ?? 'quote failed')
  return body.quote
}

function Harness() {
  const [confirm, dialog] = useConfirm()
  const authRef = useRef(createMemoryAuthSession(() => {}, 'fixture'))
  const [identity] = useState(() => resolveIdentity(captureIdentityAttempt(authRef.current, 'fixture'), '742'))
  const [target, setTarget] = useState<'cheap' | 'expensive'>('cheap')
  const [sent, setSent] = useState('')
  const [toast, setToast] = useState('')
  const activeSessionRef = useRef('s-crash')
  const pendingContinuations = useRef(new Set<string>())
  const authorize = useModelSwitchCost({ authRef, confirmDialog: confirm, toast: (text) => setToast(text) })
  const dispatch = async (frame: { model: string; text: string; displayText?: string }) => {
    const permit = await authorize({
      sessionId: 's-crash', requestId: mintMsgId(), targetModel: frame.model,
      agentId: 'main', text: frame.text,
    }, { useCachedRequestId: true })
    if (!permit) return false
    requests.push(permit.requestId)
    sentFrames.push(frame)
    setSent(requests.join(','))
    return true
  }
  const sockRef = useRef({
    getMessages: (sid: string) => sid === 's-crash' ? rows : [],
    send: dispatch,
    continueInterruptedTurn: () => { throw new Error('zero-output turn must not replay a checkpoint') },
  })
  sockRef.current.send = dispatch
  const continueTask = () => continueManualTask({
    activeId: 's-crash', demo: false, identity, authRef, error, agentId: 'main',
    activeSessionRef, pendingContinuations,
    sockRef: sockRef as unknown as ChatCardActionsInput['sockRef'],
    loadExactOrToast: async (row) => row,
    send: (async () => { throw new Error('recorded routing must be preserved') }) as ChatCardActionsInput['send'],
  })
  return <TooltipProvider><ToastProvider>
    <button type="button" onClick={() => setTarget('expensive')}>switch model</button>
    <output data-testid="target">{target}</output>
    <output data-testid="sent">{sent}</output>
    <output data-testid="toast">{toast}</output>
    <TurnStatusCard msg={error} currentTurn cb={{
      resolveInterruptedContinuation: (msg) => manualTaskContinuationSource(rows, msg),
      onContinueInterrupted: () => { void continueTask() },
    }} />
    <Composer draftKey="ocv5-742" onUpload={async () => ({
      kind: 'file', url: '/fixture-file', filename: 'fixture.txt', mimeType: 'text/plain',
    })} onSend={(text) => dispatch({ model: target, text })} />
    {dialog}
  </ToastProvider></TooltipProvider>
}
createRoot(document.getElementById('root')!).render(<Harness />)
