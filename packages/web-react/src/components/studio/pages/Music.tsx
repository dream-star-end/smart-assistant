// OCV5-593 FE-5 配乐 (mockups d10–d13 / m06; user 2026-10-23 20:52: build it to these). Music comes
// from sources under the shared provider interface (OCV5-591 M1): 我的音乐 (the user's own tracks),
// 免版权曲库 (the hand-verified catalog) and AI 生成 (only a slot, not configured). Choosing a track
// makes it the project's soundtrack (a free music take); the editor then cuts it into the film.

import { FolderHeart, Library, Loader2, Scissors, Sparkles } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'

import { kindView } from '../../../hooks/useStudioProviders'
import { studioApi, studioErrorText } from '../../../lib/studio/api'
import { shotCard, timeline } from '../../../lib/studio/model'
import {
  type MusicTrack,
  musicInfo,
  musicSources,
  pendingMusic,
  soundtrack,
  storedEdit,
  tempoForShots,
} from '../../../lib/studio/music'
import type { ProvidersView, StudioProjectView } from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { Timeline } from '../Timeline'
import { LibrarySearch } from '../music/LibrarySearch'
import { LicenseCard } from '../music/LicenseCard'
import { MusicEditor } from '../music/MusicEditor'
import { MyMusic } from '../music/MyMusic'
import { usePreview } from '../music/usePreview'

type Tab = 'mine' | 'catalog' | 'ai'

