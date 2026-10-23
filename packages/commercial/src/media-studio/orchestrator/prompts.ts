// OCV5-591 A2-1a — provider prompts are assembled by code (no LLM call): the shot spec plus every
// locked bible descriptor, verbatim, so each shot carries the same character / scene description.

export interface BibleEntry {
  kind: 'character' | 'scene' | 'style'
  name: string
  descriptor: string
}

export interface ShotSpecForPrompt {
  title?: string
  framing?: string
  action?: string
}

const ASPECT_WORDS: Record<string, string> = {
  '16:9': '横屏 16:9 构图',
  '9:16': '竖屏 9:16 构图',
  '1:1': '方形 1:1 构图',
}

const MAX_PROMPT = 4000

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

export function bibleBlock(bible: BibleEntry[]): string {
  const order = { character: 0, scene: 1, style: 2 }
  return [...bible]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map(
      (b) =>
        `【${b.kind === 'character' ? '角色' : b.kind === 'scene' ? '场景' : '风格'}·${clip(b.name, 40)}】${clip(b.descriptor, 600)}`,
    )
    .join('\n')
}

/** Reference image for one bible entry (character sheet / establishing shot). */
export function biblePrompt(entry: BibleEntry, aspect: string): string {
  const what =
    entry.kind === 'character'
      ? '角色设定图：全身、正侧面清晰、背景简洁，便于后续镜头保持外观一致'
      : entry.kind === 'scene'
        ? '场景定调图：交代环境、光线和色调，不出现人物'
        : '风格参考图：体现整体色调、质感和光线'
  return clip(`${what}。${ASPECT_WORDS[aspect] ?? ''}。\n${bibleBlock([entry])}`, MAX_PROMPT)
}

/** First frame of a shot: the shot's own spec, then the locked bible verbatim. */
export function framePrompt(shot: ShotSpecForPrompt, bible: BibleEntry[], aspect: string): string {
  const head = [
    shot.framing && `景别：${clip(shot.framing, 12)}`,
    shot.action && `画面：${clip(shot.action, 120)}`,
  ]
    .filter(Boolean)
    .join('；')
  return clip(
    `${head}。${ASPECT_WORDS[aspect] ?? ''}，电影感，真实光影。\n${bibleBlock(bible)}`,
    MAX_PROMPT,
  )
}

/** A redo after visual QA (A2-1b-1): what the judge said to avoid, appended to the prompt. */
export function withAvoid(prompt: string, avoid: string[] | undefined, max = MAX_PROMPT): string {
  if (!avoid?.length) return prompt
  const tail = `\n避免：${avoid.map((a) => clip(a, 120)).join('；')}`
  return clip(prompt, Math.max(0, max - tail.length)) + tail
}

/** Image-to-video motion prompt (the first frame already carries the look). */
export function videoPrompt(shot: ShotSpecForPrompt): string {
  return clip(
    [
      shot.action && `动作：${clip(shot.action, 120)}`,
      shot.framing && `镜头：${clip(shot.framing, 12)}`,
      '运动自然连贯，保持角色外观不变',
    ]
      .filter(Boolean)
      .join('；'),
    1000,
  )
}
