function literalTokenQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(' ')
}

/** Convert natural language into literal FTS5 tokens, with bounded uppercase OR groups. */
export function literalFtsQuery(query: string): string {
  const groups = query.split(/\s+OR\s+/)
  if (groups.length > 1) {
    const encoded = groups.map(literalTokenQuery)
    if (encoded.every(Boolean)) return encoded.map((group) => `(${group})`).join(' OR ')
  }
  return literalTokenQuery(query)
}
