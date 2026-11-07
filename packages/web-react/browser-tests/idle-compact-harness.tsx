/** Real activity/error components; backend admission is covered by boxIdleContinuity. */
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TurnActivity } from '../src/components/chat/TurnActivity'
import { TurnStatusCard } from '../src/components/chat/TurnErrorNotice'
import type { ChatMessage } from '../src/lib/chat/model'

function Harness() {
  const [phase, setPhase] = useState('compacting')
  const [continued, setContinued] = useState(0)
  const msg = { id: 'idle-wait', role: 'system', ts: 1, text: '',
    _turnStatusRecord: true, _errorCode: 'IDLE_RECOVERY_PENDING:7' } as ChatMessage
  return <>
    <button onClick={() => setPhase('reply')}>finish safe recovery</button>
    <button onClick={() => setPhase('unsafe')}>unconfirmed stop</button>
    {phase === 'compacting' && <TurnActivity info={{
      startedAt: Date.now(), agentName: '助手', turnStatus: 'compacting',
    }} />}
    {phase === 'reply' && <p>正常回复，原上下文保留。</p>}
    {phase === 'unsafe' && <TurnStatusCard msg={msg} currentTurn cb={{
      resolveInterruptedContinuation: () => ({}) as never,
      onContinueInterrupted: () => setContinued(n => n + 1),
    }} />}
    <output data-testid="continued">{continued}</output>
  </>
}
createRoot(document.getElementById('root')!).render(<Harness />)