export function MusicPage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onOpenShot: (shotId: string) => void
  onReload?: () => Promise<void> | void
}) {
  const { auth, view } = props
  const toast = useToast()
  const sources = musicSources(props.providers)
  const music = kindView(props.providers, 'music')
  const tl = useMemo(() => timeline(view), [view])
  const cards = useMemo(
    () => [...view.shots].sort((a, b) => a.ordinal - b.ordinal).map((s) => shotCard(view, s)),
    [view],
  )
  const shown = useMemo(() => new Map(cards.map((c) => [c.shot.id, c.shown])), [cards])
  const current = soundtrack(view)
  const pending = pendingMusic(view)
  const info = musicInfo(current)
  const stored = useMemo(() => storedEdit(view), [view])
  const tempo = useMemo(() => tempoForShots(tl.clips.map((c) => c.end - c.start)), [tl])
  const [tab, setTab] = useState<Tab>(sources.catalog?.state === 'ready' ? 'catalog' : 'mine')
  const [editing, setEditing] = useState(true)
  const [focus, setFocus] = useState<MusicTrack | null>(null)
  const [choosing, setChoosing] = useState(false)
  const onError = useCallback((err: unknown) => toast(studioErrorText(err), 'error'), [toast])
  const preview = usePreview(auth, onError)

  const use = async (providerId: string, t: MusicTrack) => {
    setChoosing(true)
    try {
      await studioApi.selectMusic(auth, view.project.id, providerId, t.id)
      toast(`配乐换成「${t.title}」，正在准备`, 'success')
      setEditing(true)
      await props.onReload?.()
    } catch (err) {
      onError(err)
    } finally {
      setChoosing(false)
    }
  }

  const tabs: Array<[Tab, string, typeof Library, { id: string; state: string } | null]> = [
    ['mine', '我的音乐', FolderHeart, sources.mine],
    ['catalog', '免版权曲库', Library, sources.catalog],
    ['ai', 'AI 生成', Sparkles, sources.ai],
  ]
  const showEditor = Boolean(current) && editing
  const inUseSha = current?.blobSha ?? null
  const source = tab === 'catalog' ? sources.catalog : tab === 'mine' ? sources.mine : null

  return (
    <div className="st-board st-board-music">
      <div className="st-board-main">
        <div className="st-board-scroll">
          <div className="st-row st-board-head st-music-head">
            <h2 className="st-title" style={{ fontSize: 18 }}>
              配乐
            </h2>
            <div className="st-seg st-music-tabs" role="tablist" aria-label="音乐来源">
              {tabs.map(([id, label, Icon, src]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={!showEditor && tab === id}
                  className={!showEditor && tab === id ? 'on' : ''}
                  onClick={() => {
                    setTab(id)
                    setEditing(false)
                  }}
                >
                  <Icon aria-hidden="true" />
                  {label}
                  {id === 'ai' && src?.state !== 'ready' ? (
                    <span className="st-chip st-tab-off">未配置</span>
                  ) : null}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            {pending ? (
              <span className="st-chip st-chip-agent">
                <Loader2 className="st-spin" />
                正在换配乐…
              </span>
            ) : null}
            {current ? (
              <button
                type="button"
                className={`st-btn st-btn-sm${showEditor ? ' st-btn-primary' : ''}`}
                aria-pressed={showEditor}
                onClick={() => setEditing(true)}
              >
                <Scissors />
                剪辑配乐
              </button>
            ) : null}
          </div>

          {showEditor && current ? (
            <MusicEditor
              auth={auth}
              projectId={view.project.id}
              take={current}
              track={info?.track ?? null}
              stored={stored}
              tl={tl}
              preview={preview}
              onSaved={() => props.onReload?.()}
              onChange={() => setEditing(false)}
            />
          ) : tab === 'ai' ? (
            <div className="st-card st-music-ai">
              <span className="st-agent-av" aria-hidden="true">
                <Sparkles size={18} />
              </span>
              <div className="st-h3">AI 生成音乐还没有配置</div>
              <div className="st-cap">
                管理员接入音乐生成服务后，这里可以按分镜情绪生成原创配乐。现在可以先用免版权曲库或你自己的音乐。
              </div>
              <div className="st-row" style={{ gap: 8, justifyContent: 'center' }}>
                <button
                  type="button"
                  className="st-btn st-btn-primary st-btn-sm"
                  onClick={() => setTab('catalog')}
                >
                  <Library />
                  去免版权曲库
                </button>
                <button type="button" className="st-btn st-btn-sm" onClick={() => setTab('mine')}>
                  <FolderHeart />
                  我的音乐
                </button>
              </div>
            </div>
          ) : !source || source.state !== 'ready' ? (
            <div className="st-card st-music-ai">
              <div className="st-h3">{tab === 'catalog' ? '曲库' : '我的音乐'}暂时不可用</div>
              <div className="st-cap">
                {music.state === 'unconfigured' ? '工作台的音乐服务还没开启。' : '稍后再试。'}
              </div>
            </div>
          ) : tab === 'catalog' ? (
            <LibrarySearch
              auth={auth}
              providerId={source.id}
              tempo={tempo}
              inUseSha={inUseSha}
              busy={choosing || Boolean(pending)}
              preview={preview}
              onUse={(t) => use(source.id, t)}
              onFocus={setFocus}
              onError={onError}
            />
          ) : (
            <MyMusic
              auth={auth}
              providerId={source.id}
              inUseSha={inUseSha}
              busy={choosing || Boolean(pending)}
              preview={preview}
              onUse={(t) => use(source.id, t)}
              onFocus={setFocus}
              onError={onError}
            />
          )}
        </div>
        <Timeline
          auth={auth}
          model={tl}
          shown={shown}
          musicState={music.state}
          selectedShotId={null}
          onSelect={props.onOpenShot}
        />
      </div>
      <aside className="st-panel st-music-side" aria-label="配乐与授权">
        <div className="st-music-side-b">
          {current ? (
            <LicenseCard
              title="当前配乐 · 授权"
              track={info?.track ?? null}
              license={info?.license ?? null}
            />
          ) : (
            <div className="st-card st-cap">
              还没有选配乐。挑一首“用在这支片”，就会成为这支片的配乐，之后可以裁剪、循环和调混音。
            </div>
          )}
          {focus && focus.previewSha !== current?.blobSha && !showEditor ? (
            <LicenseCard title="这首的授权" track={focus} />
          ) : null}
          <div className="st-card st-cap st-music-note">
            曲库里每首都经过人工核验：协议、署名、来源页快照都随曲目保存。CC BY
            的曲子导出成片时必须保留署名。
            标着“情绪为推测”的曲目没有试听过，情绪按曲名和配器推测，BPM 未知。
          </div>
        </div>
      </aside>
    </div>
  )
}
