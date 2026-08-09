export const TOOLBAR_HEIGHT = 52

function toPixel(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/**
 * Calculate child WebContentsView bounds relative to a BaseWindow's content area.
 *
 * The product view never moves when the shell opens a modal surface. The shell is
 * kept above it and grows only while the downloads modal (or an offline surface)
 * is visible, so the collapsed transparent shell cannot consume product input.
 */
export function calculateViewBounds({ width, height } = {}, { shellMode = 'toolbar' } = {}) {
  const contentWidth = toPixel(width)
  const contentHeight = toPixel(height)
  const toolbarHeight = Math.min(contentHeight, TOOLBAR_HEIGHT)
  const productHeight = Math.max(0, contentHeight - toolbarHeight)

  const shellHeight = ['downloads', 'offline'].includes(shellMode) ? contentHeight : toolbarHeight

  return {
    shell: { x: 0, y: 0, width: contentWidth, height: shellHeight },
    product: {
      x: 0,
      y: toolbarHeight,
      width: contentWidth,
      height: productHeight,
    },
  }
}
