import {
  type ContainerPreviewElementTarget,
  type ContainerPreviewViewport,
  normalizeContainerPreviewUrl,
} from '@openclaude/protocol/containerPreview'

export type ContainerWebAnnotation = {
  id: string
  target: ContainerPreviewElementTarget
  comment: string
  pageUrl: string
  pageTitle: string
  missing?: boolean
}

/** Resolve only explicit HTTP(S) loopback anchors; relative app links remain untouched. */
export function containerPreviewHrefFromTarget(target: EventTarget | null): string | null {
  const element =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const anchor = element?.closest<HTMLAnchorElement>('a[href]')
  if (
    !anchor ||
    anchor.hasAttribute('download') ||
    anchor.closest('[data-container-preview-ignore]')
  )
    return null
  const raw = anchor.getAttribute('href')
  if (!raw) return null
  try {
    return normalizeContainerPreviewUrl(raw).url
  } catch {
    return null
  }
}

function oneLine(value: string | undefined, max: number): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildContainerWebReviewPrompt({
  sourceUrl,
  currentUrl,
  title,
  viewport,
  annotations,
}: {
  sourceUrl: string
  currentUrl: string
  title: string
  viewport: ContainerPreviewViewport
  annotations: readonly ContainerWebAnnotation[]
}): string {
  const mode = viewport.isMobile ? '移动端' : '桌面端'
  const lines = [
    '请按下面的网页元素标注修改容器内正在运行的网页实现。先定位对应源码，完成修改后重新打开该地址验证；不要只描述方案。',
    `启动地址：${sourceUrl}`,
    `当前页面：${currentUrl}`,
    `页面标题：${oneLine(title, 200) || '（无标题）'}`,
    `检查视口：${mode} ${viewport.width} × ${viewport.height} CSS px（DPR ${viewport.deviceScaleFactor}）`,
    '',
  ]
  annotations.forEach((annotation, index) => {
    const target = annotation.target
    const label = oneLine(target.ariaLabel || target.text, 160)
    lines.push(`${index + 1}. ${annotation.comment.trim().slice(0, 2_000)}`)
    lines.push(`   - 标注页面：${annotation.pageUrl}`)
    lines.push(`   - CSS 选择器：${JSON.stringify(target.selector)}`)
    lines.push(
      `   - 元素：<${target.tag}>${target.role ? `，role=${target.role}` : ''}${label ? `，内容=${JSON.stringify(label)}` : ''}`,
    )
    lines.push(
      `   - 位置：x=${Math.round(target.bounds.x)}，y=${Math.round(target.bounds.y)}，宽=${Math.round(target.bounds.width)}，高=${Math.round(target.bounds.height)} CSS px`,
    )
    if (annotation.missing)
      lines.push('   - 注意：页面刷新后该选择器暂时未重新匹配，请结合源码确认。')
  })
  return lines.join('\n')
}
