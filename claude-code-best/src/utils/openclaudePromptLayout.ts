/**
 * OCV5-383: OpenClaude writes its extra system prompt as
 *   <static text>  SEP  <!-- oc:session-context -->  SEP  <per-session text>
 * (gateway promptSlots cacheLayout 'static-first', SEP = '\n\n---\n\n').
 * With OPENCLAUDE_PROMPT_LAYOUT=2 the static half joins the default system
 * prompt's static sections, ahead of CCB's own per-session sections, so the
 * prompt prefix is identical across sessions and provider caches can share it.
 * The marker line stays in the text: the Box route splits on it.
 */
export const OPENCLAUDE_SESSION_CONTEXT_MARKER = '<!-- oc:session-context -->'
const SEPARATOR = '\n\n---\n\n'

let staticPrompt: string | null = null
let dynamicPrompt: string | undefined

/** Splits the append prompt at the marker and remembers both halves. The
 *  default system prompt then carries the static half (getSystemPrompt), and
 *  appendSystemPromptFor() keeps only the dynamic half next to it. Prompts
 *  that replace the default (custom prompt, agent, coordinator) keep the whole
 *  file. Without the env flag or the marker nothing is registered. */
export function registerOpenClaudeAppendPrompt(
  append: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  staticPrompt = null
  dynamicPrompt = undefined
  if (env.OPENCLAUDE_PROMPT_LAYOUT !== '2' || !append) return
  const at = append.indexOf(OPENCLAUDE_SESSION_CONTEXT_MARKER)
  if (at < 0) return
  let head = append.slice(0, at)
  let tail = append.slice(at + OPENCLAUDE_SESSION_CONTEXT_MARKER.length)
  if (head.endsWith(SEPARATOR)) head = head.slice(0, -SEPARATOR.length)
  if (tail.startsWith(SEPARATOR)) tail = tail.slice(SEPARATOR.length)
  head = head.trimEnd()
  staticPrompt = head
    ? `${head}\n\n${OPENCLAUDE_SESSION_CONTEXT_MARKER}`
    : OPENCLAUDE_SESSION_CONTEXT_MARKER
  dynamicPrompt = tail.trim() ? tail : undefined
}

/** The append prompt to use next to `base`: the dynamic half when `base` is the
 *  default prompt carrying the registered static half, else the whole file. */
export function appendSystemPromptFor(
  base: readonly string[],
  append: string | undefined,
): string | undefined {
  if (staticPrompt === null || !base.includes(staticPrompt)) return append
  return dynamicPrompt
}

/** True when an OpenClaude runner started this CCB (OPENCLAUDE_PROMPT_LAYOUT=2).
 *  OCV5-382 drops upstream Claude Code product text that is wrong there. */
export function isOpenClaudeRunner(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCLAUDE_PROMPT_LAYOUT === '2'
}

/** Static half registered by registerOpenClaudeAppendPrompt, ending with the marker. */
export function getOpenClaudeStaticPrompt(): string | null {
  return staticPrompt
}
