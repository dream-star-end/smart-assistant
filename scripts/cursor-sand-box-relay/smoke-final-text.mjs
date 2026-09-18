/** A turn summary includes commentary before tools; validate the final text segment. */
export function finalAssistantText(summary) {
  const last = summary?.assistantSegments?.at(-1);
  return typeof last?.text === 'string' ? last.text : (summary?.assistantText ?? '');
}
