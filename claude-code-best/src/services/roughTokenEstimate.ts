/** Dependency-free rough text token estimate used by preflight context checks. */
export function roughTokenCountEstimation(
  content: string,
  bytesPerToken: number = 4,
): number {
  if (bytesPerToken !== 4) {
    return Math.ceil(content.length / bytesPerToken)
  }
  let ascii = 0
  let nonAscii = 0
  for (const char of content) {
    if (char.codePointAt(0)! <= 0x7f) ascii += 1
    else nonAscii += 1
  }
  return Math.ceil(ascii / bytesPerToken) + nonAscii
}
