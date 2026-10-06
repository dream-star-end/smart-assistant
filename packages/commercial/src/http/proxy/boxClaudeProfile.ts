/** OCV5 Box Claude profiles. One Box can hold several Claude Code logins, each
 * in its own CLAUDE_CONFIG_DIR next to the default `/home/box/.claude`. A
 * profile is only ever selected at launch: the product's Box scripts keep
 * reading `/home/box/.claude/projects`, and every non-default profile directory
 * must make its `projects` a symlink to that shared directory, so history
 * staging, native resume and cleanup need no profile awareness.
 *
 * The default profile launches exactly as before (no CLAUDE_CONFIG_DIR key). */
import type { BoxCcExecRequest } from "@openclaude/gateway";

export const BOX_DEFAULT_PROFILE = "default";
export const BOX_HOME = "/home/box";
export const BOX_DEFAULT_CONFIG_DIR = `${BOX_HOME}/.claude`;
const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isBoxProfileName(name: unknown): name is string {
  return typeof name === "string" && (name === BOX_DEFAULT_PROFILE || NAME.test(name));
}

/** `default` -> /home/box/.claude, `x` -> /home/box/.claude-x. */
export function boxProfileDir(name: string): string {
  if (!isBoxProfileName(name)) throw new Error("BOX_PROFILE_INVALID");
  return name === BOX_DEFAULT_PROFILE ? BOX_DEFAULT_CONFIG_DIR : `${BOX_HOME}/.claude-${name}`;
}

/** Directory basename under /home/box -> profile name, or null when it is not a
 * Claude config directory name this product could ever use (`.claude-default`
 * is refused: it would alias the default profile). */
export function boxProfileNameFromDirName(base: string): string | null {
  if (base === ".claude") return BOX_DEFAULT_PROFILE;
  const match = /^\.claude-([a-z0-9][a-z0-9-]{0,31})$/.exec(base);
  return match && match[1] !== BOX_DEFAULT_PROFILE ? match[1]! : null;
}

/** A launch request is the one that carries the run environment. */
export function isBoxLaunchRequest(request: Pick<BoxCcExecRequest, "environment">): boolean {
  return request.environment !== undefined
    && Object.hasOwn(request.environment, "CLAUDE_CODE_MAX_RETRIES");
}

/** Default profile: the request is returned untouched (same object). */
export function withBoxProfile(request: BoxCcExecRequest, profile: string): BoxCcExecRequest {
  if (profile === BOX_DEFAULT_PROFILE || !isBoxLaunchRequest(request)) return request;
  return { ...request, environment: { ...request.environment,
    CLAUDE_CONFIG_DIR: boxProfileDir(profile) } };
}

export function boxProfileKey(accountId: bigint | string, profile: string): string {
  return `${accountId.toString()}:${profile}`;
}
