// OCV5-593 media studio — full-page surface at /studio (lazy chunk). Visible only when
// GET /api/studio/providers answers 200 for this account; anything else shows a quiet
// "not open" page with a way back to chat.

import { Clapperboard, MessageSquare, Moon, Sun } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { useStudioAvailability } from '../../hooks/useStudioProviders'
import { type StudioRoute, parseStudioPath, studioHref } from '../../lib/studio/path'
import type { AuthSession } from '../../lib/types'
import './studio.css'
import { ProjectShell } from './ProjectShell'
import { StateView } from './StateViews'
import { StudioHome } from './StudioHome'

export interface StudioAppProps {
  auth: AuthSession
  theme: string
  onCycleTheme: () => void
}

export function StudioApp({ auth, theme, onCycleTheme }: StudioAppProps) {
  const availability = useStudioAvailability(auth)
  const [route, setRoute] = useState<StudioRoute | null>(() => parseStudioPath(location.pathname))

  useEffect(() => {
    const onPop = () => setRoute(parseStudioPath(location.pathname))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  const navigate = useCallback((next: StudioRoute, replace = false) => {
    const href = studioHref(next)
    if (href !== location.pathname) {
      if (replace) history.replaceState(null, '', href)
      else history.pushState(null, '', href)
    }
    setRoute(next)
  }, [])

  const dark = theme === 'dark' || document.documentElement.classList.contains('dark')

  return (
    <div className="studio-root" data-testid="studio-root">
      <nav className="st-rail" aria-label="工作台导航">
        <div className="st-brand" aria-hidden="true">
          从
        </div>
        <a className="st-ri" href="/" title="对话" aria-label="对话">
          <MessageSquare />
        </a>
        <a
          className="st-ri"
          href="/studio"
          title="媒体工作台"
          aria-label="媒体工作台"
          aria-current="page"
          onClick={(e) => {
            e.preventDefault()
            navigate({ kind: 'home' })
          }}
        >
          <Clapperboard />
        </a>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="st-ri"
          onClick={onCycleTheme}
          title="切换主题"
          aria-label="切换主题"
        >
          {dark ? <Sun /> : <Moon />}
        </button>
      </nav>
      <div className="st-main">
        {availability.state === 'checking' ? (
          <StateView kind="loading" />
        ) : availability.state === 'unavailable' ? (
          <StateView
            kind="closed"
            title="媒体工作台暂未开放"
            body="目前只对部分账号开放。开放后，这里会出现你的影片项目。"
            action={{ label: '回到对话', href: '/' }}
          />
        ) : !route ? (
          <StateView
            kind="closed"
            title="页面不存在"
            body="链接可能已失效。"
            action={{ label: '回到工作台', onClick: () => navigate({ kind: 'home' }, true) }}
          />
        ) : route.kind === 'home' ? (
          <StudioHome auth={auth} providers={availability.providers} navigate={navigate} />
        ) : (
          <ProjectShell
            key={route.id}
            auth={auth}
            projectId={route.id}
            page={route.page}
            providers={availability.providers}
            navigate={navigate}
          />
        )}
      </div>
    </div>
  )
}

export default StudioApp
