// Continue a paused studio project from the shot page and the director sidebar.
// Same actions as the brief page: approve() for a provider outage, resume() otherwise.

import { Play } from 'lucide-react'
import { useState } from 'react'

import { studioApi, studioErrorText } from '../../lib/studio/api'
import { studioPause } from '../../lib/studio/pause'
import type { StudioProjectView } from '../../lib/studio/types'
import type { AuthSession } from '../../lib/types'
import { useToast } from '../ui'

export function StudioContinue(props: {
  auth: AuthSession
  view: StudioProjectView
  onReload?: () => void
}) {
  const pause = studioPause(props.view.project, props.view.events)
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!pause) return null
  const go = async () => {
    if (busy) return
    setBusy(true)
    try {
      if (pause.action === 'approve') await studioApi.approve(props.auth, props.view.project.id)
      else await studioApi.transition(props.auth, props.view.project.id, 'resume')
      props.onReload?.()
    } catch (err) {
      toast(studioErrorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className="st-pause-banner"
      data-testid="studio-continue"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, margin: '8px 0 12px' }}
    >
      <div className="st-cap" data-testid="studio-pause-reason">
        {pause.reason}
      </div>
      <button
        type="button"
        className="st-btn st-btn-sm"
        disabled={busy}
        onClick={() => void go()}
      >
        <Play size={14} />
        {busy ? '正在继续…' : '继续'}
      </button>
    </div>
  )
}
