// OCV5-593 FE-2c 设定 · 生图 (d03): the locked bible (characters / scenes / styles), reference
// uploads, one asset's versions on the stage with comment pins, and the image model plan from
// /providers. Regenerate and lock need the orchestrator (A2-1) and stay disabled; uploading
// references works now (POST /projects/:id/uploads).

import {
  Columns2,
  Download,
  Info,
  Lock,
  MessageCircle,
  MousePointer2,
  Plus,
  Sparkles,
  Wand2,
} from 'lucide-react'
import { type ChangeEvent, type PointerEvent, useCallback, useMemo, useRef, useState } from 'react'

import { useBlobUrl } from '../../../hooks/useBlobUrl'
import { kindView } from '../../../hooks/useStudioProviders'
import {
  ANNOTATION_TEXT_MAX,
  type AnnotationDraft,
  loadDrafts,
  newDraftId,
  saveDrafts,
} from '../../../lib/studio/annotations'
import { UPLOAD_IMAGE_TYPES, studioApi, studioErrorText } from '../../../lib/studio/api'
import { qaScoreOf, takesOf } from '../../../lib/studio/model'
import type {
  ProvidersView,
  StudioAsset,
  StudioProjectView,
  StudioTake,
} from '../../../lib/studio/types'
import type { AuthSession } from '../../../lib/types'
import { useToast } from '../../ui'
import { MediaThumb } from '../MediaThumb'
import { AnnotationBubble } from './Review'

type BibleKind = 'character' | 'scene' | 'style'
const KINDS: Array<[BibleKind, string]> = [
  ['character', '角色'],
  ['scene', '场景'],
  ['style', '风格'],
]
const ASPECT_CHOICES = ['1:1', '16:9', '9:16'] as const

/** A blob-backed pseudo take so assets without generated versions (uploads) render the same way. */
function assetAsTake(a: StudioAsset): StudioTake | null {
  if (!a.blobSha) return null
  return {
    id: `asset:${a.id}`,
    ownerKind: 'bible',
    ownerId: a.id,
    version: 0,
    provider: a.kind === 'upload' || a.kind === 'reference' ? '上传' : '',
    model: '',
    op: '',
    status: 'succeeded',
    errorCode: null,
    costCredits: '0',
    qa: null,
    blobSha: a.blobSha,
    createdAt: a.createdAt,
    finishedAt: a.createdAt,
  }
}

