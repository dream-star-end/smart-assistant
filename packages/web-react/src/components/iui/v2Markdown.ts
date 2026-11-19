import type { PromptTemplateSpec, RunbookSpec, V2Spec } from "./v2Schema";

export function interpolateRunbookCommand(command: string, values: Record<string, string>): string {
  return command.replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, k1: string, k2: string) => {
    const k = k1 || k2;
    return values[k] !== undefined && values[k] !== "" ? values[k]! : whole;
  });
}

export function interpolatePromptTemplate(template: string, slots: PromptTemplateSpec["slots"], values: Record<string, string>): string {
  return template.replace(/\{\{([A-Za-z0-9_\u4e00-\u9fff-]{1,40})\}\}/g, (_, id: string) => {
    const slot = slots.find((s) => s.id === id);
    if (Object.prototype.hasOwnProperty.call(values, id)) {
      const val = values[id] ?? "";
      return val !== "" ? val : `[${slot?.label ?? id}]`;
    }
    return slot?.value || `[${slot?.label ?? id}]`;
  });
}

function head(title?: string, subtitle?: string): string[] {
  if (!title) return subtitle ? [subtitle, ""] : [];
  return subtitle ? [`**${title}**`, subtitle, ""] : [`**${title}**`, ""];
}

export function v2ToMarkdown(spec: V2Spec, values?: Record<string, string>): string {
  switch (spec.type) {
    case "deliverables":
      return [
        ...head(spec.title, spec.subtitle),
        ...spec.items.map((it) => {
          const info = [it.ext.toUpperCase(), it.size, it.meta].filter(Boolean).join(" · ");
          return `- **${it.name}**${info ? ` (${info})` : ""}${it.desc ? ` —— ${it.desc}` : ""}${it.path ? ` \`${it.path}\`` : ""}`;
        }),
      ].join("\n");
    case "citations":
      return [
        ...head(spec.title, spec.subtitle),
        ...spec.items.map((it) => {
          const name = it.url ? `[${it.title}](${it.url})` : it.title;
          return `${it.id}. **${name}**${it.meta ? ` (${it.meta})` : ""}${it.conclusion ? `\n   结论：${it.conclusion}` : ""}`;
        }),
      ].join("\n");
    case "runbook": {
      const vals = values ?? Object.fromEntries(spec.vars.map((v) => [v.id, v.value]));
      return [
        ...head(spec.title, spec.subtitle),
        ...spec.steps.flatMap((st: RunbookSpec["steps"][number], i: number) => [
          `${i + 1}. **${st.title}**${st.danger ? " [变更操作]" : ""}`,
          "```bash",
          interpolateRunbookCommand(st.command, vals),
          "```",
        ]),
      ].join("\n");
    }
    case "prompt_template": {
      const vals = values ?? Object.fromEntries(spec.slots.map((s) => [s.id, s.value]));
      return [...head(spec.title, spec.subtitle), interpolatePromptTemplate(spec.template, spec.slots, vals)].join("\n");
    }
    case "storyboard":
      return [
        ...head(spec.title, spec.subtitle),
        ...spec.shots.map((sh) => {
          const sec = sh.duration ?? Math.max(2, Math.round((sh.line.replace(/\s+/g, "").length || 1) / spec.cps));
          return `${sh.no}. [${sh.shotType ?? "镜头"} · ~${sec}s] ${sh.line}${sh.prompt ? `\n   Prompt: ${sh.prompt}` : ""}`;
        }),
      ].join("\n");
    case "flashcards":
      return [
        ...head(spec.title, spec.subtitle),
        ...spec.cards.map((c, i) => `${i + 1}. **${c.front}**\n   答：${c.back}`),
      ].join("\n");
  }
}
