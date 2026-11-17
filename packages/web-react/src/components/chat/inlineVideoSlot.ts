let activeInlineVideoId: symbol | null = null;
let activeInlineVideoPreempt: (() => void) | null = null;

/** 同一页面同一时刻只允许挂一个活跃视频播放器，切新视频前先通知旧视频拆原生播放层。 */
export function claimInlineVideoSlot(id: symbol, onPreempt: () => void): void {
  if (activeInlineVideoId && activeInlineVideoId !== id) {
    const prev = activeInlineVideoPreempt;
    activeInlineVideoId = null;
    activeInlineVideoPreempt = null;
    prev?.();
  }
  activeInlineVideoId = id;
  activeInlineVideoPreempt = onPreempt;
}

export function releaseInlineVideoSlot(id: symbol): void {
  if (activeInlineVideoId === id) {
    activeInlineVideoId = null;
    activeInlineVideoPreempt = null;
  }
}

/** 同步释放原生解码器与连接:鸿蒙 ArkWeb 同层渲染在仅移除节点时可能短暂残留黑框,pause + 移除 src + load 立即拆毁原生层。 */
export function teardownVideoElement(el: HTMLVideoElement | null): void {
  if (!el) return;
  try {
    el.pause();
    el.removeAttribute("src");
    el.load();
  } catch {
    // jsdom does not implement HTMLMediaElement.pause/load
  }
}
