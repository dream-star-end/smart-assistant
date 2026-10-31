let pending: Promise<typeof import("./tapePayload")> | undefined;

/** 首屏不静态拉 tape 解码块。第一次要展开精确大记录时再取，之后复用同一次 import。 */
export function loadTapePayload(): Promise<typeof import("./tapePayload")> {
  pending ??= import("./tapePayload");
  return pending;
}

/** 空闲时预取，打开一条带大记录的会话时解码脚本通常已经在。失败就等真正展开时再取。 */
export function prefetchTapePayloadOnIdle(): void {
  const run = () => {
    void loadTapePayload().catch(() => undefined);
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 3000);
  }
}
