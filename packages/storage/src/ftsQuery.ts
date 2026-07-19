/** Convert arbitrary natural-language input into an FTS5 literal-token query. */
export function literalFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? []
  return tokens.map((token) => `"${token}"`).join(' ')
}
