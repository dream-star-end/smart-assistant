#!/usr/bin/env tsx
/**
 * v5 教程防漂移门禁。
 *
 * `check`（默认）只读：验证能力注册表、教程、真实入口标记、交互入口覆盖、媒体规格，
 * 并要求当前语义快照与仓库内 tutorial-sync.json 完全一致。
 *
 * `accept` 是显式维护动作：功能语义变化时，正常模式要求同步提高教程内容版本或媒体版本；
 * 仅源代码重构可用 `--source-only --note "..."` 接受，但会追加不可覆盖的 JSONL 审计记录。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import ts from 'typescript'
import {
  PRODUCT_CAPABILITIES,
  PRODUCT_CAPABILITY_LIST,
  type ProductFeatureId,
} from '../packages/web-react/src/lib/productCapabilities.ts'
import {
  TUTORIAL_CATALOG_SCHEMA,
  TUTORIAL_MEDIA,
  TUTORIAL_TOPICS,
  type TutorialMediaKey,
} from '../packages/web-react/src/lib/tutorialCatalog.ts'

const ROOT = resolve(import.meta.dirname, '..')
const WEB_ROOT = join(ROOT, 'packages/web-react')
const SRC_ROOT = join(WEB_ROOT, 'src')
const MANIFEST_PATH = join(WEB_ROOT, 'tutorial-sync.json')
const HISTORY_PATH = join(WEB_ROOT, 'tutorial-sync-history.jsonl')
const HISTORY_ANCHOR_PATH = join(WEB_ROOT, 'tutorial-sync-history-head.json')
const HISTORY_REPO_PATH = relative(ROOT, HISTORY_PATH).replaceAll('\\', '/')
const MAX_TOTAL_MEDIA_BYTES = 6 * 1024 * 1024
const MAX_MEDIA_PAIR_BYTES = 768 * 1024
const REQUIRED_WIDTH = 960
const REQUIRED_HEIGHT = 540
const MIN_DURATION_SECONDS = 2
const MAX_DURATION_SECONDS = 12

type MediaSnapshot = {
  version: number
  poster: string
  video: string
  caption: string
  posterSha256: string
  videoSha256: string
  posterBytes: number
  videoBytes: number
  width: number
  height: number
  durationSeconds: number
  codec: 'VP8'
}

type CapabilitySnapshot = {
  contentVersion: number
  contentHash: string
  registryHash: string
  sourceHash: string
  mediaKey: TutorialMediaKey
  mediaVersion: number
  mediaHash: string
}

type TutorialSnapshot = {
  schema: 1
  catalogSchema: number
  capabilities: Record<string, CapabilitySnapshot>
  media: Record<TutorialMediaKey, MediaSnapshot>
}

type TutorialAudit = {
  schema: 1
  sequence: number
  previousAuditSha256: string | null
  at: string
  actor: string
  mode: 'bootstrap' | 'source-only' | 'tutorial-sync'
  note: string
  sourceChanged: string[]
  registryChanged: string[]
  contentChanged: string[]
  mediaChanged: string[]
  added: string[]
  retired: string[]
  snapshotSha256: string
}

type TutorialHistoryAnchor = {
  schema: 1
  entries: number
  historySha256: string
  headAuditSha256: string
}

type Marker = {
  id: ProductFeatureId
  file: string
  line: number
  semantic: string
}

const FEATURE_IDS = new Set(PRODUCT_CAPABILITY_LIST.map((feature) => feature.id))
const FEATURE_BY_KEY = new Map(
  Object.entries(PRODUCT_CAPABILITIES).map(([key, value]) => [key, value.id as ProductFeatureId]),
)
const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })

function fail(message: string): never {
  throw new Error(message)
}

function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
    .join(',')}}`
}

function semanticNode(node: ts.Node, sourceFile: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, sourceFile).replace(/\s+/g, ' ').trim()
}

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      // 教程本身与离线媒体舞台不能反过来充当“真实产品入口”。
      if (path === join(SRC_ROOT, 'components/tutorial')) continue
      out.push(...sourceFiles(path))
    } else if (
      (extname(name) === '.tsx' || extname(name) === '.ts') &&
      name !== 'tutorialCapture.tsx' &&
      !name.endsWith('.test.ts') &&
      !name.endsWith('.test.tsx') &&
      !name.endsWith('.spec.ts') &&
      !name.endsWith('.spec.tsx')
    ) {
      out.push(path)
    }
  }
  return out.sort()
}

function jsxName(node: ts.JsxTagNameExpression): string {
  return node.getText()
}

function jsxAttribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  )
}

function featureIdFromExpression(expression: ts.Expression | undefined): ProductFeatureId | null {
  if (!expression) return null
  if (ts.isStringLiteralLike(expression)) {
    return FEATURE_IDS.has(expression.text) ? (expression.text as ProductFeatureId) : null
  }
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'id' &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === 'PRODUCT_CAPABILITIES'
  ) {
    return FEATURE_BY_KEY.get(expression.expression.name.text) ?? null
  }
  return null
}

function featureIdFromAttribute(attribute: ts.JsxAttribute): ProductFeatureId | null {
  if (!attribute.initializer) return null
  if (ts.isStringLiteral(attribute.initializer)) {
    return featureIdFromExpression(attribute.initializer)
  }
  if (ts.isJsxExpression(attribute.initializer)) {
    return featureIdFromExpression(attribute.initializer.expression)
  }
  return null
}

function markerSlice(opening: ts.JsxOpeningLikeElement): ts.Node {
  return ts.isJsxOpeningElement(opening) && ts.isJsxElement(opening.parent)
    ? opening.parent
    : opening
}

function isInteractive(opening: ts.JsxOpeningLikeElement): boolean {
  const name = jsxName(opening.tagName)
  if (['button', 'input', 'select', 'textarea', 'summary'].includes(name)) return true
  if (name === 'a') return !!jsxAttribute(opening, 'href') || !!jsxAttribute(opening, 'role')
  return ['Button', 'IconButton', 'Switch'].includes(name)
}

function validateScope(
  scope: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
  errors: string[],
): void {
  const root = markerSlice(scope)
  const visit = (node: ts.Node): void => {
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node !== scope) {
      if (isInteractive(node)) {
        const feature = jsxAttribute(node, 'data-product-feature')
        const control = jsxAttribute(node, 'data-product-control')
        if (!feature && !control) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          errors.push(
            `${relative(ROOT, sourceFile.fileName)}:${pos.line + 1} <${jsxName(node.tagName)}> 位于 data-product-entry-scope 内，但没有 data-product-feature 或 data-product-control`,
          )
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
}

function collectMarkers(): Marker[] {
  const markers: Marker[] = []
  const errors: string[] = []
  const scopes = new Set<string>()

  for (const file of sourceFiles(SRC_ROOT)) {
    const sourceText = readFileSync(file, 'utf8')
    const sourceFile = ts.createSourceFile(
      file,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      extname(file) === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    )

    const addMarker = (id: ProductFeatureId, node: ts.Node): void => {
      const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      markers.push({
        id,
        file: relative(ROOT, file),
        line: pos.line + 1,
        semantic: semanticNode(node, sourceFile),
      })
    }

    const visit = (node: ts.Node): void => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const featureAttribute = jsxAttribute(node, 'data-product-feature')
        if (featureAttribute) {
          const id = featureIdFromAttribute(featureAttribute)
          if (!id) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
            // Tabs 的 `it.featureId` 是渲染器；真实 id 由各 items 对象字面量登记。
            if (
              !['{it.featureId}', '{featureId}'].includes(
                featureAttribute.initializer?.getText() ?? '',
              )
            ) {
              errors.push(
                `${relative(ROOT, file)}:${pos.line + 1} data-product-feature 必须引用 PRODUCT_CAPABILITIES.<key>.id 或稳定 id 字面量`,
              )
            }
          } else {
            addMarker(id, markerSlice(node))
          }
        }

        const featureProp = jsxAttribute(node, 'featureId')
        if (featureProp) {
          const id = featureIdFromAttribute(featureProp)
          if (id) addMarker(id, markerSlice(node))
        }

        const scopeAttribute = jsxAttribute(node, 'data-product-entry-scope')
        if (scopeAttribute) {
          const value = scopeAttribute.initializer?.getText().replace(/^['"]|['"]$/g, '') ?? ''
          if (!value)
            errors.push(`${relative(ROOT, file)}: data-product-entry-scope 必须有稳定名称`)
          else if (scopes.has(value)) errors.push(`data-product-entry-scope 重名：${value}`)
          else scopes.add(value)
          validateScope(node, sourceFile, errors)
        }
      }

      if (ts.isPropertyAssignment(node) && node.name.getText() === 'featureId') {
        const id = featureIdFromExpression(node.initializer)
        if (id) addMarker(id, ts.isObjectLiteralExpression(node.parent) ? node.parent : node)
        else if (!node.initializer.getText().includes('.featureId')) {
          const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          errors.push(
            `${relative(ROOT, file)}:${pos.line + 1} featureId 必须引用 PRODUCT_CAPABILITIES.<key>.id`,
          )
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }

  if (errors.length) fail(`教程入口覆盖检查失败：\n- ${errors.join('\n- ')}`)
  return markers
}

function validateCatalog(markers: Marker[]): void {
  const registryIds = [...FEATURE_IDS].sort()
  const topicIds = Object.keys(TUTORIAL_TOPICS).sort()
  if (stable(registryIds) !== stable(topicIds)) {
    fail(
      `能力注册表与教程目录不一一对应：registry=${registryIds.join(',')} topics=${topicIds.join(',')}`,
    )
  }

  const targetIds = new Set(markers.map((marker) => marker.id))
  const missingTargets = registryIds.filter((id) => !targetIds.has(id as ProductFeatureId))
  if (missingTargets.length) {
    fail(
      `以下能力没有真实 UI 目标标记 data-product-feature/featureId：${missingTargets.join(', ')}`,
    )
  }

  for (const feature of PRODUCT_CAPABILITY_LIST) {
    const id = feature.id as ProductFeatureId
    const topic = TUTORIAL_TOPICS[id]
    if (topic.featureId !== id) fail(`${id}: topic.featureId 不一致`)
    if (!Number.isInteger(topic.contentVersion) || topic.contentVersion < 1) {
      fail(`${id}: contentVersion 必须是正整数`)
    }
    if (topic.intro.length < 70 || topic.outcome.length < 20) fail(`${id}: 介绍或学习结果过短`)
    if (topic.scenarios.length < 3 || topic.steps.length < 4 || topic.tips.length < 2) {
      fail(`${id}: 教程至少需要 3 个场景、4 个步骤、2 条建议`)
    }
    if (topic.cautions.length < 1) fail(`${id}: 至少需要 1 条风险/注意事项`)
    const related = new Set(topic.related)
    if (related.size !== topic.related.length || related.has(id))
      fail(`${id}: related 必须唯一且不能指向自身`)
    for (const relatedId of related)
      if (!FEATURE_IDS.has(relatedId)) fail(`${id}: 未知相关教程 ${relatedId}`)
    if (!(topic.media in TUTORIAL_MEDIA)) fail(`${id}: 未知媒体 ${topic.media}`)
    if (feature.destination.kind === 'focus' && !FEATURE_IDS.has(feature.destination.target)) {
      fail(`${id}: focus 目标 ${feature.destination.target} 未登记`)
    }
  }
  const usedMedia = new Set(Object.values(TUTORIAL_TOPICS).map((topic) => topic.media))
  const unusedMedia = Object.keys(TUTORIAL_MEDIA).filter(
    (key) => !usedMedia.has(key as TutorialMediaKey),
  )
  if (unusedMedia.length) fail(`存在未被任何教程引用的媒体：${unusedMedia.join(', ')}`)
}

function webPublicPath(urlPath: string): string {
  if (!urlPath.startsWith('/tutorials/')) fail(`教程媒体必须是本地 /tutorials/ 路径：${urlPath}`)
  return join(WEB_ROOT, 'public', urlPath.slice(1))
}

function webpDimensions(buffer: Buffer): { width: number; height: number } {
  if (
    buffer.length < 30 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    fail('海报不是有效 WebP 文件')
  }
  const kind = buffer.toString('ascii', 12, 16)
  if (kind === 'VP8X') {
    return {
      width: 1 + buffer.readUIntLE(24, 3),
      height: 1 + buffer.readUIntLE(27, 3),
    }
  }
  if (kind === 'VP8 ') {
    if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) fail('WebP VP8 帧头无效')
    return {
      width: buffer.readUInt16LE(26) & 0x3fff,
      height: buffer.readUInt16LE(28) & 0x3fff,
    }
  }
  if (kind === 'VP8L') {
    const bits = buffer.readUInt32LE(21)
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) }
  }
  fail(`不支持的 WebP 编码块：${kind}`)
}

function readVint(buffer: Buffer, offset: number): { length: number; value: number } | null {
  const first = buffer[offset]
  if (first == null || first === 0) return null
  let length = 1
  let mask = 0x80
  while (length <= 8 && (first & mask) === 0) {
    length += 1
    mask >>= 1
  }
  if (length > 8 || offset + length > buffer.length) return null
  let value = first & (mask - 1)
  for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i]
  return { length, value }
}

function ebmlPayload(buffer: Buffer, id: readonly number[]): Buffer | null {
  const needle = Buffer.from(id)
  let offset = 0
  while ((offset = buffer.indexOf(needle, offset)) >= 0) {
    const size = readVint(buffer, offset + needle.length)
    if (size && size.value >= 0 && size.value <= 16) {
      const start = offset + needle.length + size.length
      if (start + size.value <= buffer.length) return buffer.subarray(start, start + size.value)
    }
    offset += 1
  }
  return null
}

function unsigned(payload: Buffer | null, label: string): number {
  if (!payload || payload.length === 0 || payload.length > 6) fail(`WebM 缺少 ${label}`)
  let value = 0
  for (const byte of payload) value = value * 256 + byte
  return value
}

function webmMetadata(buffer: Buffer): { width: number; height: number; durationSeconds: number } {
  if (buffer.length < 64 || !buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    fail('视频不是有效 WebM/EBML 文件')
  }
  if (!buffer.includes(Buffer.from('webm')) || !buffer.includes(Buffer.from('V_VP8'))) {
    fail('教程视频必须使用 WebM VP8 编码')
  }
  const width = unsigned(ebmlPayload(buffer, [0xb0]), 'PixelWidth')
  const height = unsigned(ebmlPayload(buffer, [0xba]), 'PixelHeight')
  const durationPayload = ebmlPayload(buffer, [0x44, 0x89])
  if (!durationPayload || (durationPayload.length !== 4 && durationPayload.length !== 8)) {
    fail('WebM 缺少可解析 Duration')
  }
  const durationTicks =
    durationPayload.length === 4 ? durationPayload.readFloatBE(0) : durationPayload.readDoubleBE(0)
  const scalePayload = ebmlPayload(buffer, [0x2a, 0xd7, 0xb1])
  const timecodeScale = scalePayload ? unsigned(scalePayload, 'TimecodeScale') : 1_000_000
  return { width, height, durationSeconds: (durationTicks * timecodeScale) / 1_000_000_000 }
}

function collectMedia(): Record<TutorialMediaKey, MediaSnapshot> {
  const result = {} as Record<TutorialMediaKey, MediaSnapshot>
  let totalBytes = 0
  for (const key of Object.keys(TUTORIAL_MEDIA).sort() as TutorialMediaKey[]) {
    const item = TUTORIAL_MEDIA[key]
    const posterPath = webPublicPath(item.poster)
    const videoPath = webPublicPath(item.video)
    if (!existsSync(posterPath) || !existsSync(videoPath)) fail(`${key}: 缺少海报或视频文件`)
    const poster = readFileSync(posterPath)
    const video = readFileSync(videoPath)
    const posterMeta = webpDimensions(poster)
    const videoMeta = webmMetadata(video)
    const pairBytes = poster.length + video.length
    totalBytes += pairBytes
    if (pairBytes > MAX_MEDIA_PAIR_BYTES)
      fail(`${key}: 媒体对 ${pairBytes} B 超过 ${MAX_MEDIA_PAIR_BYTES} B`)
    if (posterMeta.width !== REQUIRED_WIDTH || posterMeta.height !== REQUIRED_HEIGHT) {
      fail(
        `${key}: 海报必须为 ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}，实际 ${posterMeta.width}x${posterMeta.height}`,
      )
    }
    if (videoMeta.width !== REQUIRED_WIDTH || videoMeta.height !== REQUIRED_HEIGHT) {
      fail(
        `${key}: 视频必须为 ${REQUIRED_WIDTH}x${REQUIRED_HEIGHT}，实际 ${videoMeta.width}x${videoMeta.height}`,
      )
    }
    if (
      videoMeta.durationSeconds < MIN_DURATION_SECONDS ||
      videoMeta.durationSeconds > MAX_DURATION_SECONDS
    ) {
      fail(
        `${key}: 视频时长 ${videoMeta.durationSeconds.toFixed(3)} s 不在 ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} s`,
      )
    }
    result[key] = {
      version: item.version,
      poster: item.poster,
      video: item.video,
      caption: item.caption,
      posterSha256: sha256(poster),
      videoSha256: sha256(video),
      posterBytes: poster.length,
      videoBytes: video.length,
      width: videoMeta.width,
      height: videoMeta.height,
      durationSeconds: Number(videoMeta.durationSeconds.toFixed(3)),
      codec: 'VP8',
    }
  }
  if (totalBytes > MAX_TOTAL_MEDIA_BYTES) {
    fail(`教程媒体总量 ${totalBytes} B 超过 ${MAX_TOTAL_MEDIA_BYTES} B`)
  }
  return result
}

function buildSnapshot(): TutorialSnapshot {
  const markers = collectMarkers()
  validateCatalog(markers)
  const media = collectMedia()
  const capabilities: Record<string, CapabilitySnapshot> = {}
  for (const feature of [...PRODUCT_CAPABILITY_LIST].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = feature.id as ProductFeatureId
    const topic = TUTORIAL_TOPICS[id]
    const markerSemantics = markers
      .filter((marker) => marker.id === id)
      .sort((a, b) => `${a.file}:${a.line}`.localeCompare(`${b.file}:${b.line}`))
      .map((marker) => `${marker.file}\n${marker.semantic}`)
    const mediaItem = media[topic.media]
    const { contentVersion: _contentVersion, ...contentBody } = topic
    capabilities[id] = {
      contentVersion: topic.contentVersion,
      // 版本号不计入正文哈希：只“空加版本”不能冒充教程已同步更新。
      contentHash: sha256(stable(contentBody)),
      // 标题、搜索别名、分类、CTA 目的地与权限都是教程语义，必须进入版本化快照。
      registryHash: sha256(stable(feature)),
      sourceHash: sha256(markerSemantics.join('\n---\n')),
      mediaKey: topic.media,
      mediaVersion: mediaItem.version,
      mediaHash: sha256(
        `${mediaItem.posterSha256}:${mediaItem.videoSha256}:${sha256(mediaItem.caption)}`,
      ),
    }
  }
  return { schema: 1, catalogSchema: TUTORIAL_CATALOG_SCHEMA, capabilities, media }
}

function readManifest(): TutorialSnapshot | null {
  if (!existsSync(MANIFEST_PATH)) return null
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as TutorialSnapshot
}

function parseArgs(): {
  command: 'check' | 'accept'
  sourceOnly: boolean
  bootstrap: boolean
  note: string
  retire: string[]
} {
  const args = process.argv.slice(2)
  const command = args[0] === 'accept' ? 'accept' : 'check'
  const sourceOnly = args.includes('--source-only')
  const bootstrap = args.includes('--bootstrap')
  const noteIndex = args.indexOf('--note')
  const note = noteIndex >= 0 ? (args[noteIndex + 1] ?? '').trim() : ''
  const retire = args
    .flatMap((arg, index) => (arg === '--retire' ? [args[index + 1] ?? ''] : []))
    .map((id) => id.trim())
    .filter(Boolean)
  return { command, sourceOnly, bootstrap, note, retire }
}

function snapshotCapabilityIds(before: TutorialSnapshot | null, after: TutorialSnapshot): string[] {
  return [
    ...new Set([...Object.keys(before?.capabilities ?? {}), ...Object.keys(after.capabilities)]),
  ].sort()
}

function changedIds(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
  field: keyof CapabilitySnapshot,
): string[] {
  return snapshotCapabilityIds(before, after)
    .filter((id) => before?.capabilities[id]?.[field] !== after.capabilities[id]?.[field])
    .sort()
}

function changedCapabilityIds(before: TutorialSnapshot | null, after: TutorialSnapshot): string[] {
  return snapshotCapabilityIds(before, after)
    .filter(
      (id) => stable(before?.capabilities[id] ?? null) !== stable(after.capabilities[id] ?? null),
    )
    .sort()
}

function addedCapabilityIds(before: TutorialSnapshot | null, after: TutorialSnapshot): string[] {
  if (!before) return Object.keys(after.capabilities).sort()
  return Object.keys(after.capabilities)
    .filter((id) => !before.capabilities[id])
    .sort()
}

function retiredCapabilityIds(before: TutorialSnapshot | null, after: TutorialSnapshot): string[] {
  if (!before) return []
  return Object.keys(before.capabilities)
    .filter((id) => !after.capabilities[id])
    .sort()
}

function committedHistoryBaseline(): string | null {
  const configured = (process.env.TUTORIAL_HISTORY_BASE_REF ?? '').trim()
  const ref = configured && !/^0+$/.test(configured) ? configured : 'HEAD'
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}^{commit}`], {
      cwd: ROOT,
      stdio: 'ignore',
    })
  } catch {
    if (configured) fail(`无法读取教程历史基线提交：${configured}`)
    return null
  }
  try {
    return execFileSync('git', ['show', `${ref}:${HISTORY_REPO_PATH}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    // 首次引入教程系统时，可信基线提交中尚没有历史文件。
    return null
  }
}

function historyAnchor(raw: string, audits: TutorialAudit[]): TutorialHistoryAnchor {
  const head = audits.at(-1)
  if (!head) fail('tutorial-sync-history.jsonl 不能为空')
  return {
    schema: 1,
    entries: audits.length,
    historySha256: sha256(raw),
    headAuditSha256: sha256(stable(head)),
  }
}

function writeHistoryAnchor(audits: TutorialAudit[]): void {
  const raw = readFileSync(HISTORY_PATH, 'utf8')
  const anchor = historyAnchor(raw, audits)
  writeAtomic(HISTORY_ANCHOR_PATH, `${JSON.stringify(JSON.parse(stable(anchor)), null, 2)}\n`)
}

function readAndValidateHistory(manifest: TutorialSnapshot): TutorialAudit[] {
  if (!existsSync(HISTORY_PATH)) fail('缺少 tutorial-sync-history.jsonl 追加式审计记录')
  const raw = readFileSync(HISTORY_PATH, 'utf8')
  const lines = raw.endsWith('\n') ? raw.slice(0, -1).split('\n') : raw.split('\n')
  if (!raw.endsWith('\n') || lines.length === 0 || lines.some((line) => !line.trim())) {
    fail('tutorial-sync-history.jsonl 必须是非空、逐行 JSON 且以换行结尾')
  }

  const audits: TutorialAudit[] = []
  for (const [index, line] of lines.entries()) {
    let audit: TutorialAudit
    try {
      audit = JSON.parse(line) as TutorialAudit
    } catch {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行不是有效 JSON`)
    }
    if (
      audit.schema !== 1 ||
      audit.sequence !== index + 1 ||
      !['bootstrap', 'source-only', 'tutorial-sync'].includes(audit.mode) ||
      typeof audit.actor !== 'string' ||
      !audit.actor ||
      typeof audit.at !== 'string' ||
      !Number.isFinite(Date.parse(audit.at)) ||
      typeof audit.note !== 'string' ||
      audit.note.length < 8 ||
      !/^[a-f0-9]{64}$/.test(audit.snapshotSha256)
    ) {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行字段或序号无效`)
    }
    const expectedPrevious = index === 0 ? null : sha256(stable(audits[index - 1]))
    if (audit.previousAuditSha256 !== expectedPrevious) {
      fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行哈希链断裂`)
    }
    if ((index === 0) !== (audit.mode === 'bootstrap')) {
      fail('tutorial-sync-history.jsonl 只能第一条记录使用 bootstrap 模式')
    }
    for (const field of [
      'sourceChanged',
      'registryChanged',
      'contentChanged',
      'mediaChanged',
      'added',
      'retired',
    ] as const) {
      if (!Array.isArray(audit[field]) || audit[field].some((id) => typeof id !== 'string')) {
        fail(`tutorial-sync-history.jsonl 第 ${index + 1} 行 ${field} 无效`)
      }
    }
    audits.push(audit)
  }
  const expectedSnapshot = sha256(stable(manifest))
  if (audits.at(-1)?.snapshotSha256 !== expectedSnapshot) {
    fail('tutorial-sync-history.jsonl 最后一条记录与 tutorial-sync.json 快照不一致')
  }

  if (!existsSync(HISTORY_ANCHOR_PATH)) fail('缺少 tutorial-sync-history-head.json 历史锚点')
  let anchor: TutorialHistoryAnchor
  try {
    anchor = JSON.parse(readFileSync(HISTORY_ANCHOR_PATH, 'utf8')) as TutorialHistoryAnchor
  } catch {
    fail('tutorial-sync-history-head.json 不是有效 JSON')
  }
  if (stable(anchor) !== stable(historyAnchor(raw, audits))) {
    fail('tutorial-sync-history.jsonl 与历史锚点不一致，既有审计记录可能被改写')
  }

  const baseline = committedHistoryBaseline()
  if (baseline !== null && !raw.startsWith(baseline)) {
    fail('tutorial-sync-history.jsonl 必须以可信 Git 基线的完整字节内容为前缀，只能追加')
  }
  return audits
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`)
  writeFileSync(temp, content, { encoding: 'utf8', mode: 0o644 })
  renameSync(temp, path)
}

function accept(
  before: TutorialSnapshot | null,
  after: TutorialSnapshot,
  args: ReturnType<typeof parseArgs>,
): void {
  if (!args.note || args.note.length < 8)
    fail('accept 必须提供至少 8 个字符的 --note，说明对应功能/教程变化')
  if (!before && !args.bootstrap) fail('首次建立同步快照必须显式使用 --bootstrap')
  if (before && args.bootstrap) fail('tutorial-sync.json 已存在，不能再次 --bootstrap')

  let history: TutorialAudit[] = []
  if (before) {
    history = readAndValidateHistory(before)
  } else if (existsSync(HISTORY_PATH) || existsSync(HISTORY_ANCHOR_PATH)) {
    fail('首次 bootstrap 前不得存在旧的教程同步历史或历史锚点')
  }

  const sourceChanged = changedIds(before, after, 'sourceHash')
  const registryChanged = changedIds(before, after, 'registryHash')
  const contentChanged = changedIds(before, after, 'contentHash')
  const mediaChanged = changedIds(before, after, 'mediaHash')
  const allIds = new Set(changedCapabilityIds(before, after))
  const added = addedCapabilityIds(before, after)
  const retired = retiredCapabilityIds(before, after)
  const retireSet = new Set(args.retire)

  if (retireSet.size !== args.retire.length) fail('--retire 不得重复同一个稳定 ID')
  const unconfirmedRetirements = retired.filter((id) => !retireSet.has(id))
  const unexpectedRetirements = args.retire.filter((id) => !retired.includes(id))
  if (unconfirmedRetirements.length) {
    fail(
      `能力稳定 ID 不得静默删除；确认下线请为每项添加 --retire：${unconfirmedRetirements.join(', ')}`,
    )
  }
  if (unexpectedRetirements.length) {
    fail(`--retire 与实际删除能力不一致：${unexpectedRetirements.join(', ')}`)
  }
  if (args.sourceOnly && (added.length > 0 || retired.length > 0)) {
    fail('--source-only 不能接受能力新增或下线')
  }

  if (before) {
    for (const id of allIds) {
      const oldValue = before.capabilities[id]
      const newValue = after.capabilities[id]
      if (!oldValue || !newValue) continue
      const contentHashChanged = oldValue.contentHash !== newValue.contentHash
      const mediaHashChanged = oldValue.mediaHash !== newValue.mediaHash
      const contentVersionRaised = newValue.contentVersion > oldValue.contentVersion
      const mediaVersionRaised = newValue.mediaVersion > oldValue.mediaVersion
      const mediaKeyChanged = oldValue.mediaKey !== newValue.mediaKey
      const registryHashChanged = oldValue.registryHash !== newValue.registryHash

      if (newValue.contentVersion !== oldValue.contentVersion && !contentVersionRaised) {
        fail(`${id}: contentVersion 不得降低`)
      }
      if (contentHashChanged !== contentVersionRaised) {
        fail(`${id}: 教程正文哈希变化与 contentVersion 递增必须同时发生`)
      }
      if (
        !mediaKeyChanged &&
        newValue.mediaVersion !== oldValue.mediaVersion &&
        !mediaVersionRaised
      ) {
        fail(`${id}: mediaVersion 不得降低`)
      }
      if (!mediaKeyChanged && mediaHashChanged !== mediaVersionRaised) {
        fail(`${id}: 教程媒体哈希变化与 mediaVersion 递增必须同时发生`)
      }
      const tutorialUpdated =
        (contentHashChanged && contentVersionRaised) || (mediaHashChanged && mediaVersionRaised)
      if (registryHashChanged && !tutorialUpdated) {
        fail(`${id}: 能力标题/分类/别名/CTA/权限已变化，必须同步更新教程正文或媒体并提高对应版本`)
      }
      if (sourceChanged.includes(id) && !args.sourceOnly && !tutorialUpdated) {
        fail(
          `${id}: 真实入口语义已变化；请同步更新教程正文/媒体并提高版本，或以 --source-only --note 审计接受等价重构`,
        )
      }
    }
  }

  if (args.sourceOnly && registryChanged.length > 0)
    fail('--source-only 不能接受能力标题、分类、别名、CTA 或权限变化')
  if (args.sourceOnly && sourceChanged.length === 0)
    fail('--source-only 仅用于存在真实功能源语义变化的情况')
  if (before && allIds.size === 0) fail('当前能力、教程、入口与媒体没有待接受的变化')
  const serialized = `${JSON.stringify(JSON.parse(stable(after)), null, 2)}\n`
  writeAtomic(MANIFEST_PATH, serialized)
  const audit: TutorialAudit = {
    schema: 1,
    sequence: history.length + 1,
    previousAuditSha256: history.length ? sha256(stable(history.at(-1))) : null,
    at: new Date().toISOString(),
    actor: process.env.GITHUB_ACTOR || process.env.USER || 'unknown',
    mode: args.bootstrap ? 'bootstrap' : args.sourceOnly ? 'source-only' : 'tutorial-sync',
    note: args.note,
    sourceChanged,
    registryChanged,
    contentChanged,
    mediaChanged,
    added,
    retired,
    snapshotSha256: sha256(stable(after)),
  }
  appendFileSync(HISTORY_PATH, `${stable(audit)}\n`, { encoding: 'utf8', mode: 0o644, flag: 'a' })
  const nextHistory = [...history, audit]
  writeHistoryAnchor(nextHistory)
  readAndValidateHistory(after)
  console.log(`tutorials:accept OK · ${audit.mode} · ${allIds.size} capability snapshots changed`)
}

function main(): void {
  const args = parseArgs()
  const snapshot = buildSnapshot()
  const manifest = readManifest()
  if (args.command === 'accept') {
    accept(manifest, snapshot, args)
    return
  }
  if (!manifest)
    fail(
      '缺少 packages/web-react/tutorial-sync.json；运行 tutorials:accept -- --bootstrap --note <说明>',
    )
  readAndValidateHistory(manifest)
  const expected = stable(manifest)
  const actual = stable(snapshot)
  if (expected !== actual) {
    const sourceChanged = changedIds(manifest, snapshot, 'sourceHash')
    const registryChanged = changedIds(manifest, snapshot, 'registryHash')
    const contentChanged = changedIds(manifest, snapshot, 'contentHash')
    const mediaChanged = changedIds(manifest, snapshot, 'mediaHash')
    const added = addedCapabilityIds(manifest, snapshot)
    const retired = retiredCapabilityIds(manifest, snapshot)
    fail(
      [
        '教程同步快照已漂移，CI 不会自动改写文件。',
        `能力注册表变化: ${registryChanged.join(', ') || '无'}`,
        `功能源变化: ${sourceChanged.join(', ') || '无'}`,
        `教程正文变化: ${contentChanged.join(', ') || '无'}`,
        `教程媒体变化: ${mediaChanged.join(', ') || '无'}`,
        `新增能力: ${added.join(', ') || '无'}`,
        `待确认下线: ${retired.join(', ') || '无'}`,
        '确认教程同步后运行 npm run tutorials:accept -- --note "说明"。',
      ].join('\n'),
    )
  }
  const totalBytes = Object.values(snapshot.media).reduce(
    (sum, item) => sum + item.posterBytes + item.videoBytes,
    0,
  )
  console.log(
    `check:tutorials OK · ${Object.keys(snapshot.capabilities).length} capabilities · ${Object.keys(snapshot.media).length} media pairs · ${totalBytes} B`,
  )
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
