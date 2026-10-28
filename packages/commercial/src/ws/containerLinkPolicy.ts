import type { Flavor } from "../flavor/assertFlavor.js";

/** Only the boot-verified flavor supplies the default; runtime channel is shared. */
export function containerLinkEnabled(flavor?: Flavor, env = process.env): boolean {
  if (env.OC_CONTAINER_LINK === "0") return false;
  if (env.OC_CONTAINER_LINK === "1") return true;
  return flavor === "selfhost";
}

/** Transport / engine traffic is not a browser subscription for idleSweep. */
export function hasBrowserActivity(detached: boolean, readyState: number): boolean {
  return !detached && readyState === 1;
}
