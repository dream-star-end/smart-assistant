/**
 * W-R03 negative cache: skip the desktop-row SELECT for uids that recently
 * had none. Must be invalidated as soon as a uid's desktop row becomes
 * active (enroll_finish, register attach), otherwise chat falls through
 * to docker for up to 15s (W05-IMPL-02).
 *
 * Tiny module so enroll/register/ensure can import without a cycle.
 */

export const DESKTOP_ROW_MISS_TTL_MS = 15_000;

const noDesktopRowUntil = new Map<number, number>();

export function resetDesktopEnsureCacheForTest(): void {
  noDesktopRowUntil.clear();
}

export function invalidateDesktopRowMiss(uid: number): void {
  noDesktopRowUntil.delete(uid);
}

export function rememberDesktopRowMiss(uid: number, now = Date.now()): void {
  noDesktopRowUntil.set(uid, now + DESKTOP_ROW_MISS_TTL_MS);
}

export function shouldSkipDesktopRowLookup(uid: number, now = Date.now()): boolean {
  const until = noDesktopRowUntil.get(uid);
  return until !== undefined && now < until;
}
