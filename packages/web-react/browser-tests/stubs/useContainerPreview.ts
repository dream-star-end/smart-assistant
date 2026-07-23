const pageHtml = encodeURIComponent(`<!doctype html>
<html>
  <body style="margin:0;display:grid;min-height:100vh;place-items:center;background:#e7eef8">
    <button
      type="button"
      style="min-width:180px;min-height:48px"
      onclick="document.body.dataset.clicked='true'"
    >
      预览页面测试按钮
    </button>
  </body>
</html>`)

export function useContainerPreview({
  viewport,
}: {
  viewport: { width: number; height: number; isMobile: boolean }
}) {
  return {
    phase: 'ready' as const,
    transport: 'direct' as const,
    directUrl: `data:text/html;charset=utf-8,${pageHtml}`,
    error: null,
    ready: {
      url: 'http://localhost:4173/',
      title: 'Preview controls browser test',
      viewport,
    },
    selection: null,
    resolved: null,
    navigation: {
      sequence: 1,
      url: 'http://localhost:4173/',
      title: 'Preview controls browser test',
      pageRevision: 1,
    },
    send: () => true,
    useLegacyFallback: () => {},
  }
}
