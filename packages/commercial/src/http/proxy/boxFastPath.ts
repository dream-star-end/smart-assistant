/** One selfhost rollout decision for Box native resume and both stage batches.
 * The commercial instance stays on the previous path unless explicitly opted
 * in. OC_BOX_FAST_NATIVE=0 is the single emergency rollback switch. */
export function boxFastPathEnabled(): boolean {
  const setting = process.env.OC_BOX_FAST_NATIVE;
  if (setting === "0") return false;
  return process.env.OC_INSTANCE_ID === "v5-selfhost-sg" || setting === "1";
}
