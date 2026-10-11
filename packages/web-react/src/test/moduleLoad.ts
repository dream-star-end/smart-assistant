import { beforeAll } from "vitest";

/**
 * Wait for a lazily imported chunk before the file's tests run.
 *
 * The first import of a heavy chunk (MarkdownImpl, the tool-card bodies) is a cold vite
 * transform. With several test workers running at once it can take longer than vitest's
 * 10 s default hook timeout, and a timed-out beforeAll skips the whole file. This budget
 * only covers loading code. Test deadlines stay as they are (testTimeout in vite.config.ts,
 * asyncUtilTimeout in setup.ts).
 */
export const MODULE_LOAD_TIMEOUT_MS = 60_000;

export function loadBeforeAll(load: () => Promise<unknown>): void {
  beforeAll(async () => {
    await load();
  }, MODULE_LOAD_TIMEOUT_MS);
}