export function ImageStudioPage(props: {
  auth: AuthSession
  view: StudioProjectView
  providers: ProvidersView
  onReload: () => Promise<void> | void
}) {
  const { auth, view } = props
  const toast = useToast()
  const [kind, setKind] = useState<BibleKind>('character')
  const bible = useMemo(() => view.assets.filter((a) => a.kind === kind), [view.assets, kind])
  const refs = useMemo(
    () => view.assets.filter((a) => (a.kind === 'reference' || a.kind === 'upload') && a.blobSha),
    [view.assets],
  )
  const [assetId, setAssetId] = useState<string | null>(null)
  const asset = bible.find((a) => a.id === assetId) ?? bible[0] ?? null
  const versions = useMemo(() => {
    if (!asset) return []
    const generated = takesOf(view, asset.id, ['bible']).filter(
      (t) => t.status === 'succeeded' && t.blobSha,
    )
    if (generated.length) return generated
    const own = assetAsTake(asset)
    return own ? [own] : []
  }, [view, asset])
  const [takeId, setTakeId] = useState<string | null>(null)
  const take = versions.find((t) => t.id === takeId) ?? versions[0] ?? null
  const compareWith = versions.find((t) => t.id !== take?.id) ?? null
  const [tool, setTool] = useState<'view' | 'comment'>('view')
  const [compare, setCompare] = useState(false)
  const [drafts, setDrafts] = useState<AnnotationDraft[]>(() => loadDrafts(view.project.id))
  const [selected, setSelected] = useState<string | null>(null)
  const persist = useCallback(
    (next: AnnotationDraft[]) => {
      setDrafts(next)
      saveDrafts(view.project.id, next)
    },
    [view.project.id],
  )
  const mine = drafts.filter((d) => d.takeId === take?.id)
  const url = useBlobUrl(auth, take?.blobSha)
  const boxRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const imageKind = kindView(props.providers, 'image')
  const [aspect, setAspect] = useState<string>(view.project.aspect)
  const score = qaScoreOf(take)

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (tool !== 'comment' || !take || compare) return
    const r = boxRef.current!.getBoundingClientRect()
    const draft: AnnotationDraft = {
      id: newDraftId(),
      takeId: take.id,
      kind: 'point',
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
      tStart: 0,
      text: '',
      createdAt: Date.now(),
    }
    persist([...drafts, draft])
    setSelected(draft.id)
  }

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])]
    e.target.value = ''
    if (!files.length) return
    setUploading(true)
    let done = 0
    try {
      for (const f of files) {
        await studioApi.uploadAsset(auth, view.project.id, f)
        done += 1
      }
      toast(files.length > 1 ? `已上传 ${files.length} 张参考图` : '参考图已上传', 'success')
    } catch (err) {
      // Earlier files of a batch may already be stored: say so, and still refresh (code r1 P2).
      toast(done ? `已上传 ${done} 张；${studioErrorText(err)}` : studioErrorText(err), 'error')
    } finally {
      setUploading(false)
      if (done) await props.onReload()
    }
  }

  const selectedDraft = mine.find((d) => d.id === selected) ?? null

  return (
    <div className="st-image">
      <aside className="st-image-lib" aria-label="设定库">
        <fieldset className="st-seg" aria-label="设定类型">
          {KINDS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k)
                setAssetId(null)
                setTakeId(null)
              }}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {bible.length === 0 ? (
          <div className="st-card st-image-empty">
            <div className="st-h3" style={{ fontSize: 13.5 }}>
              还没有{KINDS.find(([k]) => k === kind)![1]}设定
            </div>
            <div className="st-cap">
              开拍后导演 agent 会生成设定图并锁定，每个镜头都原样带上。可以先上传参考图。
            </div>
          </div>
        ) : (
          bible.map((a) => (
            <button
              key={a.id}
              type="button"
              className={`st-card st-asset-card${asset?.id === a.id ? ' on' : ''}`}
              onClick={() => {
                setAssetId(a.id)
                setTakeId(null)
              }}
            >
              <MediaThumb
                auth={auth}
                take={takesOf(view, a.id, ['bible']).find((t) => t.blobSha) ?? assetAsTake(a)}
                style={{ aspectRatio: '16 / 10', borderRadius: 12 }}
              >
                {a.locked ? (
                  <span
                    className="st-chip st-chip-dark st-chip-ok"
                    style={{ position: 'absolute', left: 8, top: 8 }}
                  >
                    <Lock />
                    已锁定
                  </span>
                ) : null}
              </MediaThumb>
              <span className="st-asset-name">{a.name}</span>
            </button>
          ))
        )}
        <div>
          <div className="st-label" style={{ marginBottom: 8 }}>
            参考图
          </div>
          <div className="st-ref-grid">
            {refs.map((r) => (
              <MediaThumb
                key={r.id}
                auth={auth}
                take={assetAsTake(r)}
                style={{ aspectRatio: '1', borderRadius: 9 }}
              />
            ))}
            <button
              type="button"
              className="st-ref-add"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              aria-label="上传参考图"
              title="PNG / JPEG / WebP，单张不超过 25 MB"
            >
              {uploading ? <span className="st-cap">上传中…</span> : <Plus size={18} />}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept={UPLOAD_IMAGE_TYPES.join(',')}
              multiple
              hidden
              onChange={(e) => void upload(e)}
            />
          </div>
        </div>
        {asset?.descriptor ? (
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              固定描述
            </div>
            <div className="st-descriptor">{asset.descriptor}</div>
            <div className="st-cap st-row" style={{ marginTop: 6, gap: 4 }}>
              <Lock size={11} />
              每次生成原样带上
            </div>
          </div>
        ) : null}
      </aside>

      <section className="st-image-stage st-stage">
        <div className="st-row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <div className="st-glassbar" role="toolbar" aria-label="查看工具">
            <button
              type="button"
              className={`st-glass-t${tool === 'view' && !compare ? ' on' : ''}`}
              aria-label="查看"
              aria-pressed={tool === 'view' && !compare}
              onClick={() => {
                setCompare(false)
                setTool('view')
              }}
            >
              <MousePointer2 />
              <span className="st-hide-sm">查看</span>
            </button>
            <button
              type="button"
              className={`st-glass-t${tool === 'comment' && !compare ? ' on' : ''}`}
              aria-label="评论"
              aria-pressed={tool === 'comment' && !compare}
              onClick={() => {
                setCompare(false)
                setTool('comment')
              }}
              disabled={!take}
            >
              <MessageCircle />
              <span className="st-hide-sm">评论</span>
            </button>
            <span className="st-glass-sep" />
            <button
              type="button"
              className={`st-glass-t${compare ? ' on' : ''}`}
              aria-label="对比"
              aria-pressed={compare}
              disabled={!compareWith}
              onClick={() => setCompare((c) => !c)}
            >
              <Columns2 />
              <span className="st-hide-sm">对比</span>
            </button>
          </div>
          <span style={{ flex: 1 }} />
          {take?.model ? (
            <span className="st-chip st-chip-dark">
              {take.provider} · {take.model}
            </span>
          ) : null}
          {score !== null ? (
            <span className="st-chip st-chip-dark st-chip-agent">QA {score.toFixed(2)}</span>
          ) : null}
        </div>
        <div className="st-image-canvas">
          {!take ? (
            <div
              className="st-cap"
              style={{ color: 'var(--st-stage-muted)', textAlign: 'center', maxWidth: 360 }}
            >
              这里会显示设定图的各个版本。导演 agent 开拍后会先生成角色和场景设定。
            </div>
          ) : compare && compareWith ? (
            <div className="st-compare">
              {[take, compareWith].map((t) => (
                <figure key={t.id} className="st-compare-cell">
                  <MediaThumb
                    auth={auth}
                    take={t}
                    style={{ aspectRatio: '3 / 2', borderRadius: 14 }}
                  />
                  <figcaption className="st-cap">{t.version ? `v${t.version}` : '原图'}</figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div
              ref={boxRef}
              className={`st-review-media tool-${tool === 'comment' ? 'point' : 'view'}`}
              style={{ aspectRatio: '3 / 2', height: 'auto', width: '100%', maxWidth: 760 }}
              onPointerDown={onDown}
              data-testid="image-canvas"
            >
              {url ? (
                <img
                  className="st-media-fill"
                  style={{ objectFit: 'contain' }}
                  src={url}
                  draggable={false}
                  alt={asset?.name ?? '设定图'}
                />
              ) : (
                <div className="st-media-fill st-placeholder" />
              )}
              {mine.map((d, i) => (
                <button
                  key={d.id}
                  type="button"
                  className={`st-pin${selected === d.id ? ' sel' : ''}`}
                  style={{ left: `${(d.x ?? 0) * 100}%`, top: `${(d.y ?? 0) * 100}%` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => setSelected(d.id)}
                  aria-label={`评论 ${i + 1}`}
                >
                  {i + 1}
                </button>
              ))}
              {selectedDraft ? (
                <AnnotationBubble
                  draft={selectedDraft}
                  index={mine.indexOf(selectedDraft)}
                  onText={(t) =>
                    persist(
                      drafts.map((d) =>
                        d.id === selectedDraft.id
                          ? { ...d, text: t.slice(0, ANNOTATION_TEXT_MAX) }
                          : d,
                      ),
                    )
                  }
                  onDelete={() => {
                    persist(drafts.filter((d) => d.id !== selectedDraft.id))
                    setSelected(null)
                  }}
                  onClose={() => setSelected(null)}
                />
              ) : null}
            </div>
          )}
        </div>
        <div className="st-row st-image-foot">
          {versions.length > 1 ? (
            <>
              <span className="st-cap st-hide-sm" style={{ color: 'var(--st-stage-faint)' }}>
                版本
              </span>
              <fieldset className="st-versions" aria-label="版本">
                {[...versions].reverse().map((t) => {
                  const s = qaScoreOf(t)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      className={`st-version${take?.id === t.id ? ' on' : ''}`}
                      aria-pressed={take?.id === t.id}
                      onClick={() => setTakeId(t.id)}
                    >
                      <MediaThumb
                        auth={auth}
                        take={t}
                        style={{ aspectRatio: '3 / 2', borderRadius: 0 }}
                      />
                      <span className="st-row">
                        <b>v{t.version}</b>
                        <span style={{ flex: 1 }} />
                        {s !== null ? <span className="tnum">{s.toFixed(2)}</span> : null}
                      </span>
                    </button>
                  )
                })}
              </fieldset>
            </>
          ) : null}
          <span style={{ flex: 1 }} />
          {url ? (
            <a
              className="st-btn st-btn-sm st-glass"
              href={url}
              download={`${asset?.name ?? 'studio'}-v${take?.version ?? 0}`}
            >
              <Download />
              下载
            </a>
          ) : null}
          <button type="button" className="st-btn st-btn-sm" disabled title="导演 agent 上线后可用">
            <Lock />
            锁定为设定
          </button>
        </div>
      </section>

      <aside className="st-panel st-image-side" aria-label="生成">
        <div className="st-row st-image-side-head">
          <h2 className="st-h3">生成</h2>
          <span style={{ flex: 1 }} />
          {versions.length ? <span className="st-chip">{versions.length} 个版本</span> : null}
        </div>
        <div className="st-image-side-body">
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              画面描述
            </div>
            <div className="st-card st-prompt-box">
              {asset?.descriptor ?? '开拍后由导演 agent 根据需求写出画面描述。'}
              {asset?.locked ? (
                <div className="st-row" style={{ marginTop: 8, gap: 6 }}>
                  <span className="st-chip st-chip-agent">
                    <Lock />
                    固定描述
                  </span>
                </div>
              ) : null}
            </div>
          </div>
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              模型 · agent 自动选择
            </div>
            {imageKind.providers.length === 0 ? (
              <div className="st-card st-model-row" data-state="unconfigured">
                <div>
                  <b>图片生成未配置</b>
                  <div className="st-cap">管理员配置好供应商后会自动出现在这里。</div>
                </div>
              </div>
            ) : (
              imageKind.providers.map((p, i) => {
                const usable = p.state === 'ready' || p.state === 'offline'
                const first = imageKind.providers.findIndex((x) => x.state === 'ready')
                return (
                  <div
                    key={p.id}
                    className={`st-card st-model-row${usable && i === first ? ' on' : ''}`}
                    data-state={p.state}
                  >
                    <span className="st-radio" aria-hidden="true" />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{p.label}</b>
                      <div className="st-cap">
                        {p.state === 'ready'
                          ? ((p.models.find((m) => m.isDefault) ?? p.models[0])?.label ?? '可用')
                          : p.state === 'offline'
                            ? '暂时不可用，恢复后会自动排队'
                            : '未配置'}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
          <div>
            <div className="st-label" style={{ marginBottom: 8 }}>
              画幅
            </div>
            <div className="st-row" style={{ gap: 6, flexWrap: 'wrap' }}>
              {ASPECT_CHOICES.map((r) => (
                <button
                  key={r}
                  type="button"
                  className={`st-btn st-btn-sm${aspect === r ? ' st-btn-on' : ''}`}
                  aria-pressed={aspect === r}
                  onClick={() => setAspect(r)}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="st-image-side-foot">
          <div className="st-cap st-row" style={{ gap: 6, alignItems: 'flex-start' }}>
            <Info size={13} style={{ flex: 'none', marginTop: 2 }} />
            评论会变成指令交给 agent，发送前先看“agent 理解为”。导演 agent 上线后可以直接再生成。
          </div>
          <button
            type="button"
            className="st-btn st-btn-primary st-btn-lg"
            style={{ width: '100%' }}
            disabled
            title="导演 agent 上线后可用"
          >
            {imageKind.state === 'ready' ? <Wand2 /> : <Sparkles />}
            再生成（即将开放）
          </button>
        </div>
      </aside>
    </div>
  )
}
