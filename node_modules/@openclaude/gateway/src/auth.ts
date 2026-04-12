import { randomBytes } from 'node:crypto'

export function generateAccessToken(): string {
  return randomBytes(32).toString('hex')
}

export function checkToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false
  if (provided.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i)
  }
  return diff === 0
}
