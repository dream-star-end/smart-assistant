/**
 * 阶段 A · media（图片查看/标注/评论/缩放、视频任务中心、容器网页预览）审计场景。
 *
 * 归属任务：A·media 图片/媒体/容器网页预览审计。这些界面在真机上都藏在"点开一张图 /
 * 有一条视频任务 / 容器里跑着网页"之后，静态页上凑齐 desktop/mobile × light/dark 四张图，
 * 直接充当问题清单的证据。全部渲染真实组件 + 真 production CSS，数据是就地写死的桩：
 *   - 图片用内联 SVG data: URL（渐进 hook 对 data: 直链零网络透传，编辑器走 fetch(data:)）；
 *   - MediaTaskCenter 旁路直发 fetch（不走 lib/api），api-stub 拦不到，场景挂载时按路由
 *     接管 window.fetch（只接 /api/media-generation/*，其余仍回 harness 的 204）；
 *   - ContainerWebPreview 的 ready 态需要真实容器 WebSocket，静态页只能覆盖授权中 / 连接失败。
 *
 * 不包含任何业务逻辑改动。
 */
import type { MediaGenerationJob, VideoProject } from '@openclaude/protocol/mediaGeneration'
import { ContainerWebPreview } from '../../src/components/ContainerWebPreview'
import { ImageAnnotationEditor } from '../../src/components/ImageAnnotationEditor'
import { ImageCommentMode } from '../../src/components/ImageCommentMode'
import { ImageResizeMode } from '../../src/components/ImageResizeMode'
import { ImageViewer } from '../../src/components/ImageViewer'
import { MediaTaskCenter } from '../../src/components/MediaTaskCenter'
import { ImageEditActionsContext } from '../../src/components/chat/imageEditActions'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import type { Scene } from './types'

// ── 图片桩:1200×800 的渐变 + 几何图形 SVG,足够看清对比度与锚点落位 ──────────────────
const POSTER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4ed8"/><stop offset="0.55" stop-color="#7c3aed"/><stop offset="1" stop-color="#db2777"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="800" fill="url(#g)"/>
  <circle cx="330" cy="300" r="150" fill="#fbbf24" opacity="0.9"/>
  <rect x="640" y="180" width="380" height="260" rx="28" fill="#f8fafc" opacity="0.92"/>
  <rect x="690" y="230" width="280" height="24" rx="12" fill="#cbd5e1"/>
  <rect x="690" y="280" width="200" height="24" rx="12" fill="#cbd5e1"/>
  <rect x="690" y="360" width="120" height="44" rx="22" fill="#2563eb"/>
  <path d="M0 640 Q 300 520 600 640 T 1200 640 V 800 H 0 Z" fill="#0f172a" opacity="0.55"/>
  <text x="80" y="720" font-family="Inter, sans-serif" font-size="56" font-weight="700" fill="#f8fafc">海报 · 审计样图</text>
