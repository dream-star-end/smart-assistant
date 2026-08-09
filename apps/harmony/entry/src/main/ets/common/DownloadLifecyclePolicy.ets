export function isCurrentDownloadCallback(
  delegateEpoch: number,
  targetEpoch: number,
  currentEpoch: number
): boolean {
  return delegateEpoch === currentEpoch && targetEpoch === currentEpoch;
}
