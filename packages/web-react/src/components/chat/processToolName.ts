export function normalizeSingleUnderscoreMcp(name: string): string {
  if (name.startsWith("mcp__")) return name;
  const m = /^mcp_([a-z0-9]+-[a-z0-9-]+)_(.+)$/i.exec(name);
  return m ? `mcp__${m[1]}__${m[2]}` : name;
}

export function mcpOpName(name: string): string {
  const norm = normalizeSingleUnderscoreMcp(name);
  if (norm.startsWith("mcp__")) {
    const rest = norm.slice(5);
    const sep = rest.indexOf("__");
    return (sep >= 0 ? rest.slice(sep + 2) : rest).toLowerCase();
  }
  return norm.toLowerCase();
}
