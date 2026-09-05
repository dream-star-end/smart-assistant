/**
 * Container dial kinds. desktop-reverse is P1; docker paths stay direct | node-tunnel.
 */

export type ContainerEndpointKind = "direct" | "node-tunnel" | "desktop-reverse";

export type DesktopEndpointHint = { containerId: number };

/** W-01: desktop reverse-tunnel only runs the CCB engine. */
export function desktopAllowsEngine(desktop: boolean | undefined, engine: string): boolean {
  if (!desktop) return true;
  return engine === "ccb";
}