</svg>`
const POSTER_URL = `data:image/svg+xml;utf8,${encodeURIComponent(POSTER_SVG)}`

const auth = createMemoryAuthSession(() => {}, 'preview-token')
const noop = () => {}
const resolveSrc = async () => POSTER_URL

/** 黑底全屏容器:查看器的子模式(评论 / 调整大小)自身不带 Dialog,这里给它们一个同款舞台。 */
function ImmersiveStage({ children }: { children: React.ReactNode }) {
  return <div className="fixed inset-0 flex flex-col bg-black text-white">{children}</div>
}

// ── 1. 全屏图片查看器 ─────────────────────────────────────────────────────────────
function ViewerScene({ enabled }: { enabled: boolean }) {
  return (
    <ImageEditActionsContext.Provider
      value={enabled ? { submitImageEdit: async () => {}, submitImageComment: async () => {} } : {}}
    >
      <ImageViewer
        open
        onOpenChange={noop}
        src={POSTER_URL}
        alt="海报 · 审计样图"
        signPath="/home/agent/poster.svg"
        cacheIdentity={null}
        get={resolveSrc}
        peek={() => POSTER_URL}
      />
    </ImageEditActionsContext.Provider>
  )
}

// ── 2. 视频任务中心桩数据 ─────────────────────────────────────────────────────────
const NOW = Date.parse('2026-09-15T12:00:00Z')
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString()

function job(
  partial: Partial<MediaGenerationJob> & Pick<MediaGenerationJob, 'id' | 'status'>,
): MediaGenerationJob {
  return {
    requestId: `req-${partial.id}`,
    kind: 'h3_generate',
    resourceClass: 'gpu-h3',
    phase: 'sampling',
    createdAt: iso(30),
    updatedAt: iso(1),
    ...partial,
  }
}

const JOBS: MediaGenerationJob[] = [
  job({
    id: 'job-running',
    status: 'running',
    phase: 'denoise_step',
    prompt: '一只橘猫在雨后的东京街头奔跑，电影感，慢镜头',
    currentStep: 38,
    totalSteps: 60,
    createdAt: iso(6),
  }),
  job({
    id: 'job-queued',
    status: 'queued',
    phase: 'wait_gpu',
    prompt: '航拍海边小镇的清晨，薄雾，暖色调',
    queuePosition: 3,
    createdAt: iso(4),
  }),
  job({
    id: 'job-done',
    status: 'completed',
    phase: 'done',
    prompt: '产品宣传片开场：logo 从粒子中汇聚',
    resultUrl: '/api/media-generation/jobs/job-done/result',
    resultSize: 18_874_368,
    createdAt: iso(90),
    updatedAt: iso(80),
  }),
  job({
    id: 'job-failed',
    status: 'failed',
    phase: 'upload',
    prompt: '把这张草图变成 3D 动画',
    errorCode: 'H3_OOM',
    errorMessage: 'CUDA out of memory while allocating 2.1 GiB (worker gpu-h3-02)',
    createdAt: iso(200),
    updatedAt: iso(190),
  }),
  job({
    id: 'job-shot-1',
    status: 'completed',
    phase: 'done',
    projectId: 'proj-1',
    projectShotId: 'shot-1',
    createdAt: iso(60),
  }),
  job({
    id: 'job-shot-2',
    status: 'running',
    phase: 'denoise_step',
    projectId: 'proj-1',
    projectShotId: 'shot-2',
    currentStep: 12,
    totalSteps: 60,
    createdAt: iso(20),
  }),
]

const PROJECTS: VideoProject[] = [
  {
    id: 'proj-1',
    title: '春季新品发布 · 90 秒宣传片',
    rev: 4,
    status: 'needs_review',
    currentComposeJobId: null,
    shots: [
      {
        id: 'shot-1',
        ordinal: 0,
        prompt: '开场：城市天际线日出，镜头缓慢推进，出现品牌 logo',
        durationSeconds: 8,
        activeJobId: 'job-shot-1',
        activeJob: JOBS[4],
        stale: true,
      },
      {
        id: 'shot-2',
        ordinal: 1,
        prompt: '第二镜：产品特写旋转，玻璃质感反射，浅景深',
        durationSeconds: 6,
        activeJobId: 'job-shot-2',
        activeJob: JOBS[5],
        stale: false,
      },
      {
        id: 'shot-3',
        ordinal: 2,
        prompt: '收尾：用户在咖啡馆使用产品，自然光，微笑',
        durationSeconds: 6,
        activeJobId: null,
        stale: false,
      },
    ],
    createdAt: iso(300),
    updatedAt: iso(2),
  },
]

type MediaFetchMode = 'jobs' | 'empty' | 'unavailable'

/**
 * 按路由接管 window.fetch:MediaTaskCenter 不走 lib/api(自己 callWithRefresh + fetch),
 * api-stub 的 Proxy 拦不到。只接 /api/media-generation/*,其余交回 harness 原来的 204。
 */
let baseFetch: typeof window.fetch | null = null
function installMediaFetch(mode: MediaFetchMode) {
  // 只记一次 harness 的兜底 fetch,重复挂载不层层套娃。
  baseFetch ??= window.fetch
  const previous = baseFetch
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!url.includes('/api/media-generation/')) return previous(input, init)
    if (url.includes('/capabilities')) {
      return json(
        mode === 'unavailable'
          ? { available: false }
          : { available: true, workerReachable: mode !== 'jobs' },
      )
    }
    if (url.includes('/projects'))
      return json({ projects: mode === 'jobs' ? PROJECTS : [], nextCursor: null })
    if (url.includes('/jobs')) {
      return json({
        jobs: mode === 'jobs' ? JOBS : [],
        nextCursor: mode === 'jobs' ? 'cursor-2' : null,
      })
    }
    return json({})
  }
}

function TaskCenterScene({ mode }: { mode: MediaFetchMode }) {
  installMediaFetch(mode)
  return <MediaTaskCenter open auth={auth} liveJob={null} onOpenChange={noop} />
}

// ── 3. 容器网页预览:授权中 / 连接失败(ready 态需真实容器 WebSocket,静态页不覆盖) ──
function PreviewScene() {
  return (
    <ContainerWebPreview
      open
      sourceUrl="http://127.0.0.1:5173/dashboard"
      auth={auth}
      onClose={noop}
      onUseComments={noop}
    />
  )
}

const pending = () => new Promise<never>(() => {})
const refused = async () => {
  throw new Error('ECONNREFUSED 127.0.0.1:5173 —— 容器内 5173 端口没有进程在监听')
}

/**
 * 圈选编辑器取原图走 fetch(source.url):harness 把 window.fetch 兜成 204,data: URL 也会被吞成
 * 空 blob → 「图片解码失败」。这里对样图 URL **就地合成** 一个与真实取图同形的 Response
 * (带 content-type / content-length,让流式读取与百分比逻辑照常走),不借 iframe、不碰网络,
 * 每次挂载结果确定(此前借 about:blank iframe 的 fetch 偶发拿到空 blob,首轮基线就红了一张)。
 */
function allowDataUrlFetch() {
  baseFetch ??= window.fetch
  const previous = baseFetch
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url === POSTER_URL) {
      const bytes = new TextEncoder().encode(POSTER_SVG)
      return new Response(bytes, {
        status: 200,
        headers: { 'content-type': 'image/svg+xml', 'content-length': String(bytes.byteLength) },
      })
    }
    return previous(input, init)
  }
}

function AnnotationEditorScene() {
  allowDataUrlFetch()
  return (
    <ImageAnnotationEditor
      open
      source={{ url: POSTER_URL, name: '海报 · 审计样图' }}
      onOpenChange={noop}
      onSubmit={async () => {}}
    />
  )
}

export const mediaScenes: Scene[] = [
  {
    id: 'media-image-viewer',
    label: '媒体 · 全屏图片查看器（可编辑）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <ViewerScene enabled />,
  },
  {
    id: 'media-image-viewer-disabled',
    label: '媒体 · 全屏图片查看器（当前模型不支持编辑）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <ViewerScene enabled={false} />,
  },
  {
    id: 'media-image-comment',
    label: '媒体 · 评论模式（数字锚点,初始态）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <ImmersiveStage>
        <ImageCommentMode
          src={POSTER_URL}
          alt="海报 · 审计样图"
          resolveSrc={resolveSrc}
          cacheIdentity={null}
          canSubmit
          onBack={noop}
          onSubmit={async () => {}}
        />
      </ImmersiveStage>
    ),
  },
  {
    id: 'media-image-resize',
    label: '媒体 · 调整大小（五比例菜单）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <ImmersiveStage>
        <ImageResizeMode
          src={POSTER_URL}
          alt="海报 · 审计样图"
          resolveSrc={resolveSrc}
          cacheIdentity={null}
          canSubmit
          onBack={noop}
          onSubmit={async () => {}}
        />
      </ImmersiveStage>
    ),
  },
  {
    id: 'media-image-resize-unavailable',
    label: '媒体 · 调整大小（当前模型不支持）',
    group: '工作区',
    viewports: ['mobile'],
    api: {},
    render: () => (
      <ImmersiveStage>
        <ImageResizeMode
          src={POSTER_URL}
          alt="海报 · 审计样图"
          resolveSrc={resolveSrc}
          cacheIdentity={null}
          canSubmit={false}
          onBack={noop}
          onSubmit={async () => {}}
        />
      </ImmersiveStage>
    ),
  },
  {
    id: 'media-annotation-editor',
    label: '媒体 · 圈选编辑器（笔刷滑杆 + 画布 + 提示词）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <AnnotationEditorScene />,
  },
  {
    id: 'media-task-center',
    label: '媒体 · 视频任务中心（长视频项目 + 单段任务各状态）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <TaskCenterScene mode="jobs" />,
  },
  {
    id: 'media-task-center-empty',
    label: '媒体 · 视频任务中心（空态）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => <TaskCenterScene mode="empty" />,
  },
  {
    id: 'media-task-center-unavailable',
    label: '媒体 · 视频任务中心（本账号未开放）',
    group: '工作区',
    viewports: ['desktop'],
    api: {},
    render: () => <TaskCenterScene mode="unavailable" />,
  },
  {
    id: 'media-container-preview-loading',
    label: '媒体 · 容器网页预览（授权中 / 首次启动）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: { createContainerPreviewTicket: pending },
    render: () => <PreviewScene />,
  },
  {
    id: 'media-container-preview-error',
    label: '媒体 · 容器网页预览（连接失败 + 诊断详情）',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: { createContainerPreviewTicket: refused },
    render: () => <PreviewScene />,
  },
]
